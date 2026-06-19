# Claude Max API Proxy - Technical Design (Current)

## Scope

This repository implements an OpenAI-compatible HTTP proxy that executes Claude Code CLI as a local subprocess.

It supports:
- Streaming and non-streaming chat completions
- Model passthrough (model IDs and aliases accepted by Claude CLI)
- Reasoning passthrough via reasoning_effort -> --effort
- OpenClaw compatibility helpers (tool-name mapping, system prompt adaptation)

It intentionally does not implement server-side conversation persistence.

## Runtime Architecture

```text
Client (OpenClaw, Continue, OpenAI SDK, curl)
  -> HTTP /v1/chat/completions
  -> Express server (src/server/index.ts)
  -> Route handlers (src/server/routes.ts)
  -> Request adapter (src/adapter/openai-to-cli.ts)
  -> Claude subprocess manager (src/subprocess/manager.ts)
  -> claude CLI (stream-json)
  -> Response adapter (src/adapter/cli-to-openai.ts)
  -> OpenAI-compatible JSON/SSE response
```

## Source Layout

```text
src/
  index.ts                    Plugin entry point for Clawdbot integration
  e2e.test.ts                 End-to-end tests
  adapter/
    openai-to-cli.ts          OpenAI request -> CLI prompt/model/effort
    cli-to-openai.ts          CLI result -> OpenAI response/chunks
    adapter.test.ts           Adapter unit tests
  server/
    index.ts                  Express app, auth, CORS, bind policy
    routes.ts                 /health, /v1/models, /v1/chat/completions
    standalone.ts             Standalone executable entrypoint
  subprocess/
    manager.ts                Spawn/stream/timeout/env filtering/verification
  types/
    openai.ts                 OpenAI-compatible request/response types
    claude-cli.ts             Claude stream-json message/event types + guards
```

## Request Flow

1. Parse JSON request and validate messages in src/server/routes.ts.
2. Convert OpenAI messages to CLI prompt in src/adapter/openai-to-cli.ts.
3. Resolve model passthrough and optional reasoning effort.
4. Spawn claude with stream-json in src/subprocess/manager.ts.
5. Translate stream events to SSE chunks for stream=true, or aggregate result for stream=false.
6. Return OpenAI-compatible shape, including usage and optional reasoning_content.

## Security Design

Implemented controls in the current code:
- Loopback-first binding: non-loopback host requires PROXY_API_KEY.
- Optional API-key gate on /v1/* via Authorization Bearer or x-api-key.
- Optional CORS only when PROXY_CORS_ORIGIN is configured.
- Concurrency limit (default 8) to prevent subprocess exhaustion.
- Sensitive environment-variable stripping before spawning claude.
- spawn() with argument array and stdin prompt forwarding (no shell eval).

## Behavior Notes

- The proxy is stateless per request: it always runs with --no-session-persistence.
- OpenAI user is not mapped to --session-id.
- Tool-call forwarding is not exposed as OpenAI tool invocations; final text output is returned.
- /v1/models advertises known model IDs and token limits, while model input remains passthrough.

## Deployment Notes

- Build: npm run build
- Standalone start: node dist/server/standalone.js [port]
- npm bin command: claude-max-api

## Non-Goals

- No remote multi-tenant auth gateway
- No persistent chat-session database
- No generic Claude API replacement beyond OpenAI-compatible chat completions and model listing
