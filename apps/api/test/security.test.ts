import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { ApiError, CryptoBox, canonical, digest, scanText, hashToken, assertDigest } from '../src/security.js';
import { groundAnswer, type Evidence } from '../src/rag.js';
import { recallSchema, rememberSchema } from '../src/schemas.js';
import { IrysStorage, AnthropicGeneration, VoyageEmbedding } from '../src/providers.js';
import { loadConfig } from '../src/config.js';

const key = Buffer.alloc(32, 7).toString('base64');
test('AES-256-GCM roundtrip and tamper/AAD rejection', () => {
  const box = new CryptoBox(key), value = { title: 'Synthetic lesson', rules: ['Verify before publishing'] };
  const a = box.seal(value, 'tenant:memory:revision:v1'), b = box.seal(value, 'tenant:memory:revision:v1');
  assert.deepEqual(box.open(a, 'tenant:memory:revision:v1'), value);
  assert.notDeepEqual(a.ciphertext, b.ciphertext);
  assert.throws(() => box.open(a, 'other-tenant:memory:revision:v1'));
  const tampered = { ...a, ciphertext: Buffer.from(a.ciphertext) }; tampered.ciphertext[30] = tampered.ciphertext[30]! ^ 1;
  assert.throws(() => box.open(tampered, 'tenant:memory:revision:v1'));
  assert.throws(() => new CryptoBox().seal(value, 'aad'), /not configured/);
});
test('canonicalization and exact payload approval are stable and content-bound', () => {
  assert.equal(canonical({ z: 1, a: [true, 'é'] }), '{"a":[true,"é"],"z":1}');
  assert.equal(digest({ a: 1, b: 2 }), digest({ b: 2, a: 1 }));
  assert.throws(() => canonical({ bad: NaN }));
  assert.throws(() => assertDigest({ approved: false }, digest({ approved: true })), /digest/);
  assert.notDeepEqual(hashToken('same-token', 'a'.repeat(32)), hashToken('same-token', 'b'.repeat(32)));
});
test('deterministic secret, private-network and PII scanning rejects before providers', () => {
  for (const value of ['-----BEGIN PRIVATE KEY-----', 'api_key=synthetic-secret-value', 'sk-ant-' + 'a'.repeat(30), 'name@example.invalid', 'https://192.168.1.1/private', 'Bearer ' + 'a'.repeat(32), '0x' + 'a'.repeat(64), 'bad\u0000control']) assert.throws(() => scanText(value), ApiError);
  scanText('Only approved synthetic lessons, without identifying details.');
  assert.throws(() => scanText('a'.repeat(65537)), /64 KiB/);
});
const evidence: Evidence[] = [{ chunk_id: randomUUID(), text: 'Verify the storage proof before indexing.', importance: 0.9, score: 0.8, source: { artifact_id: randomUUID(), irys_tx_id: 'synthetic-test-only-id', cipher_sha256: '0x' + 'a'.repeat(64), chunk_locator: '/rules/0/statement', excerpt_sha256: '0x' + 'b'.repeat(64), gateway_ciphertext_url: 'https://gateway.irys.xyz/synthetic-test-only-id', capsule_version_id: null } }];
test('grounding maps citations only from authorized evidence, no free-form model URL', () => {
  const result = groundAnswer({ abstained: false, claims: [{ text: 'Verify the storage proof before indexing.', chunk_ids: [evidence[0]!.chunk_id] }] }, evidence);
  assert.deepEqual(result.claims[0]!.citations[0], evidence[0]!.source);
  assert.throws(() => groundAnswer({ abstained: false, claims: [{ text: 'Unsupported', chunk_ids: [randomUUID()] }] }, evidence), /outside/);
  assert.throws(() => groundAnswer({ abstained: true, claims: [{ text: 'Unsupported', chunk_ids: [evidence[0]!.chunk_id] }] }, evidence), /Abstention/);
  assert.throws(() => groundAnswer({ abstained: false, claims: [] }, evidence), /without cited/);
  assert.deepEqual(groundAnswer({ abstained: true, claims: [] }, []), { answer: 'Not enough verified evidence to answer.', abstained: true, claims: [] });
});
test('strict schemas reject invalid times, date ranges and raw remember text', () => {
  const base = { project_id: randomUUID(), query: 'Synthetic query' };
  assert.equal(recallSchema.safeParse({ ...base, effective_at: '2026-01-01T00:00:00' }).success, false);
  assert.equal(recallSchema.safeParse({ ...base, created_from: '2026-02-01T00:00:00Z', created_to: '2026-01-01T00:00:00Z' }).success, false);
  assert.equal(recallSchema.safeParse({ ...base, created_from: '2024-01-01T00:00:00Z', created_to: '2026-01-01T00:00:00Z' }).success, false);
  assert.equal(rememberSchema.safeParse({ ...base, raw_text: 'Never accept raw transcripts' }).success, false);
});
test('unconfigured real providers and permanent storage fail closed without any fetch', async () => {
  const config = loadConfig({ NODE_ENV: 'test' });
  const generation = new AnthropicGeneration(config), embedding = new VoyageEmbedding(config), storage = new IrysStorage();
  assert.equal(generation.configured, false); assert.equal(embedding.configured, false); assert.equal(storage.permanenceSupported, false);
  await assert.rejects(generation.distill({ title: 'Synthetic', sanitized_text: 'Reviewed synthetic input' }), /not configured/);
  await assert.rejects(embedding.embed(['Synthetic query'], 'query'), /not configured/);
  await assert.rejects(storage.upload(Buffer.from('synthetic ciphertext'), 'application/octet-stream', randomUUID()), /No upload was attempted/);
  await assert.rejects(storage.verify(), /do not prove/);
});
test('production rejects missing encryption and auth configuration', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /Production requires/);
  assert.throws(() => loadConfig({ KEK_V1_BASE64: randomBytes(16).toString('base64') }), /32 bytes/);
});
