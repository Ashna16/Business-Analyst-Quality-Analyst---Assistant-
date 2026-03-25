import { isLegitimateBugChunk, refineWorkItemKind } from "./bug-context.js";
import { config } from "./config.js";
import { extractWorkItemsWithContextualAi } from "./contextual-ai.js";
import type { WorkItem, WorkItemKind } from "./types.js";

const FEAT_HINTS = /\b(feature|enhancement|we should|it would be nice|roadmap|new capability)\b/i;
const ACTION_HINTS =
  /\b(action item|follow[- ]?up|need to|assign(?:ed)? to|deadline|by next sprint)\b/i;

function heuristicParse(transcript: string): WorkItem[] {
  const chunks = transcript
    .split(/\n{2,}/)
    .map((c) => c.trim())
    .filter(Boolean);

  const items: WorkItem[] = [];
  let idx = 0;
  for (const chunk of chunks) {
    const treatAsBug = isLegitimateBugChunk(chunk);

    let kind: WorkItemKind = "action_item";
    if (treatAsBug) {
      kind = "bug";
    } else if (FEAT_HINTS.test(chunk)) {
      kind = "feature_request";
    } else if (ACTION_HINTS.test(chunk)) {
      kind = "action_item";
    } else if (chunk.length < 40) {
      continue;
    }

    const firstLine = chunk.split("\n")[0]?.trim() ?? chunk;
    const title = firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
    const component = inferComponent(chunk);

    items.push({
      kind,
      component,
      title: sanitizeTitle(title, kind),
      summary: chunk,
      stepsToReproduce: stepsProposeFromText(chunk),
      actualResult: kind === "bug" ? "Observed behavior per discussion." : "N/A",
      expectedResult:
        kind === "bug"
          ? "Behavior aligns with requirements / product intent."
          : "Deliverable completed per acceptance.",
      acceptanceCriteria: defaultAc(kind, title),
      sourceQuote: chunk.slice(0, 500),
    });
    idx += 1;
    if (idx > 25) {
      break;
    }
  }
  return dedupeByTitle(items);
}

function stepsProposeFromText(text: string): string[] {
  const numbered = text.match(/^\s*(?:\d+[).]|[•*-])\s+.+$/gm);
  if (numbered?.length) {
    return numbered.map((s) => s.replace(/^\s*[\d•*-.)]+\s*/, "").trim()).slice(0, 8);
  }
  return [
    "Navigate to the affected flow discussed in the meeting.",
    "Perform the user actions described in the transcript.",
    "Observe system response and compare to expected behavior.",
  ];
}

function inferComponent(text: string): string {
  const known = [
    "Payments",
    "Auth",
    "Onboarding",
    "Statements",
    "Transfers",
    "Admin",
    "API",
    "Mobile",
    "Web",
  ];
  for (const k of known) {
    if (new RegExp(`\\b${k}\\b`, "i").test(text)) {
      return k;
    }
  }
  return "General";
}

function sanitizeTitle(title: string, kind: WorkItemKind): string {
  const prefix = kind === "bug" ? "[Bug]" : kind === "feature_request" ? "[Feature]" : "[Action]";
  return `${prefix} ${title.replace(/^\[[^\]]+\]\s*/, "")}`;
}

function defaultAc(kind: WorkItemKind, title: string): string[] {
  const t = title.slice(0, 80);
  if (kind === "bug") {
    return [
      `AC 1: ${t} — defect no longer reproducible in supported environments.`,
      "AC 2: Regression coverage added or existing tests updated.",
    ];
  }
  if (kind === "feature_request") {
    return [`AC 1: ${t} — capability delivered behind flag or GA per decision.`];
  }
  return [`AC 1: ${t} — owner confirms completion.`];
}

function dedupeByTitle(items: WorkItem[]): WorkItem[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = i.title.toLowerCase();
    if (seen.has(k)) {
      return false;
    }
    seen.add(k);
    return true;
  });
}

async function openAiParse(transcript: string): Promise<WorkItem[]> {
  const res = await fetch(`${config.openaiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.openaiModel,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are a senior BA. From meeting transcripts, extract work items.
Return JSON: { "items": Array<{
  "kind": "bug" | "feature_request" | "action_item",
  "component": string,
  "title": string,
  "summary": string,
  "stepsToReproduce": string[],
  "actualResult": string,
  "expectedResult": string,
  "acceptanceCriteria": string[]
}> }
Use banking-safe language; do not invent PCI/PII. If unclear, prefer action_item.
Do NOT classify as bug when the speaker says there is no bug, false positive, working as expected,
or only reports that something is healthy/OK on "our side". Only bug if there is a concrete defect,
wrong behavior, or regression described.`,
        },
        { role: "user", content: transcript.slice(0, 120_000) },
      ],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI parse failed: ${res.status} ${err}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = data.choices?.[0]?.message?.content;
  if (!raw) {
    throw new Error("OpenAI parse: empty response");
  }
  const parsed = JSON.parse(raw) as { items?: WorkItem[] };
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  return items.map((it) => ({
    ...it,
    kind: refineWorkItemKind(it.kind, `${it.title ?? ""}\n${it.summary ?? ""}`),
  }));
}

export async function parseTranscript(transcript: string): Promise<WorkItem[]> {
  if (config.contextualAiApiKey) {
    try {
      const items = await extractWorkItemsWithContextualAi(transcript);
      if (items.length) {
        return items.map((it) => ({
          ...it,
          kind: refineWorkItemKind(it.kind, `${it.title}\n${it.summary}`),
        }));
      }
      console.warn("[parser] Contextual AI returned no items; falling back.");
    } catch (e) {
      console.warn("[parser] Contextual AI failed, falling back:", e);
    }
  }
  if (config.openaiApiKey) {
    try {
      const items = await openAiParse(transcript);
      return items.length ? items : heuristicParse(transcript);
    } catch (e) {
      console.warn("[parser] OpenAI failed, falling back to heuristic:", e);
    }
  }
  return heuristicParse(transcript);
}
