# MemOcean

A TypeScript/pnpm monorepo for private memory capture, permission-aware recall, and a capsule marketplace prototype. This repository is an MVP implementation, not a deployed service: no live marketplace contract, supported permanent-storage adapter, or provider interoperability certification is included.

## Workspace

- `apps/api` — Fastify REST + MCP server and worker; PostgreSQL is required for authenticated and durable behavior.
- `apps/web` — static web client.
- `packages/core` — RFC 8785 JSON canonicalization, SHA-256, AES-256-GCM envelope helpers, capsule-root derivation, and shared Zod schemas/DTO types.
- `packages/cli` — local scan/review workflow and remote MCP config output.
- `packages/contracts` — contract package, when implemented.

The workspace pins `pnpm@9.15.0` and targets Node 24.22.1. Install dependencies at the repository root after all workspace package manifests are present:

```sh
corepack enable
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

## Local PostgreSQL and API

The local Compose file runs only PostgreSQL 18 with pgvector. It binds to loopback and requires a local-only password. Start from the root:

```sh
cp .env.example .env
# Replace every CHANGE_ME value in .env; generate fresh values, never use these examples in production.
docker compose up -d db
```

Provision distinct roles before applying migrations. The request login is not the schema owner or worker; the worker login is never used for HTTP requests. Connect as the local bootstrap/database administrator:

```sh
docker compose exec db psql -U memocean_bootstrap -d memocean
```

Run these SQL statements in that session. Use `\password role_name` at the `psql` prompt to set each login password without putting it in SQL history. The operator/bootstrap role should install extensions if the migration login cannot do so:

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE ROLE memocean_request NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE memocean_worker NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE memocean_migration LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE memocean_request_login LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE memocean_worker_login LOGIN NOSUPERUSER NOBYPASSRLS;
GRANT CREATE ON SCHEMA public TO memocean_migration;
GRANT memocean_request TO memocean_request_login;
GRANT memocean_worker TO memocean_worker_login;
\password memocean_migration
\password memocean_request_login
\password memocean_worker_login
```

Put the matching local-only connection passwords in `.env` for `MIGRATION_DATABASE_URL`, `DATABASE_URL`, and `WORKER_DATABASE_URL`. The API request URL must use `memocean_request_login`; the migration URL must use `memocean_migration`; the worker URL must use `memocean_worker_login`. Keep `ENABLE_WORKER=false` unless you deliberately start a separate worker with its own credentials. Do not share a URL between these roles.

Generate local application keys rather than keeping the example placeholders:

```sh
openssl rand -hex 32
openssl rand -base64 32 | tr -d '\n'
```

Use the first output for `TOKEN_HASH_PEPPER` and the second for `KEK_V1_BASE64`. The KEK must decode to exactly 32 bytes. Store production KEK backups separately from the database. Never commit `.env`.

Load the local env file into the current shell, install extensions/roles as above, then migrate and start the API:

```sh
set -a && source .env && set +a
pnpm --filter @memocean/api db:migrate
pnpm --filter @memocean/api dev
```

The API listens on `http://localhost:3000`. `/health/live` is a process check; `/healthz` also requires database, key, role, and schema readiness. Authenticated API use requires `DATABASE_URL`, `TOKEN_HASH_PEPPER`, `KEK_V1_BASE64`, and exact local `PUBLIC_API_URL`, `WEB_ORIGIN`, and `AUTH_DOMAIN` values. The migration command requires the separate `MIGRATION_DATABASE_URL`.

## CLI review and MCP setup

The CLI never reads `.env` automatically and never saves credentials. Supply a PAT in `MEMOCEAN_TOKEN` in the process environment; set `MEMOCEAN_API_URL` to the API origin or pass `--api`. The token is not accepted as a command-line argument. Commands that send text or approve egress require an interactive terminal and exact digest confirmation.

```sh
pnpm --filter @memocean/cli build
pnpm --filter @memocean/cli exec memocean scan ./selected-notes.txt
pnpm --filter @memocean/cli exec memocean draft ./selected-notes.txt --project <project-uuid> --title "Reviewed title"
pnpm --filter @memocean/cli exec memocean approve-egress <draft-uuid>
pnpm --filter @memocean/cli exec memocean distill <draft-uuid>
pnpm --filter @memocean/cli exec memocean remember <draft-uuid> --project <project-uuid>
```

`scan` is a conservative local pattern check, not a privacy guarantee and not an automatic redactor. The CLI blocks known secret/PII patterns without printing matched content. `draft` stages only after local scan and human review; it does not call a model. `approve-egress` binds consent to the exact sanitized candidate digest and makes no provider call. `distill` makes an external model call only after that persisted approval and a second explicit terminal confirmation. `remember` displays the exact distilled payload and requires a final digest confirmation before approval and job creation. A queued/accepted job is not a successful upload.

To print a remote HTTP MCP configuration without writing a token or file:

```sh
pnpm --filter @memocean/cli exec memocean mcp-config --api https://your-api.example
```

The emitted config references `${MEMOCEAN_TOKEN}` and uses bearer auth; export that variable in the MCP client's environment. Save/copy the emitted JSON yourself only after reviewing it. Specific IDE/client config interpolation is not yet integration-certified. PAT/custom-header remote MCP is the controlled pilot interface; OAuth is not implemented.

## Deployment and integration limits

`render.yaml` defines a Singapore API service (`0.5c-512mb`), a static web service, and PostgreSQL 18 (`0.1c-256mb`). Before applying the blueprint, configure the `sync: false` values, provision separate migration/request/worker database credentials and `memocean_request`/`memocean_worker` NOLOGIN roles, verify pgvector availability and database sizing, and verify each public URL/origin. Do not put a database owner connection string in `DATABASE_URL`. The baseline database size needs workload testing; it is not a production capacity claim.

Provider behavior fails closed:

- No model key means generation is unavailable; the CLI never invokes a model before the exact egress-approval gate.
- No embedding key means embedding-backed operations are unavailable.
- The API's default Irys adapter refuses uploads. No supported permanent uploader/finalized-Publish verifier is established, so no listing or successful permanence claim is made. An upload ID or gateway response does not prove permanence.
- Fuji is configured only as a test-network default. There is no deployed contract address, verified deployment, or real purchase flow in this workspace.

No real model, embedding, permanent-storage, chain transaction, or deployment calls are made by the unit test suite. A successful local build/test is not evidence that external integrations or deployment gates passed.
