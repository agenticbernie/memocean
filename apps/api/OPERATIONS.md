# API operations and integration boundaries

## Commands

From the workspace root, after the root owner installs the pinned workspace dependencies and builds `@memocean/core`:

```sh
pnpm --filter @memocean/api build
pnpm --filter @memocean/api test
MIGRATION_DATABASE_URL=... pnpm --filter @memocean/api db:migrate
pnpm --filter @memocean/api start
```

The API is ESM, uses Node 22+ and listens on `0.0.0.0:$PORT`. `GET /health/live` only checks the process. `GET /healthz` checks required configuration, request-role safety and schema presence without making model/storage/chain calls. An unset database is **not** replaced with in-memory persistence. No credentials are shipped.

## Database roles (required before migrations)

Use a disposable administrator session or the database operator to provision:

```sql
CREATE ROLE memocean_request NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE memocean_worker NOLOGIN NOSUPERUSER NOBYPASSRLS;
-- The operator creates three distinct LOGIN roles with separately managed credentials:
-- migration owner, request login, background-worker login.
GRANT memocean_request TO your_request_login;
GRANT memocean_worker TO your_worker_login;
```

`MIGRATION_DATABASE_URL` is the schema owner and must be able to install `vector`/`pgcrypto` (or have the operator install them). `DATABASE_URL` is only the request login: never an owner, superuser, BYPASSRLS role, or member of `memocean_worker`. `WORKER_DATABASE_URL` is a separate backend-only login holding `memocean_worker`, never passed to HTTP services. Set `ENABLE_WORKER=true` only with separate worker credentials. The worker has explicitly broad background privileges; it is not suitable for serving requests. Authentication is exposed through narrow, fixed-search-path SECURITY DEFINER functions, not direct runtime reads of wallet/session/challenge tables. All private tables have FORCE RLS. Migration-owner policies permit only the owner for those functions; request policies use transaction-local principal settings and live membership/project checks.

The request-role check in readiness is a guard, not a substitute for an operator reviewing inherited role membership. Provision roles before the first migration; do not grant runtime roles schema ownership or public schema CREATE. Migrations are checksummed and serialized by a session advisory lock. Applied SQL must not be edited after deployment; add a new migration. The four initial migrations form the initial schema release.

## Environment

Required for a functioning authenticated API: `DATABASE_URL`, random `TOKEN_HASH_PEPPER` (at least 32 characters), `KEK_V1_BASE64` (exactly 32 decoded bytes), `PUBLIC_API_URL`, `WEB_ORIGIN`, `AUTH_DOMAIN`. Production origins must be HTTPS. Do not generate replacement KEKs on boot. Back up the KEK separately from database backups; losing both destroys access to encrypted drafts/artifacts/responses.

Generation uses **only the official `@anthropic-ai/sdk`**. `ANTHROPIC_API_KEY` is optional at boot but generation fails closed if absent. `ANTHROPIC_MODEL` defaults to the user-requested `claude-opus-5-5`; configure an account-supported model before a live integration test. This supersedes the design document's older `GENERATION_MODEL` variable. Adaptive thinking is enabled, requests are bounded and retries are disabled to avoid silent duplicate inference. These bounded calls use non-streamed provider responses; no trial answer is streamed before persistence.

Embeddings are a separate provider: `EMBEDDING_API_KEY`, `EMBEDDING_MODEL=voyage-3.5-lite`, `EMBEDDING_DIMENSIONS=1024`. No Anthropic embedding endpoint is assumed. `USER_DAILY_MODEL_LIMIT`/`GLOBAL_DAILY_MODEL_LIMIT` default to 100/1000 request reservations; SQL clamps their maximums at those limits. Conservative charged reservations are not dollar-accurate billing and do not refund ambiguous post-dispatch failures. Raising the hard SQL caps needs a reviewed migration. Authenticated user/tenant rate windows are persisted in PostgreSQL; the IP limiter is process-local defense in depth and is not a durable quota.

Chain reconciliation additionally requires worker credentials, `AVALANCHE_RPC_URL`, `CHAIN_ID` (default 43113), and operator-populated, independently verified `chain_deployments` plus curated listing/root/version bindings. The indexer reads those database-pinned deployment bindings, not receipt hints from callers. `CHAIN_CONFIRMATIONS=3` is a policy buffer, not a claim of absolute consensus finality. Stale entitlements fail closed after 60 seconds. No backend route accepts a client receipt as proof of purchase. The indexer never sends transactions.

## Permanent-storage gate

The default `IrysStorage` deliberately refuses uploads. A supported permanent-mode uploader and finalized Publish verifier have not been established. An upload ID, gateway HTTP 200, arbitrary JSON receipt, or testnet response is **not** permanence evidence. No storage credentials, funding calls or live uploads are performed by this implementation. The provider interface and durable saga are implemented for a vetted adapter: persist cipher upload ID immediately, persist manifest separately, verify both exact hashes and permanent-mode evidence, retrieve/decrypt and validate the salted commitment, then embed/index. Failed/unverified uploads never become searchable. A queued remember request is acceptance of a durable job, not successful storage. With the default adapter its job terminates with `INTEGRATION_UNAVAILABLE`, not fake readiness.

A tested replacement must implement `StorageProvider`, explicitly advertise `permanenceSupported`, preserve network/product/gateway snapshots, and pass upload/recovery/verifier tests. Injection is currently a programmatic composition seam, not an environment switch that pretends an unsupported vendor mode works. The default gateway reader supports only the fixed Irys gateway origin and compares actual bytes; it cannot establish permanence on its own.

## Review and HTTP contract

All names are snake_case, matching `docs/MCP_SPEC.md`.

1. `POST /v1/auth/challenge` `{address,chain_id}` -> `{message,expires_at}`; sign that exact message; `POST /v1/auth/verify` `{message,signature}` -> one-hour Bearer session plus `user_id,tenant_id,project_id`. First EOA wallet proof atomically creates a personal tenant/project. ERC-1271 and refresh cookies are not implemented. Web clients must keep sessions in memory, not localStorage.
2. `POST /v1/tokens` `{name,scopes,project_ids,expires_at?}` creates a hashed PAT displayed once; list/revoke use `/v1/tokens`. PATs cannot mint PATs; session `account:manage` is required.
3. `POST /v1/drafts` `{project_id,title,sanitized_text,local_scan_passed:true,pii_review_passed:true}`. The caller must minimize/scan locally; the server rejects likely secrets/PII before providers and persists only encrypted staging. The scanner is deliberately conservative and has false positives and false negatives; it is not a privacy certification.
4. Review returned exact `candidate` and `candidate_sha256`. `POST /v1/drafts/:id/egress-approve` `{approved_sha256}` approves **only that outbound candidate**. This route does not call a model.
5. `POST /v1/drafts/:id/distill` `{}` is the only generation step. It rejects before dispatch unless egress approval is persisted. Restarting during dispatch leaves a `distilling` draft requiring operator review; no automatic repeated inference is claimed.
6. Review exact distilled `content` and new digest. `POST /v1/drafts/:id/approve` `{approved_sha256}` returns a 15-minute `approval_token`. No upload has happened yet.
7. `POST /v1/remember` takes the documented MCP remember input (`project_id,idempotency_key,approved_draft_id,approved_sha256,approval_token,importance,valid_from,valid_to?`). It consumes final approval atomically with artifact/revision/job/outbox creation and returns 202 plus job URI. `GET /v1/jobs/:id` reports actual readiness and safe error codes. Same-key/body retries return the same job; changed bodies conflict.
8. `POST /v1/recall` uses the documented recall schema; project/time/ACL constraints are materialized before vector ranking. This initial exact-search filtered baseline favors isolation over approximate-index speed. A 0.25 similarity floor is an uncalibrated conservative starting configuration, **not** a measured quality claim.
9. `/v1/capsules` only catalogs approved, indexed, independently permanent-verified paid artifacts and previews. `/v1/capsules/query` takes the documented exact root/version/project/question/mode/idempotency input. Trial is global for user+root across keys/versions/tenants, reserves before inference, uses only a separate safe derivative, and durably encrypts a validated answer before delivery. Once inference may have started, failures remain charged and are never automatically rerun. New completions require a deliberate new idempotency key and consume quota. There is no automatic fallback from trial to paid.
10. `POST /v1/capsules/:version_id/sync` `{project_id}` requires this exact user's fresh confirmed entitlement; it never grants a teammate's license. `/v1/entitlements` reports current access. `/v1/provenance/verify` accepts the documented provenance input; limitations always distinguish content truth, legal ownership, ciphertext availability and permanence.

The current memory distillation payload is a bounded private-memory lesson format, not the full marketplace capsule authoring format. Capsule authoring, curation/import of chain-bound listings, OAuth and password/session recovery are intentionally not fabricated as successful routes. Explicit public-capsule ingestion must be implemented and independently reviewed before a full marketplace publishing workflow is claimed.

## MCP

`POST /mcp` implements the project's **2026-07-28 stateless wire profile**, including `server/discover`, four tool definitions, resource templates/list/read, prompts and per-request mirrored headers/metadata. GET and DELETE return 405. Legacy initialize/session mode is not silently accepted. JSON responses are default; `Accept: text/event-stream` selects a request-scoped SSE final-response envelope (not streamed model tokens, subscriptions or resumable sessions). No session ID is minted. Tool arguments and outputs are validated. This is a controlled PAT/reference-client implementation with a hand-validated transport; **no official SDK-era or IDE interoperability certification is claimed**. Actual Claude Code/Cursor/Inspector version tests and incremental proxy/SSE behavior remain live integration gates. OAuth metadata is not advertised because no authorization server is running.

## Tests and release limits

`pnpm --filter @memocean/api test` includes deterministic unit/HTTP tests with synthetic providers. It makes no real model calls. Database integration is explicitly skipped unless `TEST_DATABASE_URL` points to a **new empty disposable database ending in `_test`**. That test account needs schema/extension/role bootstrap privileges; the test refuses an existing application database. It tests actual migrations, FORCE RLS, vector roundtrip, 100 concurrent distinct and repeated trial keys, cached answers/body conflicts, denied paid access and stale-lease fencing. A skip is **not** evidence of a database pass. Use a fresh database per run; do not use production data or credentials.

Still required before release: PostgreSQL/pgvector test execution in the deployment environment; audited role grants; supported Irys permanent uploader/verifier; real embedding/model account compatibility and bounded-cost measurements; exact chain listing imports and reorg/replay tests against a real local chain; key backup/restore drill; scanner/PII evaluation; independent citation entailment grading; budget/load/security review; tested target MCP clients and deployment/proxy behavior. Provider configuration is not evidence these gates passed.
