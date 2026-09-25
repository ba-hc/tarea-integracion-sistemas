# Sales database integration tests

Start the disposable database from the repository root:

```bash
docker compose --profile test up -d --wait sales-test-db
```

From `apps/sales-api`, point both Prisma migrations and tests at that database:

```bash
export TEST_DATABASE_URL='postgresql://sales:sales-test-only@localhost:5433/sales_test?schema=public'
npm run test:integration
```

If local port `5433` is occupied, start Compose with `SALES_TEST_DB_PORT=5434` and use
`localhost:5434` in `TEST_DATABASE_URL`. The default port is bound only to loopback.

The helper refuses a database whose name does not contain `test`; the suite truncates all
Sales tables before each test. Never set `TEST_DATABASE_URL` to a development or production
database.
