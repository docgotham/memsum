import { handleHostedRequest } from "../dist/hosted/http.js";
import { handleHostedMcpRequest } from "../dist/hosted/mcp.js";
import { createSupabaseHostedKernelHandler } from "../dist/hosted/supabase.js";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/mcp")) {
      return handleHostedMcpRequest(request);
    }
    return handleHostedRequest(request, createSupabaseHostedKernelHandler(request));
  }
};
