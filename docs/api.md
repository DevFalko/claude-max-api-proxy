# API Reference

The proxy exposes an OpenAI-compatible subset of the Chat Completions API plus a
couple of helper endpoints. Base URL defaults to `http://localhost:3456`.

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Liveness probe |
| `/v1/models` | GET | List known models |
| `/v1/chat/completions` | POST | Chat completions (streaming & non-streaming) |

No authentication is required by the proxy itself — any `Authorization` / `api_key`
value sent by the client is accepted and ignored (auth is handled by the Claude CLI).

---

## `GET /health`

```json
{ "status": "ok", "provider": "claude-code-cli", "timestamp": "2026-06-19T14:20:35.966Z" }
```

## `GET /v1/models`

Returns the known model list (see [models.md](models.md)). Any model the CLI
accepts can still be *used* even if it isn't listed here. Each entry carries
`context_length` (input window) and `max_output_tokens` so clients can size their
context budget per model.

```json
{
  "object": "list",
  "data": [
    { "id": "claude-fable-5",  "object": "model", "owned_by": "anthropic", "created": 1750000000,
      "context_length": 1000000, "max_output_tokens": 128000 },
    { "id": "claude-haiku-4-5", "object": "model", "owned_by": "anthropic", "created": 1750000000,
      "context_length": 200000, "max_output_tokens": 64000 }
  ]
}
```

## `POST /v1/chat/completions`

### Request body

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `model` | string | yes | Any CLI model ID or alias. Forwarded verbatim (provider prefix stripped). See [models.md](models.md). |
| `messages` | array | yes | OpenAI messages. `system`/`user`/`assistant` roles supported; `content` may be a string or an array of `{type:"text"\|"input_text", text}` blocks. |
| `stream` | boolean | no | `true` → Server-Sent Events. Default `false`. |
| `reasoning_effort` | string | no | `low` \| `medium` \| `high` \| `xhigh` \| `max`. Enables extended thinking. See [reasoning.md](reasoning.md). |
| `max_thinking_tokens` | number | no | On/off only: `> 0` enables thinking (value ignored), `0` forces it off. Overrides `reasoning_effort`. See [reasoning.md](reasoning.md). |
| `user` | string | no | Accepted (OpenAI end-user identifier); currently unused. |

Other OpenAI sampling fields (`temperature`, `top_p`, `max_tokens`, …) are accepted
but currently ignored — the CLI controls generation.

### Non-streaming response

```json
{
  "id": "chatcmpl-<id>",
  "object": "chat.completion",
  "created": 1750000000,
  "model": "claude-sonnet-4-6",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "17 × 23 = 391",
      "reasoning_content": "17 × 23 = 17×20 + 17×3 = 340 + 51 = 391"
    },
    "finish_reason": "stop"
  }],
  "usage": { "prompt_tokens": 12, "completion_tokens": 20, "total_tokens": 32 }
}
```

- `message.reasoning_content` is present only when thinking ran (see [reasoning.md](reasoning.md)).
- `model` echoes the **requested** model, not an auxiliary internal model.

### Streaming response (SSE)

Each event is a `data: { ... }` line; the stream terminates with `data: [DONE]`.

```
data: {"id":"chatcmpl-x","object":"chat.completion.chunk","model":"claude-sonnet-4-6",
       "choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"17 × 23"},"finish_reason":null}]}

data: {"id":"chatcmpl-x","object":"chat.completion.chunk","model":"claude-sonnet-4-6",
       "choices":[{"index":0,"delta":{"content":"17 × 23 = 391"},"finish_reason":null}]}

data: {"id":"chatcmpl-x","object":"chat.completion.chunk","model":"claude-sonnet-4-6",
       "choices":[{"index":0,"delta":{},"finish_reason":"stop"}],
       "usage":{"prompt_tokens":12,"completion_tokens":20,"total_tokens":32}}

data: [DONE]
```

- `reasoning_content` deltas (when thinking is on) are emitted **before** the
  `content` deltas.
- The final chunk carries `finish_reason: "stop"` and `usage`.

### Error response

```json
{ "error": { "message": "messages is required and must be a non-empty array",
             "type": "invalid_request_error", "code": "invalid_messages" } }
```

In streaming mode, an error is written as a `data: {"error": {...}}` event followed
by `data: [DONE]`.
