import { randomUUID, randomBytes } from 'node:crypto';
import type { Config } from './config.js';
import { Database, authorizeProject, requireScope, saveEnvelope, sealedFromRow, reserveBudget, type Principal } from './db.js';
import { ApiError, CryptoBox, assertDigest, canonical, digest, equal, hashToken, opaqueToken, scanText, sha256 } from './security.js';
import { approveSchema, draftSchema, lessonSchema, rememberSchema, type Lesson } from './schemas.js';
import type { GenerationProvider } from './providers.js';

const draftAad = (p: Principal, id: string) => `draft:${p.tenantId}:${id}:1`;
export class DraftService {
  constructor(private readonly db: Database, private readonly box: CryptoBox, private readonly model: GenerationProvider, private readonly config: Config) {}
  async create(p: Principal, input: unknown) {
    requireScope(p, 'memory:write'); const value = draftSchema.parse(input);
    scanText(value.title); scanText(value.sanitized_text);
    const candidate = { title: value.title, sanitized_text: value.sanitized_text };
    const id = randomUUID(), sealed = this.box.seal(candidate, draftAad(p, id));
    return this.db.transaction(p, async (tx) => {
      await authorizeProject(tx, p, value.project_id, true);
      const keyId = await saveEnvelope(tx, p.tenantId, sealed);
      const result = await tx.query('INSERT INTO approval_drafts(id,tenant_id,project_id,requested_by,key_envelope_id,content_ciphertext,candidate_sha256,state,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,\'scanned\',now()+interval \'24 hours\') RETURNING id,project_id,state,expires_at', [id, p.tenantId, value.project_id, p.userId, keyId, sealed.ciphertext, Buffer.from(digest(candidate).slice(2), 'hex')]);
      return { ...result.rows[0], candidate, candidate_sha256: digest(candidate), scan: { server_scan_passed: true, pipeline_version: 'deterministic-v1', limitations: ['Pattern scanning has false negatives. Human privacy and license review are still required.'] } };
    });
  }
  private async load(p: Principal, id: string, tx: import('./db.js').Tx, lock = false) {
    const result = await tx.query(`SELECT d.*,k.kek_version,k.wrapped_dek,k.wrapping_nonce,k.wrapping_tag FROM approval_drafts d JOIN key_envelopes k ON k.id=d.key_envelope_id AND k.tenant_id=d.tenant_id WHERE d.id=$1 AND d.tenant_id=$2 AND d.requested_by=$3 ${lock ? 'FOR UPDATE OF d' : ''}`, [id, p.tenantId, p.userId]);
    const row = result.rows[0];
    if (!row) throw new ApiError('NOT_FOUND', 'Draft not found', 404);
    await authorizeProject(tx, p, row.project_id, true);
    if (new Date(row.expires_at).getTime() <= Date.now()) throw new ApiError('INVALID_APPROVAL', 'Draft has expired', 409);
    return row;
  }
  async get(p: Principal, id: string) {
    requireScope(p, 'memory:write');
    return this.db.transaction(p, async (tx) => {
      const row = await this.load(p, id, tx);
      return { id: row.id, project_id: row.project_id, state: row.state, candidate_sha256: `0x${row.candidate_sha256.toString('hex')}`, content: this.box.open(sealedFromRow(row), draftAad(p, id)), expires_at: row.expires_at };
    });
  }
  async approveEgress(p: Principal, id: string, input: unknown) {
    requireScope(p, 'memory:write'); const value = approveSchema.parse(input);
    return this.db.transaction(p, async (tx) => {
      const row = await this.load(p, id, tx, true);
      if (row.state !== 'scanned' && row.state !== 'egress_approved') throw new ApiError('INVALID_APPROVAL', 'Only a scanned candidate may be approved for external model egress', 409);
      const candidate = this.box.open(sealedFromRow(row), draftAad(p, id)); assertDigest(candidate, value.approved_sha256);
      await tx.query("UPDATE approval_drafts SET state='egress_approved',egress_approved_at=now() WHERE id=$1", [id]);
      return { id, state: 'egress_approved', approved_sha256: value.approved_sha256, external_call_made: false };
    });
  }
  async distill(p: Principal, id: string, signal?: AbortSignal) {
    requireScope(p, 'memory:write');
    if (!this.model.configured) throw new ApiError('INTEGRATION_UNAVAILABLE', 'Anthropic generation is not configured; no text was sent', 503);
    const candidate = await this.db.transaction(p, async (tx) => {
      const row = await this.load(p, id, tx, true);
      if (row.state !== 'egress_approved' || !row.egress_approved_at) throw new ApiError('INVALID_APPROVAL', 'Approve the exact sanitized outbound candidate before distillation', 409);
      const content = this.box.open<{ title: string; sanitized_text: string }>(sealedFromRow(row), draftAad(p, id));
      assertDigest(content, `0x${row.candidate_sha256.toString('hex')}`); scanText(content.sanitized_text);
      await reserveBudget(tx, p, this.config);
      await tx.query("UPDATE approval_drafts SET state='distilling' WHERE id=$1", [id]);
      return content;
    });
    try {
      const lesson = lessonSchema.parse(await this.model.distill(candidate, signal));
      scanText(JSON.stringify(lesson));
      const sealed = this.box.seal(lesson, draftAad(p, id));
      return await this.db.transaction(p, async (tx) => {
        const row = await this.load(p, id, tx, true);
        if (row.state !== 'distilling') throw new ApiError('INVALID_APPROVAL', 'Draft changed during distillation', 409);
        const keyId = await saveEnvelope(tx, p.tenantId, sealed);
        await tx.query("UPDATE approval_drafts SET state='distilled',content_ciphertext=$2,key_envelope_id=$3,candidate_sha256=$4,approval_token_hash=NULL,approval_expires_at=NULL WHERE id=$1", [id, sealed.ciphertext, keyId, Buffer.from(digest(lesson).slice(2), 'hex')]);
        return { id, state: 'distilled', content: lesson, candidate_sha256: digest(lesson), requires_final_approval: true };
      });
    } catch (_error) {
      // Once distill() is invoked, the provider may have received the approved candidate even when
      // its response, validation, encryption, or persistence fails. Do not reopen egress approval.
      await this.db.transaction(p, async (tx) => { await tx.query("UPDATE approval_drafts SET state='rejected' WHERE id=$1 AND requested_by=$2 AND state='distilling'", [id, p.userId]); }).catch(() => undefined);
      throw new ApiError('UPSTREAM_UNAVAILABLE', 'Distillation may have been dispatched but could not be completed safely. This draft is not retryable; create and approve a new draft.', 503, false);
    }
  }
  async approve(p: Principal, id: string, input: unknown) {
    requireScope(p, 'memory:write'); const value = approveSchema.parse(input);
    return this.db.transaction(p, async (tx) => {
      const row = await this.load(p, id, tx, true);
      if (!['distilled', 'approved'].includes(row.state)) throw new ApiError('INVALID_APPROVAL', 'Only a distilled draft may receive final upload approval', 409);
      const content = lessonSchema.parse(this.box.open(sealedFromRow(row), draftAad(p, id))); assertDigest(content, value.approved_sha256); scanText(JSON.stringify(content));
      const token = opaqueToken('mo_approve_');
      await tx.query("UPDATE approval_drafts SET state='approved',approved_by=$2,approved_at=now(),approval_token_hash=$3,approval_expires_at=now()+interval '15 minutes' WHERE id=$1", [id, p.userId, hashToken(token, this.config.TOKEN_HASH_PEPPER)]);
      return { id, state: 'approved', approved_sha256: value.approved_sha256, approval_token: token, expires_at: new Date(Date.now() + 15 * 60000).toISOString(), uploaded: false };
    });
  }
  async remember(p: Principal, input: unknown) {
    requireScope(p, 'memory:write'); const value = rememberSchema.parse(input);
    const requestHash = sha256(canonical(value));
    return this.db.transaction(p, async (tx) => {
      await authorizeProject(tx, p, value.project_id, true);
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`remember:${p.tenantId}:${value.idempotency_key}`]);
      const existing = (await tx.query("SELECT j.*,a.state AS artifact_state,it.verified_at FROM jobs j LEFT JOIN artifacts a ON a.id=(j.payload->>'artifact_id')::uuid LEFT JOIN irys_transactions it ON it.artifact_id=a.id WHERE j.tenant_id=$1 AND j.kind='upload' AND j.idempotency_key=$2 AND j.requested_by=$3", [p.tenantId, value.idempotency_key, p.userId])).rows[0];
      if (existing) {
        if (!equal(existing.request_sha256, requestHash)) throw new ApiError('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used with a different request', 409);
        // A successful job must still resolve an indexed verified artifact at read time.
        return { kind: 'success', job_id: existing.id, memory_id: existing.payload.memory_id, state: existing.state, resource_uri: `memocean://jobs/${existing.id}`, ready: existing.state === 'succeeded' && existing.artifact_state === 'indexed' && Boolean(existing.verified_at) };
      }
      const row = await this.load(p, value.approved_draft_id, tx, true);
      if (row.project_id !== value.project_id || row.state !== 'approved' || row.approved_by !== p.userId || !row.approval_expires_at || new Date(row.approval_expires_at).getTime() <= Date.now() || !row.approval_token_hash || !equal(row.approval_token_hash, hashToken(value.approval_token, this.config.TOKEN_HASH_PEPPER))) throw new ApiError('INVALID_APPROVAL', 'Final approval is expired, consumed, changed or invalid', 409);
      const lesson = lessonSchema.parse(this.box.open<Lesson>(sealedFromRow(row), draftAad(p, row.id))); assertDigest(lesson, value.approved_sha256);
      if (!equal(row.candidate_sha256, Buffer.from(value.approved_sha256.slice(2), 'hex'))) throw new ApiError('INVALID_APPROVAL', 'Approved content changed', 409);
      const memoryId = randomUUID(), artifactId = randomUUID(), jobId = randomUUID();
      const salt = randomBytes(32), plaintext = Buffer.from(canonical(lesson));
      const plainCommitment = sha256(Buffer.concat([salt, plaintext]));
      const sealed = this.box.seal({ salt: salt.toString('base64'), payload: lesson }, `artifact:${p.tenantId}:${memoryId}:1:v1`);
      const manifest = { schema_version: '1.0', commitment_version: 1, object_id: memoryId, revision: 1, cipher_sha256: `0x${sha256(sealed.ciphertext).toString('hex')}`, plain_commitment: `0x${plainCommitment.toString('hex')}`, encryption: 'AES-256-GCM' };
      const keyId = await saveEnvelope(tx, p.tenantId, sealed);
      await tx.query("INSERT INTO artifacts(id,tenant_id,key_envelope_id,state,staging_ciphertext,public_manifest,crypto_version,cipher_sha256,manifest_sha256,plain_commitment,byte_size,sanitized_at,reviewed_by,reviewed_at) VALUES($1,$2,$3,'staged',$4,$5,1,$6,$7,$8,$9,now(),$10,now())", [artifactId, p.tenantId, keyId, sealed.ciphertext, manifest, sha256(sealed.ciphertext), sha256(canonical(manifest)), plainCommitment, sealed.ciphertext.length, p.userId]);
      await tx.query('INSERT INTO memories(id,tenant_id,project_id,created_by) VALUES($1,$2,$3,$4)', [memoryId, p.tenantId, value.project_id, p.userId]);
      await tx.query("INSERT INTO memory_revisions(memory_id,tenant_id,revision,artifact_id,schema_version,importance,valid_from,valid_to) VALUES($1,$2,1,$3,'1.0',$4,$5,$6)", [memoryId, p.tenantId, artifactId, value.importance, value.valid_from, value.valid_to ?? null]);
      const payload = { memory_id: memoryId, artifact_id: artifactId, project_id: value.project_id, revision: 1 };
      await tx.query("INSERT INTO jobs(id,tenant_id,requested_by,kind,idempotency_key,request_sha256,payload,state) VALUES($1,$2,$3,'upload',$4,$5,$6,'queued')", [jobId, p.tenantId, p.userId, value.idempotency_key, requestHash, payload]);
      await tx.query("INSERT INTO outbox(tenant_id,event_type,aggregate_id,payload,dedupe_key) VALUES($1,'memory.upload.requested',$2,$3,$4)", [p.tenantId, jobId, payload, `memory.upload:${jobId}`]);
      await tx.query("UPDATE approval_drafts SET state='consumed',consumed_at=now() WHERE id=$1", [row.id]);
      return { kind: 'success', job_id: jobId, memory_id: memoryId, state: 'queued', resource_uri: `memocean://jobs/${jobId}`, ready: false };
    });
  }
}
