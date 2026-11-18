import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ENVELOPE_MAGIC = Buffer.from('MOC1', 'ascii');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const HEADER_BYTES = ENVELOPE_MAGIC.length + NONCE_BYTES + TAG_BYTES;

export class CryptoError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CryptoError';
  }
}

export function sha256(data: Uint8Array | string): Buffer {
  return createHash('sha256').update(data).digest();
}

/** Lowercase 0x-prefixed SHA-256 digest of the exact supplied bytes. */
export function sha256Hex(data: Uint8Array | string): `0x${string}` {
  return `0x${sha256(data).toString('hex')}`;
}

export interface EncryptOptions {
  /** Optional for known-answer tests only; production callers should omit it. */
  nonce?: Uint8Array;
  aad?: Uint8Array;
}

/**
 * Encrypts bytes with AES-256-GCM. The versioned envelope is magic || nonce ||
 * tag || ciphertext; hash this whole envelope for cipherSha256.
 */
export function encryptAes256Gcm(
  plaintext: Uint8Array,
  key: Uint8Array,
  options: EncryptOptions = {},
): Buffer {
  assertKey(key);
  const nonce = options.nonce ? Buffer.from(options.nonce) : randomBytes(NONCE_BYTES);
  if (nonce.length !== NONCE_BYTES) throw new CryptoError('AES-256-GCM nonce must be 12 bytes');
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key), nonce, { authTagLength: TAG_BYTES });
  if (options.aad) cipher.setAAD(Buffer.from(options.aad));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([ENVELOPE_MAGIC, nonce, tag, ciphertext]);
}

export function decryptAes256Gcm(envelope: Uint8Array, key: Uint8Array, aad?: Uint8Array): Buffer {
  assertKey(key);
  const bytes = Buffer.from(envelope);
  if (bytes.length < HEADER_BYTES || !bytes.subarray(0, ENVELOPE_MAGIC.length).equals(ENVELOPE_MAGIC)) {
    throw new CryptoError('Unsupported or malformed AES-256-GCM envelope');
  }
  const nonceStart = ENVELOPE_MAGIC.length;
  const tagStart = nonceStart + NONCE_BYTES;
  const ciphertextStart = tagStart + TAG_BYTES;
  const nonce = bytes.subarray(nonceStart, tagStart);
  const tag = bytes.subarray(tagStart, ciphertextStart);
  const ciphertext = bytes.subarray(ciphertextStart);
  try {
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key), nonce, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tag);
    if (aad) decipher.setAAD(Buffer.from(aad));
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (cause) {
    throw new CryptoError('AES-256-GCM authentication failed', { cause });
  }
}

/** SHA256(randomSalt32 || canonicalPlaintextBytes), with salt retained privately. */
export function saltedPlaintextCommitment(salt: Uint8Array, canonicalPlaintext: Uint8Array): `0x${string}` {
  if (salt.byteLength !== 32) throw new CryptoError('Plaintext commitment salt must be 32 bytes');
  return sha256Hex(Buffer.concat([Buffer.from(salt), Buffer.from(canonicalPlaintext)]));
}

function assertKey(key: Uint8Array): void {
  if (key.byteLength !== KEY_BYTES) throw new CryptoError('AES-256-GCM key must be 32 bytes');
}

export { randomBytes };
