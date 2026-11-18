import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { Database } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { MCP_VERSION, decodeMcpName, validateMcpRequest, toolDefinitions } from '../src/mcp.js';
import { hashToken } from '../src/security.js';

const userId = randomUUID(), tenantId = randomUUID();
class FixtureDb extends Database {
  override async query(sql: string): Promise<any> {
    if (sql.includes('memocean_authenticate')) return { rows: [{ user_id: userId, tenant_id: tenantId, scopes: ['memory:read', 'provenance:read'], project_ids: [], token_id: randomUUID(), token_kind: 'pat' }], rowCount: 1 };
    if (sql.includes('memocean_request_limit')) return { rows: [{ allowed: true }], rowCount: 1 };
    throw new Error('Unexpected fixture database access');
  }
  override async close() {}
}
const metadata = { 'io.modelcontextprotocol/protocolVersion': MCP_VERSION, 'io.modelcontextprotocol/clientInfo': { name: 'synthetic-protocol-test', version: '0.1.0' }, 'io.modelcontextprotocol/clientCapabilities': {} };
const body = (method = 'server/discover', params: Record<string, unknown> = {}) => ({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: metadata } });
const headers = (method = 'server/discover', name?: string) => ({ authorization: 'Bearer mo_pat_' + 'a'.repeat(43), accept: 'application/json, text/event-stream', 'mcp-protocol-version': MCP_VERSION, 'mcp-method': method, ...(name ? { 'mcp-name': name } : {}) });
test('per-request metadata and mirrored headers are mandatory, session-era requests rejected', () => {
  assert.throws(() => validateMcpRequest(body(), {}), /HeaderMismatch/);
  assert.throws(() => validateMcpRequest(body(), { ...headers(), 'mcp-method': 'tools/list' }), /HeaderMismatch/);
  assert.throws(() => validateMcpRequest(body('tools/call', { name: 'recall' }), headers('tools/call', 'remember')), /HeaderMismatch/);
  assert.throws(() => validateMcpRequest(body(), { ...headers(), 'mcp-protocol-version': '2025-11-25' }), /UnsupportedProtocolVersion/);
  assert.equal(decodeMcpName('=?base64?' + Buffer.from('mémoire').toString('base64') + '?='), 'mémoire');
  assert.throws(() => decodeMcpName('=?base64?not-valid!?='), /malformed/);
  assert.throws(() => decodeMcpName('non-ascii-é'), /header-safe/);
});
test('all four advertised tool schemas include strict input and declared output', () => {
  assert.deepEqual(toolDefinitions.map((t) => t.name), ['recall', 'remember', 'query_capsule', 'verify_provenance']);
  for (const tool of toolDefinitions) {
    assert.equal(tool.inputSchema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.ok(tool.outputSchema);
  }
});
test('Fastify stateless MCP wire, errors, security headers and JSON/SSE responses', async (t) => {
  const app = await buildApp({ config: loadConfig({ NODE_ENV: 'test', TOKEN_HASH_PEPPER: 'synthetic-pepper-not-a-real-secret-12345', KEK_V1_BASE64: Buffer.alloc(32, 1).toString('base64') }), db: new FixtureDb() });
  t.after(() => app.close());
  for (const method of ['GET', 'DELETE'] as const) { const res = await app.inject({ method, url: '/mcp' }); assert.equal(res.statusCode, 405); assert.equal(res.headers.allow, 'POST'); }
  const discover = await app.inject({ method: 'POST', url: '/mcp', headers: headers(), payload: body() });
  assert.equal(discover.statusCode, 200);
  assert.deepEqual(discover.json().result.supportedVersions, [MCP_VERSION]);
  assert.equal(discover.json().result.resultType, 'complete');
  assert.equal(discover.json().result._meta['io.modelcontextprotocol/serverInfo'].name, 'memocean');
  assert.equal(discover.headers['mcp-session-id'], undefined);
  assert.ok(String(discover.headers['content-security-policy']).includes("default-src 'none'"));
  const unsupported = await app.inject({ method: 'POST', url: '/mcp', headers: { ...headers(), 'mcp-protocol-version': '2025-11-25' }, payload: body() });
  assert.equal(unsupported.statusCode, 400); assert.equal(unsupported.json().error.code, -32022);
  const mismatch = await app.inject({ method: 'POST', url: '/mcp', headers: headers('tools/list'), payload: body() });
  assert.equal(mismatch.json().error.code, -32020);
  const invalid = await app.inject({ method: 'POST', url: '/mcp', headers: headers('tools/call', 'recall'), payload: body('tools/call', { name: 'recall', arguments: { query: 'No project' } }) });
  assert.equal(invalid.json().error.code, -32602);
  const forbidden = await app.inject({ method: 'POST', url: '/mcp', headers: headers('tools/call', 'remember'), payload: body('tools/call', { name: 'remember', arguments: { project_id: randomUUID(), idempotency_key: randomUUID(), approved_draft_id: randomUUID(), approved_sha256: '0x' + 'a'.repeat(64), approval_token: 'a'.repeat(32), importance: 0.9, valid_from: '2026-11-18T00:00:00Z' } }) });
  assert.equal(forbidden.statusCode, 200); assert.equal(forbidden.json().result.isError, true); assert.equal(forbidden.json().result.structuredContent.code, 'FORBIDDEN');
  const unauthorized = await app.inject({ method: 'POST', url: '/mcp', headers: { ...headers(), authorization: '' }, payload: body() });
  assert.equal(unauthorized.statusCode, 401);
  const unknown = await app.inject({ method: 'POST', url: '/mcp', headers: headers('initialize'), payload: body('initialize') });
  assert.equal(unknown.statusCode, 404); assert.equal(unknown.json().error.code, -32601);
  const sse = await app.inject({ method: 'POST', url: '/mcp', headers: { ...headers(), accept: 'text/event-stream' }, payload: body() });
  assert.equal(sse.statusCode, 200); assert.match(String(sse.headers['content-type']), /text\/event-stream/); assert.ok(sse.body.startsWith('event: message\ndata: ')); assert.equal(sse.headers['x-accel-buffering'], 'no');
  const hostile = await app.inject({ method: 'POST', url: '/mcp', headers: { ...headers(), origin: 'https://evil.invalid' }, payload: body() });
  assert.equal(hostile.statusCode, 403);
  const malformed = await app.inject({ method: 'POST', url: '/mcp', headers: { ...headers(), 'content-type': 'application/json' }, payload: '{not-json' });
  assert.equal(malformed.statusCode, 400); assert.equal(malformed.json().error.code, -32700);
  const oversize = await app.inject({ method: 'POST', url: '/v1/drafts', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ sanitized_text: 'x'.repeat(270000) }) });
  assert.equal(oversize.statusCode, 413);
  const health = await app.inject('/healthz'); assert.equal(health.statusCode, 503); assert.equal(health.json().integrations.permanent_storage, 'blocked_supported_verifier_required');
  assert.equal((await app.inject('/health/live')).statusCode, 200);
});

class StatefulPatDb extends Database {
  private readonly pepper = 'synthetic-pepper-not-a-real-secret-12345';
  private readonly managerToken = `mo_session_${'m'.repeat(43)}`;
  private readonly managerHash = hashToken(this.managerToken, this.pepper);
  private readonly keys = new Map<string, { id: string; name: string; prefix: string; tokenHash: Buffer; scopes: string[]; projectIds: string[]; expiresAt: string; revoked: boolean }>();

  get managementToken() { return this.managerToken; }

  override async query(sql: string, values: unknown[] = []): Promise<any> {
    if (sql.includes('memocean_authenticate')) {
      const tokenHash = values[0] as Buffer;
      if (tokenHash.equals(this.managerHash)) return { rows: [{ user_id: userId, tenant_id: tenantId, scopes: ['account:manage', 'memory:read'], project_ids: [], token_id: 'session-1', token_kind: 'session' }], rowCount: 1 };
      const key = [...this.keys.values()].find((item) => item.tokenHash.equals(tokenHash) && !item.revoked);
      return { rows: key ? [{ user_id: userId, tenant_id: tenantId, scopes: key.scopes, project_ids: key.projectIds, token_id: key.id, token_kind: 'pat' }] : [], rowCount: key ? 1 : 0 };
    }
    if (sql.includes('memocean_request_limit')) return { rows: [{ allowed: true }], rowCount: 1 };
    if (sql.startsWith('INSERT INTO api_keys')) {
      const [,, name, prefix, tokenHash, scopes, projectIds, expiresAt] = values as [unknown, unknown, string, string, Buffer, string[], string[], string];
      const id = randomUUID();
      this.keys.set(id, { id, name, prefix, tokenHash, scopes, projectIds, expiresAt, revoked: false });
      return { rows: [{ id, name, prefix, scopes, project_ids: projectIds, expires_at: expiresAt }], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE api_keys SET revoked_at')) {
      const key = this.keys.get(values[0] as string);
      if (key) key.revoked = true;
      return { rows: [], rowCount: key ? 1 : 0 };
    }
    if (sql.includes('app_project')) return { rows: [{ allowed: true }], rowCount: 1 };
    throw new Error(`Unexpected fixture database access: ${sql}`);
  }

  override async transaction<T>(_principal: any, fn: (tx: any) => Promise<T>): Promise<T> { return fn(this); }
  override async close() {}
}

test('PAT lifecycle creates, authenticates to MCP, revokes, then rejects the token', async (t) => {
  const db = new StatefulPatDb();
  const app = await buildApp({ config: loadConfig({ NODE_ENV: 'test', TOKEN_HASH_PEPPER: 'synthetic-pepper-not-a-real-secret-12345', KEK_V1_BASE64: Buffer.alloc(32, 1).toString('base64') }), db });
  t.after(() => app.close());
  const managementHeaders = { authorization: `Bearer ${db.managementToken}` };
  const created = await app.inject({ method: 'POST', url: '/v1/tokens', headers: managementHeaders, payload: { name: 'mcp pilot', scopes: ['memory:read'], project_ids: [] } });
  assert.equal(created.statusCode, 201, created.body);
  const createdBody = created.json() as { id: string; token: string; displayed_once: boolean };
  assert.equal(createdBody.displayed_once, true);
  assert.match(createdBody.token, /^mo_pat_[A-Za-z0-9_-]{43}$/);

  const mcpHeaders = { ...headers(), authorization: `Bearer ${createdBody.token}` };
  const usable = await app.inject({ method: 'POST', url: '/mcp', headers: mcpHeaders, payload: body() });
  assert.equal(usable.statusCode, 200);

  const revoked = await app.inject({ method: 'DELETE', url: `/v1/tokens/${createdBody.id}`, headers: managementHeaders });
  assert.equal(revoked.statusCode, 204);
  const rejected = await app.inject({ method: 'POST', url: '/mcp', headers: mcpHeaders, payload: body() });
  assert.equal(rejected.statusCode, 401);
});
