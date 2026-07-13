import { handleHostedOAuthRequest } from "../dist/hosted/oauth.js";

export default {
  async fetch(request) {
    return handleHostedOAuthRequest(request);
  }
};
