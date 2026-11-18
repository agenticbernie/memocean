import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DraftService } from '../src/drafts.js';
import { Database, type Principal, type Tx } from '../src/db.js';
import { CryptoBox, digest } from '../src/security.js';
import { loadConfig } from '../src/config.js';
import type { GenerationProvider } from '../src/providers.js';

const p: Principal = { userId: randomUUID(), tenantId: randomUUID(), tokenId: randomUUID(), tokenKind: 'session', scopes: ['memory:write'], projectIds: [] };
const projectId = randomUUID(), draftId = randomUUID();
const config = loadConfig({ NODE_ENV: 'test', TOKEN_HASH_PEPPER: 'synthetic-test-pepper-not-live-12345678', KEK_V1_BASE64: Buffer.alloc(32, 8).toString('base64') });
const box = new CryptoBox(config.KEK_V1_BASE64);
const candidate = { title: 'Synthetic lesson', sanitized_text: 'Verify evidence before indexing.' };
function fixtureDb(state: string, expiry = Date.now() + 60000, writes: string[] = []) {
  const sealed = box.seal(candidate, `draft:${p.tenantId}:${draftId}:1`);
  const row = { id: draftId, tenant_id: p.tenantId, project_id: projectId, requested_by: p.userId, state, expires_at: new Date(expiry), egress_approved_at: state === 'egress_approved' ? new Date() : null, candidate_sha256: Buffer.from(digest(candidate).slice(2), 'hex'), content_ciphertext: sealed.ciphertext, wrapped_dek: sealed.wrappedDek, wrapping_nonce: sealed.wrappingNonce, wrapping_tag: sealed.wrappingTag, kek_version: 'v1' };
  const tx = { query: async (sql: string) => {
    if (sql.includes('FROM approval_drafts')) return { rows: [row], rowCount: 1 };
    if (sql.includes('app_project')) return { rows: [{ allowed: true }], rowCount: 1 };
    if (sql.includes('memocean_reserve_budget')) return { rows: [{ allowed: true }], rowCount: 1 };
    if (sql.includes('UPDATE approval_drafts')) { writes.push(sql); if (sql.includes("state='distilling'")) row.state = 'distilling'; if (sql.includes("state='rejected'")) row.state = 'rejected'; return { rows: [], rowCount: 1 }; }
    throw new Error('Unexpected query: ' + sql);
  } } as unknown as Tx;
  class Fixture extends Database { override async transaction<T>(_p: Principal | null, fn: (tx: Tx) => Promise<T>) { return fn(tx); } }
  return new Fixture();
}
test('scanned input cannot trigger a model call without exact egress approval', async () => {
  let calls = 0;
  const model: GenerationProvider = { configured: true, distill: async () => { calls++; throw new Error('Should not run'); }, answer: async () => { throw new Error('Should not run'); } };
  const service = new DraftService(fixtureDb('scanned'), box, model, config);
  await assert.rejects(service.distill(p, draftId), /Approve the exact sanitized outbound candidate/);
  assert.equal(calls, 0);
});
test('egress approval rejects digest drift and expiry without changing or sending content', async () => {
  const model: GenerationProvider = { configured: false, distill: async () => { throw new Error('Should not run'); }, answer: async () => { throw new Error('Should not run'); } };
  const service = new DraftService(fixtureDb('scanned'), box, model, config);
  await assert.rejects(service.approveEgress(p, draftId, { approved_sha256: digest({ ...candidate, sanitized_text: 'Changed' }) }), /digest/);
  const expired = new DraftService(fixtureDb('scanned', Date.now() - 1000), box, model, config);
  await assert.rejects(expired.approveEgress(p, draftId, { approved_sha256: digest(candidate) }), /expired/);
});
test('final approval cannot bypass distillation or human exact-payload review', async () => {
  const model: GenerationProvider = { configured: false, distill: async () => { throw new Error('Should not run'); }, answer: async () => { throw new Error('Should not run'); } };
  const service = new DraftService(fixtureDb('egress_approved'), box, model, config);
  await assert.rejects(service.approve(p, draftId, { approved_sha256: digest(candidate) }), /Only a distilled draft/);
  await assert.rejects(service.distill(p, draftId), /no text was sent/);
});

test('a potentially dispatched failed distillation rejects the draft instead of reopening egress approval', async () => {
  const writes: string[] = [], model: GenerationProvider = {
    configured: true,
    distill: async () => ({}),
    answer: async () => { throw new Error('Should not run'); },
  };
  const service = new DraftService(fixtureDb('egress_approved', Date.now() + 60000, writes), box, model, config);
  await assert.rejects(service.distill(p, draftId), /not retryable/);
  assert.ok(writes.some((sql) => sql.includes("state='distilling'")));
  assert.ok(writes.some((sql) => sql.includes("state='rejected'")));
  assert.ok(!writes.some((sql) => sql.includes("state='egress_approved'")));
});
