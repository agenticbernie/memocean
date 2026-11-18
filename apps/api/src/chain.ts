import { createPublicClient, http, keccak256, parseAbi, parseAbiItem, encodeAbiParameters, stringToHex, type Address, type Hex } from 'viem';
import type { Config } from './config.js';
import { Database } from './db.js';
import { ApiError } from './security.js';

const purchaseEvent = parseAbiItem('event Purchased(uint256 indexed listingId,address indexed buyer,address indexed seller,uint256 paidWei,uint256 sellerWei,uint256 platformWei)');
const marketplaceAbi = parseAbi(['function hasPurchased(address buyer,uint256 listingId) view returns (bool)', 'function getListing(uint256 listingId) view returns ((bytes32 capsuleRoot,bytes16 capsuleUuid,uint32 version,uint16 commitmentVersion,address seller,address feeRecipient,uint16 feeBps,uint256 priceWei,bool active,string cipherIrysId,string manifestIrysId,bytes32 cipherSha256,bytes32 manifestSha256,bytes32 plainCommitment,bytes32 licenseSha256))']);
export interface ListingSnapshot { capsuleRoot: Hex; capsuleUuid: Hex; version: number; commitmentVersion: number; seller: Address; feeRecipient: Address; feeBps: number; priceWei: bigint; active: boolean; cipherIrysId: string; manifestIrysId: string; cipherSha256: Hex; manifestSha256: Hex; plainCommitment: Hex; licenseSha256: Hex }
export interface PurchaseLog { transactionHash: Hex; logIndex: number; blockNumber: bigint; blockHash: Hex; listingId: bigint; buyer: Address; seller: Address; paidWei: bigint; sellerWei: bigint; platformWei: bigint }
export interface ChainReader { chainId(): Promise<number>; height(): Promise<bigint>; blockHash(height: bigint): Promise<Hex>; code(address: Address): Promise<Hex>; purchases(address: Address, from: bigint, to: bigint): Promise<PurchaseLog[]>; hasPurchased(address: Address, buyer: Address, listing: bigint): Promise<boolean>; listing(address: Address, listing: bigint): Promise<ListingSnapshot> }
export class AvalancheReader implements ChainReader {
  private readonly client;
  constructor(rpcUrl: string) { this.client = createPublicClient({ transport: http(rpcUrl, { timeout: 15000, retryCount: 0 }) }); }
  chainId() { return this.client.getChainId(); }
  height() { return this.client.getBlockNumber(); }
  async blockHash(height: bigint): Promise<Hex> { return (await this.client.getBlock({ blockNumber: height })).hash; }
  async code(address: Address): Promise<Hex> { return (await this.client.getCode({ address })) ?? '0x'; }
  async hasPurchased(address: Address, buyer: Address, listing: bigint): Promise<boolean> { return this.client.readContract({ address, abi: marketplaceAbi, functionName: 'hasPurchased', args: [buyer, listing] }); }
  async listing(address: Address, listing: bigint): Promise<ListingSnapshot> { return this.client.readContract({ address, abi: marketplaceAbi, functionName: 'getListing', args: [listing] }); }
  async purchases(address: Address, from: bigint, to: bigint): Promise<PurchaseLog[]> {
    const logs = await this.client.getLogs({ address, event: purchaseEvent, fromBlock: from, toBlock: to, strict: true });
    return logs.filter((log) => !log.removed).map((log) => ({ transactionHash: log.transactionHash, logIndex: log.logIndex, blockNumber: log.blockNumber, blockHash: log.blockHash, listingId: log.args.listingId, buyer: log.args.buyer, seller: log.args.seller, paidWei: log.args.paidWei, sellerWei: log.args.sellerWei, platformWei: log.args.platformWei }));
  }
}
const rawHash = (hex: string): Buffer => Buffer.from(hex.slice(2), 'hex');
const matchesCuratedListing = (deployment: Record<string, any>, address: Address, listing: Record<string, any>, snapshot: ListingSnapshot): boolean => {
  const capsuleUuid = `0x${listing.capsule_root_id.replaceAll('-', '')}` as Hex;
  const derivedRoot = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'bytes16' }], [keccak256(stringToHex('MemOceanCapsuleRoot:v1')), BigInt(deployment.chain_id), address, listing.initial_seller as Address, capsuleUuid]));
  return snapshot.priceWei > 0n
    && snapshot.capsuleRoot.toLowerCase() === derivedRoot
    && rawHash(derivedRoot).equals(listing.onchain_root)
    && snapshot.capsuleUuid.toLowerCase() === capsuleUuid
    && BigInt(snapshot.version) === BigInt(listing.capsule_version)
    && snapshot.commitmentVersion === 1
    && snapshot.seller.toLowerCase() === listing.seller.toLowerCase()
    && snapshot.feeRecipient.toLowerCase() === listing.fee_recipient.toLowerCase()
    && snapshot.feeBps === Number(listing.fee_bps)
    && snapshot.cipherIrysId === listing.cipher_irys_id
    && snapshot.manifestIrysId === listing.manifest_tx_id
    && rawHash(snapshot.cipherSha256).equals(listing.cipher_sha256)
    && rawHash(snapshot.manifestSha256).equals(listing.manifest_sha256)
    && rawHash(snapshot.plainCommitment).equals(listing.plain_commitment)
    && rawHash(snapshot.licenseSha256).equals(listing.license_sha256);
};
export class MarketplaceIndexer {
  constructor(private readonly db: Database, private readonly reader: ChainReader, private readonly config: Config) {}
  async tick(): Promise<number> {
    const deployments = (await this.db.query('SELECT * FROM chain_deployments WHERE chain_id=$1 ORDER BY id', [this.config.CHAIN_ID])).rows;
    let confirmed = 0;
    for (const deployment of deployments) {
      const address = deployment.contract_address as Address;
      if (await this.reader.chainId() !== Number(deployment.chain_id) || !rawHash(keccak256(await this.reader.code(address))).equals(deployment.code_hash) || !rawHash(await this.reader.blockHash(BigInt(deployment.deployment_block))).equals(deployment.deployment_block_hash)) throw new ApiError('INTEGRATION_UNAVAILABLE', 'Marketplace deployment chain, code or genesis binding does not match', 503);
      await this.synchronizeCatalog(deployment, address);
      await this.reconcile(deployment.id, address);
      const height = await this.reader.height();
      const target = height - BigInt(this.config.CHAIN_CONFIRMATIONS - 1);
      const from = BigInt(deployment.finalized_cursor) + 1n;
      if (target < from) continue;
      const to = target < from + 999n ? target : from + 999n;
      const logs = await this.reader.purchases(address, from, to);
      const checked: Array<PurchaseLog & { snapshot: ListingSnapshot }> = [];
      for (const log of logs) {
        if (log.blockNumber < from || log.blockNumber > to || log.paidWei <= 0n || log.paidWei !== log.sellerWei + log.platformWei || log.buyer.toLowerCase() === log.seller.toLowerCase() || await this.reader.blockHash(log.blockNumber) !== log.blockHash || !await this.reader.hasPurchased(address, log.buyer, log.listingId)) continue;
        checked.push({ ...log, snapshot: await this.reader.listing(address, log.listingId) });
      }
      await this.db.transaction(null, async (tx) => {
        const lock = (await tx.query('SELECT finalized_cursor FROM chain_deployments WHERE id=$1 FOR UPDATE', [deployment.id])).rows[0];
        if (!lock || BigInt(lock.finalized_cursor) + 1n !== from) return; // Another replica advanced this cursor.
        for (const log of checked) {
          // Only a previously curated immutable version mapping can be licensed, never arbitrary chain spam.
          const listing = (await tx.query(`SELECT l.*,cv.id AS version_id,cv.version AS capsule_version,cv.license_sha256,rb.capsule_root_id,rb.initial_seller,rb.onchain_root,a.cipher_sha256,a.manifest_sha256,a.plain_commitment,it.tx_id AS cipher_irys_id,it.manifest_tx_id FROM listings l JOIN capsule_root_bindings rb ON rb.id=l.root_binding_id AND rb.deployment_id=l.deployment_id JOIN capsule_versions cv ON cv.id=l.capsule_version_id AND cv.root_id=rb.capsule_root_id JOIN artifacts a ON a.id=cv.artifact_id JOIN irys_transactions it ON it.artifact_id=a.id WHERE l.deployment_id=$1 AND l.listing_id=$2 AND l.seller=$3 AND cv.review_state='approved' AND a.state='indexed' AND it.verified_at IS NOT NULL AND it.permanence_verified`, [deployment.id, log.listingId.toString(), log.seller.toLowerCase()])).rows[0];
          if (!listing || log.platformWei !== log.paidWei * BigInt(listing.fee_bps) / 10000n) continue;
          const snapshot = log.snapshot;
          if (!matchesCuratedListing(deployment, address, listing, snapshot)) continue;
          const event = (await tx.query(`INSERT INTO chain_events(deployment_id,tx_hash,log_index,block_number,block_hash,event_name,decoded,state) VALUES($1,$2,$3,$4,$5,'Purchased',$6,'confirmed') ON CONFLICT(deployment_id,tx_hash,log_index) DO UPDATE SET state='confirmed',block_hash=excluded.block_hash,block_number=excluded.block_number RETURNING id`, [deployment.id, rawHash(log.transactionHash), log.logIndex, log.blockNumber.toString(), rawHash(log.blockHash), { listing_id: log.listingId.toString(), buyer: log.buyer.toLowerCase(), paid_wei: log.paidWei.toString() }])).rows[0]!;
          const buyer = (await tx.query('SELECT wb.user_id FROM wallet_bindings wb JOIN users u ON u.id=wb.user_id WHERE wb.address=$1 AND wb.revoked_at IS NULL AND u.disabled_at IS NULL', [log.buyer.toLowerCase()])).rows[0];
          const order = (await tx.query(`INSERT INTO orders(deployment_id,listing_row_id,event_id,buyer_wallet,buyer_user_id,paid_wei,state) VALUES($1,$2,$3,$4,$5,$6,'confirmed') ON CONFLICT(event_id) DO UPDATE SET state='confirmed',buyer_user_id=excluded.buyer_user_id RETURNING id`, [deployment.id, listing.id, event.id, log.buyer.toLowerCase(), buyer?.user_id ?? null, log.paidWei.toString()])).rows[0]!;
          if (buyer) await tx.query(`INSERT INTO entitlements(order_id,user_id,capsule_version_id,buyer_wallet,state,last_chain_check_at) VALUES($1,$2,$3,$4,'active',now()) ON CONFLICT(order_id) DO UPDATE SET state='active',last_chain_check_at=now()`, [order.id, buyer.user_id, listing.version_id, log.buyer.toLowerCase()]);
          confirmed++;
        }
        await tx.query('UPDATE chain_deployments SET finalized_cursor=$2 WHERE id=$1', [deployment.id, to.toString()]);
      });
    }
    return confirmed;
  }
  private async synchronizeCatalog(deployment: Record<string, any>, address: Address): Promise<void> {
    // Catalog is bounded to 50 visible curated listings; canonical reads converge after reorgs without event-specific cursors.
    const curated = (await this.db.query(`SELECT l.*,cv.version AS capsule_version,cv.license_sha256,rb.capsule_root_id,rb.initial_seller,rb.onchain_root,a.cipher_sha256,a.manifest_sha256,a.plain_commitment,it.tx_id AS cipher_irys_id,it.manifest_tx_id FROM listings l JOIN capsule_root_bindings rb ON rb.id=l.root_binding_id AND rb.deployment_id=l.deployment_id JOIN capsule_versions cv ON cv.id=l.capsule_version_id AND cv.root_id=rb.capsule_root_id JOIN capsules c ON c.root_id=rb.capsule_root_id JOIN artifacts a ON a.id=cv.artifact_id JOIN irys_transactions it ON it.artifact_id=a.id JOIN capsule_previews p ON p.capsule_version_id=cv.id JOIN artifacts pa ON pa.id=p.artifact_id JOIN irys_transactions pit ON pit.artifact_id=pa.id WHERE l.deployment_id=$1 AND l.active AND cv.review_state='approved' AND a.state='indexed' AND it.verified_at IS NOT NULL AND it.permanence_verified AND it.verified_cipher_sha256=a.cipher_sha256 AND it.verified_manifest_sha256=a.manifest_sha256 AND pa.id<>a.id AND pa.state='indexed' AND pit.verified_at IS NOT NULL AND pit.permanence_verified AND pit.verified_cipher_sha256=pa.cipher_sha256 AND pit.verified_manifest_sha256=pa.manifest_sha256 ORDER BY c.created_at DESC,c.root_id,cv.version DESC LIMIT 50`, [deployment.id])).rows;
    const snapshots: Array<{ listingId: string; snapshot: ListingSnapshot }> = [];
    for (const listing of curated) snapshots.push({ listingId: listing.id, snapshot: await this.reader.listing(address, BigInt(listing.listing_id)) });
    await this.db.transaction(null, async (tx) => {
      for (const candidate of snapshots) {
        const listing = (await tx.query(`SELECT l.*,cv.version AS capsule_version,cv.license_sha256,rb.capsule_root_id,rb.initial_seller,rb.onchain_root,a.cipher_sha256,a.manifest_sha256,a.plain_commitment,it.tx_id AS cipher_irys_id,it.manifest_tx_id FROM listings l JOIN capsule_root_bindings rb ON rb.id=l.root_binding_id AND rb.deployment_id=l.deployment_id JOIN capsule_versions cv ON cv.id=l.capsule_version_id AND cv.root_id=rb.capsule_root_id JOIN artifacts a ON a.id=cv.artifact_id JOIN irys_transactions it ON it.artifact_id=a.id WHERE l.id=$1 AND l.deployment_id=$2 FOR UPDATE`, [candidate.listingId, deployment.id])).rows[0];
        if (!listing || !matchesCuratedListing(deployment, address, listing, candidate.snapshot)) throw new ApiError('INTEGRATION_UNAVAILABLE', 'Marketplace listing snapshot does not match the curated immutable mapping', 503);
        await tx.query('UPDATE listings SET price_wei=$2,active=$3 WHERE id=$1', [listing.id, candidate.snapshot.priceWei.toString(), candidate.snapshot.active]);
      }
    });
  }
  private async reconcile(deploymentId: string, address: Address): Promise<void> {
    // Expired cached entitlements already fail closed in app_entitled(). Reconciliation refreshes only canonical evidence.
    const events = (await this.db.query(`SELECT ce.*,o.id AS order_id,o.buyer_wallet,o.buyer_user_id,l.listing_id,l.capsule_version_id FROM chain_events ce JOIN orders o ON o.event_id=ce.id JOIN listings l ON l.id=o.listing_row_id WHERE ce.deployment_id=$1 AND ce.event_name='Purchased' AND ce.state='confirmed' ORDER BY ce.last_checked_at NULLS FIRST,ce.block_number,ce.id LIMIT 200`, [deploymentId])).rows;
    for (const event of events) {
      const canonical = rawHash(await this.reader.blockHash(BigInt(event.block_number))).equals(event.block_hash) && await this.reader.hasPurchased(address, event.buyer_wallet, BigInt(event.listing_id));
      await this.db.transaction(null, async (tx) => {
        await tx.query('UPDATE chain_events SET last_checked_at=now() WHERE id=$1', [event.id]);
        if (!canonical) {
          await tx.query('UPDATE chain_deployments SET finalized_cursor=least(finalized_cursor,$2::bigint-1) WHERE id=$1', [deploymentId, event.block_number]);
          await tx.query("UPDATE chain_events SET state='orphaned' WHERE id=$1", [event.id]);
          await tx.query("UPDATE orders SET state='orphaned' WHERE id=$1", [event.order_id]);
          await tx.query("UPDATE entitlements SET state='suspended',last_chain_check_at=now() WHERE order_id=$1", [event.order_id]);
          return;
        }
        const buyer = (await tx.query('SELECT user_id FROM wallet_bindings WHERE address=$1 AND revoked_at IS NULL', [event.buyer_wallet])).rows[0];
        if (!buyer) { await tx.query("UPDATE entitlements SET state='suspended' WHERE order_id=$1", [event.order_id]); return; }
        await tx.query('UPDATE orders SET buyer_user_id=$2 WHERE id=$1', [event.order_id, buyer.user_id]);
        await tx.query(`INSERT INTO entitlements(order_id,user_id,capsule_version_id,buyer_wallet,state,last_chain_check_at) VALUES($1,$2,$3,$4,'active',now()) ON CONFLICT(order_id) DO UPDATE SET state='active',last_chain_check_at=now()`, [event.order_id, buyer.user_id, event.capsule_version_id, event.buyer_wallet]);
      });
    }
  }
}
