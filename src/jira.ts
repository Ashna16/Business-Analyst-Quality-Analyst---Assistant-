import { Buffer } from "node:buffer";
import { Composio } from "composio-core";
import { config } from "./config.js";
import type { RedactedWorkItem } from "./types.js";

export type JiraPayload = {
  title: string;
  description: string;
  stepsToReproduce: string[];
  actualResult: string;
  expectedResult: string;
  acceptanceCriteria: string[];
};

export function toJiraPayload(item: RedactedWorkItem): JiraPayload {
  const title = `${item.component} - ${item.title.replace(/^\[[^\]]+\]\s*/, "")}`;
  const descParts = [
    item.summary,
    item.redactionNotes ? `\n\n_Redaction: ${item.redactionNotes}_` : "",
  ];
  return {
    title,
    description: descParts.join("").trim(),
    stepsToReproduce: item.stepsToReproduce,
    actualResult: item.actualResult,
    expectedResult: item.expectedResult,
    acceptanceCriteria: item.acceptanceCriteria,
  };
}

const MAX_URL_DESCRIPTION_CHARS = 3500;
/** Jira REST / ADF practical cap per issue description body */
const MAX_REST_DESCRIPTION_CHARS = 100_000;

function buildJiraDescriptionBody(jira: JiraPayload, maxLen: number | null): string {
  const parts = [
    jira.description,
    "",
    "## Steps to Reproduce",
    ...jira.stepsToReproduce.map((s, i) => `${i + 1}. ${s}`),
    "",
    "## Actual Result",
    jira.actualResult,
    "",
    "## Expected Result",
    jira.expectedResult,
    "",
    "## Acceptance Criteria",
    ...jira.acceptanceCriteria.map((c) => `- ${c}`),
  ];
  let text = parts.join("\n");
  if (maxLen !== null && text.length > maxLen) {
    text = `${text.slice(0, maxLen)}\n\n…(truncated)`;
  }
  return text;
}

function buildFullDescriptionForUrl(jira: JiraPayload): string {
  return buildJiraDescriptionBody(jira, MAX_URL_DESCRIPTION_CHARS);
}

/** Hostname for Atlassian Cloud (e.g. mysite.atlassian.net). */
function jiraCloudHost(): string {
  let h = config.jiraAtlassianDomain.replace(/^https?:\/\//i, "").replace(/\/$/, "");
  if (!h.includes(".")) {
    h = `${h}.atlassian.net`;
  }
  return h;
}

function jiraRestIssueUrl(): string {
  return `https://${jiraCloudHost()}/rest/api/3/issue`;
}

const ADF_TEXT_MAX = 32767;

type AdfText = { type: "text"; text: string; marks?: { type: string }[] };
type AdfBlock = Record<string, unknown>;

function cleanWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** Remove markdown bold wrappers and stray asterisks used for bold. */
function stripMarkdownBold(text: string): string {
  let s = text.replace(/\*\*([\s\S]*?)\*\*/gu, "$1");
  s = s.replace(/\*\*/gu, "");
  return s;
}

function cleanPlainSegment(text: string): string {
  return cleanWhitespace(stripMarkdownBold(text));
}

function cleanIssueSummaryTitle(title: string): string {
  return cleanPlainSegment(title).slice(0, 255);
}

function adfTextPlain(text: string): AdfText {
  const t = cleanPlainSegment(text).slice(0, ADF_TEXT_MAX) || " ";
  return { type: "text", text: t };
}

function adfBoldLabel(label: string): AdfBlock {
  return {
    type: "paragraph",
    content: [
      {
        type: "text",
        text: cleanPlainSegment(label).slice(0, ADF_TEXT_MAX) || " ",
        marks: [{ type: "strong" }],
      },
    ],
  };
}

function adfParagraphFromPlain(text: string): AdfBlock {
  return {
    type: "paragraph",
    content: [adfTextPlain(text)],
  };
}

function adfHeading(level: 2 | 3, text: string): AdfBlock {
  return {
    type: "heading",
    attrs: { level },
    content: [adfTextPlain(text)],
  };
}

function adfOrderedList(items: string[]): AdfBlock {
  const listItems = items.map((raw) => {
    const item = cleanPlainSegment(raw);
    return {
      type: "listItem",
      content: [adfParagraphFromPlain(item || " ")],
    };
  });
  return { type: "orderedList", attrs: { order: 1 }, content: listItems };
}

function adfBulletList(items: string[]): AdfBlock {
  const listItems = items.map((raw) => {
    const item = cleanPlainSegment(raw);
    return {
      type: "listItem",
      content: [adfParagraphFromPlain(item || " ")],
    };
  });
  return { type: "bulletList", content: listItems };
}

/**
 * Parse intro/description text: ## → heading, 1. / - → lists, else paragraph runs.
 */
function parseIntroMarkdownToAdfBlocks(text: string): AdfBlock[] {
  const stripped = stripMarkdownBold(text).replace(/  +/gu, " ");
  const lines = stripped.split(/\r?\n/);
  const blocks: AdfBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) {
      i++;
      continue;
    }

    if (line.startsWith("## ")) {
      blocks.push(adfHeading(2, line.slice(3)));
      i++;
      continue;
    }
    if (line.startsWith("### ")) {
      blocks.push(adfHeading(3, line.slice(4)));
      i++;
      continue;
    }

    if (/^\d+\.\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const L = lines[i].trim();
        if (!L) {
          break;
        }
        const m = L.match(/^\d+\.\s*(.*)$/);
        if (!m) {
          break;
        }
        items.push(m[1]);
        i++;
      }
      if (items.length) {
        blocks.push(adfOrderedList(items));
      }
      continue;
    }

    if (/^[-*]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const L = lines[i].trim();
        if (!L) {
          break;
        }
        const m = L.match(/^[-*]\s*(.*)$/);
        if (!m) {
          break;
        }
        items.push(m[1]);
        i++;
      }
      if (items.length) {
        blocks.push(adfBulletList(items));
      }
      continue;
    }

    const paraLines: string[] = [];
    while (i < lines.length) {
      const L = lines[i].trim();
      if (!L) {
        break;
      }
      if (L.startsWith("## ") || L.startsWith("### ") || /^\d+\.\s/.test(L) || /^[-*]\s/.test(L)) {
        break;
      }
      paraLines.push(L);
      i++;
    }
    if (paraLines.length) {
      blocks.push(adfParagraphFromPlain(paraLines.join(" ")));
    }
  }

  return blocks;
}

/** Full description ADF for REST create (structured sections + parsed intro). */
function buildDirectIssueDescriptionAdf(jira: JiraPayload): {
  type: "doc";
  version: 1;
  content: AdfBlock[];
} {
  const content: AdfBlock[] = [];

  const intro = jira.description.trim();
  if (intro) {
    content.push(...parseIntroMarkdownToAdfBlocks(intro));
  }

  content.push(adfBoldLabel("Steps to Reproduce"));
  if (jira.stepsToReproduce.length) {
    content.push(adfOrderedList(jira.stepsToReproduce));
  } else {
    content.push(adfParagraphFromPlain(" "));
  }

  content.push(adfBoldLabel("Actual Result"));
  content.push(adfParagraphFromPlain(jira.actualResult || " "));

  content.push(adfBoldLabel("Expected Result"));
  content.push(adfParagraphFromPlain(jira.expectedResult || " "));

  content.push(adfBoldLabel("Acceptance Criteria"));
  if (jira.acceptanceCriteria.length) {
    content.push(adfBulletList(jira.acceptanceCriteria));
  } else {
    content.push(adfParagraphFromPlain(" "));
  }

  return {
    type: "doc",
    version: 1,
    content: content.length ? content : [adfParagraphFromPlain(" ")],
  };
}

/** Keep REST description under cap by trimming the freeform intro first. */
function truncateJiraPayloadForRest(jira: JiraPayload): JiraPayload {
  const full = buildJiraDescriptionBody(jira, null);
  if (full.length <= MAX_REST_DESCRIPTION_CHARS) {
    return jira;
  }
  const cut = full.length - MAX_REST_DESCRIPTION_CHARS + 80;
  const d = jira.description;
  const newLen = Math.max(0, d.length - cut);
  const trimmed = stripMarkdownBold(d).slice(0, newLen).trimEnd() + "\n\n…(truncated)";
  return { ...jira, description: trimmed };
}

function buildCreateIssueHref(jira: JiraPayload): string {
  const summary = encodeURIComponent(jira.title);
  const description = encodeURIComponent(buildFullDescriptionForUrl(jira));
  const pid = encodeURIComponent(config.jiraProjectId);
  const issuetype = encodeURIComponent(config.jiraIssueTypeId);
  return `https://${jiraCloudHost()}/secure/CreateIssueDetails!init.jspa?pid=${pid}&issuetype=${issuetype}&priority=3&summary=${summary}&description=${description}`;
}

/**
 * Large primary CTA at the top of the exported stub (Markdown = one prominent link; opens Jira pre-filled).
 * URL uses your Atlassian Cloud host (`JIRA_ATLASSIAN_DOMAIN`); `pid` comes from JIRA_PROJECT_ID (numeric id, not the project key—verify in Jira).
 */
export function buildJiraSendToJiraTopSection(jira: JiraPayload): string {
  const href = buildCreateIssueHref(jira);
  return `## ➡️ [**Send to Jira**](${href})

`;
}

/**
 * Markdown block: same Create issue deep link as the Send to Jira CTA.
 */
export function buildJiraQuickImportSection(jira: JiraPayload): string {
  const href = buildCreateIssueHref(jira);
  const label = "Open pre-filled Create Issue in Jira";
  return `## ⚡️ Quick Import to Jira

[${label}](${href})
`;
}

export type JiraBugData = {
  item: RedactedWorkItem;
  jira: JiraPayload;
};

/**
 * Create a Jira issue via REST API v3 using Basic auth (base64(email:api_token)).
 */
export async function createJiraTicketDirect(
  bugData: JiraBugData,
): Promise<{ ok: boolean; detail: string; issueKey?: string; issueUrl?: string }> {
  if (!config.jiraApiToken || !config.jiraUserEmail) {
    return {
      ok: false,
      detail: "JIRA_API_TOKEN or JIRA_USER_EMAIL not set — direct Jira create skipped",
    };
  }

  const jiraForAdf = truncateJiraPayloadForRest(bugData.jira);
  const body = {
    fields: {
      project: { key: config.jiraProjectKey },
      summary: cleanIssueSummaryTitle(jiraForAdf.title),
      description: buildDirectIssueDescriptionAdf(jiraForAdf),
      issuetype: { name: config.jiraIssueTypeName },
    },
  };

  const token = Buffer.from(`${config.jiraUserEmail}:${config.jiraApiToken}`, "utf8").toString(
    "base64",
  );

  let res: Response;
  try {
    res = await fetch(jiraRestIssueUrl(), {
      method: "POST",
      headers: {
        Authorization: `Basic ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, detail: `Jira REST fetch failed: ${String(e)}` };
  }

  const rawText = await res.text();
  let data: {
    key?: string;
    self?: string;
    errorMessages?: string[];
    errors?: Record<string, string>;
  };
  try {
    data = JSON.parse(rawText) as typeof data;
  } catch {
    return { ok: false, detail: `Jira REST ${res.status}: ${rawText.slice(0, 500)}` };
  }

  if (!res.ok) {
    const msg =
      data.errorMessages?.join("; ") ||
      Object.entries(data.errors ?? {})
        .map(([k, v]) => `${k}: ${v}`)
        .join("; ") ||
      rawText.slice(0, 500);
    return { ok: false, detail: `Jira REST ${res.status}: ${msg}` };
  }

  const issueKey = typeof data.key === "string" ? data.key : undefined;
  const issueUrl = issueKey
    ? `https://${jiraCloudHost()}/browse/${issueKey}`
    : typeof data.self === "string"
      ? data.self
      : undefined;

  return {
    ok: true,
    detail: issueKey ? `Created ${issueKey}` : "Issue created",
    issueKey,
    issueUrl,
  };
}

/**
 * Create a Jira issue via Composio (action JIRA_CREATE_ISSUE).
 * Requires COMPOSIO_API_KEY, COMPOSIO_JIRA_CONNECTED_ACCOUNT_ID, and JIRA_PROJECT_KEY in env.
 */
export async function createJiraTicketAutomated(
  bugData: JiraBugData,
): Promise<{ ok: boolean; detail: string; issueKey?: string; issueUrl?: string }> {
  if (!config.composioApiKey) {
    return {
      ok: false,
      detail: "COMPOSIO_API_KEY not set — automated Jira skipped",
    };
  }
  if (!config.composioJiraConnectedAccountId) {
    return {
      ok: false,
      detail:
        "COMPOSIO_JIRA_CONNECTED_ACCOUNT_ID not set — add a Jira connection in Composio and paste its connected account id",
    };
  }

  const composio = new Composio({ apiKey: config.composioApiKey });
  const entity = composio.getEntity(config.composioEntityId);
  const description = buildFullDescriptionForUrl(bugData.jira);

  let res;
  try {
    res = await entity.execute({
      actionName: "JIRA_CREATE_ISSUE",
      params: {
        project_key: config.jiraProjectKey,
        issue_type: config.jiraIssueTypeName,
        summary: bugData.jira.title,
        description,
      },
      connectedAccountId: config.composioJiraConnectedAccountId,
    });
  } catch (e) {
    return { ok: false, detail: `Composio error: ${String(e)}` };
  }

  if (!res.successful) {
    return { ok: false, detail: res.error ?? "Composio JIRA_CREATE_ISSUE failed" };
  }

  const data = res.data as { key?: string; self?: string };
  const issueKey = typeof data.key === "string" ? data.key : undefined;
  const issueUrl = issueKey
    ? `https://${jiraCloudHost()}/browse/${issueKey}`
    : typeof data.self === "string"
      ? data.self
      : undefined;

  return {
    ok: true,
    detail: issueKey ? `Created ${issueKey}` : "Issue created",
    issueKey,
    issueUrl,
  };
}

export async function createJiraViaApify(
  payload: JiraPayload,
): Promise<{ ok: boolean; detail: string }> {
  if (!config.apifyToken || !config.apifyActorId) {
    return {
      ok: false,
      detail:
        "mock: Apify token or actor id missing — would create ticket with payload keys: title, description, steps...",
    };
  }

  const res = await fetch(
    `https://api.apify.com/v2/acts/${config.apifyActorId}/runs?token=${encodeURIComponent(config.apifyToken)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jiraPayload: payload,
      }),
    },
  );

  if (!res.ok) {
    const t = await res.text();
    return { ok: false, detail: `Apify ${res.status}: ${t}` };
  }
  const data = (await res.json()) as { data?: { id?: string } };
  const runId = data.data?.id ?? "unknown";
  return { ok: true, detail: `Apify run started: ${runId}` };
}
