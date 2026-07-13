#!/usr/bin/env node
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { StdioServerTransport, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { defaultConfigPath, loadConfig } from "./config.js";
import { createDmsumMcpServer } from "./mcp.js";
import { loadRegistry } from "./registry.js";
import { RoutedDmsumVault } from "./router.js";
import { DmsumVault } from "./vault.js";

type TransportMode = "stdio" | "http";

interface ServerArgs {
  configPath?: string;
  registryPath?: string;
  syncPath?: string;
  transport: TransportMode;
  host: string;
  port: number;
  path: string;
}

function argValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parseTransport(value: string | undefined): TransportMode {
  if (!value) return "stdio";
  if (value === "stdio" || value === "http") return value;
  throw new Error("--transport must be either stdio or http");
}

function parsePort(value: string | undefined): number {
  if (!value) return 3333;
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("--port must be an integer between 1 and 65535");
  }
  return port;
}

function parseArgs(argv = process.argv.slice(2)): ServerArgs {
  return {
    configPath: argValue(argv, "--config"),
    registryPath: argValue(argv, "--registry"),
    syncPath: argValue(argv, "--sync"),
    transport: parseTransport(argValue(argv, "--transport")),
    host: argValue(argv, "--host") ?? "127.0.0.1",
    port: parsePort(argValue(argv, "--port")),
    path: argValue(argv, "--path") ?? "/mcp"
  };
}

function requestHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

function normalizeMcpAcceptHeader(headers: Headers, method: string): void {
  const accept = headers.get("accept") ?? "";
  const acceptsJson = accept.includes("application/json");
  const acceptsEventStream = accept.includes("text/event-stream");

  if (method === "GET") {
    if (!acceptsEventStream) headers.set("accept", "text/event-stream");
    return;
  }

  if (method === "POST") {
    if (!acceptsJson || !acceptsEventStream) {
      headers.set("accept", "application/json, text/event-stream");
    }
  }
}

function webRequest(req: IncomingMessage, host: string, port: number): Request {
  const authority = req.headers.host ?? `${host}:${port}`;
  const url = new URL(req.url ?? "/", `http://${authority}`);
  const method = req.method ?? "GET";
  const headers = requestHeaders(req);
  normalizeMcpAcceptHeader(headers, method);
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers
  };

  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(req) as unknown as RequestInit["body"];
    init.duplex = "half";
  }

  return new Request(url, init);
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Accept, Content-Type, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID"
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, MCP-Protocol-Version");
}

async function writeWebResponse(response: Response, res: ServerResponse): Promise<void> {
  setCorsHeaders(res);
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.statusCode = response.status;
  if (response.statusText) res.statusMessage = response.statusText;

  if (!response.body) {
    res.end();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const stream = Readable.fromWeb(response.body as any);
    stream.on("error", reject);
    res.on("finish", resolve);
    stream.pipe(res);
  });
}

async function connectHttpServer(
  mcpServer: ReturnType<typeof createDmsumMcpServer>,
  args: Pick<ServerArgs, "host" | "port" | "path">
): Promise<void> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true
  });
  await mcpServer.connect(transport);

  const httpServer = http.createServer(async (req, res) => {
    try {
      const request = webRequest(req, args.host, args.port);
      const path = new URL(request.url).pathname;

      if (req.method === "OPTIONS") {
        setCorsHeaders(res);
        res.writeHead(204);
        res.end();
        return;
      }

      if (path === "/health") {
        setCorsHeaders(res);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, name: "memsum" }));
        return;
      }

      if (path !== args.path) {
        setCorsHeaders(res);
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end(`Mem·Sum MCP endpoint is ${args.path}`);
        return;
      }

      await writeWebResponse(await transport.handleRequest(request), res);
    } catch (error) {
      setCorsHeaders(res);
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(String(error));
    }
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(args.port, args.host, resolve);
  });

  const url = `http://${args.host}:${args.port}${args.path}`;
  console.error(`Mem·Sum MCP HTTP server listening at ${url}`);
  console.error(`Health check: http://${args.host}:${args.port}/health`);

  const close = async () => {
    await transport.close();
    httpServer.close();
  };
  process.once("SIGINT", () => void close().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
}

async function main(): Promise<void> {
  const args = parseArgs();
  const vault = args.registryPath
    ? new RoutedDmsumVault(await loadRegistry(args.registryPath))
    : args.configPath
      ? new DmsumVault(await loadConfig(args.configPath))
      : new DmsumVault(await loadConfig(defaultConfigPath()));
  const server = createDmsumMcpServer(vault, args.syncPath ? { syncPath: args.syncPath } : undefined);
  if (args.transport === "http") {
    await connectHttpServer(server, args);
    return;
  }
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
