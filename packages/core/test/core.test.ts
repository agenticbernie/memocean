import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalizeJson,
  capsuleUuidToBytes16,
  CryptoError,
  decryptAes256Gcm,
  deriveCapsuleRoot,
  encryptAes256Gcm,
  recallSchema,
  rememberSchema,
  sha256Hex,
  saltedPlaintextCommitment,
} from '../src/index.js';

const UUID = '123e4567-e89b-42d3-a456-426614174000';

test('RFC 8785 canonicalization sorts keys and normalizes JSON numbers', () => {
  assert.equal(canonicalizeJson({ z: 4.5, a: 'quote " and newline\n', n: -0 }), '{"a":"quote \\" and newline\\n","n":0,"z":4.5}');
  assert.equal(canonicalizeJson([1e30, 0.000001]), '[1e+30,0.000001]');
});

test('SHA-256 is lower-case, 0x-prefixed, and hashes exact bytes', () => {
  assert.equal(sha256Hex('abc'), '0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('AES-256-GCM uses a versioned nonce/tag envelope and authenticates AAD', () => {
  const key = Buffer.alloc(32, 0x11);
  const nonce = Buffer.alloc(12, 0x22);
  const aad = Buffer.from('tenant:fixture');
  const plaintext = Buffer.from('approved payload');
  const envelope = encryptAes256Gcm(plaintext, key, { nonce, aad });
  assert.equal(envelope.subarray(0, 4).toString('ascii'), 'MOC1');
  assert.deepEqual(decryptAes256Gcm(envelope, key, aad), plaintext);
  assert.throws(() => decryptAes256Gcm(envelope, key, Buffer.from('other tenant')), CryptoError);
  const altered = Buffer.from(envelope);
  const lastByte = altered.length - 1;
  altered[lastByte] = altered[lastByte]! ^ 1;
  assert.throws(() => decryptAes256Gcm(altered, key, aad), CryptoError);
  assert.throws(() => encryptAes256Gcm(plaintext, Buffer.alloc(31)), CryptoError);
});

test('salted plaintext commitment binds the 32-byte secret salt', () => {
  const salt = Buffer.alloc(32, 7);
  const bytes = Buffer.from('{"lesson":"review first"}');
  const expected = sha256Hex(Buffer.concat([salt, bytes]));
  assert.equal(saltedPlaintextCommitment(salt, bytes), expected);
  assert.notEqual(saltedPlaintextCommitment(Buffer.alloc(32, 8), bytes), expected);
  assert.throws(() => saltedPlaintextCommitment(Buffer.alloc(31), bytes), CryptoError);
});

test('capsule UUID v4 is encoded as raw bytes16 and root matches ABI/Keccak fixture', () => {
  assert.equal(capsuleUuidToBytes16(UUID), '0x123e4567e89b42d3a456426614174000');
  assert.equal(
    deriveCapsuleRoot({
      chainId: 43113,
      contractAddress: '0x1111111111111111111111111111111111111111',
      initialSeller: '0x2222222222222222222222222222222222222222',
      capsuleUuid: UUID,
    }),
    '0x31f8ba5435de3c991b89680b9e4041b7bee7abde8ae10bd65e64805b78abc2e1',
  );
  assert.notEqual(
    deriveCapsuleRoot({
      chainId: 43114,
      contractAddress: '0x1111111111111111111111111111111111111111',
      initialSeller: '0x2222222222222222222222222222222222222222',
      capsuleUuid: UUID,
    }),
    '0x31f8ba5435de3c991b89680b9e4041b7bee7abde8ae10bd65e64805b78abc2e1',
  );
  assert.throws(() => capsuleUuidToBytes16('00000000-0000-0000-0000-000000000000'), TypeError);
});

test('shared API schemas preserve strict and temporal validation behavior', () => {
  assert.equal(recallSchema.safeParse({
    query: 'find reviewed decision',
    project_id: '123e4567-e89b-42d3-a456-426614174000',
    created_from: '2026-01-01T00:00:00Z',
    created_to: '2026-12-31T00:00:00Z',
  }).success, true);
  assert.equal(recallSchema.safeParse({
    query: 'find reviewed decision',
    project_id: '123e4567-e89b-42d3-a456-426614174000',
    extra: true,
  }).success, false);
  assert.equal(rememberSchema.safeParse({
    project_id: '123e4567-e89b-42d3-a456-426614174000',
    idempotency_key: '123e4567-e89b-42d3-a456-426614174000',
    approved_draft_id: '123e4567-e89b-42d3-a456-426614174000',
    approved_sha256: `0x${'a'.repeat(64)}`,
    approval_token: 'a'.repeat(32),
    importance: 0.5,
    valid_from: '2026-01-02T00:00:00Z',
    valid_to: '2026-01-01T00:00:00Z',
  }).success, false);
});
