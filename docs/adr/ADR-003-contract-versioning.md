# ADR-003 - Contract-first versioning and compatibility policy

**Status:** Accepted

## Context
The implementation must be able to evolve without changing integration assumptions unexpectedly. The contracts therefore need an explicit evolution strategy for compatible and breaking changes.

## Alternatives considered
1. **Code-first and generate contracts later.** Fast at the beginning but creates drift and merge-time integration failures.
2. **Contract-first without compatibility gates.** Better coordination, but accidental breaking changes can still enter main.
3. **Contract-first with semantic tags and automated compatibility checks.** Requires more discipline but makes independent implementation practical.

## Decision
Freeze the baseline as Git tag `contracts-v1.0.0` after both contract files are merged and validated.

Versioning rules:
- REST major version is encoded in the path: `/v1`.
- gRPC major version is encoded in the package: `repuestossur.inventory.v1`.
- Contract releases use semantic tags `contracts-vMAJOR.MINOR.PATCH`.
- Additive compatible changes can remain in v1.
- Breaking behavior/schema changes require `/v2` and/or `inventory.v2`.

## Compatible changes in v1
- Add a new optional REST response field.
- Add a new REST endpoint.
- Add a new protobuf field using a new field number.
- Add a new protobuf RPC when existing consumers remain valid.

## Breaking changes requiring a major version
- Remove or rename a required REST field.
- Change the meaning/type of an existing REST field.
- Remove an endpoint or change existing success/error semantics incompatibly.
- Change a protobuf field number or reuse a deleted field number.
- Change a protobuf field to an incompatible wire type.
- Remove/rename an RPC used by consumers.

## Change process
After the freeze, no contract file is edited as a side effect of a feature change. Contract modifications require a dedicated contract PR with the affected tests and documentation updated. A breaking change requires a new major version and migration plan.

## Cost accepted
Small changes may take longer because the interface is deliberately controlled.

## Consequences
- `buf lint` and `buf breaking --against '.git#tag=contracts-v1.0.0'` are CI gates for protobuf.
- An OpenAPI breaking-change checker should run against the frozen baseline.
- Deleted protobuf fields must reserve both their old field number and name.
- Consumers can implement against the frozen files independently of implementation order.
