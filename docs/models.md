# Model Tunneling

The proxy forwards the requested model to the Claude Code CLI's `--model` flag
**verbatim**, so any model ID or alias the CLI accepts works — including models
released after this document was written. There is no allow-list.

## Resolution rules

Implemented in [`src/adapter/openai-to-cli.ts`](../src/adapter/openai-to-cli.ts) (`extractModel`):

1. Strip a provider prefix if present: `claude-code-cli/` or `claude-max/`
   (e.g. `claude-max/claude-sonnet-4-6` → `claude-sonnet-4-6`).
2. Pass the remainder through unchanged as `--model`.
3. Empty or whitespace-only input falls back to **`claude-opus-4-8`**.

That's it — full IDs (`claude-opus-4-8`), bare aliases (`opus`), and future model
strings all flow straight to the CLI.

## Known models (`/v1/models`)

`KNOWN_MODELS` is the source of truth for the `/v1/models` listing and the default
fallback. It is **not** a whitelist — unlisted models still work.

| Model ID | Tier |
|----------|------|
| `claude-fable-5` | Most capable (thinking always on) |
| `claude-opus-4-8` | Opus (current, default fallback) |
| `claude-opus-4-7` | Opus |
| `claude-opus-4-6` | Opus |
| `claude-sonnet-4-6` | Sonnet (balanced) |
| `claude-haiku-4-5` | Haiku (fastest) |
| `claude-opus-4-5` | Opus (legacy, active) |
| `claude-sonnet-4-5` | Sonnet (legacy, active) |
| `opus` / `sonnet` / `haiku` / `fable` | Aliases → latest of each tier |

To add a model to the listing, edit `KNOWN_MODELS` in
[`src/adapter/openai-to-cli.ts`](../src/adapter/openai-to-cli.ts). To *use* a new
model you don't need to change anything — just request it.

## Response model echoes the request

The response `model` field reflects the **model you requested**, not whatever the
CLI reports in `modelUsage`.

Why: Claude Code bills auxiliary models for internal subtasks (e.g. Haiku for
summarization), so `result.modelUsage` can contain a model that didn't actually
serve your turn — and its key order is not the main model. Deriving the response
model from `Object.keys(modelUsage)[0]` would mislabel responses (a Sonnet request
could come back tagged `claude-haiku-4-5`).

- Non-streaming: `cliResultToOpenai(..., requestedModel)` uses the resolved request model.
- Streaming: the model is pinned to the resolved request model for every chunk.

See [`src/adapter/cli-to-openai.ts`](../src/adapter/cli-to-openai.ts) and
[`src/server/routes.ts`](../src/server/routes.ts).

## Examples

```bash
# Full ID
curl -s localhost:3456/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"claude-opus-4-8","messages":[{"role":"user","content":"hi"}]}' | jq .model
# → "claude-opus-4-8"

# Alias
curl -s localhost:3456/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"sonnet","messages":[{"role":"user","content":"hi"}]}' | jq .model
# → "sonnet"

# Provider prefix stripped
curl -s localhost:3456/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"claude-max/claude-haiku-4-5","messages":[{"role":"user","content":"hi"}]}' | jq .model
# → "claude-haiku-4-5"
```
