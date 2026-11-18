import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().url().optional(),
  MIGRATION_DATABASE_URL: z.string().url().optional(),
  WORKER_DATABASE_URL: z.string().url().optional(),
  PUBLIC_API_URL: z.string().url().default('http://localhost:3000'),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  AUTH_DOMAIN: z.string().default('localhost:5173'),
  CHAIN_ID: z.coerce.number().int().positive().default(43113),
  TOKEN_HASH_PEPPER: z.string().min(32).optional(),
  KEK_V1_BASE64: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_MODEL: z.string().min(1).default('claude-opus-5-5'),
  EMBEDDING_API_KEY: z.string().min(1).optional(),
  EMBEDDING_MODEL: z.literal('voyage-3.5-lite').default('voyage-3.5-lite'),
  EMBEDDING_DIMENSIONS: z.coerce.number().pipe(z.literal(1024)).default(1024),
  JOB_CONCURRENCY: z.coerce.number().int().min(1).max(2).default(2),
  USER_DAILY_MODEL_LIMIT: z.coerce.number().int().positive().default(100),
  GLOBAL_DAILY_MODEL_LIMIT: z.coerce.number().int().positive().default(1000),
  ENABLE_WORKER: z.enum(['true', 'false']).default('false'),
  AVALANCHE_RPC_URL: z.string().url().optional(),
  MARKETPLACE_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  CHAIN_CONFIRMATIONS: z.coerce.number().int().min(1).default(3),
});
export type Config = z.infer<typeof envSchema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config = envSchema.parse(env);
  if (config.AUTH_DOMAIN !== new URL(config.WEB_ORIGIN).host || config.AUTH_DOMAIN.includes('*')) throw new Error('AUTH_DOMAIN must exactly match the WEB_ORIGIN host');
  if (config.KEK_V1_BASE64 && (Buffer.from(config.KEK_V1_BASE64, 'base64').length !== 32 || Buffer.from(config.KEK_V1_BASE64, 'base64').toString('base64') !== config.KEK_V1_BASE64)) {
    throw new Error('KEK_V1_BASE64 must decode to exactly 32 bytes');
  }
  if (config.NODE_ENV === 'production') {
    if (!config.DATABASE_URL || !config.TOKEN_HASH_PEPPER || !config.KEK_V1_BASE64) {
      throw new Error('Production requires DATABASE_URL, TOKEN_HASH_PEPPER and KEK_V1_BASE64');
    }
    if (!config.PUBLIC_API_URL.startsWith('https:') || !config.WEB_ORIGIN.startsWith('https:')) {
      throw new Error('Production public origins must use HTTPS');
    }
    if (config.MIGRATION_DATABASE_URL === config.DATABASE_URL) {
      throw new Error('Migration and request database credentials must be separate');
    }
  }
  return config;
}
export function readinessConfig(config: Config): string[] {
  return (['DATABASE_URL', 'TOKEN_HASH_PEPPER', 'KEK_V1_BASE64'] as const).filter((key) => !config[key]);
}
