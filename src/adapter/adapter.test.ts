/**
 * Unit tests for the pure adapter functions — no server, no CLI, no tokens.
 *
 * Run: npm test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractModel,
  resolveThinking,
  modelLimitsFor,
  KNOWN_MODELS,
} from "./openai-to-cli.js";
import { normalizeModelName } from "./cli-to-openai.js";
import type { OpenAIChatRequest } from "../types/openai.js";

const req = (over: Partial<OpenAIChatRequest>): OpenAIChatRequest => ({
  model: "claude-opus-4-8",
  messages: [{ role: "user", content: "hi" }],
  ...over,
});

describe("extractModel", () => {
  it("passes full IDs through verbatim", () => {
    assert.equal(extractModel("claude-sonnet-4-6"), "claude-sonnet-4-6");
  });
  it("passes bare aliases through", () => {
    assert.equal(extractModel("opus"), "opus");
  });
  it("strips claude-max/ and claude-code-cli/ prefixes", () => {
    assert.equal(extractModel("claude-max/claude-haiku-4-5"), "claude-haiku-4-5");
    assert.equal(extractModel("claude-code-cli/opus"), "opus");
  });
  it("falls back to the default for empty/whitespace input", () => {
    assert.equal(extractModel(""), "claude-opus-4-8");
    assert.equal(extractModel("   "), "claude-opus-4-8");
    assert.equal(extractModel(undefined as unknown as string), "claude-opus-4-8");
  });
});

describe("resolveThinking", () => {
  it("maps reasoning_effort directly to effort", () => {
    assert.deepEqual(resolveThinking(req({ reasoning_effort: "low" })), { effort: "low" });
    assert.deepEqual(resolveThinking(req({ reasoning_effort: "xhigh" })), { effort: "xhigh" });
  });
  it("maps an unknown reasoning_effort to high", () => {
    assert.deepEqual(
      resolveThinking(req({ reasoning_effort: "bogus" as never })),
      { effort: "high" }
    );
  });
  it("treats a positive max_thinking_tokens as thinking-on (high)", () => {
    assert.deepEqual(resolveThinking(req({ max_thinking_tokens: 5000 })), { effort: "high" });
  });
  it("treats max_thinking_tokens <= 0 as off, overriding effort", () => {
    assert.deepEqual(
      resolveThinking(req({ max_thinking_tokens: 0, reasoning_effort: "high" })),
      {}
    );
    assert.deepEqual(resolveThinking(req({ max_thinking_tokens: -1 })), {});
  });
  it("returns {} (off) when nothing is set", () => {
    assert.deepEqual(resolveThinking(req({})), {});
  });
});

describe("modelLimitsFor", () => {
  it("returns published limits for known models", () => {
    assert.deepEqual(modelLimitsFor("claude-opus-4-8"), {
      contextLength: 1_000_000,
      maxOutputTokens: 128_000,
    });
    assert.deepEqual(modelLimitsFor("claude-haiku-4-5"), {
      contextLength: 200_000,
      maxOutputTokens: 64_000,
    });
  });
  it("falls back to conservative defaults for unknown models", () => {
    assert.deepEqual(modelLimitsFor("claude-future-9"), {
      contextLength: 200_000,
      maxOutputTokens: 8_192,
    });
  });
  it("has positive limits for every KNOWN_MODEL", () => {
    for (const id of KNOWN_MODELS) {
      const l = modelLimitsFor(id);
      assert.ok(l.contextLength > 0 && l.maxOutputTokens > 0, `bad limits for ${id}`);
    }
  });
});

describe("normalizeModelName", () => {
  it("strips a trailing date snapshot", () => {
    assert.equal(normalizeModelName("claude-sonnet-4-6-20250929"), "claude-sonnet-4-6");
  });
  it("leaves dateless IDs unchanged", () => {
    assert.equal(normalizeModelName("claude-opus-4-8"), "claude-opus-4-8");
    assert.equal(normalizeModelName("opus"), "opus");
  });
  it("defaults when undefined", () => {
    assert.equal(normalizeModelName(undefined), "claude-opus-4-8");
  });
});
