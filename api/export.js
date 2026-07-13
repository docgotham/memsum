import { handleHostedExportRequest } from "../dist/hosted/export.js";

export default {
  async fetch(request) {
    return handleHostedExportRequest(request);
  }
};
