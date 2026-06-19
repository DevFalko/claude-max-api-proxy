# Reasoning / Extended Thinking

The proxy exposes Claude's extended thinking through the OpenAI-standard
`reasoning_effort` field and returns the thinking text in a separate
`reasoning_content` field (the convention used by DeepSeek, OpenRouter, vLLM, …).

## Enabling it

```jsonc
{
  "model": "claude-sonnet-4-6",
  "reasoning_effort": "high",   // low | medium | high | xhigh | max
  "messages": [{ "role": "user", "content": "..." }]
}
```

`reasoning_effort` maps **1:1** to the Claude Code CLI's `--effort` flag.

| `reasoning_effort` | CLI `--effort` |
|--------------------|----------------|
| `low` | `low` |
| `medium` | `medium` |
| `high` | `high` |
| `xhigh` | `xhigh` |
| `max` | `max` |

An unrecognized value is treated as `high`. (`xhigh`/`max` are Claude-specific
extras beyond the OpenAI standard `low`/`medium`/`high`.)

### `max_thinking_tokens`

An optional explicit switch:

- `max_thinking_tokens: 0` → thinking **off** (overrides `reasoning_effort`).
- `max_thinking_tokens: N` (N > 0) without `reasoning_effort` → thinking **on** at
  `high` effort. The number itself is passed to the CLI as a forward-compatible
  hint but **does not cap depth** on current CLI versions (see below).

## Output

The thinking text is delivered separately from the answer:

- **Non-streaming:** `choices[0].message.reasoning_content` (alongside `content`).
- **Streaming:** `choices[0].delta.reasoning_content` chunks, emitted **before**
  the `content` chunks.

When thinking is off, `reasoning_content` is absent entirely.

## Off by default

Omit `reasoning_effort` (and `max_thinking_tokens`) and thinking is disabled — the
proxy sets `MAX_THINKING_TOKENS=0` in the subprocess environment, which is the
reliable hard-off switch (see the behavior table). No `reasoning_content` is returned.

## Adaptive caveat

Even with `reasoning_effort` set, **whether the model thinks is adaptive**: a
trivial prompt (e.g. "What is 2+2?") may answer directly with no thinking, so
`reasoning_content` can legitimately be empty/absent. Prompts that genuinely call
for multi-step reasoning reliably produce thinking. `claude-fable-5` always thinks.

## How it works under the hood

Verified empirically against Claude Code CLI 2.1.x in
`--print --output-format stream-json --verbose --include-partial-messages` mode:

| Subprocess setup | Thinking |
|------------------|----------|
| `--effort <level>` | **on** — enables/deepens thinking |
| `MAX_THINKING_TOKENS=0` (with or without `--effort`) | **off** — overrides everything |
| `MAX_THINKING_TOKENS=64` + `--effort high` | thinking still runs and is **not** capped — a positive value is effectively a no-op |
| no flag, reasoning-heavy prompt | adaptive **on** |
| no flag, trivial prompt | **off** |

So `--effort` is the activation/depth lever, and `MAX_THINKING_TOKENS=0` is the
only dependable way to force thinking off.

Thinking arrives on the stream as:

- `content_block_start` with `content_block.type: "thinking"`
- `content_block_delta` with `delta.type: "thinking_delta"` (text in `delta.thinking`)
- `content_block_delta` with `delta.type: "signature_delta"` — **ignored** by the proxy

The proxy forwards `thinking_delta` events as `reasoning_content`.

### Code map

| Concern | Location |
|---------|----------|
| `reasoning_effort` / `max_thinking_tokens` → effort | `resolveThinking()` in [`src/adapter/openai-to-cli.ts`](../src/adapter/openai-to-cli.ts) |
| `--effort` flag + `MAX_THINKING_TOKENS=0` off-switch | [`src/subprocess/manager.ts`](../src/subprocess/manager.ts) |
| Thinking event type guards | [`src/types/claude-cli.ts`](../src/types/claude-cli.ts) (`isThinkingDelta`) |
| `reasoning_content` streaming / accumulation | [`src/server/routes.ts`](../src/server/routes.ts) |

## Examples

Non-streaming:

```bash
curl -s localhost:3456/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"claude-sonnet-4-6","reasoning_effort":"high",
       "messages":[{"role":"user","content":"Compute 17*23 two ways; reason it through."}]}' \
  | jq '{reasoning:.choices[0].message.reasoning_content, answer:.choices[0].message.content}'
```

Streaming:

```bash
curl -sN localhost:3456/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"claude-opus-4-8","reasoning_effort":"high","stream":true,
       "messages":[{"role":"user","content":"Why is the sky blue? Reason briefly."}]}'
```

Python (OpenAI SDK):

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:3456/v1", api_key="not-needed")
resp = client.chat.completions.create(
    model="claude-sonnet-4-6",
    messages=[{"role": "user", "content": "Compute 17*23 two ways; reason it through."}],
    extra_body={"reasoning_effort": "high"},
)
msg = resp.choices[0].message
print("THINKING:", getattr(msg, "reasoning_content", None))
print("ANSWER:", msg.content)
```
