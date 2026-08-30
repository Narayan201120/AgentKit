import { Lamatic } from "lamatic";
import { config } from "../orchestrate.js";

if (!process.env.SUMMARIZE_FEEDBACK) {
  // Throw only at runtime when actually invoking; allow build without env
  // But keep loud check here for local dev guidance
  console.warn(
    "SUMMARIZE_FEEDBACK is not set. Flow calls will use local fallback until configured.",
  );
}

if (
  !process.env.LAMATIC_API_URL ||
  !process.env.LAMATIC_PROJECT_ID ||
  !process.env.LAMATIC_API_KEY
) {
  console.warn(
    "Lamatic credentials missing. Using local fallback mode for debrief.",
  );
}

export const lamaticClient = new Lamatic({
  endpoint: config.api.endpoint ?? "",
  projectId: config.api.projectId ?? null,
  apiKey: config.api.apiKey ?? "",
});
