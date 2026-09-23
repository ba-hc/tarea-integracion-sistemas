# Contract freeze procedure

## Frozen baseline

The integration baseline is exactly:

- `contracts/rest/openapi.yaml`
- `contracts/grpc/repuestossur/inventory/v1/inventory.proto`
- `contracts/buf.yaml`
- ADR-001 through ADR-004
- architecture policies in `docs/architecture/`

After validation and merge to `main`, create:

```bash
git tag -a contracts-v1.0.0 -m "Freeze RepuestosSur REST and gRPC contracts v1.0.0"
git push origin contracts-v1.0.0
```

## Freeze rule

After `contracts-v1.0.0`, implementation work MUST consume these contracts as immutable inputs. A contract must not be edited casually to make an implementation easier.

### Compatible change

Requires a dedicated `contract:` PR that:

- explains why the change is required,
- updates affected contract tests/documentation,
- demonstrates compatibility with existing consumers.

### Breaking change

Requires:

- a new major API/package (`/v2` or `inventory.v2`),
- migration notes,
- all affected tests updated deliberately,
- a new contract tag.

## Required gates before tagging

```bash
# protobuf style and compilation
buf lint contracts/grpc

# after the baseline exists, future PRs also run:
buf breaking contracts/grpc --against '.git#tag=contracts-v1.0.0,subdir=contracts/grpc'
```

CI should also validate `contracts/rest/openapi.yaml` with an OpenAPI 3.1-compatible validator and may use an OpenAPI diff tool to reject breaking REST changes against the frozen tag.
