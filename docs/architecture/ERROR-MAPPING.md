# Error and status mapping

## Public REST error envelope

```json
{
  "code": "INVENTORY_UNAVAILABLE",
  "message": "Inventory service is unavailable",
  "traceId": "73a9be64-6e7e-42c2-badc-55f42f649668",
  "details": {}
}
```

`details` is optional. Internal stack traces, SQL messages and raw gRPC errors are never returned to clients.

## REST codes

| Situation | HTTP | Public code |
|---|---:|---|
| malformed/invalid request | 400 | `VALIDATION_ERROR` |
| API key missing/invalid | 401 | `UNAUTHORIZED` |
| valid key lacks role | 403 | `FORBIDDEN` |
| customer absent | 404 | `CUSTOMER_NOT_FOUND` |
| order absent | 404 | `ORDER_NOT_FOUND` |
| duplicate customer email | 409 | `CUSTOMER_EMAIL_CONFLICT` |
| insufficient current stock | 409 | `INSUFFICIENT_STOCK` |
| idempotency key reused with different payload | 409 | `IDEMPOTENCY_KEY_CONFLICT` |
| referenced Inventory part absent | 422 | `PART_NOT_FOUND` |
| Inventory connection/service unavailable | 503 | `INVENTORY_UNAVAILABLE` |
| Inventory deadline exceeded | 504 | `INVENTORY_TIMEOUT` |
| unexpected Sales failure | 500 | `INTERNAL_ERROR` |

## gRPC Inventory statuses

| Inventory condition | gRPC status |
|---|---|
| malformed UUID, empty items, invalid quantity, duplicate part in request | `INVALID_ARGUMENT` |
| requested part not found | `NOT_FOUND` |
| insufficient stock | `FAILED_PRECONDITION` |
| same order_id reused with a different reservation payload | `ALREADY_EXISTS` |
| unexpected database/server error | `INTERNAL` |
| server/network unavailable | `UNAVAILABLE` |
| caller deadline exceeded | `DEADLINE_EXCEEDED` |

## Sales translation for order mutation calls

| gRPC | HTTP | Public code |
|---|---:|---|
| `INVALID_ARGUMENT` | 400 | `VALIDATION_ERROR` |
| `NOT_FOUND` | 422 | `PART_NOT_FOUND` |
| `FAILED_PRECONDITION` | 409 | `INSUFFICIENT_STOCK` |
| `ALREADY_EXISTS` from internal order-id mismatch | 500 | `INTERNAL_ERROR` |
| `UNAVAILABLE` | 503 | `INVENTORY_UNAVAILABLE` |
| `DEADLINE_EXCEEDED` | 504 | `INVENTORY_TIMEOUT` |
| `INTERNAL` / `UNKNOWN` | 500 | `INTERNAL_ERROR` |
