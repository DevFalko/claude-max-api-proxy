/**
 * Express HTTP Server
 *
 * Provides OpenAI-compatible API endpoints that wrap Claude Code CLI
 */

import express, { Express, Request, Response, NextFunction } from "express";
import { createServer, Server } from "http";
import { handleChatCompletions, handleModels, handleHealth } from "./routes.js";

export interface ServerConfig {
  port: number;
  host?: string;
}

let serverInstance: Server | null = null;

/**
 * Optional shared-secret auth. When PROXY_API_KEY is set, every /v1 request must
 * present it as `Authorization: Bearer <key>` or `x-api-key: <key>`. When unset,
 * the proxy is open (intended for loopback-only, single-user use).
 */
function expectedApiKey(): string | undefined {
  return process.env.PROXY_API_KEY?.trim() || undefined;
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const expected = expectedApiKey();
  if (!expected) return next(); // open mode (loopback default)
  const authHeader = req.header("authorization") || "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const provided = bearer || req.header("x-api-key") || "";
  if (provided && provided === expected) return next();
  res.status(401).json({
    error: {
      message: "Missing or invalid API key",
      type: "authentication_error",
      code: "invalid_api_key",
    },
  });
}

/**
 * Create and configure the Express app
 */
function createApp(): Express {
  const app = express();

  // Middleware: use raw body parser + manual JSON parse for better error diagnostics
  app.use(express.raw({ type: "application/json", limit: "10mb" }));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (req.body && Buffer.isBuffer(req.body) && req.body.length > 0) {
      const raw = req.body.toString("utf8");
      if (process.env.DEBUG) {
        console.log("[Body raw]:", raw.substring(0, 200));
      }
      try {
        req.body = JSON.parse(raw);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[Body parse error]:", msg);
        if (process.env.DEBUG) {
          console.error("[Body raw]:", raw.substring(0, 300));
        } else {
          console.error("[Body metadata]:", {
            length: raw.length,
            method: req.method,
            url: req.originalUrl,
          });
        }
        return next(err);
      }
    }
    next();
  });

  // Request logging (debug mode)
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (process.env.DEBUG) {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    }
    next();
  });

  // CORS is opt-in. A wildcard `Access-Control-Allow-Origin: *` would let any web
  // page the operator visits drive this API cross-origin (localhost-CSRF), which
  // is dangerous since requests spawn Claude with --dangerously-skip-permissions.
  // OpenAI-compatible clients are server-side and don't need CORS; set
  // PROXY_CORS_ORIGIN only if a browser client must reach the proxy.
  const corsOrigin = process.env.PROXY_CORS_ORIGIN?.trim();
  if (corsOrigin) {
    app.use((_req: Request, res: Response, next: NextFunction) => {
      res.setHeader("Access-Control-Allow-Origin", corsOrigin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key");
      next();
    });
    app.options("*", (_req: Request, res: Response) => {
      res.sendStatus(200);
    });
  }

  // Routes (health stays open; /v1 is gated by optional auth)
  app.get("/health", handleHealth);
  app.get("/v1/models", requireAuth, handleModels);
  app.post("/v1/chat/completions", requireAuth, handleChatCompletions);

  // 404 handler
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: {
        message: "Not found",
        type: "invalid_request_error",
        code: "not_found",
      },
    });
  });

  // Error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[Server Error]:", err.message);
    res.status(500).json({
      error: {
        message: err.message,
        type: "server_error",
        code: null,
      },
    });
  });

  return app;
}

/**
 * Start the HTTP server
 */
export async function startServer(config: ServerConfig): Promise<Server> {
  const { port, host = "127.0.0.1" } = config;

  // The loopback bind is a load-bearing security control: the proxy runs Claude
  // with --dangerously-skip-permissions and no auth by default. Refuse to expose
  // it on a non-loopback interface unless an API key is configured.
  const isLoopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (!isLoopback && !expectedApiKey()) {
    throw new Error(
      `Refusing to bind to non-loopback host "${host}" without PROXY_API_KEY set. ` +
        "The proxy executes tools on the host; set PROXY_API_KEY before exposing it."
    );
  }

  if (serverInstance) {
    console.log("[Server] Already running, returning existing instance");
    return serverInstance;
  }

  const app = createApp();

  return new Promise((resolve, reject) => {
    serverInstance = createServer(app);

    serverInstance.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${port} is already in use`));
      } else {
        reject(err);
      }
    });

    serverInstance.listen(port, host, () => {
      console.log(`[Server] Claude Code CLI provider running at http://${host}:${port}`);
      console.log(`[Server] OpenAI-compatible endpoint: http://${host}:${port}/v1/chat/completions`);
      resolve(serverInstance!);
    });
  });
}

/**
 * Stop the HTTP server
 */
export async function stopServer(): Promise<void> {
  if (!serverInstance) {
    return;
  }

  return new Promise((resolve, reject) => {
    serverInstance!.close((err) => {
      if (err) {
        reject(err);
      } else {
        console.log("[Server] Stopped");
        serverInstance = null;
        resolve();
      }
    });
  });
}

/**
 * Get the current server instance
 */
export function getServer(): Server | null {
  return serverInstance;
}
