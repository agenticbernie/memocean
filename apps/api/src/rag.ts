import { createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Config } from './config.js';
import { Database, authorizeProject, requireScope, reserveBudget, saveEnvelope, sealedFromRow, type Principal, type Tx } from './db.js';
import { ApiError, CryptoBox, canonical, digest, equal, scanText, sha256 } from './security.js';
import { recallSchema, queryCapsuleSchema, generatedAnswerSchema, uuid, timestamp, type RecallInput, type QueryCapsuleInput } from './schemas.js';
import type { EmbeddingProvider, GenerationProvider } from './providers.js';

export interface Citation { artifact_id: string; irys_tx_id: string; cipher_sha256: string; chunk_locator: string; excerpt_sha256: string; gateway_ciphertext_url: string; capsule_version_id: string | null }
export interface Evidence { chunk_id: string; text: string; importance: number; score: number; source: Citation }
export function evidenceFromRow(row: Record<string, any>): Evidence {
  const gateway = new URL(row.gateway_base_url as string);
  if (gateway.protocol !== 'https:' || gateway.username || gateway.password) throw new ApiError('EVIDENCE_INVALID', 'Invalid stored gateway', 409);
  const text = row.sanitized_text as string;
  if (!text || text.length > 2000) throw new ApiError('EVIDENCE_INVALID', 'Invalid indexed chunk', 409);
  return { chunk_id: row.id, text, importance: Number(row.importance ?? 0.5), score: Math.max(-1, Math.min(1, Number(row.similarity ?? 1))), source: { artifact_id: row.artifact_id, irys_tx_id: row.tx_id, cipher_sha256: `0x${(row.cipher_sha256 as Buffer).toString('hex')}`, chunk_locator: row.locator, excerpt_sha256: `0x${sha256(text).toString('hex')}`, gateway_ciphertext_url: `${gateway.origin}/${encodeURIComponent(row.tx_id)}`, capsule_version_id: row.capsule_version_id ?? null } };
}
export function groundAnswer(raw: unknown, evidence: Evidence[], maxChars = 6000) {
  const answer = generatedAnswerSchema.parse(raw);
  if (answer.abstained) {
    if (answer.claims.length) throw new ApiError('EVIDENCE_INVALID', 'Abstention must not contain factual claims', 502);
    return { answer: 'Not enough verified evidence to answer.', abstained: true, claims: [] };
  }
  if (!answer.claims.length) throw new ApiError('EVIDENCE_INVALID', 'An answer without cited claims is not accepted', 502);
  const byId = new Map(evidence.map((item) => [item.chunk_id, item]));
  const claims = answer.claims.map((claim) => ({ text: claim.text, citations: claim.chunk_ids.map((id) => {
    const item = byId.get(id);
    if (!item) throw new ApiError('EVIDENCE_INVALID', 'Generation cited a source outside the authorized retrieval evidence', 502);
    return item.source;
  }) }));
  const text = claims.map((claim) => claim.text).join('\n');
  scanText(text);
  if (text.length > maxChars) throw new ApiError('EVIDENCE_INVALID', 'Answer exceeds the reviewed preview output policy', 502);
  return { answer: text, abstained: false, claims };
}
interface Cursor { binding: string; expires: number; score: number; id: string; effectiveAt: string }
export class RagService {
  constructor(private readonly db: Database, private readonly embedder: EmbeddingProvider, private readonly model: GenerationProvider, private readonly box: CryptoBox, private readonly config: Config) {}
  private cursorKey(): string { if (!this.config.TOKEN_HASH_PEPPER) throw new ApiError('INTEGRATION_UNAVAILABLE', 'Cursor signing is not configured', 503); return this.config.TOKEN_HASH_PEPPER; }
  private cursorBinding(p: Principal, input: RecallInput): string { const { cursor: _, ...filters } = input; return digest({ user: p.userId, tenant: p.tenantId, filters }); }
  private encodeCursor(value: Cursor): string { const body = Buffer.from(canonical(value)).toString('base64url'); return `${body}.${createHmac('sha256', this.cursorKey()).update(body).digest('base64url')}`; }
  private decodeCursor(raw: string, binding: string): Cursor {
    const [body, signature, extra] = raw.split('.');
    if (!body || !signature || extra || !equal(createHmac('sha256', this.cursorKey()).update(body).digest(), Buffer.from(signature, 'base64url'))) throw new ApiError('INVALID_INPUT', 'Invalid or expired pagination cursor');
    try {
      const cursor = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Cursor;
      if (cursor.binding !== binding || cursor.expires <= Date.now() || !Number.isFinite(cursor.score) || !timestamp.safeParse(cursor.effectiveAt).success || !/^[0-9a-f-]{36}$/.test(cursor.id)) throw new Error('Invalid cursor');
      return cursor;
    } catch { throw new ApiError('INVALID_INPUT', 'Invalid or expired pagination cursor'); }
  }
  async recall(p: Principal, raw: unknown, signal?: AbortSignal) {
    requireScope(p, 'memory:read'); const input = recallSchema.parse(raw); scanText(input.query);
    // No embedding/model call occurs before live project ACL and token allowlist checks.
    await this.db.transaction(p, async (tx) => authorizeProject(tx, p, input.project_id));
    const cursor = input.cursor ? this.decodeCursor(input.cursor, this.cursorBinding(p, input)) : null;
    const effectiveAt = input.effective_at ?? cursor?.effectiveAt ?? new Date().toISOString();
    const vector = (await this.embedder.embed([input.query], 'query', signal))[0]!;
    const items = await this.db.transaction(p, async (tx) => {
      await authorizeProject(tx, p, input.project_id);
      const result = await tx.query(`WITH authorized AS MATERIALIZED (
        SELECT c.id,c.locator,c.sanitized_text,c.embedding,r.importance,a.id AS artifact_id,a.cipher_sha256,tx.tx_id,tx.gateway_base_url,NULL::uuid AS capsule_version_id
        FROM memory_chunks c JOIN memory_revisions r ON r.id=c.revision_id AND r.tenant_id=c.tenant_id JOIN memories m ON m.id=r.memory_id AND m.tenant_id=r.tenant_id JOIN artifacts a ON a.id=r.artifact_id AND a.tenant_id=r.tenant_id JOIN irys_transactions tx ON tx.artifact_id=a.id
        WHERE c.tenant_id=$1 AND c.embedding_model=$10 AND m.project_id=$2 AND app_project(m.project_id,m.tenant_id) AND m.archived_at IS NULL AND a.state='indexed' AND tx.verified_at IS NOT NULL AND tx.verified_cipher_sha256=a.cipher_sha256 AND tx.verified_manifest_sha256=a.manifest_sha256
        AND r.valid_from<=$4::timestamptz AND (r.valid_to IS NULL OR r.valid_to>$4::timestamptz) AND ($5::timestamptz IS NULL OR r.created_at>=$5) AND ($6::timestamptz IS NULL OR r.created_at<$6)
        UNION ALL
        SELECT c.id,c.locator,c.sanitized_text,c.embedding,0.5::numeric,a.id,a.cipher_sha256,tx.tx_id,tx.gateway_base_url,v.id
        FROM project_capsules pc JOIN entitlements e ON e.id=pc.entitlement_id AND e.user_id=pc.user_id AND e.capsule_version_id=pc.capsule_version_id JOIN capsule_versions v ON v.id=pc.capsule_version_id JOIN capsule_chunks c ON c.capsule_version_id=v.id JOIN artifacts a ON a.id=v.artifact_id JOIN irys_transactions tx ON tx.artifact_id=a.id
        WHERE pc.tenant_id=$1 AND c.embedding_model=$10 AND pc.project_id=$2 AND pc.user_id=$3 AND e.user_id=$3 AND app_entitled(v.id) AND a.state='indexed' AND tx.verified_at IS NOT NULL AND tx.permanence_verified AND tx.verified_cipher_sha256=a.cipher_sha256 AND tx.verified_manifest_sha256=a.manifest_sha256 AND v.review_state='approved'
        AND v.created_at<=$4::timestamptz AND ($5::timestamptz IS NULL OR v.created_at>=$5) AND ($6::timestamptz IS NULL OR v.created_at<$6)
      ), ranked AS (SELECT *,1-(embedding<=>$7::vector) AS similarity FROM authorized)
      SELECT * FROM ranked WHERE similarity>=0.25 AND ($8::double precision IS NULL OR similarity<$8 OR (similarity=$8 AND id>$9::uuid)) ORDER BY similarity DESC,id ASC LIMIT $11`, [p.tenantId, input.project_id, p.userId, effectiveAt, input.created_from ?? null, input.created_to ?? null, `[${vector.join(',')}]`, cursor?.score ?? null, cursor?.id ?? null, this.config.EMBEDDING_MODEL, input.limit + 1]);
      return result.rows.map(evidenceFromRow);
    });
    const more = items.length > input.limit; const page = items.slice(0, input.limit), last = page.at(-1);
    return { kind: 'success', items: page, next_cursor: more && last ? this.encodeCursor({ binding: this.cursorBinding(p, input), expires: Date.now() + 15 * 60000, score: last.score, id: last.chunk_id, effectiveAt }) : null };
  }
  async chat(p: Principal, raw: unknown, signal?: AbortSignal) {
    requireScope(p, 'memory:read');
    const value = z.object({ project_id: uuid, question: z.string().min(1).max(2000), created_from: timestamp.optional(), created_to: timestamp.optional(), effective_at: timestamp.optional() }).strict().parse(raw);
    const retrieved = await this.recall(p, { project_id: value.project_id, query: value.question, ...(value.created_from ? { created_from: value.created_from } : {}), ...(value.created_to ? { created_to: value.created_to } : {}), ...(value.effective_at ? { effective_at: value.effective_at } : {}), limit: 12 }, signal);
    let answer: ReturnType<typeof groundAnswer>;
    if (!retrieved.items.length) answer = { answer: 'Not enough verified evidence to answer.', abstained: true, claims: [] };
    else {
      if (!this.model.configured) throw new ApiError('INTEGRATION_UNAVAILABLE', 'Generation is not configured', 503);
      await this.db.transaction(p, async (tx) => { await authorizeProject(tx, p, value.project_id); await reserveBudget(tx, p, this.config); });
      answer = groundAnswer(await this.model.answer(value.question, retrieved.items.map((item) => ({ chunk_id: item.chunk_id, text: item.text })), signal), retrieved.items);
    }
    return this.db.transaction(p, async (tx) => {
      await authorizeProject(tx, p, value.project_id);
      for (const item of retrieved.items) {
        const permitted = item.source.capsule_version_id
          ? (await tx.query('SELECT 1 FROM project_capsules pc WHERE pc.project_id=$1 AND pc.user_id=$2 AND pc.capsule_version_id=$3 AND app_entitled(pc.capsule_version_id)', [value.project_id, p.userId, item.source.capsule_version_id])).rowCount
          : (await tx.query("SELECT 1 FROM memory_chunks c JOIN memory_revisions r ON r.id=c.revision_id JOIN memories m ON m.id=r.memory_id JOIN artifacts a ON a.id=r.artifact_id WHERE c.id=$1 AND m.project_id=$2 AND m.tenant_id=$3 AND a.state='indexed' AND m.archived_at IS NULL", [item.chunk_id, value.project_id, p.tenantId])).rowCount;
        if (!permitted) throw new ApiError('FORBIDDEN', 'Evidence authorization changed before answer delivery', 403);
      }
      const id = (await tx.query('INSERT INTO chat_answers(tenant_id,user_id,project_id,answer_text,abstained) VALUES($1,$2,$3,$4,$5) RETURNING id', [p.tenantId, p.userId, value.project_id, answer.answer, answer.abstained])).rows[0]!.id;
      let ordinal = 0;
      for (const claim of answer.claims) for (const source of claim.citations) await tx.query('INSERT INTO answer_citations(answer_id,ordinal,irys_tx_id,artifact_id,chunk_locator,excerpt_sha256) VALUES($1,$2,$3,$4,$5,$6)', [id, ordinal++, source.irys_tx_id, source.artifact_id, source.chunk_locator, Buffer.from(source.excerpt_sha256.slice(2), 'hex')]);
      return { kind: 'success', answer_id: id, ...answer };
    });
  }
  private async capsuleEvidence(tx: Tx, p: Principal, input: QueryCapsuleInput): Promise<{ items: Evidence[]; maxChars: number }> {
    await authorizeProject(tx, p, input.project_id);
    const version = (await tx.query("SELECT id,root_id FROM capsule_versions WHERE id=$1 AND root_id=$2 AND review_state='approved'", [input.capsule_version_id, input.capsule_root_id])).rows[0];
    if (!version) throw new ApiError('NOT_FOUND', 'Capsule version not found', 404);
    if (input.mode === 'purchased') {
      const access = (await tx.query('SELECT app_entitled($1) AS allowed', [input.capsule_version_id])).rows[0]?.allowed;
      if (!access) throw new ApiError('FORBIDDEN', 'A fresh confirmed buyer-specific entitlement for this exact version is required', 403);
      const result = await tx.query("SELECT c.*,a.id AS artifact_id,a.cipher_sha256,tx.tx_id,tx.gateway_base_url,v.id AS capsule_version_id FROM capsule_chunks c JOIN capsule_versions v ON v.id=c.capsule_version_id JOIN artifacts a ON a.id=v.artifact_id JOIN irys_transactions tx ON tx.artifact_id=a.id WHERE c.capsule_version_id=$1 AND c.embedding_model=$2 AND app_entitled(v.id) AND a.state='indexed' AND tx.verified_at IS NOT NULL AND tx.permanence_verified AND tx.verified_cipher_sha256=a.cipher_sha256 AND tx.verified_manifest_sha256=a.manifest_sha256 ORDER BY c.ordinal LIMIT 12", [input.capsule_version_id, this.config.EMBEDDING_MODEL]);
      return { items: result.rows.map(evidenceFromRow), maxChars: 6000 };
    }
    // This query cannot read capsule_chunks or the paid artifact: only the independently approved derivative.
    const row = (await tx.query("SELECT cp.*,a.cipher_sha256,a.indexed_payload_sha256,tx.tx_id,tx.gateway_base_url FROM capsule_previews cp JOIN artifacts a ON a.id=cp.artifact_id JOIN irys_transactions tx ON tx.artifact_id=a.id JOIN capsule_versions v ON v.id=cp.capsule_version_id WHERE cp.capsule_version_id=$1 AND a.id<>v.artifact_id AND a.state='indexed' AND tx.verified_at IS NOT NULL AND tx.permanence_verified AND tx.verified_cipher_sha256=a.cipher_sha256 AND tx.verified_manifest_sha256=a.manifest_sha256", [input.capsule_version_id])).rows[0];
    if (!row) throw new ApiError('NOT_READY', 'An independently verified safe preview is not available', 409);
    if (!row.indexed_payload_sha256 || !equal(row.safe_content_sha256, row.indexed_payload_sha256) || !equal(sha256(canonical(row.safe_content)), row.safe_content_sha256)) throw new ApiError('EVIDENCE_INVALID', 'Safe preview content hash does not match its verified decrypted artifact', 409);
    const preview = canonical(row.safe_content); scanText(preview);
    const leaves: Array<{ pointer: string; text: string }> = [];
    const walk = (value: unknown, pointer: string): void => {
      if (typeof value === 'string') { if (value) leaves.push({ pointer: pointer || '', text: value }); }
      else if (Array.isArray(value)) value.forEach((item, i) => walk(item, `${pointer}/${i}`));
      else if (value && typeof value === 'object') for (const key of Object.keys(value).sort()) walk((value as Record<string, unknown>)[key], `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`);
    };
    walk(row.safe_content, '');
    const items: Evidence[] = [];
    for (const leaf of leaves) for (let start = 0; start < leaf.text.length && items.length < 12; start += 1800) {
      const locator = `${leaf.pointer}#utf16=${start}:${Math.min(start + 1800, leaf.text.length)}`;
      if (locator.length > 256) throw new ApiError('EVIDENCE_INVALID', 'Safe preview locator exceeds the source policy', 409);
      const hash = sha256(`${row.artifact_id}:${locator}`); hash[6] = (hash[6]! & 15) | 64; hash[8] = (hash[8]! & 63) | 128;
      const hex = hash.toString('hex').slice(0, 32); const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      items.push(evidenceFromRow({ ...row, id, sanitized_text: leaf.text.slice(start, start + 1800), locator, capsule_version_id: input.capsule_version_id }));
    }
    return { items, maxChars: Math.min(row.max_output_chars, 1200) };
  }
  async query(p: Principal, raw: unknown, signal?: AbortSignal) {
    requireScope(p, 'capsule:query'); const input = queryCapsuleSchema.parse(raw); scanText(input.question);
    const fullHash = sha256(canonical(input));
    const reservation = await this.db.transaction(p, async (tx) => {
      const evidence = await this.capsuleEvidence(tx, p, input);
      if (input.mode === 'trial') {
        await tx.query('INSERT INTO trial_counters(user_id,capsule_root_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [p.userId, input.capsule_root_id]);
        const counter = (await tx.query('SELECT used_count FROM trial_counters WHERE user_id=$1 AND capsule_root_id=$2 FOR UPDATE', [p.userId, input.capsule_root_id])).rows[0]!;
        const old = (await tx.query('SELECT a.*,k.kek_version,k.wrapped_dek,k.wrapping_nonce,k.wrapping_tag FROM trial_attempts a LEFT JOIN key_envelopes k ON k.id=a.response_key_envelope_id WHERE a.user_id=$1 AND a.capsule_root_id=$2 AND a.idempotency_key=$3 FOR UPDATE OF a', [p.userId, input.capsule_root_id, input.idempotency_key])).rows[0];
        if (old) {
          // Preserve idempotency conflict semantics before performing any state recovery.
          if (!equal(old.request_sha256, fullHash)) return { old, remaining: 3 - counter.used_count, evidence };
          // A reserved attempt has not reached the dispatch claim. Recover it here as well as in
          // the optional worker so retries cannot remain NOT_READY when no worker is running.
          if (old.state === 'reserved') {
            const refunded = await tx.query("UPDATE trial_attempts SET state='refunded' WHERE id=$1 AND state='reserved' AND created_at<now()-interval '5 minutes' RETURNING id", [old.id]);
            if (refunded.rowCount) {
              await tx.query('UPDATE trial_counters SET used_count=used_count-1 WHERE user_id=$1 AND capsule_root_id=$2 AND used_count>0', [p.userId, input.capsule_root_id]);
              old.state = 'refunded';
            }
          } else if (old.state === 'running') {
            // A running lease may have reached the provider. It remains charged and is never replayed.
            const failed = await tx.query("UPDATE trial_attempts SET state='failed_charged',lease_until=NULL WHERE id=$1 AND state='running' AND lease_until<now() RETURNING id", [old.id]);
            if (failed.rowCount) old.state = 'failed_charged';
          }
          return { old, remaining: 3 - counter.used_count, evidence };
        }
        if (counter.used_count >= 3) throw new ApiError('TRIAL_EXHAUSTED', 'The three lifetime questions for this user and capsule root are exhausted', 429);
        if (!this.model.configured) throw new ApiError('INTEGRATION_UNAVAILABLE', 'Generation is not configured; no trial was charged', 503);
        await reserveBudget(tx, p, this.config);
        await tx.query('UPDATE trial_counters SET used_count=used_count+1 WHERE user_id=$1 AND capsule_root_id=$2 AND used_count<3', [p.userId, input.capsule_root_id]);
        const row = (await tx.query("INSERT INTO trial_attempts(user_id,capsule_root_id,capsule_version_id,idempotency_key,request_sha256,state,tenant_id,project_id) VALUES($1,$2,$3,$4,$5,'reserved',$6,$7) RETURNING *", [p.userId, input.capsule_root_id, input.capsule_version_id, input.idempotency_key, fullHash, p.tenantId, input.project_id])).rows[0]!;
        return { old: null, row, remaining: 2 - counter.used_count, evidence };
      }
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`paid:${p.userId}:${input.capsule_version_id}:${input.idempotency_key}`]);
      const old = (await tx.query('SELECT a.*,k.kek_version,k.wrapped_dek,k.wrapping_nonce,k.wrapping_tag FROM paid_query_attempts a LEFT JOIN key_envelopes k ON k.id=a.response_key_envelope_id WHERE a.user_id=$1 AND a.capsule_version_id=$2 AND a.idempotency_key=$3 FOR UPDATE OF a', [p.userId, input.capsule_version_id, input.idempotency_key])).rows[0];
      if (old) {
        // Preserve idempotency conflict semantics before performing any state recovery.
        if (!equal(old.request_sha256, fullHash)) return { old, remaining: null, evidence };
        // The advisory lock fences retries for this key. A stale reservation was never claimed for
        // dispatch, while an expired running lease may have reached the provider and is fail-closed.
        if (old.state === 'reserved') {
          const failed = await tx.query("UPDATE paid_query_attempts SET state='failed',lease_until=NULL WHERE id=$1 AND state='reserved' AND created_at<now()-interval '5 minutes' RETURNING id", [old.id]);
          if (failed.rowCount) old.state = 'failed';
        } else if (old.state === 'running') {
          const failed = await tx.query("UPDATE paid_query_attempts SET state='failed',lease_until=NULL WHERE id=$1 AND state='running' AND lease_until<now() RETURNING id", [old.id]);
          if (failed.rowCount) old.state = 'failed';
        }
        return { old, remaining: null, evidence };
      }
      if (!this.model.configured) throw new ApiError('INTEGRATION_UNAVAILABLE', 'Generation is not configured', 503);
      await reserveBudget(tx, p, this.config);
      const row = (await tx.query("INSERT INTO paid_query_attempts(tenant_id,project_id,user_id,capsule_version_id,idempotency_key,request_sha256,state) VALUES($1,$2,$3,$4,$5,$6,'reserved') RETURNING *", [p.tenantId, input.project_id, p.userId, input.capsule_version_id, input.idempotency_key, fullHash])).rows[0]!;
      return { old: null, row, remaining: null, evidence };
    });
    const table = input.mode === 'trial' ? 'trial_attempts' : 'paid_query_attempts';
    if (reservation.old) {
      const old = reservation.old;
      if (!equal(old.request_sha256, fullHash)) throw new ApiError('IDEMPOTENCY_CONFLICT', 'This idempotency key belongs to a different full request', 409);
      if (old.state === 'succeeded') return this.box.open(sealedFromRow(old, 'response_ciphertext'), `answer:${p.tenantId}:${p.userId}:${old.id}:v1`);
      if (old.state === 'refunded') throw new ApiError('UPSTREAM_UNAVAILABLE', 'This attempt was cancelled before dispatch and refunded. A deliberate new request needs a new idempotency key.', 503, false);
      if (['failed', 'failed_charged'].includes(old.state)) throw new ApiError('UPSTREAM_UNAVAILABLE', input.mode === 'trial' ? 'This attempt may have reached model dispatch and remains charged; it will not be inferred again' : 'This attempt is terminal and will not be inferred again; use a new idempotency key for a deliberate request', 503, false);
      throw new ApiError('NOT_READY', 'This operation is reserved or running. Retry the same key; do not create another request.', 409, true, old.id, input.mode === 'trial' ? `memocean://trials/${old.id}` : null);
    }
    const row = reservation.row!; const lease = randomUUID();
    try {
      await this.db.transaction(p, async (tx) => {
        await this.capsuleEvidence(tx, p, input); // Authorization is live at dispatch, not just at reservation.
        const claim = await tx.query(`UPDATE ${table} SET state='running',lease_token=$2,lease_until=now()+interval '60 seconds' WHERE id=$1 AND state='reserved' RETURNING id`, [row.id, lease]);
        if (!claim.rowCount) throw new ApiError('NOT_READY', 'Attempt was already claimed', 409);
      });
    } catch (error) {
      // This code path is known not to have invoked inference. Refund only a still-reserved row,
      // under the same lifetime counter lock, exactly once. Running attempts are never refunded.
      if (input.mode === 'trial') await this.db.transaction(p, async (tx) => {
        await tx.query('SELECT used_count FROM trial_counters WHERE user_id=$1 AND capsule_root_id=$2 FOR UPDATE', [p.userId, input.capsule_root_id]);
        const refunded = await tx.query("UPDATE trial_attempts SET state='refunded' WHERE id=$1 AND user_id=$2 AND state='reserved' RETURNING id", [row.id, p.userId]);
        if (refunded.rowCount) await tx.query('UPDATE trial_counters SET used_count=used_count-1 WHERE user_id=$1 AND capsule_root_id=$2 AND used_count>0', [p.userId, input.capsule_root_id]);
      }).catch(() => undefined);
      throw error;
    }
    try {
      const grounded = reservation.evidence.items.length ? groundAnswer(await this.model.answer(input.question, reservation.evidence.items.map((e) => ({ chunk_id: e.chunk_id, text: e.text })), signal), reservation.evidence.items, reservation.evidence.maxChars) : { answer: 'Not enough verified evidence to answer.', abstained: true, claims: [] };
      const answer = { kind: 'success', capsule_version_id: input.capsule_version_id, mode: input.mode, ...grounded, trial_attempt_id: input.mode === 'trial' ? row.id : null, trials_remaining: reservation.remaining, quota_state: input.mode === 'trial' ? 'succeeded' : 'not_applicable' };
      const sealed = this.box.seal(answer, `answer:${p.tenantId}:${p.userId}:${row.id}:v1`);
      await this.db.transaction(p, async (tx) => {
        await this.capsuleEvidence(tx, p, input);
        const keyId = await saveEnvelope(tx, p.tenantId, sealed);
        const result = await tx.query(`UPDATE ${table} SET state='succeeded',response_ciphertext=$3,response_key_envelope_id=$4,lease_until=NULL WHERE id=$1 AND lease_token=$2 AND state='running' AND lease_until>now() RETURNING id`, [row.id, lease, sealed.ciphertext, keyId]);
        if (!result.rowCount) throw new ApiError('NOT_READY', 'Attempt lease expired; response was not delivered', 409);
      });
      // No answer bytes are delivered until the encrypted response is durably committed.
      return answer;
    } catch (error) {
      await this.db.transaction(p, async (tx) => { await tx.query(`UPDATE ${table} SET state=$3,lease_until=NULL WHERE id=$1 AND lease_token=$2 AND state='running'`, [row.id, lease, input.mode === 'trial' ? 'failed_charged' : 'failed']); }).catch(() => undefined);
      throw error;
    }
  }
}
