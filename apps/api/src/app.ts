import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { loadConfig, readinessConfig, type Config } from './config.js';
import { Database, authorizeProject, requireScope } from './db.js';
import { ApiError, CryptoBox, publicError } from './security.js';
import { AnthropicGeneration, IrysStorage, VoyageEmbedding, type GenerationProvider, type EmbeddingProvider, type StorageProvider } from './providers.js';
import { AuthService } from './auth.js';
import { DraftService } from './drafts.js';
import { RagService } from './rag.js';
import { ResourceService } from './resources.js';
import { registerMcp } from './mcp.js';
import { uuid } from './schemas.js';

export interface AppOptions { config?: Config; db?: Database; generation?: GenerationProvider; embeddings?: EmbeddingProvider; storage?: StorageProvider; logger?: boolean }
export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const db = options.db ?? new Database(config.DATABASE_URL);
  const box = new CryptoBox(config.KEK_V1_BASE64);
  const generation = options.generation ?? new AnthropicGeneration(config), embeddings = options.embeddings ?? new VoyageEmbedding(config), storage = options.storage ?? new IrysStorage();
  const auth = new AuthService(db, config), drafts = new DraftService(db, box, generation, config), rag = new RagService(db, embeddings, generation, box, config), resources = new ResourceService(db, box, storage, config);
  const app = Fastify({ bodyLimit: 256 * 1024, requestTimeout: 60000, connectionTimeout: 10000, keepAliveTimeout: 5000, maxParamLength: 512, trustProxy: false, genReqId: () => randomUUID(), disableRequestLogging: true, logger: options.logger ? { level: 'info', redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]', 'headers.authorization', 'body', 'query', '*.token', '*.approval_token', '*.signature', '*.nonce', '*.sanitized_text', '*.question', '*.message'], censor: '[REDACTED]' }, serializers: { req: (req: any) => ({ method: req.method }), res: (res: any) => ({ statusCode: res.statusCode }) } } : false });
  await app.register(cors, { origin: config.WEB_ORIGIN, methods: ['GET', 'POST', 'DELETE', 'OPTIONS'], allowedHeaders: ['Authorization', 'Content-Type', 'MCP-Protocol-Version', 'Mcp-Method', 'Mcp-Name', 'Accept'], credentials: false, strictPreflight: true });
  await app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } });
  await app.register(rateLimit, { max: 60, timeWindow: '1 minute', keyGenerator: (req) => req.ip, errorResponseBuilder: () => ({ kind: 'error', code: 'RATE_LIMITED', message: 'Request rate limit exceeded', retryable: true }) });
  app.addHook('onRequest', async (req, reply) => {
    if (req.headers.origin && req.headers.origin !== config.WEB_ORIGIN) throw new ApiError('FORBIDDEN', 'Origin is not allowed', 403);
    if (Object.keys(req.query as object).some((key) => /token|authorization|api.?key/i.test(key))) throw new ApiError('UNAUTHENTICATED', 'Credentials must be sent only through the Authorization header', 401);
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').header('X-Request-Id', req.id);
  });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send(publicError(new ApiError('INVALID_INPUT', 'Request does not match the documented input schema'), req.id));
    if (error instanceof ApiError) return reply.code(error.status).send(publicError(error, req.id));
    const frameworkError = typeof error === 'object' && error !== null ? error as { code?: unknown; statusCode?: unknown } : {};
    const code = typeof frameworkError.code === 'string' ? frameworkError.code : undefined;
    const statusCode = typeof frameworkError.statusCode === 'number' ? frameworkError.statusCode : undefined;
    if (code === 'FST_ERR_CTP_INVALID_JSON_BODY') return reply.code(400).send(req.url.split('?')[0] === '/mcp' ? { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } : publicError(new ApiError('INVALID_INPUT', 'Invalid JSON body'), req.id));
    if (statusCode === 413) return reply.code(413).send(publicError(new ApiError('INVALID_INPUT', 'Body exceeds the 256 KiB limit', 413), req.id));
    if (statusCode === 429) return reply.code(429).header('Retry-After', '60').send(publicError(new ApiError('RATE_LIMITED', 'Request rate limit exceeded', 429, true), req.id));
    if (statusCode !== undefined && statusCode < 500) return reply.code(statusCode).send(publicError(new ApiError('INVALID_INPUT', 'Request could not be accepted', statusCode), req.id));
    return reply.code(500).send(publicError(error, req.id));
  });
  app.get('/health/live', async () => ({ status: 'alive' }));
  app.get('/healthz', async (_req, reply) => {
    const missing = readinessConfig(config);
    let database = false; try { database = await db.ready(); } catch { /* No connection string or credentials are disclosed. */ }
    return reply.code(database && !missing.length ? 200 : 503).send({ status: database && !missing.length ? 'ready' : 'not_ready', database, missing_config: missing, integrations: { generation: generation.configured ? 'configured_not_live_verified' : 'unavailable', embeddings: embeddings.configured ? 'configured_not_live_verified' : 'unavailable', permanent_storage: storage.permanenceSupported ? 'adapter_configured' : 'blocked_supported_verifier_required', oauth: 'not_implemented' } });
  });
  app.post('/v1/auth/challenge', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => auth.challenge(req.body));
  app.post('/v1/auth/verify', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => auth.verify(req.body));
  app.delete('/v1/auth/session', async (req, reply) => { await auth.logout(req.headers.authorization); return reply.code(204).send(); });
  app.get('/v1/me', async (req) => { const p = await auth.authenticate(req.headers.authorization); return { user_id: p.userId, tenant_id: p.tenantId, scopes: p.scopes, project_ids: p.projectIds, auth_mode: p.tokenKind }; });
  app.get('/v1/projects', async (req) => resources.projects(await auth.authenticate(req.headers.authorization)));
  app.post('/v1/projects', async (req, reply) => {
    const p = await auth.authenticate(req.headers.authorization); requireScope(p, 'account:manage');
    const value = z.object({ name: z.string().min(1).max(120) }).strict().parse(req.body), id = randomUUID();
    await db.transaction(p, async (tx) => {
      await tx.query('INSERT INTO projects(id,tenant_id,name) VALUES($1,$2,$3)', [id, p.tenantId, value.name]);
      await tx.query("INSERT INTO project_acl(project_id,tenant_id,user_id,permission) VALUES($1,$2,$3,'admin')", [id, p.tenantId, p.userId]);
    });
    return reply.code(201).send({ id, name: value.name });
  });
  app.post('/v1/tokens', async (req, reply) => reply.code(201).send(await auth.createPat(await auth.authenticate(req.headers.authorization), req.body)));
  app.get('/v1/tokens', async (req) => { const p = await auth.authenticate(req.headers.authorization); requireScope(p, 'account:manage'); return db.transaction(p, async (tx) => ({ items: (await tx.query('SELECT id,name,prefix,scopes,project_ids,created_at,expires_at,revoked_at FROM api_keys WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', [p.userId])).rows })); });
  app.delete<{ Params: { id: string } }>('/v1/tokens/:id', async (req, reply) => { await auth.revokePat(await auth.authenticate(req.headers.authorization), uuid.parse(req.params.id)); return reply.code(204).send(); });
  app.post('/v1/drafts', async (req, reply) => reply.code(201).send(await drafts.create(await auth.authenticate(req.headers.authorization), req.body)));
  app.get<{ Params: { id: string } }>('/v1/drafts/:id', async (req) => drafts.get(await auth.authenticate(req.headers.authorization), uuid.parse(req.params.id)));
  app.post<{ Params: { id: string } }>('/v1/drafts/:id/egress-approve', async (req) => drafts.approveEgress(await auth.authenticate(req.headers.authorization), uuid.parse(req.params.id), req.body));
  app.post<{ Params: { id: string } }>('/v1/drafts/:id/distill', async (req) => { z.object({}).strict().parse(req.body ?? {}); const signal = new AbortController(); req.raw.once('aborted', () => signal.abort()); return drafts.distill(await auth.authenticate(req.headers.authorization), uuid.parse(req.params.id), signal.signal); });
  app.post<{ Params: { id: string } }>('/v1/drafts/:id/approve', async (req) => drafts.approve(await auth.authenticate(req.headers.authorization), uuid.parse(req.params.id), req.body));
  app.post('/v1/remember', async (req, reply) => reply.code(202).send(await drafts.remember(await auth.authenticate(req.headers.authorization), req.body)));
  app.post('/v1/recall', async (req) => rag.recall(await auth.authenticate(req.headers.authorization), req.body));
  app.post('/v1/chat', async (req) => rag.chat(await auth.authenticate(req.headers.authorization), req.body));
  app.post('/v1/capsules/query', async (req) => rag.query(await auth.authenticate(req.headers.authorization), req.body));
  app.get('/v1/capsules', async () => ({ items: (await db.query('SELECT * FROM memocean_catalog()')).rows }));
  app.get('/v1/entitlements', async (req) => { const p = await auth.authenticate(req.headers.authorization); requireScope(p, 'capsule:query'); return db.transaction(p, async (tx) => ({ items: (await tx.query("SELECT e.id,e.capsule_version_id,e.state,e.last_chain_check_at,app_entitled(e.capsule_version_id) AS access_current FROM entitlements e WHERE user_id=$1 ORDER BY e.id LIMIT 100", [p.userId])).rows })); });
  app.post<{ Params: { id: string } }>('/v1/capsules/:id/sync', async (req) => {
    const p = await auth.authenticate(req.headers.authorization); requireScope(p, 'capsule:query'); const id = uuid.parse(req.params.id), value = z.object({ project_id: uuid }).strict().parse(req.body);
    return db.transaction(p, async (tx) => {
      await authorizeProject(tx, p, value.project_id, true);
      const entitlement = (await tx.query("SELECT id FROM entitlements WHERE user_id=$1 AND capsule_version_id=$2 AND app_entitled(capsule_version_id) LIMIT 1", [p.userId, id])).rows[0];
      if (!entitlement) throw new ApiError('FORBIDDEN', 'Confirmed exact-version buyer entitlement is required; client receipts never unlock access', 403);
      await tx.query('INSERT INTO project_capsules(tenant_id,project_id,user_id,entitlement_id,capsule_version_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(project_id,user_id,capsule_version_id) DO UPDATE SET entitlement_id=excluded.entitlement_id', [p.tenantId, value.project_id, p.userId, entitlement.id, id]);
      return { capsule_version_id: id, project_id: value.project_id, synced: true, resource_uri: `memocean://capsules/${id}` };
    });
  });
  app.get<{ Params: { id: string } }>('/v1/jobs/:id', async (req) => resources.job(await auth.authenticate(req.headers.authorization), uuid.parse(req.params.id)));
  app.post('/v1/provenance/verify', async (req) => resources.provenance(await auth.authenticate(req.headers.authorization), req.body));
  registerMcp(app, { auth, drafts, rag, resources, db });
  app.addHook('onClose', async () => { if (!options.db) await db.close(); });
  return app;
}
