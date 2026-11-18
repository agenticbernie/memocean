import pg, { type PoolClient, type QueryResultRow } from 'pg';
import type { Config } from './config.js';
import { ApiError, type Sealed } from './security.js';
export interface Principal { userId: string; tenantId: string; scopes: string[]; projectIds: string[]; tokenId: string; tokenKind: 'session' | 'pat' }
export type Tx = PoolClient;
export class Database {
  readonly pool?: pg.Pool;
  constructor(url?: string) { if (url) this.pool = new pg.Pool({ connectionString: url, max: 8, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, statement_timeout: 15000, application_name: 'memocean-api' }); }
  async query<T extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []): Promise<pg.QueryResult<T>> {
    if (!this.pool) throw new ApiError('INTEGRATION_UNAVAILABLE', 'PostgreSQL is not configured', 503);
    return this.pool.query<T>(sql, values);
  }
  async transaction<T>(principal: Principal | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (!this.pool) throw new ApiError('INTEGRATION_UNAVAILABLE', 'PostgreSQL is not configured', 503);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout='15000ms'");
      if (principal) await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)", [principal.tenantId, principal.userId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async ready(): Promise<boolean> {
    const result = await this.query<{ safe: boolean; migrated: boolean }>(`SELECT NOT r.rolsuper AND NOT r.rolbypassrls AND NOT pg_has_role(current_user,'memocean_worker','MEMBER') AND NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.relname='artifacts' AND c.relnamespace='public'::regnamespace AND pg_has_role(current_user,c.relowner,'MEMBER')) AS safe, (SELECT count(*)=5 FROM schema_migrations WHERE name IN ('001_initial.sql','002_security.sql','003_invariants.sql','004_operations.sql','005_request_rate_limit_atomic.sql')) AS migrated FROM pg_roles r WHERE r.rolname=current_user`);
    return result.rows[0]?.safe === true && result.rows[0]?.migrated === true;
  }
  async close(): Promise<void> { await this.pool?.end(); }
}
export function requireScope(principal: Principal, scope: string): void {
  if (!principal.scopes.includes(scope)) throw new ApiError('FORBIDDEN', 'Token does not have the required scope', 403);
}
export async function authorizeProject(tx: Tx, principal: Principal, projectId: string, write = false): Promise<void> {
  if (principal.projectIds.length && !principal.projectIds.includes(projectId)) throw new ApiError('FORBIDDEN', 'Project is not permitted for this token', 403);
  const result = await tx.query('SELECT app_project($1,$2,$3) AS allowed', [projectId, principal.tenantId, write]);
  if (!result.rows[0]?.allowed) throw new ApiError('FORBIDDEN', 'Project is not permitted', 403);
}
export async function saveEnvelope(tx: Tx, tenantId: string, sealed: Sealed): Promise<string> {
  const result = await tx.query<{ id: string }>(`INSERT INTO key_envelopes(tenant_id,kek_version,wrapping_algorithm,wrapped_dek,wrapping_nonce,wrapping_tag) VALUES($1,$2,'AES-256-GCM',$3,$4,$5) RETURNING id`, [tenantId, sealed.kekVersion, sealed.wrappedDek, sealed.wrappingNonce, sealed.wrappingTag]);
  return result.rows[0]!.id;
}
export function sealedFromRow(row: Record<string, any>, ciphertext = 'content_ciphertext'): Sealed {
  return { ciphertext: row[ciphertext] as Buffer, wrappedDek: row.wrapped_dek as Buffer, wrappingNonce: row.wrapping_nonce as Buffer, wrappingTag: row.wrapping_tag as Buffer, kekVersion: row.kek_version as 'v1' };
}
export async function reserveBudget(tx: Tx, principal: Principal, config: Config): Promise<void> {
  const result = await tx.query('SELECT memocean_reserve_budget($1,$2,$3) AS allowed', [principal.userId, config.USER_DAILY_MODEL_LIMIT, config.GLOBAL_DAILY_MODEL_LIMIT]);
  if (!result.rows[0]?.allowed) throw new ApiError('BUDGET_EXCEEDED', 'Daily inference budget is exhausted', 429);
}
