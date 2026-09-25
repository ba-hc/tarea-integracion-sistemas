# Changelog

## Unreleased

- Added the authenticated Sales REST API for customers and orders, backed by its own PostgreSQL database.
- Added gRPC stock reservation/release with request deadlines, idempotent order creation, and compensation after local persistence failure.
- Added Docker Compose deployment, disposable database integration tests, and a reproducible resilience demo.

- Updated PostgreSQL 18 Compose mounts and test database port handling; legacy database volumes remain untouched.
- Made dependency recovery tests wait for Inventory health before retrying traffic.
- Hardened ambiguous Inventory failures, durable compensation, commit-ack recovery, and original-response idempotency; documented verified RS-402 results and the reproducible demo report.
