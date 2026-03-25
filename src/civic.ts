import { config } from "./config.js";
import type { RedactedWorkItem, WorkItem } from "./types.js";

const LOCAL_PATTERNS: Array<{ name: string; re: RegExp; replacement: string }> = [
  { name: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: "[REDACTED-SSN]" },
  {
    name: "card",
    re: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
    replacement: "[REDACTED-PAN]",
  },
  {
    name: "email",
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: "[REDACTED-EMAIL]",
  },
  {
    name: "routing",
    re: /\b\d{9}\b/g,
    replacement: "[REDACTED-ID]",
  },
];

function localRedact(item: WorkItem): RedactedWorkItem {
  const apply = (s: string) => {
    let out = s;
    const notes: string[] = [];
    for (const { name, re, replacement } of LOCAL_PATTERNS) {
      if (re.test(out)) {
        notes.push(name);
        re.lastIndex = 0;
        out = out.replace(re, replacement);
      }
    }
    return { text: out, notes };
  };

  const sum = apply(item.summary);
  const t = apply(item.title);
  const ar = apply(item.actualResult);
  const er = apply(item.expectedResult);
  const sq = item.sourceQuote ? apply(item.sourceQuote) : { text: undefined, notes: [] };
  const steps = item.stepsToReproduce.map((x) => apply(x).text);
  const ac = item.acceptanceCriteria.map((x) => apply(x).text);

  const mergedNotes = [
    ...new Set([...sum.notes, ...t.notes, ...ar.notes, ...er.notes, ...sq.notes]),
  ];

  return {
    ...item,
    title: t.text,
    summary: sum.text,
    actualResult: ar.text,
    expectedResult: er.text,
    stepsToReproduce: steps,
    acceptanceCriteria: ac,
    sourceQuote: sq.text,
    redactionNotes:
      mergedNotes.length > 0 ? `Local patterns redacted: ${mergedNotes.join(", ")}` : undefined,
  };
}

async function civicApiRedact(item: WorkItem): Promise<RedactedWorkItem> {
  const url = `${config.civicApiUrl.replace(/\/$/, "")}/redact`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.civicApiKey ? { Authorization: `Bearer ${config.civicApiKey}` } : {}),
    },
    body: JSON.stringify({
      payload: {
        title: item.title,
        summary: item.summary,
        stepsToReproduce: item.stepsToReproduce,
        actualResult: item.actualResult,
        expectedResult: item.expectedResult,
        acceptanceCriteria: item.acceptanceCriteria,
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`Civic Nexus error ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as Record<string, unknown>;
  const payload = (body.redacted ?? body.payload ?? body) as Partial<WorkItem>;
  return {
    ...item,
    title: String(payload.title ?? item.title),
    summary: String(payload.summary ?? item.summary),
    stepsToReproduce: Array.isArray(payload.stepsToReproduce)
      ? payload.stepsToReproduce
      : item.stepsToReproduce,
    actualResult: String(payload.actualResult ?? item.actualResult),
    expectedResult: String(payload.expectedResult ?? item.expectedResult),
    acceptanceCriteria: Array.isArray(payload.acceptanceCriteria)
      ? payload.acceptanceCriteria
      : item.acceptanceCriteria,
    redactionNotes: "Civic Nexus API",
  };
}

export async function redactForEnterprise(item: WorkItem): Promise<RedactedWorkItem> {
  if (config.civicApiUrl) {
    try {
      return await civicApiRedact(item);
    } catch (e) {
      console.warn("[civic] API failed, using local redaction:", e);
    }
  }
  return localRedact(item);
}
