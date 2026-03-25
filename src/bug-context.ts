/**
 * Context-aware bug detection: read clauses / sentences (not isolated keywords)
 * before treating text as a defect worth a Jira ticket.
 */

import type { WorkItemKind } from "./types.js";

function norm(s: string): string {
  return s
    .replace(/\*+|_+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const BUG_SURFACE =
  /\b(bug|bugs|defect|defects|broken|crash(?:es|ed)?|regression|fail(?:ed|ure)?|error|errors)\b/i;

const NEGATED_BUG =
  /\b(?:no|without|not|isn'?t|aren't|ain'?t|never|wasn'?t|weren'?t)\s+(?:an?\s+)?(?:bug|bugs|defect|defects)\b/i;

const NOT_A_PRODUCT_BUG = /\bnot\s+a\s+product\s+bug\b/i;

const NO_PRODUCT_DEFECT = /\bno\s+product\s+defect\b/i;

const NEGATED_ISSUE = /\bnot\s+(?:an?\s+)?(?:issue|problem|blocker)\b/i;

const NEGATED_ERROR = /\bno\s+errors?\b|\bnot\s+(?:an?\s+)?error\b|\bno\s+failure\b/i;

const INFORMATIONAL_CLEAR =
  /\b(?:false\s+positive|working\s+as\s+expected|expected\s+behavior|by\s+design|w(?:o|a)nt\s+fix|won'?t\s+fix)\b/i;

const HEALTHY_OR_OK =
  /\b(?:is\s+)?(?:healthy|green|fine|ok|good|clean|clear)\b.*\b(?:our\s+side|on\s+our\s+side)\b|\bno\s+bug\s+on\s+our\s+side\b/i;

/** Meta discussion about filing, not a described failure. */
const APOST = "['\u2019]";

const PROCEDURAL_BUG_MENTION = new RegExp(
  String.raw`\blet${APOST}s\s+get\s+(?:a\s+)?bug\s+filed\b|\bget\s+(?:a\s+)?bug\s+filed\b|\bbug\s*,\s*high\s+priority\b`,
  "i",
);

/** Symptoms / impact language that supports a real defect report. */
const AFFIRMATIVE_DEFECT = new RegExp(
  [
    String.raw`values?\s+are\s+not\s+mapping`,
    String.raw`not\s+mapping\s+correctly`,
    String.raw`data\s+is\s+not\s+saved`,
    String.raw`not\s+saved`,
    String.raw`doesn${APOST}t\s+(?:save|stick|persist)`,
    String.raw`nothing\s+sticks`,
    String.raw`snaps\s+back\s+to`,
    String.raw`(?:buttons?|cta)\s+are\s+not\s+aligned`,
    String.raw`are\s+not\s+aligned`,
    String.raw`aren${APOST}t\s+aligned`,
    String.raw`misaligned`,
    String.raw`wrong\s+(?:value|enum|option|data)`,
    String.raw`shows\s+as\s+\w+\s+instead`,
    String.raw`blank\s+screen`,
    String.raw`drops\s+the\s+\w+\s+column`,
    String.raw`clears\s+instead\s+of`,
    String.raw`not\s+working`,
    String.raw`doesn${APOST}t\s+work`,
    String.raw`still\s+broken`,
    String.raw`layout\s*/\s*css\s+bug`,
    String.raw`css\s+bug`,
    String.raw`repro(?:duc)?(?:es|ed)?\b`,
  ].join("|"),
  "i",
);

/** Manager triage (“great catch, bug, high priority”) with no concrete symptom in the same block. */
function isTriagingOnlyChunk(n: string): boolean {
  if (!/\bgreat\s+catch\b/i.test(n)) {
    return false;
  }
  if (!/\bbug\b/i.test(n)) {
    return false;
  }
  if (!/\bhigh\s+priority\b/i.test(n)) {
    return false;
  }
  return !AFFIRMATIVE_DEFECT.test(n);
}

const CLAUSE_SPLIT = /\s*(?:;|,|\u2014|(?<=\S)\s+-\s+|(?:\s+\bbut\b\s+)|(?:\s+\bhowever\b\s+))\s*/i;

function splitClauses(text: string): string[] {
  const primary = text.split(CLAUSE_SPLIT);
  const out: string[] = [];
  for (const p of primary) {
    const subs = p.split(/(?<=[.!?])\s+(?=[*\w])/);
    for (const s of subs) {
      const t = s.trim();
      if (t) {
        out.push(t);
      }
    }
  }
  return out.length ? out : [text.trim()].filter(Boolean);
}

function clauseNegatesBug(clause: string): boolean {
  const t = clause;
  return (
    NEGATED_BUG.test(t) ||
    NOT_A_PRODUCT_BUG.test(t) ||
    NO_PRODUCT_DEFECT.test(t) ||
    NEGATED_ISSUE.test(t) ||
    INFORMATIONAL_CLEAR.test(t) ||
    HEALTHY_OR_OK.test(t) ||
    (NEGATED_ERROR.test(t) && !AFFIRMATIVE_DEFECT.test(t))
  );
}

function clauseIsProcedural(clause: string): boolean {
  return PROCEDURAL_BUG_MENTION.test(clause);
}

function clauseHasBugSurface(clause: string): boolean {
  const s = clause.replace(/\bnon-?bug\b/gi, "nonbugtoken");
  if (!BUG_SURFACE.test(s)) {
    return false;
  }
  if (/\bduring\s+regression\b/i.test(clause) && !clauseHasAffirmativeDefect(clause)) {
    return false;
  }
  return true;
}

function clauseHasAffirmativeDefect(clause: string): boolean {
  return AFFIRMATIVE_DEFECT.test(clause);
}

/**
 * True if this block describes a defect worth tracking (not a denial / status-only line).
 */
export function isLegitimateBugChunk(text: string): boolean {
  if (!text || text.trim().length < 12) {
    return false;
  }

  const normalized = norm(text);
  if (isTriagingOnlyChunk(normalized)) {
    return false;
  }

  const clauses = splitClauses(normalized);
  if (clauses.length === 0) {
    return false;
  }

  let sawAffirmative = false;
  let sawBugWordInNonNegatedClause = false;

  for (const c of clauses) {
    if (clauseNegatesBug(c) || clauseIsProcedural(c)) {
      continue;
    }
    const surface = clauseHasBugSurface(c);
    const affirm = clauseHasAffirmativeDefect(c);

    if (surface && affirm) {
      return true;
    }
    if (affirm) {
      sawAffirmative = true;
    }
    if (surface) {
      sawBugWordInNonNegatedClause = true;
    }
  }

  if (sawAffirmative) {
    return true;
  }
  if (sawBugWordInNonNegatedClause) {
    return true;
  }
  return false;
}

export function shouldDowngradeKeywordBugToNonBug(chunk: string, hadBugKeyword: boolean): boolean {
  if (!hadBugKeyword) {
    return false;
  }
  return !isLegitimateBugChunk(chunk);
}

export function refineWorkItemKind(kind: WorkItemKind, summary: string): WorkItemKind {
  if (kind !== "bug") {
    return kind;
  }
  if (!isLegitimateBugChunk(summary)) {
    return "action_item";
  }
  return kind;
}
