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

function buildFullDescriptionForUrl(jira: JiraPayload): string {
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
  if (text.length > MAX_URL_DESCRIPTION_CHARS) {
    text = `${text.slice(0, MAX_URL_DESCRIPTION_CHARS)}\n\n…(truncated for URL length; see sections above in this file.)`;
  }
  return text;
}

function jiraSubdomain(): string {
  return config.jiraAtlassianDomain.replace(/\.atlassian\.net$/i, "").replace(/^https?:\/\//i, "");
}

function buildCreateIssueHref(jira: JiraPayload): string {
  const summary = encodeURIComponent(jira.title);
  const description = encodeURIComponent(buildFullDescriptionForUrl(jira));
  const pid = encodeURIComponent(config.jiraProjectId);
  const issuetype = encodeURIComponent(config.jiraIssueTypeId);
  return `https://ashnaparekh1998.atlassian.net/secure/CreateIssueDetails!init.jspa?pid=${pid}&issuetype=${issuetype}&priority=3&summary=${summary}&description=${description}`;
}

/**
 * Large primary CTA at the top of the exported stub (Markdown = one prominent link; opens Jira pre-filled).
 * URL uses ashnaparekh1998.atlassian.net; `pid` comes from JIRA_PROJECT_ID (numeric id, not the SCRUM key—verify in Jira).
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
  const sub = jiraSubdomain();
  const issueUrl = issueKey
    ? `https://${sub}.atlassian.net/browse/${issueKey}`
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
