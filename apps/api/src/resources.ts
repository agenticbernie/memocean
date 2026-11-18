import { createHmac } from 'node:crypto';
import type { Config } from './config.js';
import { Database, authorizeProject, requireScope, sealedFromRow, type Principal } from './db.js';
import { ApiError, CryptoBox, equal } from './security.js';
import { provenanceSchema, uuid } from './schemas.js';
import { evidenceFromRow } from './rag.js';
import type { StorageProvider } from './providers.js';

export class ResourceService {
  constructor(private readonly db: Database, private readonly box: CryptoBox, private readonly storage: StorageProvider, private readonly config: Config) {}
  async projects(p: Principal) {
    return this.db.transaction(p, async (tx) => {
      const result = await tx.query('SELECT p.id,p.name,p.created_at FROM projects p JOIN project_acl a ON a.project_id=p.id AND a.tenant_id=p.tenant_id WHERE p.tenant_id=$1 AND a.user_id=$2 AND ($3::uuid[]=\'{}\' OR p.id=ANY($3)) ORDER BY p.created_at,p.id LIMIT 100', [p.tenantId, p.userId, p.projectIds]);
      return { items: result.rows };
    });
  }
  async list(p: Principal, rawCursor?: string) {
    const key = this.config.TOKEN_HASH_PEPPER;
    if (!key) throw new ApiError('INTEGRATION_UNAVAILABLE', 'Cursor signing is not configured', 503);
    let after: { created_at: string; id: string } | null = null;
    if (rawCursor) {
      const [body, sig, extra] = rawCursor.split('.');
      if (!body || !sig || extra || !equal(Buffer.from(sig, 'base64url'), createHmac('sha256', key).update(body).digest())) throw new ApiError('INVALID_INPUT', 'Invalid resource cursor');
      try {
        const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        if (parsed.user !== p.userId || parsed.tenant !== p.tenantId || parsed.expires < Date.now() || typeof parsed.created_at !== 'string' || !uuid.safeParse(parsed.id).success) throw new Error('Invalid');
        after = parsed;
      } catch { throw new ApiError('INVALID_INPUT', 'Invalid resource cursor'); }
    }
    if (!p.scopes.includes('memory:read')) return { resources: [] };
    return this.db.transaction(p, async (tx) => {
      const rows = (await tx.query('SELECT p.id,p.name,p.created_at FROM projects p JOIN project_acl a ON a.project_id=p.id AND a.tenant_id=p.tenant_id WHERE p.tenant_id=$1 AND a.user_id=$2 AND ($3::uuid[]=\'{}\' OR p.id=ANY($3)) AND ($4::timestamptz IS NULL OR (p.created_at,p.id)>($4::timestamptz,$5::uuid)) ORDER BY p.created_at,p.id LIMIT 51', [p.tenantId, p.userId, p.projectIds, after?.created_at ?? null, after?.id ?? null])).rows;
      const page = rows.slice(0, 50), last = page.at(-1);
      const body = rows.length > 50 && last ? Buffer.from(JSON.stringify({ user: p.userId, tenant: p.tenantId, expires: Date.now() + 900000, created_at: last.created_at, id: last.id })).toString('base64url') : null;
      return { resources: page.map((row) => ({ uri: `memocean://projects/${row.id}/rules`, name: row.name, mimeType: 'application/json' })), ...(body ? { nextCursor: `${body}.${createHmac('sha256', key).update(body).digest('base64url')}` } : {}) };
    });
  }
  async job(p: Principal, id: string) {
    requireScope(p, 'memory:read'); uuid.parse(id);
    return this.db.transaction(p, async (tx) => {
      const row = (await tx.query("SELECT j.*,a.state AS artifact_state,tx.verified_at FROM jobs j JOIN artifacts a ON a.id=(j.payload->>'artifact_id')::uuid AND a.tenant_id=j.tenant_id LEFT JOIN irys_transactions tx ON tx.artifact_id=a.id WHERE j.id=$1 AND j.tenant_id=$2 AND j.requested_by=$3", [id, p.tenantId, p.userId])).rows[0];
      if (!row) throw new ApiError('NOT_FOUND', 'Operation not found', 404);
      await authorizeProject(tx, p, row.payload.project_id);
      const ready = row.state === 'succeeded' && row.artifact_state === 'indexed' && Boolean(row.verified_at);
      const sources = ready ? (await tx.query('SELECT c.*,a.id AS artifact_id,a.cipher_sha256,tx.tx_id,tx.gateway_base_url FROM memory_chunks c JOIN memory_revisions r ON r.id=c.revision_id JOIN artifacts a ON a.id=r.artifact_id JOIN irys_transactions tx ON tx.artifact_id=a.id WHERE a.id=$1 AND a.state=\'indexed\' AND tx.verified_at IS NOT NULL ORDER BY c.ordinal LIMIT 50', [row.payload.artifact_id])).rows.map((r) => evidenceFromRow(r).source) : [];
      return { uri: `memocean://jobs/${id}`, generated_at: new Date().toISOString(), kind: 'job', job_id: id, state: row.state, artifact_state: row.artifact_state, ready, sources, error_code: row.last_error ?? null };
    });
  }
  async read(p: Principal, uri: string) {
    const match = /^memocean:\/\/(projects|capsules|jobs|trials)\/([0-9a-fA-F-]{36})(\/rules)?$/.exec(uri);
    if (!match || !uuid.safeParse(match[2]).success || (match[1] === 'projects') !== (match[3] === '/rules')) throw new ApiError('INVALID_INPUT', 'Invalid resource URI');
    const id = match[2]!;
    if (match[1] === 'jobs') return this.job(p, id);
    return this.db.transaction(p, async (tx) => {
      if (match[1] === 'projects') {
        requireScope(p, 'memory:read'); await authorizeProject(tx, p, id);
        const result = await tx.query("SELECT c.*,a.id AS artifact_id,a.cipher_sha256,tx.tx_id,tx.gateway_base_url FROM memory_chunks c JOIN memory_revisions r ON r.id=c.revision_id AND r.tenant_id=c.tenant_id JOIN memories m ON m.id=r.memory_id AND m.tenant_id=r.tenant_id JOIN artifacts a ON a.id=r.artifact_id JOIN irys_transactions tx ON tx.artifact_id=a.id WHERE m.project_id=$1 AND m.tenant_id=$2 AND m.archived_at IS NULL AND r.valid_from<=now() AND (r.valid_to IS NULL OR r.valid_to>now()) AND a.state='indexed' AND tx.verified_at IS NOT NULL AND tx.verified_cipher_sha256=a.cipher_sha256 AND tx.verified_manifest_sha256=a.manifest_sha256 ORDER BY c.created_at,c.id LIMIT 51", [id, p.tenantId]);
        if (result.rows.length > 50) throw new ApiError('NOT_READY', 'Project contains more than 50 chunks; use paginated recall to select a bounded rules snapshot', 409);
        return { uri, generated_at: new Date().toISOString(), kind: 'rules', project_id: id, items: result.rows.map((r) => { const e = evidenceFromRow(r); return { id: e.chunk_id, text: e.text, source: e.source }; }), next_cursor: null };
      }
      if (match[1] === 'capsules') {
        requireScope(p, 'capsule:query');
        if (p.projectIds.length) {
          const scoped = await tx.query('SELECT 1 FROM project_capsules WHERE user_id=$1 AND capsule_version_id=$2 AND project_id=ANY($3) LIMIT 1', [p.userId, id, p.projectIds]);
          if (!scoped.rowCount) throw new ApiError('NOT_FOUND', 'Resource not found', 404);
        }
        const access = (await tx.query('SELECT v.license_spdx_or_custom FROM capsule_versions v WHERE v.id=$1 AND (app_entitled(v.id) OR app_member(v.owner_tenant_id))', [id])).rows[0];
        if (!access) throw new ApiError('NOT_FOUND', 'Resource not found', 404);
        const result = await tx.query("SELECT c.*,a.id AS artifact_id,a.cipher_sha256,tx.tx_id,tx.gateway_base_url FROM capsule_chunks c JOIN capsule_versions v ON v.id=c.capsule_version_id JOIN artifacts a ON a.id=v.artifact_id JOIN irys_transactions tx ON tx.artifact_id=a.id WHERE c.capsule_version_id=$1 AND a.state='indexed' AND tx.verified_at IS NOT NULL AND tx.permanence_verified ORDER BY c.ordinal LIMIT 51", [id]);
        if (result.rows.length > 50) throw new ApiError('NOT_READY', 'Use query_capsule for this version; the corpus exceeds the bounded resource snapshot', 409);
        return { uri, generated_at: new Date().toISOString(), kind: 'capsule', capsule_version_id: id, license: access.license_spdx_or_custom, items: result.rows.map((r) => { const e = evidenceFromRow(r); return { id: e.chunk_id, text: e.text, source: e.source }; }), next_cursor: null };
      }
      requireScope(p, 'capsule:query');
      const row = (await tx.query('SELECT a.*,tc.used_count,k.kek_version,k.wrapped_dek,k.wrapping_nonce,k.wrapping_tag FROM trial_attempts a JOIN trial_counters tc ON tc.user_id=a.user_id AND tc.capsule_root_id=a.capsule_root_id LEFT JOIN key_envelopes k ON k.id=a.response_key_envelope_id WHERE a.id=$1 AND a.user_id=$2', [id, p.userId])).rows[0];
      if (!row || row.tenant_id !== p.tenantId) throw new ApiError('NOT_FOUND', 'Resource not found', 404);
      await authorizeProject(tx, p, row.project_id);
      const answer = row.state === 'succeeded' ? this.box.open<{ answer: string; claims: Array<{ citations: unknown[] }> }>(sealedFromRow(row, 'response_ciphertext'), `answer:${p.tenantId}:${p.userId}:${id}:v1`) : null;
      return { uri, generated_at: new Date().toISOString(), kind: 'trial', attempt_id: id, state: row.state, trials_remaining: 3 - row.used_count, answer: answer?.answer ?? null, sources: answer?.claims.flatMap((claim) => claim.citations) ?? [] };
    });
  }
  async provenance(p: Principal, raw: unknown) {
    requireScope(p, 'provenance:read'); const input = provenanceSchema.parse(raw);
    const row = await this.db.transaction(p, async (tx) => {
      // RLS is necessary but not sufficient: private artifacts additionally require this token's project scope.
      const row = (await tx.query('SELECT a.*,tx.tx_id,tx.verified_at,tx.gateway_base_url,tx.permanence_verified FROM artifacts a JOIN irys_transactions tx ON tx.artifact_id=a.id WHERE a.id=$1', [input.artifact_id])).rows[0];
      if (!row) throw new ApiError('NOT_FOUND', 'Artifact not found', 404);
      const privateRevision = (await tx.query('SELECT m.project_id FROM memory_revisions r JOIN memories m ON m.id=r.memory_id WHERE r.artifact_id=$1', [input.artifact_id])).rows[0];
      if (privateRevision) await authorizeProject(tx, p, privateRevision.project_id);
      else if (p.projectIds.length) {
        const mapping = await tx.query('SELECT 1 FROM project_capsules pc JOIN capsule_versions cv ON cv.id=pc.capsule_version_id WHERE cv.artifact_id=$1 AND pc.user_id=$2 AND pc.project_id=ANY($3) LIMIT 1', [input.artifact_id, p.userId, p.projectIds]);
        if (!mapping.rowCount) throw new ApiError('NOT_FOUND', 'Artifact not found', 404);
      }
      if (input.capsule_version_id) {
        const version = await tx.query('SELECT 1 FROM capsule_versions v LEFT JOIN capsule_previews cp ON cp.capsule_version_id=v.id WHERE v.id=$1 AND (v.artifact_id=$2 OR cp.artifact_id=$2)', [input.capsule_version_id, input.artifact_id]);
        if (!version.rowCount) throw new ApiError('NOT_FOUND', 'Artifact/version mapping not found', 404);
      }
      return row;
    });
    let storageStatus = row.verified_at && ['verified', 'indexed'].includes(row.state) ? 'verified' : 'unverified';
    if (input.refresh) {
      try { await this.storage.fetchVerified(row.tx_id, row.cipher_sha256, row.gateway_base_url); } catch (error) { storageStatus = error instanceof ApiError && error.code === 'EVIDENCE_INVALID' ? 'mismatch' : 'unavailable'; }
    }
    return { kind: 'success', artifact_id: row.id, irys_tx_id: row.tx_id, cipher_sha256: `0x${row.cipher_sha256.toString('hex')}`, storage_status: storageStatus, chain_status: input.capsule_version_id ? 'unavailable' : 'not_applicable', checked_at: new Date().toISOString(), limitations: ['Hashes and storage evidence do not verify factual truth, copyright or legal ownership.', 'Gateway URLs expose ciphertext, not publicly readable plaintext.', row.permanence_verified ? 'Permanence evidence was recorded by the configured verifier; current availability is not an uptime guarantee.' : 'Permanent storage has not been established for this artifact.'] };
  }
}
