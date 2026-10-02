# Gateway API

Base URL in development: `http://localhost:3001`

## Chat completions

```http
POST /v1/chat/completions
Authorization: Bearer vh_test_...
Content-Type: application/json
```

Accepted fields:

```json
{
  "model": "gpt-4.1-mini",
  "messages": [{ "role": "user", "content": "Explain our return policy." }],
  "temperature": 0.2,
  "max_tokens": 400,
  "stream": true
}
```

Unknown fields are rejected. The gateway does not forward arbitrary JSON.

`stream: true` forwards provider chunks as they arrive. The gateway records time to first token, total latency, and usage after the stream completes. If the client disconnects, the gateway stops reading the provider response and finalises the request.

Non-streaming requests may send `Idempotency-Key`. Vhalcha stores a SHA-256 fingerprint of the parsed request, the Vhalcha request id, and a status (`pending`, `completed`, or `failed`) for 24 hours. It does not store the prompt or the provider completion, so the original model output is not replayed.

A repeated key with the same fingerprint, after the first call has finished, returns:

```json
{
  "error": {
    "code": "idempotent_request_already_completed",
    "message": "This idempotency key has already completed.",
    "request_id": "..."
  }
}
```

The provider is not called again. The same key with a different request returns `idempotency_conflict`. A key that is still in progress also returns `idempotency_conflict`. Streaming requests ignore the header.

Before the provider call, Vhalcha estimates a maximum cost from the message length (four characters per token) and `max_tokens`. When `max_tokens` is omitted, the reservation uses 4,096 output tokens. That estimate is reserved atomically. The request is then marked `provider_started` before provider I/O. After the provider reports usage, the hold is replaced by the actual cost. A failed provider call releases the hold. A hold that expires before the provider starts is released with no cost. A hold that expires after `provider_started` is recorded at the reserved amount and the request becomes `reconciliation_required`.

## Errors

```json
{
  "error": {
    "code": "invalid_api_key",
    "message": "The provided Vhalcha API key is invalid."
  }
}
```

| Code | HTTP | Meaning |
| --- | --- | --- |
| `invalid_api_key` | 401 | Missing, malformed, or unknown key |
| `api_key_revoked` | 401 | Revoked or expired key |
| `organisation_unavailable` | 403 | Organisation is not active |
| `system_disabled` | 403 | System is disabled or offline |
| `model_not_allowed` | 403 | No allow rule matched |
| `pricing_unknown` | 403 | Model has no price and a hard budget is active |
| `budget_exceeded` | 402 | Hard budget reached. The provider is not called. |
| `rate_limit_exceeded` | 429 | AI system rate limit reached |
| `invalid_request` | 400 | Body failed schema validation |
| `idempotency_conflict` | 409 | Same key is already running, or the request fingerprint differs |
| `idempotent_request_already_completed` | 409 | The key already finished. The provider is not called. `request_id` is the original Vhalcha request |
| `provider_error` | 502 | Provider rejected the request |
| `provider_unavailable` | 503 | Provider or platform credential is unavailable |
| `rate_limiter_unavailable` | 503 | Redis could not enforce the rate limit |
| `control_plane_unavailable` | 503 | PostgreSQL or idempotency storage could not enforce policy |
| `internal_error` | 500 | Unexpected failure. Database details are not returned. |

Budget exceeded is HTTP 402 throughout V1.

Rate-limit responses include `ratelimit-limit`, `ratelimit-remaining`, and `ratelimit-reset` when the limiter answered.

## Health

```http
GET /health
GET /ready
```

`/health` returns whether the process is up. `/ready` checks PostgreSQL and Redis. Neither response includes credentials.

## Pricing

Known standard prices live in `packages/providers/src/pricing`. Cost is calculated from input and output tokens. An unknown model records `estimated_cost_usd = null` and `pricing_unknown` in metadata. If a hard budget applies, that request is blocked before the provider call.

The development model is `gpt-4.1-mini`.
