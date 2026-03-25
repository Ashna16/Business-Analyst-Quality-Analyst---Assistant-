import { config } from "./config.js";
import type { WorkItem, WorkItemKind } from "./types.js";

const BASE = "https://api.contextual.ai/v1";
/** ~24k tokens budget for knowledge; conservative char cap */
const MAX_KNOWLEDGE_CHARS = 90_000;

const SYSTEM_PROMPT = `You are a senior technical BA and QA lead analyzing meeting notes (e.g. Google Meet captions or minutes).
Your job is to extract structured work items grounded ONLY in the supplied meeting notes (knowledge). Do not invent issues.

Classification rules (read full sentences and surrounding context):
- bug: A concrete software/product defect (wrong behavior, data loss, UI break, crash, incorrect mapping, regression). There must be a describable problem — not merely the word "bug" in "no bug", "not a bug", "non-bug", filing instructions, or status like "no product defect" / "feed is fine".
- feature_request: New capability or material change requested, explicitly labeled or clearly implied.
- action_item: Follow-ups, owners, deadlines, or discussions with no concrete defect.

Return ONLY valid JSON (no markdown fences), shape:
{"items":[{"kind":"bug"|"feature_request"|"action_item","component":"string","title":"string","summary":"string","stepsToReproduce":["string"],"actualResult":"string","expectedResult":"string","acceptanceCriteria":["string"]}]}

Use concise titles. For banking/enterprise tone; do not fabricate PII or credentials.`;

function sliceKnowledge(text: string): string[] {
  const t = text.trim();
  if (t.length <= MAX_KNOWLEDGE_CHARS) {
    return [t];
  }
  const chunks: string[] = [];
  for (let i = 0; i < t.length; i += MAX_KNOWLEDGE_CHARS) {
    chunks.push(t.slice(i, i + MAX_KNOWLEDGE_CHARS));
  }
  return chunks;
}

function parseJsonFromResponse(raw: string): { items?: unknown[] } {
  let t = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/m.exec(t);
  if (fence) {
    t = fence[1].trim();
  }
  const parsed = JSON.parse(t) as { items?: unknown[] };
  return parsed;
}

function strVal(v: unknown, fallback: string): string {
  if (v == null) {
    return fallback;
  }
  if (typeof v === "string") {
    return v;
  }
  if (typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  if (typeof v === "bigint") {
    return String(v);
  }
  return fallback;
}

function coerceWorkItem(row: Record<string, unknown>, i: number): WorkItem | null {
  const kindRaw = strVal(row.kind, "").toLowerCase();
  let kind: WorkItemKind = "action_item";
  if (kindRaw === "bug" || kindRaw === "defect") {
    kind = "bug";
  } else if (kindRaw === "feature_request" || kindRaw === "feature") {
    kind = "feature_request";
  } else if (kindRaw === "action_item" || kindRaw === "action") {
    kind = "action_item";
  }

  const title = strVal(row.title, `item-${i}`).trim();
  const summary = strVal(row.summary, title).trim();
  if (!summary && !title) {
    return null;
  }

  const steps = Array.isArray(row.stepsToReproduce)
    ? (row.stepsToReproduce as unknown[]).map((s) => String(s))
    : [];

  const ac = Array.isArray(row.acceptanceCriteria)
    ? (row.acceptanceCriteria as unknown[]).map((s) => String(s))
    : [];

  return {
    kind,
    component: strVal(row.component, "General").trim() || "General",
    title,
    summary: summary || title,
    stepsToReproduce: steps.length
      ? steps
      : [
          "Follow the scenario described in the meeting notes.",
          "Capture actual vs expected behavior.",
        ],
    actualResult: strVal(row.actualResult, "See summary.").trim(),
    expectedResult: strVal(row.expectedResult, "See summary.").trim(),
    acceptanceCriteria: ac.length ? ac : ["Defined in engineering / QA review."],
    sourceQuote: typeof row.sourceQuote === "string" ? row.sourceQuote : undefined,
  };
}

export async function extractWorkItemsWithContextualAi(transcript: string): Promise<WorkItem[]> {
  const url = `${BASE.replace(/\/$/, "")}/generate`;
  const knowledge = sliceKnowledge(transcript);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${config.contextualAiApiKey}`,
    },
    body: JSON.stringify({
      model: config.contextualAiModel,
      system_prompt: SYSTEM_PROMPT,
      knowledge,
      temperature: 0,
      top_p: 0.9,
      max_new_tokens: 2048,
      avoid_commentary: true,
      messages: [
        {
          role: "user",
          content:
            'Extract work items from the meeting notes provided in knowledge. Output ONLY the JSON object with an "items" array as specified in your instructions — no other text.',
        },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Contextual AI generate failed: ${res.status} ${err}`);
  }

  const data = (await res.json()) as { response?: string };
  const raw = data.response;
  if (!raw || typeof raw !== "string") {
    throw new Error("Contextual AI: empty response");
  }

  const parsed = parseJsonFromResponse(raw);
  const rows = Array.isArray(parsed.items) ? parsed.items : [];
  const out: WorkItem[] = [];
  let idx = 0;
  for (const row of rows) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const item = coerceWorkItem(row as Record<string, unknown>, idx);
    if (item) {
      out.push(item);
    }
    idx += 1;
  }
  return out;
}
