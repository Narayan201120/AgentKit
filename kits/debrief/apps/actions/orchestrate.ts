"use server";

import { z } from "zod";
import { lamaticClient } from "@/lib/lamatic-client";

// ── Schema enforcement (server-side, fails loudly) ─────────
export const DebriefSchema = z.object({
  summary: z.string().min(1, "summary must be non-empty"),
  strengths: z.array(z.string()),
  gaps: z.array(z.string()),
  action_items: z.array(z.string()),
});

export type DebriefOutput = z.infer<typeof DebriefSchema>;

function extractJson(raw: string): string {
  // Handle model returning markdown fences or extra text
  const trimmed = raw.trim();
  // Try direct JSON
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // Try to extract ```json block
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch) return fenceMatch[1].trim();
    // Try to find first {...} block
    const braceStart = trimmed.indexOf("{");
    const braceEnd = trimmed.lastIndexOf("}");
    if (braceStart !== -1 && braceEnd !== -1 && braceEnd > braceStart) {
      return trimmed.slice(braceStart, braceEnd + 1);
    }
    return trimmed;
  }
}

function localFallback(feedback: string): DebriefOutput {
  // Deterministic keyword-based fallback for when Lamatic creds are absent
  // Keeps schema valid and allows local testing without model calls
  const lower = feedback.toLowerCase();

  const strengths: string[] = [];
  const gaps: string[] = [];
  const actionItems: string[] = [];

  if (lower.includes("strong") || lower.includes("clear") || lower.includes("good"))
    strengths.push("Demonstrated clear communication and problem-solving under discussion");
  if (lower.includes("system design") || lower.includes("architecture"))
    strengths.push("Showed strength in system design / architecture thinking");
  if (lower.includes("coding") || lower.includes("speed"))
    strengths.push("Coding speed and implementation fluency noted");

  if (lower.includes("indexing") || lower.includes("detail") || lower.includes("edge"))
    gaps.push("Needs deeper detail on database / edge-case handling");
  if (lower.includes("struggled") || lower.includes("missed") || lower.includes("weak"))
    gaps.push("Missed some edge cases and follow-up depth expected for role level");
  if (strengths.length === 0 && gaps.length === 0) {
    gaps.push("Insufficient signal in notes to assess depth — gather more targeted examples");
  }

  if (gaps.some((g) => g.toLowerCase().includes("edge")))
    actionItems.push("Practice edge-case enumeration and test-case design on coding prompts");
  if (gaps.some((g) => g.toLowerCase().includes("database")))
    actionItems.push("Review database indexing trade-offs and prepare a 2-minute explainer");
  actionItems.push("Prepare STAR stories that link strengths to concrete project outcomes");

  // Ensure non-empty per schema expectations for demo; real LLM path may return empty arrays legitimately
  const summary =
    "Mixed feedback: strengths in communication and system thinking with gaps in detail depth and edge-case coverage.";

  // Deduplicate and cap
  const dedup = (arr: string[]): string[] => [...new Set(arr)].slice(0, 5);

  return {
    summary,
    strengths: dedup(strengths.length ? strengths : ["Engaged collaboratively and communicated clearly"]),
    gaps: dedup(gaps),
    action_items: dedup(actionItems),
  };
}

export async function summarizeFeedback(feedback: string): Promise<{
  success: boolean;
  data?: DebriefOutput;
  error?: string;
}> {
  try {
    if (!feedback || !feedback.trim()) {
      throw new Error("Feedback is required");
    }

    const trimmed = feedback.trim();
    // Tag handling: frontend already tags by round; no transformation needed here except trim
    const inputs: Record<string, unknown> = { feedback: trimmed };

    const flowId = process.env.SUMMARIZE_FEEDBACK;
    const hasCreds =
      flowId &&
      process.env.LAMATIC_API_URL &&
      process.env.LAMATIC_PROJECT_ID &&
      process.env.LAMATIC_API_KEY;

    let rawResult: string;

    if (hasCreds) {
      const resData = await lamaticClient.executeFlow(flowId, inputs);
      // Lamatic atomic flow maps result -> result field per orchestrate.js outputMapping
      const possible =
        (resData as { result?: unknown })?.result ??
        (resData as { data?: unknown })?.data;

      if (typeof possible === "string") {
        rawResult = possible;
      } else if (
        possible !== null &&
        typeof possible === "object" &&
        "result" in (possible as Record<string, unknown>)
      ) {
        const inner = (possible as Record<string, unknown>)["result"];
        if (typeof inner === "string") rawResult = inner;
        else rawResult = JSON.stringify(possible);
      } else if (possible !== null && typeof possible === "object") {
        rawResult = JSON.stringify(possible);
      } else {
        throw new Error("No result returned from flow");
      }
    } else {
      // Local fallback path for dev/CI without Lamatic creds — still enforces schema
      const fallback = localFallback(trimmed);
      // Validate before returning to ensure schema path is exercised
      const parsed = DebriefSchema.parse(fallback);
      return { success: true, data: parsed };
    }

    const jsonStr = extractJson(rawResult);
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(jsonStr);
    } catch (e) {
      throw new Error(
        `Model returned malformed JSON: ${(e as Error).message}. Raw: ${rawResult.slice(0, 500)}`,
      );
    }

    // Server-side schema enforcement — fails loudly
    const validated = DebriefSchema.parse(parsedJson);

    // Additional strictness: ensure no extra coercion silently passed
    if (
      typeof validated.summary !== "string" ||
      !Array.isArray(validated.strengths) ||
      !Array.isArray(validated.gaps) ||
      !Array.isArray(validated.action_items)
    ) {
      throw new Error("Schema validation failed: incorrect types after parse");
    }

    return { success: true, data: validated };
  } catch (error) {
    console.error("[Debrief] summarize error:", error);
    let errorMessage = "Unknown error occurred";
    if (error instanceof z.ZodError) {
      errorMessage = `Schema validation failed: ${error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ")}`;
    } else if (error instanceof Error) {
      errorMessage = error.message;
      if (error.message.includes("fetch failed")) {
        errorMessage =
          "Network error: Unable to connect to Lamatic. Check network and credentials.";
      } else if (error.message.toLowerCase().includes("api key")) {
        errorMessage = "Authentication error: Verify LAMATIC_API_KEY and project IDs.";
      }
    }
    return { success: false, error: errorMessage };
  }
}
