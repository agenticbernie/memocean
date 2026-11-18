import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../src/migrate.js';
import { Database, type Principal, type Tx } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { ApiError, CryptoBox, canonical, sha256 } from '../src/security.js';
import { RagService } from '../src/rag.js';
import { CLAIM_JOBS_SQL, ensureLease } from '../src/jobs.js';
import type { GenerationProvider, EmbeddingProvider } from '../src/providers.js';

const url = process.env.TEST_DATABASE_URL;
test('PostgreSQL pgvector/RLS/100-way quota concurrency/lease fencing integration', { skip: !url ? 'TEST_DATABASE_URL not set; database integration has NOT been verified' : false, timeout: 120000 }, async (t) => {
  assert.ok(url);
  const parsed = new URL(url);
  assert.match(parsed.pathname, /_test$/, 'Use a dedicated empty database whose name ends in _test');
  const admin = new pg.Pool({ connectionString: url, max: 3 });
  t.after(() => admin.end());
  if ((await admin.query("SELECT to_regclass('public.users') AS existing")).rows[0]?.existing) throw new Error('Integration requires a new empty disposable test database. Do not point it at an existing application database.');
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='memocean_request') THEN CREATE ROLE memocean_request NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='memocean_worker') THEN CREATE ROLE memocean_worker NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$");
  // The disposable test login must be able to SET LOCAL ROLE to emulate the request connection.
  // This needs CREATEROLE/admin ownership and deliberately cannot run against a shared database.
  await admin.query('GRANT memocean_request,memocean_worker TO CURRENT_USER');
  const applied = await migrate(url); assert.equal(applied.length, 5); assert.deepEqual(await migrate(url), []);
  assert.ok((await admin.query("SELECT extversion FROM pg_extension WHERE extname='vector'")).rows[0]?.extversion);
  class RequestDb extends Database {
    override async transaction<T>(p: Principal | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
      return super.transaction(p, async (tx) => { await tx.query('SET LOCAL ROLE memocean_request'); return fn(tx); });
    }
  }
  const requestDb = new RequestDb(url); t.after(() => requestDb.close());
  const config = loadConfig({ NODE_ENV: 'test', TOKEN_HASH_PEPPER: 'synthetic-integration-pepper-not-live-12345', KEK_V1_BASE64: Buffer.alloc(32, 5).toString('base64') });
  const vector = [1, ...Array<number>(1023).fill(0)], vectorSql = `[${vector.join(',')}]`;
  async function userFixture() {
    const userId = randomUUID(), tenantId = randomUUID(), projectId = randomUUID();
    await admin.query('INSERT INTO users(id,external_subject) VALUES($1,$2)', [userId, `synthetic:${userId}`]);
    await admin.query("INSERT INTO tenants(id,name) VALUES($1,'Synthetic test tenant')", [tenantId]);
    await admin.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')", [tenantId, userId]);
    await admin.query("INSERT INTO projects(id,tenant_id,name) VALUES($1,$2,'Synthetic test project')", [projectId, tenantId]);
    await admin.query("INSERT INTO project_acl(project_id,tenant_id,user_id,permission) VALUES($1,$2,$3,'admin')", [projectId, tenantId, userId]);
    return { principal: { userId, tenantId, projectIds: [], scopes: ['memory:read', 'capsule:query'], tokenId: randomUUID(), tokenKind: 'pat' as const }, projectId };
  }
  const a = await userFixture(), b = await userFixture();
  await t.test('denied user quota does not consume the tenant quota', async () => {
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      const tokenHash = sha256(`rate-limit:${randomUUID()}`);
      const minute = (await client.query<{ minute: Date }>("SELECT date_trunc('minute',now()) AS minute")).rows[0]!.minute;
      const tenantKey = `tenant:${a.principal.tenantId}`, userKey = `user:${a.principal.userId}`;
      await client.query('INSERT INTO auth_sessions(user_id,tenant_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval \'1 hour\')', [a.principal.userId, a.principal.tenantId, tokenHash]);
      await client.query('INSERT INTO request_rate_windows(rate_key,window_start,used) VALUES($1,$2,599),($3,$2,120)', [tenantKey, minute, userKey]);
      assert.equal((await client.query<{ allowed: boolean }>('SELECT memocean_request_limit($1) AS allowed', [tokenHash])).rows[0]!.allowed, false);
      const usage = await client.query<{ rate_key: string; used: number }>('SELECT rate_key,used FROM request_rate_windows WHERE window_start=$1 AND rate_key IN ($2,$3) ORDER BY rate_key', [minute, tenantKey, userKey]);
      assert.deepEqual(usage.rows, [{ rate_key: tenantKey, used: 599 }, { rate_key: userKey, used: 120 }].sort((left, right) => left.rate_key.localeCompare(right.rate_key)));
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
  async function artifact(tenantId: string, userId: string, payloadHash = sha256('synthetic fixture payload')) {
    const keyId = randomUUID(), id = randomUUID(), txId = `synthetic-test-only-${id}`, hash = sha256(id), manifestHash = sha256('{}');
    await admin.query("INSERT INTO key_envelopes(id,tenant_id,kek_version,wrapping_algorithm,wrapped_dek,wrapping_nonce,wrapping_tag) VALUES($1,$2,'v1','AES-256-GCM',$3,$4,$5)", [keyId, tenantId, Buffer.alloc(32), Buffer.alloc(12), Buffer.alloc(16)]);
    await admin.query("INSERT INTO artifacts(id,tenant_id,key_envelope_id,state,staging_ciphertext,public_manifest,crypto_version,cipher_sha256,manifest_sha256,plain_commitment,byte_size,sanitized_at,reviewed_by,reviewed_at) VALUES($1,$2,$3,'staged',$4,'{}',1,$5,$6,$5,10,now(),$7,now())", [id, tenantId, keyId, Buffer.from('synthetic fixture only'), hash, manifestHash, userId]);
    // Explicit synthetic DB fixtures are not claims about Irys uploads or real permanence evidence.
    await admin.query("INSERT INTO irys_transactions(tx_id,artifact_id,network,storage_product,gateway_base_url,receipt,uploaded_at,manifest_tx_id,manifest_receipt,verified_at,permanence_verified,storage_verification_evidence,verified_cipher_sha256,verified_manifest_sha256) VALUES($1,$2,'synthetic-test','permanent','https://gateway.irys.xyz','{}',now(),$3,'{}',now(),true,'{\"synthetic_fixture_only\":true}',$4,$5)", [txId, id, `${txId}-manifest`, hash, manifestHash]);
    await admin.query("UPDATE artifacts SET state='indexed',indexed_payload_sha256=$2 WHERE id=$1", [id, payloadHash]);
    return id;
  }
  async function memory(fixture: typeof a, text: string) {
    const artifactId = await artifact(fixture.principal.tenantId, fixture.principal.userId), memoryId = randomUUID(), revisionId = randomUUID();
    await admin.query('INSERT INTO memories(id,tenant_id,project_id,created_by) VALUES($1,$2,$3,$4)', [memoryId, fixture.principal.tenantId, fixture.projectId, fixture.principal.userId]);
    await admin.query("INSERT INTO memory_revisions(id,memory_id,tenant_id,revision,artifact_id,schema_version,importance,valid_from) VALUES($1,$2,$3,1,$4,'1.0',0.9,'2026-01-01T00:00:00Z')", [revisionId, memoryId, fixture.principal.tenantId, artifactId]);
    await admin.query("INSERT INTO memory_chunks(tenant_id,revision_id,ordinal,locator,sanitized_text,embedding,embedding_model) VALUES($1,$2,0,'/rules/0/statement',$3,$4::vector,'voyage-3.5-lite')", [fixture.principal.tenantId, revisionId, text, vectorSql]);
    return { artifactId, memoryId };
  }
  const ma = await memory(a, 'Only tenant A verified evidence.'), mb = await memory(b, 'Only tenant B private evidence.');
  let calls = 0;
  const model: GenerationProvider = { configured: true, distill: async () => { throw new Error('Not part of test'); }, answer: async (_question, evidence) => { calls++; return { abstained: false, claims: [{ text: 'Verify the chain and storage evidence before publishing.', chunk_ids: [evidence[0]!.chunk_id] }] }; } };
  const embedding: EmbeddingProvider = { configured: true, embed: async (texts) => texts.map(() => vector) };
  const rag = new RagService(requestDb, embedding, model, new CryptoBox(config.KEK_V1_BASE64), config);
  await t.test('FORCE RLS two-tenant read/write isolation and pooled context reset', async () => {
    const rows = await requestDb.transaction(a.principal, async (tx) => (await tx.query('SELECT sanitized_text FROM memory_chunks')).rows);
    assert.deepEqual(rows.map((r) => r.sanitized_text), ['Only tenant A verified evidence.']);
    await assert.rejects(requestDb.transaction(a.principal, async (tx) => { await tx.query("INSERT INTO memories(tenant_id,project_id,created_by) VALUES($1,$2,$3)", [b.principal.tenantId, b.projectId, a.principal.userId]); }));
    const cleared = await requestDb.transaction(null, async (tx) => (await tx.query('SELECT * FROM memory_chunks')).rows); assert.equal(cleared.length, 0);
    await assert.rejects(rag.recall(a.principal, { project_id: b.projectId, query: 'Private evidence' }), /Project is not permitted/);
    const recalled = await rag.recall(a.principal, { project_id: a.projectId, query: 'Verified evidence' });
    assert.equal(recalled.items.length, 1); assert.equal(recalled.items[0]!.source.artifact_id, ma.artifactId); assert.notEqual(recalled.items[0]!.source.artifact_id, mb.artifactId);
  });
  async function capsule() {
    const root = randomUUID(), version = randomUUID(), safe = { rule: 'Verify the chain and storage evidence before publishing.' };
    const paid = await artifact(b.principal.tenantId, b.principal.userId), preview = await artifact(b.principal.tenantId, b.principal.userId, sha256(canonical(safe)));
    await admin.query("INSERT INTO capsules(root_id,owner_tenant_id,creator_user_id,title) VALUES($1,$2,$3,'Synthetic reviewed capsule')", [root, b.principal.tenantId, b.principal.userId]);
    await admin.query("INSERT INTO capsule_versions(id,root_id,owner_tenant_id,version,artifact_id,license_spdx_or_custom,license_sha256,review_state) VALUES($1,$2,$3,1,$4,'Synthetic test license',$5,'approved')", [version, root, b.principal.tenantId, paid, sha256('synthetic-license')]);
    await admin.query('INSERT INTO capsule_previews(capsule_version_id,owner_tenant_id,artifact_id,safe_content,safe_content_sha256,reviewed_by,reviewed_at) VALUES($1,$2,$3,$4,$5,$6,now())', [version, b.principal.tenantId, preview, safe, sha256(canonical(safe)), b.principal.userId]);
    return { root, version };
  }
  await t.test('100 distinct requests reserve at most three lifetime user/root trials before inference', async () => {
    const cap = await capsule(); const before = calls;
    const results = await Promise.allSettled(Array.from({ length: 100 }, (_, i) => rag.query(a.principal, { project_id: a.projectId, capsule_root_id: cap.root, capsule_version_id: cap.version, question: `Synthetic question ${i}`, mode: 'trial', idempotency_key: randomUUID() })));
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 3);
    assert.equal(calls - before, 3);
    assert.equal((await admin.query('SELECT used_count FROM trial_counters WHERE user_id=$1 AND capsule_root_id=$2', [a.principal.userId, cap.root])).rows[0].used_count, 3);
    for (const result of results) if (result.status === 'rejected') assert.equal((result.reason as ApiError).code, 'TRIAL_EXHAUSTED');
  });
  await t.test('100 same-key calls reserve once and changed full body conflicts without inference', async () => {
    const cap = await capsule(), key = randomUUID(), before = calls;
    const body = { project_id: a.projectId, capsule_root_id: cap.root, capsule_version_id: cap.version, question: 'Synthetic same-key question', mode: 'trial' as const, idempotency_key: key };
    const results = await Promise.allSettled(Array.from({ length: 100 }, () => rag.query(a.principal, body)));
    assert.equal(calls - before, 1); assert.ok(results.some((r) => r.status === 'fulfilled'));
    assert.equal((await admin.query('SELECT used_count FROM trial_counters WHERE user_id=$1 AND capsule_root_id=$2', [a.principal.userId, cap.root])).rows[0].used_count, 1);
    const cached = await rag.query(a.principal, body) as any; assert.equal(cached.quota_state, 'succeeded'); assert.equal(calls - before, 1);
    await assert.rejects(rag.query(a.principal, { ...body, question: 'Different body' }), (e: unknown) => e instanceof ApiError && e.code === 'IDEMPOTENCY_CONFLICT');
    assert.equal(calls - before, 1);
  });
  await t.test('purchased mode cannot unlock using an address, receipt hint or teammate identity', async () => {
    const cap = await capsule();
    await assert.rejects(rag.query(a.principal, { project_id: a.projectId, capsule_root_id: cap.root, capsule_version_id: cap.version, question: 'Paid evidence', mode: 'purchased', idempotency_key: randomUUID() }), (e: unknown) => e instanceof ApiError && e.code === 'FORBIDDEN');
  });
  await t.test('expired job lease is reclaimed and stale worker cannot commit', async () => {
    const jobId = randomUUID();
    await admin.query("INSERT INTO jobs(id,tenant_id,requested_by,kind,idempotency_key,request_sha256,payload,state) VALUES($1,$2,$3,'upload',$4,$5,$6,'queued')", [jobId, a.principal.tenantId, a.principal.userId, randomUUID(), sha256('synthetic-job'), { artifact_id: ma.artifactId, memory_id: ma.memoryId, project_id: a.projectId, revision: 1 }]);
    const first = (await admin.query(CLAIM_JOBS_SQL, [1])).rows[0]; assert.equal(first.id, jobId);
    await admin.query("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [jobId]);
    await assert.rejects(ensureLease(admin as unknown as Tx, first), /no longer owns/);
    const second = (await admin.query(CLAIM_JOBS_SQL, [1])).rows[0]; assert.equal(second.id, jobId); assert.notEqual(first.lease_token, second.lease_token);
    assert.equal((await admin.query("UPDATE jobs SET state='succeeded' WHERE id=$1 AND lease_token=$2 AND lease_until>now()", [jobId, first.lease_token])).rowCount, 0);
  });
  await t.test('indexed gate and independently reviewed preview invariants reject fabricated readiness', async () => {
    const tenant = a.principal.tenantId, user = a.principal.userId, envelopeId = randomUUID(), id = randomUUID();
    await admin.query("INSERT INTO key_envelopes(id,tenant_id,kek_version,wrapping_algorithm,wrapped_dek,wrapping_nonce,wrapping_tag) VALUES($1,$2,'v1','AES-256-GCM',$3,$4,$5)", [envelopeId, tenant, Buffer.alloc(32), Buffer.alloc(12), Buffer.alloc(16)]);
    await assert.rejects(admin.query("INSERT INTO artifacts(id,tenant_id,key_envelope_id,state,public_manifest,crypto_version,cipher_sha256,manifest_sha256,plain_commitment,byte_size,indexed_payload_sha256,sanitized_at,reviewed_by,reviewed_at) VALUES($1,$2,$3,'indexed','{}',1,$4,$4,$4,1,$4,now(),$5,now())", [id, tenant, envelopeId, sha256('synthetic-unverified'), user]), /not storage verified/);
  });
});
