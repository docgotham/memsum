import { handleHostedVersionRequest } from "../dist/hosted/version.js";

export default {
  async fetch() {
    return handleHostedVersionRequest();
  }
};
