# Claude Max API Proxy

> Actively maintained fork of [atalovesyou/claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy) with OpenClaw integration, improved streaming, full Anthropic model tunneling, and OpenAI-style reasoning support.

**Use your Claude Max subscription ($200/month) with any OpenAI-compatible client — no separate API costs!**

This proxy wraps the Claude Code CLI as a subprocess and exposes an OpenAI-compatible HTTP API, allowing tools like OpenClaw, Continue.dev, or any OpenAI-compatible client to use your Claude Max subscription instead of paying per-API-call.

## Why This Exists

| Approach | Cost | Limitation |
|----------|------|------------|
| Claude API | ~$15/M input, ~$75/M output tokens | Pay per use |
| Claude Max | $200/month flat | OAuth blocked for third-party API use |
| **This Proxy** | $0 extra (uses Max subscription) | Routes through CLI |

Anthropic blocks OAuth tokens from being used directly with third-party API clients. However, the Claude Code CLI *can* use OAuth tokens. This proxy bridges that gap by wrapping the CLI and exposing a standard API.

## How It Works

```
Your App (OpenClaw, Continue.dev, etc.)
         ↓
    HTTP Request (OpenAI format)
         ↓
   Claude Max API Proxy (this project)
         ↓
   Claude Code CLI (subprocess)
         ↓
   OAuth Token (from Max subscription)
         ↓
   Anthropic API
         ↓
   Response → OpenAI format → Your App
```

## Features

- **OpenAI-compatible API** — Works with any client that supports OpenAI's API format
- **Full Anthropic model tunneling** — Pass through *any* model the CLI accepts (Fable 5, Opus 4.8/4.7/4.6, Sonnet 4.6, Haiku 4.5, …) plus the bare aliases `opus`/`sonnet`/`haiku`/`fable`. New models work without a code change. See [docs/models.md](docs/models.md).
- **Reasoning / extended thinking** — Set `reasoning_effort` (`low`/`medium`/`high`/`xhigh`/`max`) and the model's thinking is streamed back in a separate `reasoning_content` field (DeepSeek/OpenRouter-style). See [docs/reasoning.md](docs/reasoning.md).
- **Streaming support** — Real-time token streaming via Server-Sent Events, with reasoning chunks emitted before the answer
- **OpenClaw integration** — Automatic tool name mapping and system prompt adaptation
- **Content block handling** — Proper text block separators for multi-block responses
- **Session management** — Maintains conversation context via session IDs
- **Auto-start service** — Optional LaunchAgent for macOS
- **Zero configuration** — Uses existing Claude CLI authentication
- **Secure by design** — Uses `spawn()` to prevent shell injection

## What's Different from the Original

- **Full model passthrough** — The original collapsed every request onto three aliases and defaulted everything to Opus. This fork forwards the exact requested model ID/alias to `--model`, and the response echoes the model you asked for (not an auxiliary internal model). See [docs/models.md](docs/models.md).
- **Reasoning support** — `reasoning_effort` → the CLI's `--effort` flag; extended-thinking output is surfaced as `reasoning_content`. See [docs/reasoning.md](docs/reasoning.md).
- **OpenClaw tool mapping** — Maps OpenClaw tool names (`exec`, `read`, `web_search`, etc.) to Claude Code equivalents (`Bash`, `Read`, `WebSearch`)
- **System prompt stripping** — Removes OpenClaw-specific tooling sections that confuse the CLI
- **Content block support** — Handles `input_text` content blocks and multi-block text separators
- **Improved streaming** — Better SSE handling with connection confirmation and client disconnect detection

## Prerequisites

1. **Claude Max subscription** ($200/month) — [Subscribe here](https://claude.ai)
2. **Claude Code CLI** installed and authenticated:
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude /login   # OAuth via browser (older builds: claude auth login)
   ```
3. **Node.js ≥ 20**

## Installation

```bash
# Clone your fork
git clone https://github.com/<your-account>/claude-max-api-proxy.git
cd claude-max-api-proxy

# Install dependencies
npm install

# Build
npm run build
```

## Usage

### Start the server

```bash
npm start
# or
node dist/server/standalone.js
```

The server runs at `http://localhost:3456` by default. Pass a custom port as an argument:

```bash
node dist/server/standalone.js 8080
```

### Test it

```bash
# Health check
curl http://localhost:3456/health

# List models
curl http://localhost:3456/v1/models

# Chat completion (non-streaming)
curl -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Chat completion (streaming)
curl -N -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4-8",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'

# With reasoning (thinking streamed as reasoning_content, separate from content)
curl -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "reasoning_effort": "high",
    "messages": [{"role": "user", "content": "Compute 17*23 two ways; reason it through."}]
  }'
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/v1/models` | GET | List available models |
| `/v1/chat/completions` | POST | Chat completions (streaming & non-streaming) |

Full request/response field reference (including `reasoning_effort` and `reasoning_content`): [docs/api.md](docs/api.md).

## Available Models

The proxy **forwards the requested model verbatim** to the CLI, so any model or alias the Claude Code CLI accepts works — including ones released after this README was written. The list returned by `/v1/models`:

| Model ID | Tier | Notes |
|----------|------|-------|
| `claude-fable-5` | Most capable | Thinking always on |
| `claude-opus-4-8` | Opus (current) | Default fallback |
| `claude-opus-4-7` | Opus | |
| `claude-opus-4-6` | Opus | |
| `claude-sonnet-4-6` | Sonnet | Balanced |
| `claude-haiku-4-5` | Haiku | Fastest |
| `claude-opus-4-5`, `claude-sonnet-4-5` | Legacy | Still active |
| `opus`, `sonnet`, `haiku`, `fable` | Aliases | Map to the latest of each tier |

A `claude-code-cli/` or `claude-max/` provider prefix is stripped automatically (e.g. `claude-max/claude-sonnet-4-6`). An empty or unrecognized model falls back to `claude-opus-4-8`.

`/v1/models` also reports each model's `context_length` (input window: 1M for Opus/Sonnet/Fable, 200K for Haiku) and `max_output_tokens`, so OpenClaw and other clients can size their context budget per model. Details: [docs/models.md](docs/models.md).

## Reasoning / Extended Thinking

Enable extended thinking per request with the OpenAI-standard `reasoning_effort` field:

```jsonc
{
  "model": "claude-sonnet-4-6",
  "reasoning_effort": "high",        // low | medium | high | xhigh | max
  "messages": [{ "role": "user", "content": "..." }]
}
```

- The thinking text comes back in a **separate `reasoning_content`** field on the message (non-streaming) or delta (streaming) — it is **not** mixed into `content`.
- In streaming mode, `reasoning_content` chunks arrive **before** the `content` chunks.
- Omit `reasoning_effort` and thinking is **off** (no `reasoning_content`). You can also force it off with `max_thinking_tokens: 0`.

Whether the model actually thinks is adaptive: trivial prompts may answer directly even at high effort. Full behavior, the effort→`--effort` mapping, and the CLI mechanics: [docs/reasoning.md](docs/reasoning.md).

## Configuration with Popular Tools

### OpenClaw

OpenClaw works with this proxy out of the box. The proxy automatically maps OpenClaw tool names to Claude Code equivalents and strips conflicting tooling sections from system prompts.

### Continue.dev

Add to your Continue config:

```json
{
  "models": [{
    "title": "Claude (Max)",
    "provider": "openai",
    "model": "claude-sonnet-4-6",
    "apiBase": "http://localhost:3456/v1",
    "apiKey": "not-needed"
  }]
}
```

### Generic OpenAI Client (Python)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3456/v1",
    api_key="not-needed",  # Any value works
)

response = client.chat.completions.create(
    model="claude-sonnet-4-6",
    messages=[{"role": "user", "content": "Hello!"}],
    extra_body={"reasoning_effort": "high"},  # optional: enable thinking
)

print(response.choices[0].message.content)
# Thinking (if enabled) is on response.choices[0].message.reasoning_content
```

## Auto-Start on macOS

The proxy can run as a macOS LaunchAgent on port 3456. For a full step-by-step
plist + install walkthrough, see [docs/macos-setup.md](docs/macos-setup.md).

**Plist location:** `~/Library/LaunchAgents/com.openclaw.claude-max-proxy.plist`

```bash
# Start the service
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.openclaw.claude-max-proxy.plist

# Restart
launchctl kickstart -k gui/$(id -u)/com.openclaw.claude-max-proxy

# Stop
launchctl bootout gui/$(id -u)/com.openclaw.claude-max-proxy

# Check status
launchctl list com.openclaw.claude-max-proxy
```

## Architecture

```
src/
├── types/
│   ├── claude-cli.ts      # Claude CLI JSON streaming types + type guards (incl. thinking events)
│   └── openai.ts          # OpenAI API types (reasoning_effort, reasoning_content, tool calls)
├── adapter/
│   ├── openai-to-cli.ts   # OpenAI request → CLI: model passthrough + effort resolution
│   └── cli-to-openai.ts   # CLI response → OpenAI: echoes requested model
├── subprocess/
│   └── manager.ts         # Claude CLI subprocess: --model / --effort, thinking event forwarding
├── session/
│   └── manager.ts         # Session ID mapping
├── server/
│   ├── index.ts           # Express server setup
│   ├── routes.ts          # API route handlers (reasoning_content streaming + non-streaming)
│   └── standalone.ts      # Entry point
└── index.ts               # Package exports
```

See [docs/](docs/) for the API reference, model-tunneling details, and reasoning behavior.

## Security & configuration

This proxy turns HTTP requests into `claude --dangerously-skip-permissions`
subprocesses that can run tools (Bash, file edits, web fetch) on the host. Treat
it as a **local, single-user gateway** and understand the trust boundary:

- **Loopback by default.** The server binds to `127.0.0.1`. Binding to a
  non-loopback host is refused unless `PROXY_API_KEY` is set — the loopback bind
  is a load-bearing control.
- **Optional auth.** Set `PROXY_API_KEY` to require `Authorization: Bearer <key>`
  (or `x-api-key: <key>`) on `/v1/*`. Unset → open (loopback only).
- **CORS is opt-in.** No `Access-Control-Allow-Origin` header is sent unless
  `PROXY_CORS_ORIGIN` is set — this stops a web page you visit from driving the
  API cross-origin (localhost-CSRF).
- **Concurrency cap.** At most `PROXY_MAX_CONCURRENCY` (default 8) subprocesses
  run at once; excess requests get `429`.
- **Env hygiene.** Common third-party secrets (`AWS_*`, `GH_*`, `OPENAI_*`,
  `*_TOKEN`, `*_SECRET`, …) are stripped from the subprocess environment;
  `ANTHROPIC_*`/`CLAUDE_*` are preserved so the CLI can authenticate.
- Uses `spawn()` (no shell) — request text can't inject shell commands; the
  prompt is passed via **stdin** (avoids `E2BIG`).

| Env var | Default | Purpose |
|---|---|---|
| `PROXY_API_KEY` | (unset) | Require this bearer / `x-api-key` token on `/v1/*` |
| `PROXY_CORS_ORIGIN` | (unset) | Enable CORS for this origin |
| `PROXY_MAX_CONCURRENCY` | `8` | Max concurrent `claude` subprocesses |
| `CLAUDE_BIN` | `claude` | Path to the Claude Code CLI |
| `DEBUG` | (unset) | Verbose request/body logging |

## Troubleshooting

### "Claude CLI not found" / "Not logged in"

Install and authenticate the CLI:
```bash
npm install -g @anthropic-ai/claude-code
claude /login
```

### `reasoning_content` is empty even with `reasoning_effort` set

Thinking is adaptive — for trivial prompts the model may answer directly. Try a prompt that genuinely requires reasoning, or a higher effort level. See [docs/reasoning.md](docs/reasoning.md).

### Streaming returns immediately with no content

Ensure you're using `-N` with curl (disables buffering):
```bash
curl -N -X POST http://localhost:3456/v1/chat/completions ...
```

### Server won't start

Check that the Claude CLI is in your PATH:
```bash
which claude
```

## Contributing

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md). Please submit PRs with tests.

## License

MIT

## Acknowledgments

- Originally created by [atalovesyou](https://github.com/atalovesyou/claude-max-api-proxy)
- Built for use with [OpenClaw](https://openclaw.com)
- Powered by [Claude Code CLI](https://github.com/anthropics/claude-code)
