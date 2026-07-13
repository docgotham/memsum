import path from "node:path";
import { loadConfig } from "../dist/config.js";
import { renderAuditError, renderAuditPage, renderSetupPage } from "../dist/web.js";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const configPath = process.env.DMSUM_CONFIG_PATH ?? path.join(process.cwd(), ".dmsum", "config.json");

    try {
      const config = await loadConfig(configPath);
      return toResponse(await renderAuditPage(config, url.searchParams.get("path") ?? "."));
    } catch (error) {
      if (process.env.VERCEL) {
        return toResponse(renderSetupPage(String(error)));
      }
      return toResponse(renderAuditError(error));
    }
  }
};

function toResponse(page) {
  return new Response(page.body, {
    status: page.status,
    headers: {
      "content-type": page.contentType
    }
  });
}
