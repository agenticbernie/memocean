import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { Database } from './db.js';
import { CryptoBox } from './security.js';
import { IrysStorage, OpenAICompatibleEmbedding } from './providers.js';
import { JobWorker } from './jobs.js';
import { AvalancheReader, MarketplaceIndexer } from './chain.js';

const config = loadConfig();
const app = await buildApp({ config, logger: true });
let worker: JobWorker | undefined, workerDb: Database | undefined, chainTimer: NodeJS.Timeout | undefined;
if (config.ENABLE_WORKER === 'true') {
  if (!config.WORKER_DATABASE_URL || config.WORKER_DATABASE_URL === config.DATABASE_URL) throw new Error('A separate WORKER_DATABASE_URL is required to enable background jobs');
  workerDb = new Database(config.WORKER_DATABASE_URL);
  worker = new JobWorker(workerDb, new CryptoBox(config.KEK_V1_BASE64), new IrysStorage(), new OpenAICompatibleEmbedding(config), config);
  worker.start();
  if (config.AVALANCHE_RPC_URL) {
    const indexer = new MarketplaceIndexer(workerDb, new AvalancheReader(config.AVALANCHE_RPC_URL), config);
    let polling = false;
    chainTimer = setInterval(() => {
      if (polling) return;
      polling = true;
      void indexer.tick().catch(() => { app.log.warn({ code: 'CHAIN_RECONCILIATION_UNAVAILABLE' }, 'Chain reconciliation failed closed'); }).finally(() => { polling = false; });
    }, 15000);
    chainTimer.unref();
  }
}
let stopping = false;
async function shutdown() {
  if (stopping) return; stopping = true;
  if (chainTimer) clearInterval(chainTimer);
  const hardStop = setTimeout(() => process.exit(1), 55000); hardStop.unref();
  await worker?.stop();
  await app.close();
  await workerDb?.close();
  clearTimeout(hardStop);
}
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
await app.listen({ host: '0.0.0.0', port: config.PORT });
