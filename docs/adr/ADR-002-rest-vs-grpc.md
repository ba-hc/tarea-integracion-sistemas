# ADR-002 - REST externally, unary gRPC internally

**Status:** Accepted

## Context
The public-facing Sales capability may be used by staff and a future web portal, while Inventory is an internal high-frequency dependency used only by Sales. The assignment explicitly asks for REST outside and gRPC inside, but the choice still must be justified.

## Alternatives considered
1. **REST/JSON for both boundaries.** Operationally simple and easy to inspect, but duplicates HTTP API concerns on the internal path and gives weaker schema/code-generation guarantees than the selected protobuf contract.
2. **gRPC for both boundaries.** Strong contracts and efficient binary transport everywhere, but browser/public interoperability and manual debugging are less convenient for the public edge.
3. **REST public + gRPC internal.** Uses a broadly interoperable HTTP/JSON interface at the edge and a strongly typed protobuf RPC interface between services.

## Decision
Expose Sales through a versioned REST/JSON API under `/v1`. Use unary gRPC with Protocol Buffers for Sales-to-Inventory communication.

## Justification
Public consumers benefit from standard HTTP semantics, OpenAPI tooling and easy browser/tool interoperability. Internally, the `.proto` is a compact, language-neutral contract that can generate clients and servers. Every required Inventory operation is request/response, so unary RPC is sufficient; streaming would add complexity without a use case.

## Cost accepted
- The system carries two protocol/tooling stacks.
- Engineers must understand both HTTP status semantics and gRPC status semantics.
- Error translation at the Sales boundary must be explicit.

## Consequences
- REST contract: `contracts/rest/openapi.yaml`.
- gRPC contract: `contracts/grpc/repuestossur/inventory/v1/inventory.proto`.
- Streaming RPCs are forbidden in v1.
- Sales owns the translation from gRPC failures to stable public HTTP errors.
