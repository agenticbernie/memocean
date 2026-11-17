# Database schema — PostgreSQL và pgvector

**TL;DR:** PostgreSQL giữ identity, ACL, chỉ mục và trạng thái workflow; Irys giữ ciphertext đã xác minh; chain là nguồn sự thật thanh toán. DDL dưới là tham chiếu thiết kế có thứ tự phụ thuộc, chưa phải migration đã chạy.

Ngày baseline: **17-11-2026**. Xem [kiến trúc](ARCHITECTURE.md), [MCP](MCP_SPEC.md), [contract](SMART_CONTRACT_SPEC.md), [roadmap](ROADMAP.md). Không có PostgreSQL server/`psql` trong phiên soạn tài liệu; phải chạy DDL và test concurrency trên PostgreSQL thực trước implementation acceptance.

## 1. Quy ước không thay đổi giữa các tài liệu

- `capsule_root_id`: UUID ổn định qua nhiều version. Contract root là **sender/deployment-bound commitment**, không zero-pad UUID: `keccak256(abi.encode(keccak256("MemOceanCapsuleRoot:v1"), chainId, contractAddress, initialSeller, bytes16(uuidBytes)))`. UUID parse đúng16network-order bytes, không UTF-8 chuỗi UUID. Trial theo **user + canonical UUID root**, không theo on-chain deployment/version/wallet/key/session.
- `capsule_version_id`: UUID nội bộ của version bất biến. `listing_id`: số uint256 trong một deployment. Không dùng ba ID thay thế nhau.
- User là người mua; tenant là workspace. Wallet thuộc user qua proof; membership không tự cấp license cho đồng đội. Tích hợp capsule vào project cần cả license của user và quyền project.
- Address lưu lowercase `0x` + 40 hex; hiển thị checksum chỉ ở UI. Wei và listing ID dùng `numeric(78,0)` hoặc chuỗi, không JavaScript Number.
- Tất cả thời gian `timestamptz`, API RFC3339 UTC. Hash SHA-256 32 bytes; `bytea` không chứa chuỗi hex ASCII. Irys transaction ID giữ nguyên text opaque, không ép bytes32.
- Chọn thiết kế embedding **Voyage `voyage-3.5-lite`, 1024 chiều**, cosine. Đây là lựa chọn cần benchmark/kiểm tra availability; không có “Claude embedding endpoint”. Nếu đổi provider/dimension, reindex vào cột/bảng mới, không trộn vector.
- Trạng thái artifact: `staged → uploading → uploaded → verified → indexed`, lỗi `failed`/`quarantined`. Capsule chỉ list sau indexed và review approved.

## 2. DDL tham chiếu đầy đủ

Chọn PostgreSQL18 trong blueprint, SQL dùng khả năng PostgreSQL16+, extension `vector` với HNSW và `pgcrypto`. Availability trên managed plan phải được kiểm chứng. UUID do API sinh hoặc `gen_random_uuid()`. SQL không tạo superuser hoặc cài package hệ điều hành.

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE DOMAIN evm_address AS text
  CHECK (VALUE ~ '^0x[0-9a-f]{40}$');
CREATE DOMAIN hash32 AS bytea CHECK (octet_length(VALUE) = 32);
CREATE DOMAIN uint256_num AS numeric(78,0)
  CHECK (VALUE >= 0 AND VALUE < power(2::numeric, 256));

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_subject text UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz
);
CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE memberships (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('owner','admin','member')),
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id, user_id)
);
CREATE TABLE wallet_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  address evm_address NOT NULL UNIQUE,
  verified_at timestamptz NOT NULL,
  revoked_at timestamptz,
  UNIQUE (id, user_id)
);
CREATE TABLE auth_challenges (
  nonce_hash hash32 PRIMARY KEY,
  user_id uuid REFERENCES users(id),
  expected_address evm_address NOT NULL,
  domain text NOT NULL,
  uri text NOT NULL,
  chain_id bigint NOT NULL CHECK (chain_id > 0),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  token_hash hash32 NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  refresh_token_hash hash32 UNIQUE,
  refresh_expires_at timestamptz,
  rotated_at timestamptz,
  revoked_at timestamptz,
  CHECK ((refresh_token_hash IS NULL) = (refresh_expires_at IS NULL))
);
CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id)
);
CREATE TABLE project_acl (
  project_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  permission text NOT NULL CHECK (permission IN ('read','write','admin')),
  PRIMARY KEY (project_id, user_id),
  FOREIGN KEY (project_id, tenant_id) REFERENCES projects(id, tenant_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id)
);
CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  prefix text NOT NULL UNIQUE,
  token_hash hash32 NOT NULL UNIQUE,
  scopes text[] NOT NULL CHECK (cardinality(scopes) > 0),
  project_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  replaces_id uuid REFERENCES api_keys(id),
  last_used_at timestamptz,
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id)
);
CREATE TABLE key_envelopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  kek_version text NOT NULL,
  wrapping_algorithm text NOT NULL CHECK (wrapping_algorithm = 'AES-256-GCM'),
  wrapped_dek bytea NOT NULL,
  wrapping_nonce bytea NOT NULL CHECK (octet_length(wrapping_nonce) = 12),
  wrapping_tag bytea NOT NULL CHECK (octet_length(wrapping_tag) = 16),
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz,
  UNIQUE (id, tenant_id)
);
CREATE TABLE artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  key_envelope_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN
    ('staged','uploading','uploaded','verified','indexed','failed','quarantined')),
  staging_ciphertext bytea,
  public_manifest jsonb NOT NULL,
  crypto_version integer NOT NULL CHECK (crypto_version = 1),
  cipher_sha256 hash32 NOT NULL,
  manifest_sha256 hash32 NOT NULL,
  plain_commitment hash32 NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  sanitized_at timestamptz NOT NULL,
  reviewed_by uuid NOT NULL REFERENCES users(id),
  reviewed_at timestamptz NOT NULL,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (key_envelope_id, tenant_id) REFERENCES key_envelopes(id, tenant_id)
);
CREATE TABLE irys_transactions (
  tx_id text PRIMARY KEY CHECK (octet_length(tx_id) BETWEEN 1 AND 512),
  artifact_id uuid NOT NULL UNIQUE REFERENCES artifacts(id),
  network text NOT NULL,
  storage_product text NOT NULL,
  gateway_base_url text NOT NULL,
  receipt jsonb NOT NULL,
  uploaded_at timestamptz NOT NULL,
  verified_at timestamptz,
  manifest_tx_id text UNIQUE CHECK (octet_length(manifest_tx_id) BETWEEN 1 AND 512),
  manifest_receipt jsonb,
  permanence_verified boolean NOT NULL DEFAULT false,
  storage_verification_evidence jsonb,
  verified_cipher_sha256 hash32,
  verified_manifest_sha256 hash32,
  CHECK ((verified_at IS NULL) = (verified_cipher_sha256 IS NULL)),
  CHECK ((verified_at IS NULL) = (verified_manifest_sha256 IS NULL)),
  CHECK ((manifest_tx_id IS NULL) = (manifest_receipt IS NULL)),
  CHECK (verified_at IS NULL OR
    (manifest_tx_id IS NOT NULL AND manifest_receipt IS NOT NULL
     AND storage_verification_evidence IS NOT NULL)),
  CHECK (NOT permanence_verified OR
    (verified_at IS NOT NULL AND storage_product = 'permanent'))
);
CREATE TABLE approval_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  requested_by uuid NOT NULL REFERENCES users(id),
  key_envelope_id uuid NOT NULL,
  content_ciphertext bytea NOT NULL,
  candidate_sha256 hash32 NOT NULL,
  state text NOT NULL CHECK (state IN
    ('scanned','egress_approved','distilled','approved','consumed','rejected','expired')),
  egress_approved_at timestamptz,
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  approval_token_hash hash32,
  approval_expires_at timestamptz,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (project_id, tenant_id) REFERENCES projects(id, tenant_id),
  FOREIGN KEY (key_envelope_id, tenant_id) REFERENCES key_envelopes(id, tenant_id),
  CHECK ((approval_token_hash IS NULL) = (approval_expires_at IS NULL))
);
CREATE TABLE memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (id, tenant_id),
  FOREIGN KEY (project_id, tenant_id) REFERENCES projects(id, tenant_id)
);
CREATE TABLE memory_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  artifact_id uuid NOT NULL,
  schema_version text NOT NULL CHECK (schema_version = '1.0'),
  importance numeric(4,3) NOT NULL CHECK (importance BETWEEN 0 AND 1),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (memory_id, revision),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (memory_id, tenant_id) REFERENCES memories(id, tenant_id),
  FOREIGN KEY (artifact_id, tenant_id) REFERENCES artifacts(id, tenant_id),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE TABLE capsules (
  root_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_tenant_id uuid NOT NULL REFERENCES tenants(id),
  creator_user_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (root_id, owner_tenant_id)
);
CREATE TABLE capsule_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  root_id uuid NOT NULL,
  owner_tenant_id uuid NOT NULL,
  version bigint NOT NULL CHECK (version BETWEEN 1 AND 4294967295),
  artifact_id uuid NOT NULL,
  license_spdx_or_custom text NOT NULL,
  license_sha256 hash32 NOT NULL,
  review_state text NOT NULL CHECK (review_state IN ('pending','approved','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (root_id, version),
  UNIQUE (id, root_id),
  UNIQUE (id, owner_tenant_id),
  FOREIGN KEY (root_id, owner_tenant_id) REFERENCES capsules(root_id, owner_tenant_id),
  FOREIGN KEY (artifact_id, owner_tenant_id) REFERENCES artifacts(id, tenant_id)
);
CREATE TABLE capsule_previews (
  capsule_version_id uuid PRIMARY KEY,
  owner_tenant_id uuid NOT NULL,
  artifact_id uuid NOT NULL UNIQUE,
  safe_content jsonb NOT NULL,
  safe_content_sha256 hash32 NOT NULL,
  reviewed_by uuid NOT NULL REFERENCES users(id),
  reviewed_at timestamptz NOT NULL,
  max_output_chars integer NOT NULL DEFAULT 1200 CHECK (max_output_chars BETWEEN 100 AND 2000),
  FOREIGN KEY (capsule_version_id, owner_tenant_id)
    REFERENCES capsule_versions(id, owner_tenant_id),
  FOREIGN KEY (artifact_id, owner_tenant_id) REFERENCES artifacts(id, tenant_id)
);
CREATE TABLE memory_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  locator text NOT NULL,
  sanitized_text text NOT NULL,
  embedding vector(1024) NOT NULL,
  embedding_model text NOT NULL CHECK (embedding_model = 'voyage-3.5-lite'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (revision_id, ordinal),
  FOREIGN KEY (revision_id, tenant_id) REFERENCES memory_revisions(id, tenant_id)
);
CREATE TABLE capsule_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_tenant_id uuid NOT NULL,
  capsule_version_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  locator text NOT NULL,
  sanitized_text text NOT NULL,
  embedding vector(1024) NOT NULL,
  embedding_model text NOT NULL CHECK (embedding_model = 'voyage-3.5-lite'),
  UNIQUE (capsule_version_id, ordinal),
  FOREIGN KEY (capsule_version_id, owner_tenant_id)
    REFERENCES capsule_versions(id, owner_tenant_id)
);
CREATE TABLE chain_deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id bigint NOT NULL,
  contract_address evm_address NOT NULL,
  deployment_block bigint NOT NULL CHECK (deployment_block >= 0),
  deployment_block_hash hash32 NOT NULL,
  code_hash hash32 NOT NULL,
  finalized_cursor bigint NOT NULL,
  UNIQUE (chain_id, contract_address)
);
CREATE TABLE capsule_root_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id uuid NOT NULL REFERENCES chain_deployments(id),
  capsule_root_id uuid NOT NULL REFERENCES capsules(root_id),
  initial_seller evm_address NOT NULL,
  onchain_root hash32 NOT NULL,
  UNIQUE (deployment_id, capsule_root_id),
  UNIQUE (deployment_id, onchain_root),
  UNIQUE (id, deployment_id)
);
CREATE TABLE listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id uuid NOT NULL REFERENCES chain_deployments(id),
  listing_id uint256_num NOT NULL,
  root_binding_id uuid NOT NULL,
  capsule_version_id uuid NOT NULL REFERENCES capsule_versions(id),
  seller evm_address NOT NULL,
  price_wei uint256_num NOT NULL CHECK (price_wei > 0),
  fee_bps integer NOT NULL CHECK (fee_bps BETWEEN 0 AND 1000),
  fee_recipient evm_address NOT NULL,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (deployment_id, listing_id),
  UNIQUE (id, deployment_id),
  FOREIGN KEY (root_binding_id, deployment_id) REFERENCES capsule_root_bindings(id, deployment_id)
);
CREATE TABLE chain_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id uuid NOT NULL REFERENCES chain_deployments(id),
  tx_hash hash32 NOT NULL,
  log_index integer NOT NULL CHECK (log_index >= 0),
  block_number bigint NOT NULL,
  block_hash hash32 NOT NULL,
  event_name text NOT NULL,
  decoded jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('observed','confirmed','orphaned')),
  observed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deployment_id, tx_hash, log_index),
  UNIQUE (id, deployment_id)
);
CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id uuid NOT NULL,
  listing_row_id uuid NOT NULL,
  event_id uuid NOT NULL UNIQUE,
  buyer_wallet evm_address NOT NULL,
  buyer_user_id uuid REFERENCES users(id),
  paid_wei uint256_num NOT NULL,
  state text NOT NULL CHECK (state IN ('observed','confirmed','orphaned')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (listing_row_id, deployment_id) REFERENCES listings(id, deployment_id),
  FOREIGN KEY (event_id, deployment_id) REFERENCES chain_events(id, deployment_id)
);
CREATE TABLE entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id),
  user_id uuid NOT NULL REFERENCES users(id),
  capsule_version_id uuid NOT NULL REFERENCES capsule_versions(id),
  buyer_wallet evm_address NOT NULL,
  state text NOT NULL CHECK (state IN ('active','suspended')),
  last_chain_check_at timestamptz NOT NULL,
  UNIQUE (user_id, capsule_version_id, order_id)
);
CREATE TABLE project_capsules (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  entitlement_id uuid NOT NULL REFERENCES entitlements(id),
  capsule_version_id uuid NOT NULL REFERENCES capsule_versions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id, capsule_version_id),
  FOREIGN KEY (project_id, tenant_id) REFERENCES projects(id, tenant_id)
);
CREATE TABLE trial_counters (
  user_id uuid NOT NULL REFERENCES users(id),
  capsule_root_id uuid NOT NULL REFERENCES capsules(root_id),
  used_count integer NOT NULL DEFAULT 0 CHECK (used_count BETWEEN 0 AND 3),
  PRIMARY KEY (user_id, capsule_root_id)
);
CREATE TABLE trial_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  capsule_root_id uuid NOT NULL,
  capsule_version_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  request_sha256 hash32 NOT NULL,
  state text NOT NULL CHECK (state IN ('reserved','running','succeeded','failed_charged','refunded')),
  response_ciphertext bytea,
  response_key_envelope_id uuid REFERENCES key_envelopes(id),
  lease_until timestamptz,
  lease_token uuid,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, capsule_root_id, idempotency_key),
  FOREIGN KEY (user_id, capsule_root_id) REFERENCES trial_counters(user_id, capsule_root_id),
  FOREIGN KEY (capsule_version_id, capsule_root_id) REFERENCES capsule_versions(id, root_id),
  CHECK ((response_ciphertext IS NULL) = (response_key_envelope_id IS NULL))
);
CREATE TABLE paid_query_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  capsule_version_id uuid NOT NULL REFERENCES capsule_versions(id),
  idempotency_key uuid NOT NULL,
  request_sha256 hash32 NOT NULL,
  state text NOT NULL CHECK (state IN ('reserved','running','succeeded','failed')),
  response_ciphertext bytea,
  response_key_envelope_id uuid REFERENCES key_envelopes(id),
  lease_until timestamptz,
  lease_token uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, capsule_version_id, idempotency_key),
  FOREIGN KEY (project_id, tenant_id) REFERENCES projects(id, tenant_id),
  CHECK ((response_ciphertext IS NULL) = (response_key_envelope_id IS NULL))
);
CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  requested_by uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('distill','upload','verify','index','sync_purchase','reconcile')),
  idempotency_key text NOT NULL,
  request_sha256 hash32 NOT NULL,
  payload jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('queued','running','retry','succeeded','failed')),
  result jsonb,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  run_after timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  lease_token uuid,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, kind, idempotency_key)
);
CREATE TABLE outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  event_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  available_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE TABLE chat_answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id),
  project_id uuid NOT NULL,
  answer_text text NOT NULL,
  abstained boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, tenant_id) REFERENCES projects(id, tenant_id)
);
CREATE TABLE answer_citations (
  answer_id uuid NOT NULL REFERENCES chat_answers(id),
  ordinal integer NOT NULL,
  irys_tx_id text NOT NULL REFERENCES irys_transactions(tx_id),
  artifact_id uuid NOT NULL REFERENCES artifacts(id),
  chunk_locator text NOT NULL,
  excerpt_sha256 hash32 NOT NULL,
  PRIMARY KEY (answer_id, ordinal)
);
CREATE INDEX memory_chunks_hnsw ON memory_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX capsule_chunks_hnsw ON capsule_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX memory_chunks_tenant ON memory_chunks (tenant_id, revision_id);
CREATE INDEX capsule_chunks_version ON capsule_chunks (capsule_version_id);
CREATE INDEX memory_project_time ON memories (tenant_id, project_id, created_at);
CREATE INDEX entitlement_access ON entitlements (user_id, capsule_version_id) WHERE state = 'active';
CREATE INDEX jobs_due ON jobs (run_after, created_at) WHERE state IN ('queued','retry','running');
CREATE INDEX outbox_due ON outbox (available_at) WHERE published_at IS NULL;
CREATE INDEX chain_blocks ON chain_events (deployment_id, block_number);
```

Các invariant liên bảng cần API transaction hoặc trigger ở migration thực: approval draft user/project/digest/expiry khớp và chỉ consume một lần cùng tạo job; preview artifact phải là artifact **khác** paid artifact, đã verified/indexed và được review độc lập; reviewer có quyền tenant; artifacts indexed phải có verified transaction; citation artifact phải đúng transaction; project_capsules user/version phải trùng entitlement active; order buyer phải trùng wallet đã proof; key project allowlist phải là project cùng tenant; onchain_root phải recompute từ domain/chain/contract/initial_seller/UUID đúng encoding; listing version root phải trùng capsule_root_bindings.capsule_root_id. Không decode hash root thành UUID. Không giả vờ CHECK constraint có thể đọc bảng khác. Approval token được HMAC-hash như PAT; không lưu token rõ. Retry remember cùng idempotency được trả job cũ trước khi kiểm consumed token; key mới với draft consumed bị reject. Egress approval là người dùng duyệt sanitized text **trước** gọi model ngoài; final approval là người dùng duyệt distilled digest **trước** permanent upload.

`irys_transactions` được INSERT ngay sau ciphertext upload với `tx_id`, initial upload response trong `receipt`, manifest columns NULL và verified_at NULL. SDK response chỉ có id không được gọi là cryptographic receipt. Persist trước khi upload manifest; sau manifest upload mới UPDATE manifest_tx_id/manifest_receipt atomically, artifact state từ uploading→uploaded. Verify cả hai bytes/hash/network/product và finalized Publish evidence rồi mới ghi verified_at/hash/evidence/permanence_verified. Nullability cho phép restart không làm mất cipher tx khi manifest chưa có. Public manifest được persist canonicalizable trong artifacts.public_manifest, không reconstruct từ dữ liệu có thể đổi; scan riêng trước lưu/upload. Verify Irys availability API còn là M0 blocker, JSONB evidence không tự biến ID thành proof. Marketplace permanent claim yêu cầu permanence_verified=true trên paid và preview artifacts; devnet storage verification không được set flag này.

Revision, approved capsule version, verified tx và listing commitment là append-only. DB role runtime không được UPDATE các payload bất biến; chỉ stored transition functions có quyền đổi trạng thái. Thay nội dung tạo version/revision và artifact mới. Key rewrap chỉ đổi wrapped DEK/KEK version, không sửa ciphertext.

## 3. Trial: đúng ba lần toàn vòng đời, không race

Chính sách: mỗi user + root được ba reservation **không refund**, trừ lỗi xác định trước khi gọi inference. `used_count` gồm reserved/running/succeeded/failed_charged. Timeout sau khi model có thể đã chạy vẫn charged; tránh hoàn tiền khi một completion đang về trễ. UI phải thông báo trước.

Transaction dưới chạy `READ COMMITTED` với lock counter; token user từ auth, không từ request. HMAC/hash full request canonical (project + version + mode + question, không chỉ question) phải được so sánh để cùng idempotency key mà câu hỏi khác trả conflict.

```sql
BEGIN;
INSERT INTO trial_counters (user_id, capsule_root_id)
VALUES ($1, $2) ON CONFLICT DO NOTHING;
SELECT used_count FROM trial_counters
WHERE user_id = $1 AND capsule_root_id = $2 FOR UPDATE;
-- Sau lock: SELECT trial_attempts cùng user/root/idempotency_key.
-- Nếu tồn tại: so request_sha256, trả cùng attempt; KHÔNG debit.
-- Nếu chưa tồn tại và used_count = 3: rollback, TRIAL_EXHAUSTED.
UPDATE trial_counters SET used_count = used_count + 1
WHERE user_id = $1 AND capsule_root_id = $2 AND used_count < 3
RETURNING used_count;
-- Phải có đúng một row trước INSERT; nếu không thì rollback.
INSERT INTO trial_attempts
(user_id, capsule_root_id, capsule_version_id, idempotency_key, request_sha256, state)
VALUES ($1, $2, $3, $4, $5, 'reserved');
COMMIT;
```

Paid queries dùng `paid_query_attempts` với same-key/body cache và authorization recheck mỗi retry; không debit trial, không trả cache cho user mất entitlement/project. Paid running timeout không tự inference lại; client cần ý định/key mới khi thật sự muốn thử lại và chịu cost.

Sau commit, claim attempt `running` với lease token. Chỉ worker sở hữu lease hiện tại được persist `succeeded` và encrypted response. **Persist trước khi gửi bất kỳ answer token cho client**; trial không stream completion trực tiếp. Retry đọc lại response đã lưu. Cùng request concurrent bị serialize bởi counter và unique key.

Refund chỉ `reserved → refunded` khi chưa từng claim model, trong cùng counter lock + conditional UPDATE. Giảm counter đúng một lần nếu UPDATE trả row. `running` hết lease → `failed_charged`, không refund tự động và không tự chạy inference lại; hỗ trợ người dùng xử lý thủ công có audit. Provider không hỗ trợ exactly-once; policy này chọn không tạo free completion race. 100 concurrent requests, ba key khác nhau hay lặp một key, là test bắt buộc.

## 4. Job lease và outbox

Jobs/outbox được ghi cùng transaction tạo artifact/revision. Không chứa transcript thô hoặc plaintext secret trong JSON payload; chỉ ID và ciphertext đã được scan/duyệt. Claim tối đa 2 jobs/replica để API Starter không bị job làm nghẽn.

```sql
WITH picked AS (
  SELECT id FROM jobs
  WHERE run_after <= now()
    AND (state IN ('queued','retry') OR (state = 'running' AND lease_until < now()))
  ORDER BY run_after, created_at
  FOR UPDATE SKIP LOCKED LIMIT 2
)
UPDATE jobs j SET state = 'running', attempts = attempts + 1,
  lease_until = now() + interval '60 seconds', lease_token = gen_random_uuid()
FROM picked WHERE j.id = picked.id RETURNING j.*;
```

Heartbeat gia hạn mỗi 20 giây, timeout theo bước, retry backoff jitter tối đa 5 lần rồi failed. Completion phải `WHERE id=$id AND lease_token=$token AND lease_until>now()`. Lease fencing bảo vệ DB, không ngăn side-effect upload trùng: lưu tx ID ngay khi nhận, retry verify trước upload, dùng idempotency của vendor nếu được chứng minh; orphan upload có thể tốn phí nhưng không publish hai version. Outbox delivery at-least-once; consumer dùng dedupe_key. Chain cursor advance và log insert cùng transaction.

## 5. Tenant isolation, RLS và truy vấn vector

ACL — access control list — bắt buộc ở API trước retrieval, SQL joins và RLS. Role app không là table owner, không BYPASSRLS; migrations dùng role riêng. Auth bootstrap chỉ dùng functions hẹp để tra hash token, không quyền đọc bảng dữ liệu toàn tenant. Token chứa tenant chỉ là claim cần so membership sống, không tự tin JWT lâu ngày.

```sql
ALTER TABLE memory_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_chunks FORCE ROW LEVEL SECURITY;
CREATE POLICY memory_chunks_read ON memory_chunks FOR SELECT USING (
  tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  AND EXISTS (
    SELECT 1 FROM memory_revisions r
    JOIN memories m ON m.id = r.memory_id AND m.tenant_id = r.tenant_id
    JOIN project_acl a ON a.project_id = m.project_id AND a.tenant_id = m.tenant_id
    JOIN memberships ms ON ms.tenant_id = a.tenant_id AND ms.user_id = a.user_id
    WHERE r.id = memory_chunks.revision_id
      AND a.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND ms.revoked_at IS NULL
  )
);
-- Chạy trong transaction trên MỘT connection từ pool.
BEGIN;
SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true);
SELECT c.id, c.locator, c.sanitized_text, tx.tx_id,
       1 - (c.embedding <=> $3::vector) AS similarity
FROM memory_chunks c
JOIN memory_revisions r ON r.id = c.revision_id AND r.tenant_id = c.tenant_id
JOIN memories m ON m.id = r.memory_id AND m.tenant_id = r.tenant_id
JOIN artifacts ar ON ar.id = r.artifact_id AND ar.tenant_id = r.tenant_id
JOIN irys_transactions tx ON tx.artifact_id = ar.id
JOIN project_acl acl ON acl.project_id = m.project_id AND acl.tenant_id = m.tenant_id
WHERE c.tenant_id = $1 AND m.project_id = $4 AND acl.user_id = $2
  AND m.archived_at IS NULL AND ar.state = 'indexed' AND tx.verified_at IS NOT NULL
  AND r.valid_from <= $5::timestamptz
  AND (r.valid_to IS NULL OR r.valid_to > $5::timestamptz)
ORDER BY c.embedding <=> $3::vector LIMIT 12;
COMMIT;
```

Tham số `$5` là “hiệu lực tại thời điểm”, khác filter `created_at` từ/đến. Khi API dùng date range, thêm `r.created_at >= from AND r.created_at < to` cùng timezone UTC. Không lấy top-k toàn DB rồi lọc ở TypeScript. Giới hạn tenant/project/time/policy phải có trong query trước đưa context vào model.

Policy trên chỉ là pattern SELECT cụ thể; migration thực phải ENABLE/FORCE RLS và policy tương ứng cho tất cả bảng tenant/private, bao gồm paid_query_attempts, approval_drafts, memories, revisions, artifacts, envelopes, jobs, chat và citations; write policy cần WITH CHECK. Không cấp runtime rights trước khi policy coverage test PASS. Capsule retrieval dùng policy riêng: seller có membership + quyền review **hoặc** `entitlements.user_id = current user AND state='active'` với `last_chain_check_at` còn hạn. Trial không bao giờ đọc capsule_chunks; chỉ preview đã duyệt với `capsule_previews.artifact_id` nối verified irys_transactions, dùng locator trên preview artifact. Không ghi paid corpus tx làm citation của preview chưa đọc corpus. Cấm dùng tenant seller từ client để bypass.

`project_capsules` không cấp quyền cho mọi member: query luôn kiểm tra user của mapping trùng user của entitlement. DB worker role có bypass giới hạn cho reconcile nhưng không được dùng làm request role. Pooled connection dùng `SET LOCAL`/`set_config(..., true)` trong transaction và rollback khi lỗi; không `SET` session-global.

HNSW approximate có thể trả thiếu sau filter; test exact search so sánh recall, tăng search effort hoặc iterative scans khi extension hỗ trợ, fallback exact trong project nhỏ. Không bỏ ACL để tăng recall. Lưu model/version; rebuild HNSW sau thay model. Index plaintext/embeddings nằm trong managed DB: đây **không** phải end-to-end encrypted search.

## 6. Entitlement, retention và khôi phục

`orders.buyer_user_id` ban đầu null nếu buyer chưa login; chỉ claim bằng fresh proof của đúng buyer_wallet. Indexer không suy identity từ wallet gửi lên request. Với smart contract wallet cần ERC-1271 support/test riêng trước công bố.

Active entitlement yêu cầu event confirmed đúng deployment, order/version/price khớp chain `hasPurchased`; chain check TTL mục tiêu 60 giây cho unlock, immediate recheck khi nghi reorg. Khi RPC không dùng được và chưa có kiểm chứng mới, fail closed cho unlock mới; access đã export không thu hồi được. DB không phải nguồn thanh toán gốc.

Backup: managed PostgreSQL backup theo plan thực; encrypted offline export key_envelopes + KEK backup do security owner giữ tách DB. Restore drill dựng tenant mới từ artifacts verified, rebuild chunks từ Irys + DEK, replay chain từ deployment block, không mất trial counters. Trial counters/attempts và identity không tái tạo từ chain; cần DB restore point riêng, không được reset quota bằng reindex.

Retention đề xuất: xóa staging_ciphertext sau verify + backup checkpoint; chat 30 ngày opt-in; revoked key hash giữ audit 90 ngày; raw session không lưu. Irys permanence không có bảo đảm quyền xóa bytes: không upload PII/secret ngay từ đầu. Xóa index/quyền truy cập và crypto-shredding giảm khả năng đọc, không hứa xóa dữ liệu permanent hoặc bản sao buyer.

## 7. Nguồn và kiểm chứng cần chạy

- [pgvector README: HNSW, filtering, supported dimensions](https://github.com/pgvector/pgvector) — truy cập 17-11-2026; vector dimension của thiết kế là 1024, nằm trong giới hạn HNSW vector 2000 chiều được tài liệu mô tả.
- [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) — tài liệu chính thức, truy cập 17-11-2026.
- [PostgreSQL locking clause](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE) — SKIP LOCKED cho queue, không cho view nghiệp vụ tổng quát.
- [Voyage embeddings](https://docs.voyageai.com/docs/embeddings) — kiểm tra model/dimension trước mua quota; không dùng làm bằng chứng benchmark MemOcean.

**Gate implementation:** DDL apply clean trên DB tạm; tất cả composite FK negative tests; RLS hai tenant; 100-way trial concurrency; expired lease fencing; bigint round trip; replay/reorg; restore key và DB. Parsing Markdown/SQL text không thay thế các test này.
