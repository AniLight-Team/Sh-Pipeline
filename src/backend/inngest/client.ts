import { Inngest } from "inngest";

export const inngest = new Inngest({
  id: "sh-pipeline",
  baseUrl: process.env.INNGEST_BASE_URL || undefined,
  eventKey: process.env.INNGEST_EVENT_KEY || undefined,
});

