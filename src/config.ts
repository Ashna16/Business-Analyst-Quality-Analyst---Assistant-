import "dotenv/config";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

function env(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

function envBool(name: string, fallback: boolean): boolean {
  const v = env(name);
  if (!v) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

/** Default: ~/Desktop/BA_QA_DEMO_OUTPUT; override with OUTPUT_DIR (relative to package root unless absolute or ~/). */
function resolveOutputDir(): string {
  const raw = env("OUTPUT_DIR");
  if (!raw) {
    return join(homedir(), "Desktop", "BA_QA_DEMO_OUTPUT");
  }
  if (raw.startsWith("~/")) {
    return join(homedir(), raw.slice(2));
  }
  if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) {
    return raw;
  }
  return resolve(root, raw);
}

export const config = {
  openclawGatewayUrl: env("OPENCLAW_GATEWAY_URL", "http://127.0.0.1:9700"),
  openclawGatewayToken: env("OPENCLAW_GATEWAY_TOKEN"),

  openaiApiKey: env("OPENAI_API_KEY"),
  /** Optional; pipeline uses Bearer token only — reserved for proxies or future auth. */
  openaiPassword: env("OPENAI_PASSWORD"),
  openaiBaseUrl: env("OPENAI_BASE_URL", "https://api.openai.com/v1"),
  openaiModel: env("OPENAI_MODEL", "gpt-4.1-mini"),

  /** Contextual AI GLM — meeting-note extraction via POST /v1/generate (knowledge = transcript) */
  contextualAiApiKey: env("CONTEXTUAL_AI_API_KEY"),
  contextualAiModel: env("CONTEXTUAL_AI_MODEL", "v2"),

  civicApiUrl: env("CIVIC_NEXUS_API_URL"),
  civicApiKey: env("CIVIC_NEXUS_API_KEY"),

  redisUrl: env("REDIS_URL"),
  redisPrefix: env("REDIS_MEMORY_PREFIX", "baqa:bugs"),

  apifyToken: env("APIFY_API_TOKEN"),
  apifyActorId: env("APIFY_ACTOR_ID"),

  /** Composio (automated Jira via composio-core) */
  composioApiKey: env("COMPOSIO_API_KEY"),
  composioEntityId: env("COMPOSIO_ENTITY_ID", "default"),
  /** Connected Jira account id from Composio dashboard / Connections */
  composioJiraConnectedAccountId: env("COMPOSIO_JIRA_CONNECTED_ACCOUNT_ID"),
  /** Project key for JIRA_CREATE_ISSUE (e.g. PROJ), not the numeric pid */
  jiraProjectKey: env("JIRA_PROJECT_KEY", "PROJ"),
  /** Issue type name or id for Composio (e.g. Bug) */
  jiraIssueTypeName: env("JIRA_ISSUE_TYPE_NAME", "Bug"),

  /** Atlassian Cloud host: subdomain only or full host (e.g. acme or acme.atlassian.net). */
  jiraAtlassianDomain: env("JIRA_ATLASSIAN_DOMAIN", "your-domain.atlassian.net"),

  /** Jira REST: API token + email for Basic auth (https://developer.atlassian.com/cloud/jira/platform/rest/v3/) */
  jiraApiToken: env("JIRA_API_TOKEN"),
  jiraUserEmail: env("JIRA_USER_EMAIL"),
  /** Numeric Jira project id for Create Issue URL pid= (verify for your SCRUM board). */
  jiraProjectId: env("JIRA_PROJECT_ID", "10000"),
  jiraIssueTypeId: env("JIRA_ISSUE_TYPE_ID", "1"),

  outputDir: resolveOutputDir(),
  memoryFile: resolve(root, env("MEMORY_FILE", "./data/bug-memory.json")),

  /** When true, pipeline prints full JIRA-*.md and QA-*.md text to the terminal after each bug (good with watch mode). */
  echoArtifactsToConsole: envBool("BAQA_ECHO_ARTIFACTS", true),
};

mkdirSync(config.outputDir, { recursive: true });
mkdirSync(dirname(config.memoryFile), { recursive: true });

export const mockMode = envBool(
  "BAQA_MOCK",
  !config.contextualAiApiKey &&
    !config.openaiApiKey &&
    !config.civicApiUrl &&
    !config.redisUrl &&
    !config.apifyToken,
);
