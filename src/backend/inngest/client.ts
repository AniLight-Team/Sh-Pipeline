import { Inngest } from "inngest";
import { INNGEST_BASE_URL } from "../config.js";

export const inngest = new Inngest({
  id: "sh-pipeline",
  baseUrl: INNGEST_BASE_URL,
  eventKey: process.env.INNGEST_EVENT_KEY || "local-sh-pipeline-key",
  isDev: !process.env.INNGEST_SIGNING_KEY,
});
