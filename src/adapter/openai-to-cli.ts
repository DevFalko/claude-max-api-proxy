/**
 * Converts OpenAI chat request format to Claude CLI input
 */

import type { OpenAIChatRequest, OpenAIContentBlock } from "../types/openai.js";

// A Claude model is just whatever the CLI's `--model` flag accepts: a full
// model ID (e.g. "claude-opus-4-8") or a bare alias (e.g. "opus", "fable").
export type ClaudeModel = string;

// Effort levels accepted by `claude --effort`.
export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";
const ALLOWED_EFFORTS: ClaudeEffort[] = ["low", "medium", "high", "xhigh", "max"];

export interface CliInput {
  prompt: string;
  model: ClaudeModel;
  sessionId?: string;
  // Reasoning / extended thinking. In Claude CLI 2.1.x the `--effort` flag
  // enables and deepens thinking; MAX_THINKING_TOKENS=0 is the only reliable
  // hard-off switch (a positive value does NOT cap depth — it's a no-op the
  // current CLI ignores, kept only as a forward-compatible hint).
  // effort === undefined → thinking disabled.
  effort?: ClaudeEffort;
  thinkingBudget?: number;
}

/**
 * Known model IDs and aliases. This is the source of truth for the `/v1/models`
 * listing and for the default fallback — it is NOT a whitelist. Any value the
 * CLI's `--model` flag accepts is passed through, so future models work without
 * a code change.
 */
export const KNOWN_MODELS = [
  // Current
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
  // Legacy (still active)
  "claude-opus-4-5",
  "claude-sonnet-4-5",
  // Bare aliases the CLI understands
  "opus",
  "sonnet",
  "haiku",
  "fable",
];

const DEFAULT_MODEL = "claude-opus-4-8";

export interface ModelLimits {
  /** Input context window in tokens. */
  contextLength: number;
  /** Maximum output tokens. */
  maxOutputTokens: number;
}

/**
 * Documented per-model limits, exposed via `/v1/models` so clients (OpenClaw,
 * etc.) can size their context budget per model. These are the models'
 * published context windows; the CLI manages compaction within whatever the
 * subscription actually grants. Edit here to adjust the advertised values.
 */
export const MODEL_LIMITS: Record<string, ModelLimits> = {
  "claude-fable-5": { contextLength: 1_000_000, maxOutputTokens: 128_000 },
  "claude-opus-4-8": { contextLength: 1_000_000, maxOutputTokens: 128_000 },
  "claude-opus-4-7": { contextLength: 1_000_000, maxOutputTokens: 128_000 },
  "claude-opus-4-6": { contextLength: 1_000_000, maxOutputTokens: 128_000 },
  "claude-sonnet-4-6": { contextLength: 1_000_000, maxOutputTokens: 64_000 },
  "claude-haiku-4-5": { contextLength: 200_000, maxOutputTokens: 64_000 },
  // Legacy (still active) — conservative defaults
  "claude-opus-4-5": { contextLength: 200_000, maxOutputTokens: 64_000 },
  "claude-sonnet-4-5": { contextLength: 1_000_000, maxOutputTokens: 64_000 },
  // Aliases → latest of each tier
  opus: { contextLength: 1_000_000, maxOutputTokens: 128_000 },
  sonnet: { contextLength: 1_000_000, maxOutputTokens: 64_000 },
  haiku: { contextLength: 200_000, maxOutputTokens: 64_000 },
  fable: { contextLength: 1_000_000, maxOutputTokens: 128_000 },
};

const DEFAULT_LIMITS: ModelLimits = { contextLength: 200_000, maxOutputTokens: 8_192 };

/** Look up a model's advertised limits, falling back to a conservative default. */
export function modelLimitsFor(model: string): ModelLimits {
  return MODEL_LIMITS[model] ?? DEFAULT_LIMITS;
}

/**
 * Resolve the requested model into the value passed to `claude --model`.
 *
 * Provider prefixes (`claude-code-cli/`, `claude-max/`) are stripped; the
 * remainder is passed through verbatim so any current or future model ID/alias
 * works. Empty/missing input falls back to the default.
 */
export function extractModel(model: string): ClaudeModel {
  const stripped = (model || "").replace(/^(?:claude-code-cli|claude-max)\//, "").trim();
  return stripped || DEFAULT_MODEL;
}

export interface ResolvedThinking {
  effort?: ClaudeEffort;
  thinkingBudget?: number;
}

/**
 * Resolve the reasoning configuration from an OpenAI request.
 *
 * - `reasoning_effort` (low/medium/high/xhigh/max) maps directly to `--effort`.
 * - `max_thinking_tokens > 0` without an effort level turns thinking on (at
 *   "high"); the number is carried as a forward-compatible env hint only.
 * - `max_thinking_tokens === 0` (or negative) forces thinking off, even if an
 *   effort level was also supplied.
 * - Nothing set → thinking off.
 */
export function resolveThinking(request: OpenAIChatRequest): ResolvedThinking {
  const mtt = request.max_thinking_tokens;
  const explicitlyOff = typeof mtt === "number" && mtt <= 0;
  if (explicitlyOff) return {};

  const budget = typeof mtt === "number" && mtt > 0 ? Math.floor(mtt) : undefined;

  if (request.reasoning_effort) {
    const effort = (ALLOWED_EFFORTS as string[]).includes(request.reasoning_effort)
      ? (request.reasoning_effort as ClaudeEffort)
      : "high";
    return { effort, thinkingBudget: budget };
  }

  if (budget !== undefined) {
    // Budget provided without an effort level → enable thinking at high depth.
    return { effort: "high", thinkingBudget: budget };
  }

  return {};
}

/**
 * Extract text from a content field that may be a string or array of content blocks.
 * OpenAI API allows content as either:
 *   - A plain string: "Hello"
 *   - An array of content blocks: [{"type": "text", "text": "Hello"}]
 */
function extractText(content: string | OpenAIContentBlock[]): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((block) => block.type === "text" || block.type === "input_text")
      .map((block) => block.text)
      .join("\n");
  }
  return String(content || "");
}

/**
 * Strip OpenClaw-specific tooling sections from system prompts.
 * These reference tools (exec, process, web_search, etc.) that don't exist
 * in the Claude Code CLI environment, causing the model to get confused.
 * We remove: ## Tooling, ## Tool Call Style, ## OpenClaw CLI Quick Reference,
 * ## OpenClaw Self-Update
 */
function stripOpenClawTooling(text: string): string {
  const sectionsToStrip = [
    "## Tooling",
    "## Tool Call Style",
    "## OpenClaw CLI Quick Reference",
    "## OpenClaw Self-Update",
  ];
  let result = text;
  for (const section of sectionsToStrip) {
    // Match from section header to the next ## header (or end of string)
    const pattern = new RegExp(
      section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
        "\\n[\\s\\S]*?(?=\\n## |$)",
      "g"
    );
    result = result.replace(pattern, "");
  }
  // Clean up excessive blank lines left behind
  result = result.replace(/\n{3,}/g, "\n\n");
  return result.trim();
}

/**
 * Convert OpenAI messages array to a single prompt string for Claude CLI
 *
 * Claude Code CLI in --print mode expects a single prompt, not a conversation.
 * We format the messages into a readable format that preserves context.
 */
export function messagesToPrompt(
  messages: OpenAIChatRequest["messages"]
): string {
  const parts: string[] = [];

  for (const msg of messages) {
    const text = extractText(msg.content);
    switch (msg.role) {
      case "system":
        // System messages become context instructions
        // Strip OpenClaw tooling sections that conflict with Claude Code's native tools
        parts.push(`<system>\n${stripOpenClawTooling(text)}\n</system>\n`);
        break;

      case "user":
        // User messages are the main prompt
        parts.push(text);
        break;

      case "assistant":
        // Previous assistant responses for context
        parts.push(`<previous_response>\n${text}\n</previous_response>\n`);
        break;
    }
  }

  return parts.join("\n").trim();
}

/**
 * Convert OpenAI chat request to CLI input format
 */
export function openaiToCli(request: OpenAIChatRequest): CliInput {
  const thinking = resolveThinking(request);
  return {
    prompt: messagesToPrompt(request.messages),
    model: extractModel(request.model),
    sessionId: request.user, // Use OpenAI's user field for session mapping
    effort: thinking.effort,
    thinkingBudget: thinking.thinkingBudget,
  };
}
