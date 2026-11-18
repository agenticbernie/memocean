import { createHash, createHmac, timingSafeEqual, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

export class ApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400, public readonly retryable = false, public readonly operationId: string | null = null, public readonly resourceUri: string | null = null) {
    super(message);
  }
}
export function canonical(value: unknown): string {
  if (typeof value === 'string') {
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) throw new ApiError('INVALID_INPUT', 'Canonical JSON cannot contain unpaired Unicode surrogates');
    return JSON.stringify(value);
  }
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new ApiError('INVALID_INPUT', 'Only plain JSON objects can be canonicalized');
    return `{${Object.keys(value).sort().map((key) => `${canonical(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  throw new ApiError('INVALID_INPUT', 'Only finite JSON values may be canonicalized');
}
export const sha256 = (value: string | Buffer): Buffer => createHash('sha256').update(value).digest();
export const digest = (value: unknown): string => `0x${sha256(canonical(value)).toString('hex')}`;
export function hashToken(token: string, pepper?: string): Buffer {
  if (!pepper) throw new ApiError('INTEGRATION_UNAVAILABLE', 'Token authentication is not configured', 503);
  return createHmac('sha256', pepper).update(token).digest();
}
export function equal(a: Buffer, b: Buffer): boolean { return a.length === b.length && timingSafeEqual(a, b); }
export const opaqueToken = (prefix = 'mo_pat_'): string => `${prefix}${randomBytes(32).toString('base64url')}`;
export function assertDigest(value: unknown, expected: string): void {
  if (!equal(Buffer.from(digest(value).slice(2), 'hex'), Buffer.from(expected.slice(2), 'hex'))) {
    throw new ApiError('INVALID_APPROVAL', 'The exact reviewed content digest does not match', 409);
  }
}
export interface Sealed { ciphertext: Buffer; wrappedDek: Buffer; wrappingNonce: Buffer; wrappingTag: Buffer; kekVersion: 'v1' }
export class CryptoBox {
  private readonly kek?: Buffer;
  constructor(base64Key?: string) {
    if (base64Key) {
      this.kek = Buffer.from(base64Key, 'base64');
      if (this.kek.length !== 32) throw new Error('KEK must be 32 bytes');
    }
  }
  private key(): Buffer { if (!this.kek) throw new ApiError('INTEGRATION_UNAVAILABLE', 'Encryption key is not configured', 503); return this.kek; }
  seal(value: unknown, aad: string): Sealed {
    const key = this.key();
    const dek = randomBytes(32), nonce = randomBytes(12), wrappingNonce = randomBytes(12);
    try {
      const cipher = createCipheriv('aes-256-gcm', dek, nonce);
      cipher.setAAD(Buffer.from(aad));
      const data = Buffer.concat([cipher.update(canonical(value), 'utf8'), cipher.final()]);
      const ciphertext = Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), data]);
      const wrap = createCipheriv('aes-256-gcm', key, wrappingNonce);
      wrap.setAAD(Buffer.from(`memocean:dek:v1:${aad}`));
      const wrappedDek = Buffer.concat([wrap.update(dek), wrap.final()]);
      return { ciphertext, wrappedDek, wrappingNonce, wrappingTag: wrap.getAuthTag(), kekVersion: 'v1' };
    } finally { dek.fill(0); }
  }
  open<T>(sealed: Sealed, aad: string): T {
    const key = this.key();
    if (sealed.kekVersion !== 'v1' || sealed.ciphertext[0] !== 1 || sealed.ciphertext.length < 30) throw new ApiError('EVIDENCE_INVALID', 'Invalid encrypted envelope', 409);
    const unwrap = createDecipheriv('aes-256-gcm', key, sealed.wrappingNonce);
    unwrap.setAAD(Buffer.from(`memocean:dek:v1:${aad}`)); unwrap.setAuthTag(sealed.wrappingTag);
    const dek = Buffer.concat([unwrap.update(sealed.wrappedDek), unwrap.final()]);
    try {
      const decipher = createDecipheriv('aes-256-gcm', dek, sealed.ciphertext.subarray(1, 13));
      decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(sealed.ciphertext.subarray(13, 29));
      return JSON.parse(Buffer.concat([decipher.update(sealed.ciphertext.subarray(29)), decipher.final()]).toString('utf8')) as T;
    } finally { dek.fill(0); }
  }
}
const prohibited = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:sk-ant-|sk-proj-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{12,}/,
  /\b(?:seed[_ -]?phrase|mnemonic)\s*[:=][^\n]{10,}/i,
  /\b(?:abandon\s+){3,}/i,
  /https?:\/\/[^\s/]*(?:\.internal|\.local)(?:[/:]|\b)/i,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\b(?:private[_ -]?key|api[_ -]?key|password|secret|seed[_ -]?phrase|mnemonic)\s*[:=]\s*["']?[^\s"']{8,}/i,
  /\b(?:0x)?[a-fA-F0-9]{64}\b/,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\b\d{3}-\d{2}-\d{4}\b/,
  /https?:\/\/(?:[^\s/@]+:[^\s/@]+@|localhost\b|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)/i,
  /\b(?:Bearer|Authorization:)\s+[A-Za-z0-9_.-]{16,}/i,
];
export function scanText(text: string): void {
  if (Buffer.byteLength(text, 'utf8') > 64 * 1024) throw new ApiError('INVALID_INPUT', 'Sanitized input exceeds 64 KiB');
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text) || prohibited.some((pattern) => pattern.test(text))) {
    throw new ApiError('SCAN_REJECTED', 'Potential secret, private identifier or control sequence detected. Redact locally and review again.', 422);
  }
}
export function publicError(error: unknown, requestId: string) {
  const safe = error instanceof ApiError ? error : new ApiError('INTERNAL_ERROR', 'The operation could not be completed', 500);
  return { kind: 'error' as const, code: safe.code, message: safe.message, retryable: safe.retryable, request_id: requestId, operation_id: safe.operationId, resource_uri: safe.resourceUri };
}
