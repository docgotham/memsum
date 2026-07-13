import { handleHostedMcpRequest } from "../dist/hosted/mcp.js";

export default {
  async fetch(request) {
    return handleHostedMcpRequest(request);
  }
};
