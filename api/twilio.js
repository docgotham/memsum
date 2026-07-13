import { handleTwilioInboundSmsRequest } from "../dist/hosted/inbound-sms.js";

export default {
  async fetch(request) {
    return handleTwilioInboundSmsRequest(request);
  }
};
