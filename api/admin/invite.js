import { handleHostedAdminInviteRequest } from "../../dist/hosted/admin.js";

export default {
  async fetch(request) {
    return handleHostedAdminInviteRequest(request);
  }
};
