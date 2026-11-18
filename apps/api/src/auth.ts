import { randomBytes } from 'node:crypto';
import { SiweMessage } from 'siwe';
import { getAddress } from 'viem';
import type { Config } from './config.js';
import { Database, type Principal, requireScope, authorizeProject } from './db.js';
import { ApiError, hashToken, opaqueToken, sha256 } from './security.js';
import { challengeSchema, verifySchema, createPatSchema } from './schemas.js';

export class AuthService {
  constructor(private readonly db: Database, private readonly config: Config) {}
  async challenge(input: unknown) {
    const value = challengeSchema.parse(input);
    if (value.chain_id !== this.config.CHAIN_ID) throw new ApiError('INVALID_INPUT', 'Unsupported SIWE chain');
    const nonce = randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + 5 * 60000).toISOString();
    const message = new SiweMessage({ domain: this.config.AUTH_DOMAIN, address: getAddress(value.address), statement: 'Sign in to MemOcean. This does not authorize transactions or permanent uploads.', uri: this.config.WEB_ORIGIN, version: '1', chainId: value.chain_id, nonce, issuedAt: new Date().toISOString(), expirationTime: expiresAt }).prepareMessage();
    await this.db.query('SELECT memocean_create_challenge($1,$2,$3,$4,$5,$6,$7)', [hashToken(nonce, this.config.TOKEN_HASH_PEPPER), value.address.toLowerCase(), this.config.AUTH_DOMAIN, this.config.WEB_ORIGIN, value.chain_id, sha256(message), expiresAt]);
    return { message, expires_at: expiresAt };
  }
  async verify(input: unknown) {
    const value = verifySchema.parse(input);
    let parsed: SiweMessage;
    try { parsed = new SiweMessage(value.message); } catch { throw new ApiError('UNAUTHENTICATED', 'Invalid wallet challenge', 401); }
    if (parsed.domain !== this.config.AUTH_DOMAIN || parsed.uri !== this.config.WEB_ORIGIN || parsed.chainId !== this.config.CHAIN_ID || parsed.version !== '1' || !parsed.expirationTime || Date.parse(parsed.expirationTime) <= Date.now() || !parsed.issuedAt || Date.parse(parsed.issuedAt) > Date.now() + 30000) throw new ApiError('UNAUTHENTICATED', 'Wallet challenge is invalid or expired', 401);
    try {
      const result = await parsed.verify({ signature: value.signature, domain: this.config.AUTH_DOMAIN, nonce: parsed.nonce, time: new Date().toISOString() });
      if (!result.success) throw new Error('Invalid signature');
    } catch { throw new ApiError('UNAUTHENTICATED', 'Wallet signature could not be verified. EOA wallets only in this pilot.', 401); }
    const token = opaqueToken('mo_session_');
    try {
      const result = await this.db.query('SELECT * FROM memocean_finish_login($1,$2,$3,$4,$5)', [hashToken(parsed.nonce, this.config.TOKEN_HASH_PEPPER), sha256(value.message), parsed.address.toLowerCase(), parsed.chainId, hashToken(token, this.config.TOKEN_HASH_PEPPER)]);
      if (!result.rows[0]) throw new Error('Login unavailable');
      return { token, token_type: 'Bearer', ...result.rows[0] };
    } catch (error) {
      if ((error as { code?: string }).code === '28000') throw new ApiError('UNAUTHENTICATED', 'Wallet challenge is invalid, used or expired', 401);
      throw error;
    }
  }
  async authenticate(header?: string): Promise<Principal> {
    if (!header?.startsWith('Bearer ') || header.length > 256) throw new ApiError('UNAUTHENTICATED', 'Configure a scoped MemOcean Bearer PAT for this controlled pilot', 401);
    const token = header.slice(7);
    if (!/^mo_(?:pat|session)_[A-Za-z0-9_-]{43}$/.test(token)) throw new ApiError('UNAUTHENTICATED', 'Invalid Bearer token', 401);
    const result = await this.db.query('SELECT * FROM memocean_authenticate($1)', [hashToken(token, this.config.TOKEN_HASH_PEPPER)]);
    const row = result.rows[0];
    if (!row) throw new ApiError('UNAUTHENTICATED', 'Bearer token is expired, revoked or unavailable', 401);
    const allowed = (await this.db.query('SELECT memocean_request_limit($1) AS allowed', [hashToken(token, this.config.TOKEN_HASH_PEPPER)])).rows[0]?.allowed;
    if (!allowed) throw new ApiError('RATE_LIMITED', 'Per-user or per-tenant request limit exceeded', 429, true);
    return { userId: row.user_id, tenantId: row.tenant_id, scopes: row.scopes, projectIds: row.project_ids, tokenId: row.token_id, tokenKind: row.token_kind };
  }
  async logout(header?: string): Promise<void> {
    const principal = await this.authenticate(header); requireScope(principal, 'account:manage');
    await this.db.query('SELECT memocean_revoke_session($1)', [hashToken(header!.slice(7), this.config.TOKEN_HASH_PEPPER)]);
  }
  async createPat(principal: Principal, input: unknown) {
    requireScope(principal, 'account:manage');
    const value = createPatSchema.parse(input);
    const expiry = value.expires_at ?? new Date(Date.now() + 30 * 86400000).toISOString();
    if (Date.parse(expiry) <= Date.now() || Date.parse(expiry) > Date.now() + 90 * 86400000) throw new ApiError('INVALID_INPUT', 'PAT expiry must be within the next 90 days');
    const token = opaqueToken();
    return this.db.transaction(principal, async (tx) => {
      for (const projectId of value.project_ids) await authorizeProject(tx, principal, projectId);
      const result = await tx.query('INSERT INTO api_keys(tenant_id,user_id,name,prefix,token_hash,scopes,project_ids,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,prefix,name,scopes,project_ids,expires_at', [principal.tenantId, principal.userId, value.name, token.slice(0, 18), hashToken(token, this.config.TOKEN_HASH_PEPPER), value.scopes, value.project_ids, expiry]);
      return { ...result.rows[0], token, displayed_once: true };
    });
  }
  async revokePat(principal: Principal, id: string): Promise<void> {
    requireScope(principal, 'account:manage');
    await this.db.transaction(principal, async (tx) => { await tx.query('UPDATE api_keys SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND tenant_id=$3', [id, principal.userId, principal.tenantId]); });
  }
}
