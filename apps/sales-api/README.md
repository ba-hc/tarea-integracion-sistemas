# Sales API

NestJS REST API for customers and sales orders. Sales owns its PostgreSQL database and
calls Inventory only through the versioned unary gRPC contract; it never queries the
Inventory database.

## Local development

Requires Node.js 24 and PostgreSQL. From `apps/sales-api`:

```bash
npm ci
cp .env.example .env
npm run db:migrate
npm run build
npm test
npm start
```

`API_KEY_READER` and `API_KEY_OPERATOR` are required, must be different, and must be
provided through the environment or an untracked `.env`. Never use demo keys outside a
local machine. `INVENTORY_RPC_DEADLINE_MS` defaults to 800 ms; gRPC retries are disabled.

## API

The frozen REST contract is `../../contracts/rest/openapi.yaml`. `/v1/health` is public.
All customer/order operations require `X-API-Key`; reader keys are read-only and operator
keys may write. Every response carries `X-Trace-Id`, and error responses use the contract
error envelope. See `../../docs/architecture/` for data ownership and error semantics.

## Tests

`npm run typecheck` and `npm run build` verify the app; `npm test` runs isolated unit tests.
Database integration tests apply migrations to the disposable database selected by
`TEST_DATABASE_URL`, then cover reservation retries after ambiguous errors, durable serialized
compensation, lost commit acknowledgments, original-response replay, and cancellation recovery
after a local update failure. See [`test/integration/README.md`](test/integration/README.md);
never point it at a development or production database. The black-box contract suite is in
`../../tests/system`.
