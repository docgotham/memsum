import http from "node:http";
import type { DmsumConfig } from "./types.js";
import { renderAuditError, renderAuditPage } from "./web.js";

export async function startAuditServer(config: DmsumConfig, port: number): Promise<http.Server> {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      const requestedPath = url.searchParams.get("path") ?? ".";
      sendPage(response, await renderAuditPage(config, requestedPath));
    } catch (error) {
      sendPage(response, renderAuditError(error));
    }
  });

  await new Promise<void>((resolve) => server.listen(port, resolve));
  return server;
}

function sendPage(response: http.ServerResponse, page: { status: number; contentType: string; body: string }): void {
  response.writeHead(page.status, { "content-type": page.contentType });
  response.end(page.body);
}
