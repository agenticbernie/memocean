import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from './config.js';
import { Database, sealedFromRow, type Tx } from './db.js';
import { ApiError, CryptoBox, canonical, equal, scanText, sha256 } from './security.js';
import { lessonSchema } from './schemas.js';
import type { EmbeddingProvider, StorageProvider, UploadResult } from './providers.js';

interface Job { id: string; tenant_id: string; requested_by: string; lease_token: string; attempts: number; kind: string; payload: { artifact_id: string; memory_id: string; project_id: string; revision: number } }
export const CLAIM_JOBS_SQL = `WITH picked AS (SELECT id FROM jobs WHERE run_after<=now() AND attempts<5 AND (state IN ('queued','retry') OR (state='running' AND lease_until<now())) ORDER BY run_after,created_at FOR UPDATE SKIP LOCKED LIMIT $1) UPDATE jobs j SET state='running',attempts=attempts+1,lease_until=now()+interval '60 seconds',lease_token=gen_random_uuid() FROM picked WHERE j.id=picked.id RETURNING j.*`;
export async function ensureLease(tx: Tx, job: Job): Promise<void> {
  const result = await tx.query("SELECT id FROM jobs WHERE id=$1 AND lease_token=$2 AND state='running' AND lease_until>now() FOR UPDATE", [job.id, job.lease_token]);
  if (!result.rowCount) throw new ApiError('LEASE_LOST', 'The worker no longer owns this operation', 409);
}
export class JobWorker {
  private stopping = false;
  private loop?: Promise<void>;
  constructor(private readonly db: Database, private readonly box: CryptoBox, private readonly storage: StorageProvider, private readonly embeddings: EmbeddingProvider, private readonly config: Config) {}
  start(): void { if (!this.loop) this.loop = this.run(); }
  private async run(): Promise<void> {
    while (!this.stopping) {
      try { await this.tick(); } catch { /* Database/provider outages remain durable, no content is logged. */ }
      if (!this.stopping) await delay(1000);
    }
  }
  async stop(): Promise<void> { this.stopping = true; await this.loop; }
  async tick(): Promise<number> {
    const abandoned = (await this.db.query("SELECT id,user_id,capsule_root_id FROM trial_attempts WHERE state='reserved' AND created_at<now()-interval '5 minutes' ORDER BY created_at LIMIT 100")).rows;
    for (const attempt of abandoned) await this.db.transaction(null, async (tx) => {
      await tx.query('SELECT used_count FROM trial_counters WHERE user_id=$1 AND capsule_root_id=$2 FOR UPDATE', [attempt.user_id, attempt.capsule_root_id]);
      const refunded = await tx.query("UPDATE trial_attempts SET state='refunded' WHERE id=$1 AND state='reserved' AND created_at<now()-interval '5 minutes' RETURNING id", [attempt.id]);
      if (refunded.rowCount) await tx.query('UPDATE trial_counters SET used_count=used_count-1 WHERE user_id=$1 AND capsule_root_id=$2 AND used_count>0', [attempt.user_id, attempt.capsule_root_id]);
    });
    await this.db.query("UPDATE paid_query_attempts SET state='failed' WHERE state='reserved' AND created_at<now()-interval '5 minutes'");
    // A possibly dispatched inference is never retried automatically. Expiry remains charged.
    await this.db.query("UPDATE trial_attempts SET state='failed_charged',lease_until=NULL WHERE state='running' AND lease_until<now()");
    await this.db.query("UPDATE paid_query_attempts SET state='failed',lease_until=NULL WHERE state='running' AND lease_until<now()");
    await this.db.query("UPDATE jobs SET state='failed',last_error='RETRY_EXHAUSTED',lease_until=NULL WHERE attempts>=5 AND (state IN ('queued','retry') OR (state='running' AND lease_until<now()))");
    const jobs = await this.db.transaction(null, async (tx) => (await tx.query<Job>(CLAIM_JOBS_SQL, [this.config.JOB_CONCURRENCY])).rows);
    await Promise.all(jobs.map((job) => this.process(job)));
    return jobs.length;
  }
  private async process(job: Job): Promise<void> {
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      void this.db.query("UPDATE jobs SET lease_until=now()+interval '60 seconds' WHERE id=$1 AND lease_token=$2 AND state='running' AND lease_until>now() RETURNING id", [job.id, job.lease_token]).then((r) => { if (!r.rowCount) leaseLost = true; }).catch(() => { leaseLost = true; });
    }, 20000);
    heartbeat.unref();
    try {
      if (job.kind !== 'upload') throw new ApiError('INTEGRATION_UNAVAILABLE', 'This job kind is not enabled by the current worker', 503);
      if (!this.storage.available || !this.storage.permanenceSupported) throw new ApiError('INTEGRATION_UNAVAILABLE', 'Irys permanent-mode and finalized Publish verifier integration are unavailable; no upload attempted', 503);
      if (leaseLost) throw new ApiError('LEASE_LOST', 'Operation lease expired', 409);
      await this.uploadAndIndex(job);
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'LEASE_LOST') {
        const code = error instanceof ApiError ? error.code : 'UPSTREAM_UNAVAILABLE';
        const terminal = job.attempts >= 5 || ['INTEGRATION_UNAVAILABLE', 'EVIDENCE_INVALID'].includes(code);
        await this.db.transaction(null, async (tx) => {
          await ensureLease(tx, job);
          if (code === 'EVIDENCE_INVALID') await tx.query("UPDATE artifacts SET state='quarantined',last_error=$2 WHERE id=$1", [job.payload.artifact_id, code]);
          await tx.query("UPDATE jobs SET state=$3,last_error=$4,lease_until=NULL,run_after=now()+($5::integer*interval '1 second') WHERE id=$1 AND lease_token=$2 AND lease_until>now()", [job.id, job.lease_token, terminal ? 'failed' : 'retry', code, Math.min(300, 2 ** job.attempts + Math.floor(Math.random() * 5))]);
        }).catch(() => undefined);
      }
    } finally { clearInterval(heartbeat); }
  }
  private async uploadAndIndex(job: Job): Promise<void> {
    let row = await this.db.transaction(null, async (tx) => {
      await ensureLease(tx, job);
      const row = (await tx.query('SELECT a.*,k.kek_version,k.wrapped_dek,k.wrapping_nonce,k.wrapping_tag FROM artifacts a JOIN key_envelopes k ON k.id=a.key_envelope_id AND k.tenant_id=a.tenant_id WHERE a.id=$1 AND a.tenant_id=$2 FOR UPDATE OF a', [job.payload.artifact_id, job.tenant_id])).rows[0];
      if (!row || row.state === 'quarantined') throw new ApiError('EVIDENCE_INVALID', 'Artifact is missing or quarantined', 409);
      if (row.state === 'staged' || row.state === 'failed') await tx.query("UPDATE artifacts SET state='uploading' WHERE id=$1", [row.id]);
      return row;
    });
    const manifestBytes = Buffer.from(canonical(row.public_manifest));
    if (!equal(sha256(manifestBytes), row.manifest_sha256)) throw new ApiError('EVIDENCE_INVALID', 'Staged manifest hash mismatch', 409);
    let txRow = (await this.db.query('SELECT * FROM irys_transactions WHERE artifact_id=$1', [row.id])).rows[0];
    if (!txRow) {
      if (!row.staging_ciphertext || !equal(sha256(row.staging_ciphertext), row.cipher_sha256)) throw new ApiError('EVIDENCE_INVALID', 'Staged ciphertext hash mismatch', 409);
      const cipher = await this.storage.upload(row.staging_ciphertext, 'application/octet-stream', `cipher:${row.id}`);
      await this.db.transaction(null, async (tx) => {
        await ensureLease(tx, job);
        // Cipher ID is persisted before a manifest upload can occur; recovery never forgets this step.
        await tx.query('INSERT INTO irys_transactions(tx_id,artifact_id,network,storage_product,gateway_base_url,receipt,uploaded_at) VALUES($1,$2,$3,$4,$5,$6,now()) ON CONFLICT(artifact_id) DO NOTHING', [cipher.id, row.id, cipher.network, cipher.storageProduct, cipher.gatewayBaseUrl, cipher.response]);
      });
      txRow = (await this.db.query('SELECT * FROM irys_transactions WHERE artifact_id=$1', [row.id])).rows[0]!;
    }
    const cipher: UploadResult = { id: txRow.tx_id, response: txRow.receipt, network: txRow.network, storageProduct: txRow.storage_product, gatewayBaseUrl: txRow.gateway_base_url };
    if (!txRow.manifest_tx_id) {
      const manifest = await this.storage.upload(manifestBytes, 'application/json', `manifest:${row.id}`);
      if (manifest.network !== cipher.network || manifest.storageProduct !== cipher.storageProduct || manifest.gatewayBaseUrl !== cipher.gatewayBaseUrl) throw new ApiError('EVIDENCE_INVALID', 'Storage product changed between artifact uploads', 409);
      await this.db.transaction(null, async (tx) => {
        await ensureLease(tx, job);
        await tx.query('UPDATE irys_transactions SET manifest_tx_id=$2,manifest_receipt=$3 WHERE artifact_id=$1 AND manifest_tx_id IS NULL', [row.id, manifest.id, manifest.response]);
        await tx.query("UPDATE artifacts SET state='uploaded' WHERE id=$1", [row.id]);
      });
      txRow = (await this.db.query('SELECT * FROM irys_transactions WHERE artifact_id=$1', [row.id])).rows[0]!;
    }
    const manifest: UploadResult = { ...cipher, id: txRow.manifest_tx_id, response: txRow.manifest_receipt };
    const evidence = await this.storage.verify(cipher, manifest, row.cipher_sha256, row.manifest_sha256);
    if (!equal(evidence.cipherHash, row.cipher_sha256) || !equal(evidence.manifestHash, row.manifest_sha256) || !evidence.permanenceVerified || cipher.storageProduct !== 'permanent' || !Object.keys(evidence.evidence).length) throw new ApiError('EVIDENCE_INVALID', 'Storage proof is incomplete or does not establish permanent mode', 409);
    const ciphertext = await this.storage.fetchVerified(cipher.id, row.cipher_sha256, cipher.gatewayBaseUrl);
    const fetchedManifest = await this.storage.fetchVerified(manifest.id, row.manifest_sha256, manifest.gatewayBaseUrl);
    if (!equal(sha256(ciphertext), row.cipher_sha256) || !equal(sha256(fetchedManifest), row.manifest_sha256)) throw new ApiError('EVIDENCE_INVALID', 'Retrieved storage bytes do not match approved commitments', 409);
    const unpacked = this.box.open<{ salt: string; payload: unknown }>({ ...sealedFromRow(row, 'staging_ciphertext'), ciphertext }, `artifact:${job.tenant_id}:${job.payload.memory_id}:${job.payload.revision}:v1`);
    const lesson = lessonSchema.parse(unpacked.payload), salt = Buffer.from(unpacked.salt, 'base64');
    if (salt.length !== 32 || !equal(sha256(Buffer.concat([salt, Buffer.from(canonical(lesson))])), row.plain_commitment)) throw new ApiError('EVIDENCE_INVALID', 'Decrypted content commitment mismatch', 409);
    scanText(JSON.stringify(lesson));
    await this.db.transaction(null, async (tx) => {
      await ensureLease(tx, job);
      await tx.query('UPDATE irys_transactions SET verified_at=now(),permanence_verified=true,storage_verification_evidence=$2,verified_cipher_sha256=$3,verified_manifest_sha256=$4 WHERE artifact_id=$1', [row.id, evidence.evidence, row.cipher_sha256, row.manifest_sha256]);
      await tx.query("UPDATE artifacts SET state='verified' WHERE id=$1 AND state<>'indexed'", [row.id]);
    });
    const chunks = [
      ...lesson.rules.map((item, i) => ({ locator: `/rules/${i}/statement`, text: item.statement })),
      ...lesson.anti_patterns.flatMap((item, i) => [{ locator: `/anti_patterns/${i}/symptom`, text: item.symptom }, { locator: `/anti_patterns/${i}/correction`, text: item.correction }]),
      ...lesson.few_shot_examples.flatMap((item, i) => [{ locator: `/few_shot_examples/${i}/input`, text: item.input }, { locator: `/few_shot_examples/${i}/good_output`, text: item.good_output }, { locator: `/few_shot_examples/${i}/explanation`, text: item.explanation }]),
    ].flatMap((chunk) => {
      const pieces = []; for (let start = 0; start < chunk.text.length; start += 1800) pieces.push({ locator: `${chunk.locator}#utf16=${start}:${Math.min(start + 1800, chunk.text.length)}`, text: chunk.text.slice(start, start + 1800) }); return pieces;
    });
    if (!chunks.length) throw new ApiError('EVIDENCE_INVALID', 'No reusable lessons were approved for indexing', 409);
    const vectors: number[][] = [];
    for (let i = 0; i < chunks.length; i += 32) vectors.push(...await this.embeddings.embed(chunks.slice(i, i + 32).map((item) => item.text), 'document'));
    await this.db.transaction(null, async (tx) => {
      await ensureLease(tx, job);
      const revision = (await tx.query('SELECT id FROM memory_revisions WHERE memory_id=$1 AND revision=$2 AND artifact_id=$3', [job.payload.memory_id, job.payload.revision, row.id])).rows[0];
      if (!revision) throw new ApiError('EVIDENCE_INVALID', 'Revision mapping is missing', 409);
      for (let i = 0; i < chunks.length; i++) await tx.query("INSERT INTO memory_chunks(tenant_id,revision_id,ordinal,locator,sanitized_text,embedding,embedding_model) VALUES($1,$2,$3,$4,$5,$6::vector,'voyage-3.5-lite') ON CONFLICT(revision_id,ordinal) DO NOTHING", [job.tenant_id, revision.id, i, chunks[i]!.locator, chunks[i]!.text, `[${vectors[i]!.join(',')}]`]);
      await tx.query("UPDATE artifacts SET state='indexed',indexed_payload_sha256=$2 WHERE id=$1 AND state IN ('verified','indexed')", [row.id, sha256(canonical(lesson))]);
      await tx.query("UPDATE jobs SET state='succeeded',result=$3,lease_until=NULL,last_error=NULL WHERE id=$1 AND lease_token=$2 AND lease_until>now()", [job.id, job.lease_token, { memory_id: job.payload.memory_id, artifact_id: row.id }]);
      await tx.query('UPDATE outbox SET published_at=now() WHERE aggregate_id=$1 AND published_at IS NULL', [job.id]);
    });
  }
}
