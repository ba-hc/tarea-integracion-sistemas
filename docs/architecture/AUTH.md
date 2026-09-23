# Authentication and authorization contract

## Mechanism

Public REST requests use:

```http
X-API-Key: <secret>
```

`/v1/health` is public. All customer/order operations require a valid key.

## Roles

| Role | GET | POST |
|---|---:|---:|
| `reader` | yes | no |
| `operator` | yes | yes |

## Status behavior

- Missing key: `401 UNAUTHORIZED`.
- Unknown/invalid key: `401 UNAUTHORIZED`.
- Valid `reader` key on a POST operation: `403 FORBIDDEN`.
- Valid `operator` key: allowed subject to normal business validation.

## Security rules

- Keys are supplied through environment/secrets, never committed.
- Raw keys must not appear in logs, traces, test snapshots or error messages.
- Compare keys using a constant-time comparison or compare stored hashes.
- Local Docker may use HTTP; production deployment would require TLS at the ingress/reverse proxy.
- Logs should identify the key role or non-secret key identifier, not the secret itself.

## Context factor for ABET 2

Security of customer and operational data materially changes the design: authenticated access is mandatory; write privileges are separated from read privileges; secrets are externalized; and sensitive headers are redacted from logs.
