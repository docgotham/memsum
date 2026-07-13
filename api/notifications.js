import { handleNotificationWorkerRequest } from "../dist/hosted/notifications.js";

export default {
  async fetch(request) {
    return handleNotificationWorkerRequest(request);
  }
};
