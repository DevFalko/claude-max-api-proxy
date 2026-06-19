/**
 * API Route Handlers
 *
 * Implements OpenAI-compatible endpoints for Clawdbot integration
 */

import type { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { ClaudeSubprocess } from "../subprocess/manager.js";
import { openaiToCli, KNOWN_MODELS, modelLimitsFor } from "../adapter/openai-to-cli.js";
import {
  cliResultToOpenai,
  createDoneChunk,
  normalizeModelName,
} from "../adapter/cli-to-openai.js";
import type { OpenAIChatRequest } from "../types/openai.js";
import type { ClaudeCliResult, ClaudeCliStreamEvent } from "../types/claude-cli.js";

// Cap concurrent Claude subprocesses to avoid resource-exhaustion DoS. Each
// request spawns a heavyweight `claude` process; without a ceiling a burst of
// requests can exhaust CPU/RAM/FDs and the operator's budget.
const MAX_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.PROXY_MAX_CONCURRENCY || "8", 10) || 8
);
let inFlight = 0;

/**
 * Handle POST /v1/chat/completions
 *
 * Main endpoint for chat requests, supports both streaming and non-streaming
 */
export async function handleChatCompletions(
  req: Request,
  res: Response
): Promise<void> {
  const requestId = uuidv4().replace(/-/g, "").slice(0, 24);
  const body = req.body as OpenAIChatRequest;
  const stream = body.stream === true;

  try {
    // Validate request
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json({
        error: {
          message: "messages is required and must be a non-empty array",
          type: "invalid_request_error",
          code: "invalid_messages",
        },
      });
      return;
    }

    // Bound concurrent subprocesses (resource-exhaustion DoS guard).
    if (inFlight >= MAX_CONCURRENCY) {
      res.status(429).json({
        error: {
          message: `Too many concurrent requests (max ${MAX_CONCURRENCY})`,
          type: "rate_limit_error",
          code: "concurrency_limit",
        },
      });
      return;
    }

    // Convert to CLI input format
    const cliInput = openaiToCli(body);
    const subprocess = new ClaudeSubprocess();

    inFlight++;
    try {
      if (stream) {
        await handleStreamingResponse(req, res, subprocess, cliInput, requestId);
      } else {
        await handleNonStreamingResponse(res, subprocess, cliInput, requestId);
      }
    } finally {
      inFlight--;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[handleChatCompletions] Error:", message);

    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message,
          type: "server_error",
          code: null,
        },
      });
    }
  }
}

/**
 * Handle streaming response (SSE)
 *
 * IMPORTANT: The Express req.on("close") event fires when the request body
 * is fully received, NOT when the client disconnects. For SSE connections,
 * we use res.on("close") to detect actual client disconnection.
 */
async function handleStreamingResponse(
  req: Request,
  res: Response,
  subprocess: ClaudeSubprocess,
  cliInput: ReturnType<typeof openaiToCli>,
  requestId: string
): Promise<void> {
  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Request-Id", requestId);

  // CRITICAL: Flush headers immediately to establish SSE connection
  // Without this, headers are buffered and client times out waiting
  res.flushHeaders();

  // Send initial comment to confirm connection is alive
  res.write(":ok\n\n");

  return new Promise<void>((resolve, reject) => {
    let isFirst = true;
    // Pin the streamed model to the (normalized) requested model — don't derive
    // it from assistant events, which may carry an auxiliary internal model.
    // Normalizing here keeps every chunk consistent with the final done chunk
    // (which also normalizes) and with the non-streaming response.
    const lastModel = normalizeModelName(cliInput.model);
    let isComplete = false;
    let hasEmittedText = false;

    // Handle actual client disconnect (response stream closed)
    res.on("close", () => {
      if (!isComplete) {
        // Client disconnected before response completed - kill subprocess
        subprocess.kill();
      }
      resolve();
    });

    // When a new text content block starts after we've already emitted text,
    // insert a separator so text from different blocks doesn't run together
    subprocess.on("text_block_start", () => {
      if (hasEmittedText && !res.writableEnded) {
        const sepChunk = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: lastModel,
          choices: [{
            index: 0,
            delta: {
              content: "\n\n",
            },
            finish_reason: null,
          }],
        };
        res.write(`data: ${JSON.stringify(sepChunk)}\n\n`);
      }
    });

    // Handle streaming extended-thinking deltas → reasoning_content.
    // Only forward thinking that precedes the first visible-content token:
    // reasoning_content must precede content (clients close the reasoning panel
    // on the first content token), and later thinking belongs to internal
    // tool-loop / sub-agent turns rather than the final answer's chain-of-thought.
    subprocess.on("thinking_delta", (event: ClaudeCliStreamEvent) => {
      const delta = event.event.delta;
      const text = (delta?.type === "thinking_delta" && delta.thinking) || "";
      if (text && !hasEmittedText && !res.writableEnded) {
        const chunk = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: lastModel,
          choices: [{
            index: 0,
            delta: {
              role: isFirst ? "assistant" : undefined,
              reasoning_content: text,
            },
            finish_reason: null,
          }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        isFirst = false;
      }
    });

    // Handle streaming content deltas
    subprocess.on("content_delta", (event: ClaudeCliStreamEvent) => {
      const delta = event.event.delta;
      const text = (delta?.type === "text_delta" && delta.text) || "";
      if (text && !res.writableEnded) {
        const chunk = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: lastModel,
          choices: [{
            index: 0,
            delta: {
              role: isFirst ? "assistant" : undefined,
              content: text,
            },
            finish_reason: null,
          }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        isFirst = false;
        hasEmittedText = true;
      }
    });

    subprocess.on("result", (result: ClaudeCliResult) => {
      isComplete = true;
      if (!res.writableEnded) {
        // Send final done chunk with finish_reason and usage data
        const doneChunk = createDoneChunk(requestId, lastModel);
        if (result.usage) {
          doneChunk.usage = {
            prompt_tokens: result.usage.input_tokens || 0,
            completion_tokens: result.usage.output_tokens || 0,
            total_tokens:
              (result.usage.input_tokens || 0) + (result.usage.output_tokens || 0),
          };
        }
        res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
      resolve();
    });

    subprocess.on("error", (error: Error) => {
      console.error("[Streaming] Error:", error.message);
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
            error: { message: error.message, type: "server_error", code: null },
          })}\n\n`
        );
        // Always close the SSE stream with the [DONE] sentinel, even on error.
        res.write("data: [DONE]\n\n");
        res.end();
      }
      resolve();
    });

    subprocess.on("close", (code: number | null) => {
      // Subprocess exited - ensure response is closed
      if (!res.writableEnded) {
        if (code !== 0 && !isComplete) {
          // Abnormal exit without result - send error
          res.write(`data: ${JSON.stringify({
            error: { message: `Process exited with code ${code}`, type: "server_error", code: null },
          })}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
      }
      resolve();
    });

    // Start the subprocess
    subprocess.start(cliInput.prompt, {
      model: cliInput.model,
      effort: cliInput.effort,
    }).catch((err) => {
      console.error("[Streaming] Subprocess start error:", err);
      reject(err);
    });
  });
}

/**
 * Handle non-streaming response
 */
async function handleNonStreamingResponse(
  res: Response,
  subprocess: ClaudeSubprocess,
  cliInput: ReturnType<typeof openaiToCli>,
  requestId: string
): Promise<void> {
  return new Promise((resolve) => {
    let finalResult: ClaudeCliResult | null = null;
    let reasoningContent = "";
    let contentStarted = false;

    // Once the visible answer starts, stop capturing thinking: later thinking
    // belongs to internal tool-loop / sub-agent turns, not the final answer's
    // chain-of-thought, and would otherwise be conflated into reasoning_content.
    subprocess.on("content_delta", () => {
      contentStarted = true;
    });

    // Accumulate the pre-answer extended-thinking text → message.reasoning_content
    subprocess.on("thinking_delta", (event: ClaudeCliStreamEvent) => {
      if (contentStarted) return;
      const delta = event.event.delta;
      if (delta?.type === "thinking_delta" && delta.thinking) {
        reasoningContent += delta.thinking;
      }
    });
    subprocess.on("result", (result: ClaudeCliResult) => {
      finalResult = result;
    });

    subprocess.on("error", (error: Error) => {
      console.error("[NonStreaming] Error:", error.message);
      // Kill so a late buffered result can't trigger a second response, and
      // guard against double-send in case a response was already sent.
      subprocess.kill();
      if (!res.headersSent) {
        res.status(500).json({
          error: {
            message: error.message,
            type: "server_error",
            code: null,
          },
        });
      }
      resolve();
    });

    subprocess.on("close", (code: number | null) => {
      // Guard the whole handler: the error handler above may have already
      // responded (e.g. on timeout), and a buffer flush on close can still set
      // finalResult — without this guard res.json would throw ERR_HTTP_HEADERS_SENT.
      if (res.headersSent) {
        resolve();
        return;
      }
      if (finalResult) {
        res.json(
          cliResultToOpenai(
            finalResult,
            requestId,
            undefined,
            reasoningContent || undefined,
            cliInput.model
          )
        );
      } else {
        res.status(500).json({
          error: {
            message: `Claude CLI exited with code ${code} without response`,
            type: "server_error",
            code: null,
          },
        });
      }
      resolve();
    });

    // Start the subprocess
    subprocess
      .start(cliInput.prompt, {
        model: cliInput.model,
        effort: cliInput.effort,
      })
      .catch((error) => {
        res.status(500).json({
          error: {
            message: error.message,
            type: "server_error",
            code: null,
          },
        });
        resolve();
      });
  });
}

/**
 * Handle GET /v1/models
 *
 * Returns available models
 */
export function handleModels(_req: Request, res: Response): void {
  const now = Math.floor(Date.now() / 1000);
  res.json({
    object: "list",
    data: KNOWN_MODELS.map((id) => {
      const limits = modelLimitsFor(id);
      return {
        id,
        object: "model" as const,
        owned_by: "anthropic",
        created: now,
        // Per-model limits so clients can size their context budget.
        context_length: limits.contextLength,
        max_output_tokens: limits.maxOutputTokens,
      };
    }),
  });
}

/**
 * Handle GET /health
 *
 * Health check endpoint
 */
export function handleHealth(_req: Request, res: Response): void {
  res.json({
    status: "ok",
    provider: "claude-code-cli",
    timestamp: new Date().toISOString(),
  });
}
