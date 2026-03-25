import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isLegitimateBugChunk } from "./bug-context.js";
import { redactForEnterprise } from "./civic.js";
import { config, mockMode } from "./config.js";
import {
  buildQaMarkdown,
  generateWordQAReport,
  makeTestCaseId,
  wordReportMarkdownLink,
  writeTestDoc,
} from "./doc-generator.js";
import {
  buildJiraQuickImportSection,
  buildJiraSendToJiraTopSection,
  createJiraTicketAutomated,
  toJiraPayload,
} from "./jira.js";
import { findSimilarBugs, recordBugFingerprint } from "./memory.js";
import { pingOpenClawGateway } from "./openclaw-bridge.js";
import { parseTranscript } from "./parser.js";
import type { MemoryHit, PipelineResult, RedactedWorkItem } from "./types.js";

async function echoArtifactMarkdown(
  label: string,
  filePath: string,
  readFile: typeof import("node:fs/promises").readFile,
) {
  const text = await readFile(filePath, "utf8");
  console.log(
    `\n${"═".repeat(72)}\n${label}\n${filePath}\n${"─".repeat(72)}\n${text}\n${"═".repeat(72)}\n`,
  );
}

async function writeJiraMarkdownStub(
  item: RedactedWorkItem,
  jira: ReturnType<typeof toJiraPayload>,
  extras?: { wordAbsPath?: string; issueUrl?: string },
): Promise<string> {
  const slug = `${item.kind}-${item.component}-${item.title}`.slice(0, 60);
  const safe = slug.replace(/[^a-z0-9-_]+/gi, "_");
  const ac = jira.acceptanceCriteria.map((c) => `- [ ] ${c}`).join("\n");
  const steps = jira.stepsToReproduce.map((s, i) => `${i + 1}. ${s}`).join("\n");

  const wordBlock =
    extras?.wordAbsPath != null && extras.wordAbsPath !== ""
      ? `## 📂 QA validation (Word)

${wordReportMarkdownLink(extras.wordAbsPath)}

`
      : "";

  const jiraBlock =
    extras?.issueUrl != null && extras.issueUrl !== ""
      ? `## 🔗 Created in Jira

${extras.issueUrl}

`
      : "";

  const body = `# Jira / Mira ticket (draft)

${buildJiraSendToJiraTopSection(jira)}${wordBlock}${jiraBlock}## Title
**${jira.title}**

## Description
${jira.description}

## Steps to Reproduce
${steps}

## Actual Result
${jira.actualResult}

## Expected Result
${jira.expectedResult}

## Acceptance Criteria
${ac}

${buildJiraQuickImportSection(jira)}
`;
  const path = join(config.outputDir, `JIRA-${safe}.md`);
  await writeFile(path, body, "utf8");
  return path;
}

export async function runPipeline(transcriptPath: string): Promise<PipelineResult> {
  mkdirSync(config.outputDir, { recursive: true });

  const { readFile } = await import("node:fs/promises");
  const transcript = await readFile(transcriptPath, "utf8");

  const gw = await pingOpenClawGateway();
  console.log(`[openclaw] gateway: ${gw.ok ? "OK" : "SKIP"} — ${gw.detail}`);
  if (mockMode) {
    console.log(
      "[baqa] Mock-friendly mode: missing some API keys — writing local markdown and console summary.",
    );
  }

  const parsed = await parseTranscript(transcript);
  const redacted: RedactedWorkItem[] = [];
  for (const item of parsed) {
    redacted.push(await redactForEnterprise(item));
  }

  const memoryChecks = new Map<string, MemoryHit[]>();
  const jiraResults = new Map<string, { ok: boolean; detail: string }>();
  const writtenFiles: string[] = [];

  for (const item of redacted) {
    if (item.kind !== "bug") {
      continue;
    }
    if (!isLegitimateBugChunk(`${item.title}\n${item.summary}`)) {
      console.log(
        `[pipeline] skipped Jira/QA — not a confirmed defect in context: ${item.title.slice(0, 72)}…`,
      );
      continue;
    }

    const mem = await findSimilarBugs(`${item.title}\n${item.summary}`, 30);
    memoryChecks.set(item.title, mem);
    if (mem.length) {
      console.log(`[memory] Similar bugs for "${item.title.slice(0, 60)}…":`, mem.length);
    }

    const jiraPayload = toJiraPayload(item);

    const slug = `${item.kind}-${item.component}-${item.title}`.slice(0, 60);
    const safe = slug.replace(/[^a-z0-9-_]+/gi, "_");
    const tcId = makeTestCaseId();

    const wordPath = await generateWordQAReport({
      testCaseId: tcId,
      item,
      jira: jiraPayload,
      fileSlug: safe,
    });
    writtenFiles.push(wordPath);

    const jiraAutomated = await createJiraTicketAutomated({ item, jira: jiraPayload });
    jiraResults.set(item.title, { ok: jiraAutomated.ok, detail: jiraAutomated.detail });
    console.log(`[jira] ${item.title.slice(0, 50)}… => ${jiraAutomated.detail}`);

    if (jiraAutomated.ok) {
      console.log("🚀 Jira Ticket Created & Word Doc Generated!");
    }

    const stubPath = await writeJiraMarkdownStub(item, jiraPayload, {
      wordAbsPath: wordPath,
      issueUrl: jiraAutomated.issueUrl,
    });
    writtenFiles.push(stubPath);

    const qaMd = buildQaMarkdown(item, jiraPayload, tcId);
    const qaPath = await writeTestDoc(`${item.component}-${item.title}`, qaMd);
    writtenFiles.push(qaPath);

    if (config.echoArtifactsToConsole) {
      await echoArtifactMarkdown("Latest Jira/Q stub (full markdown)", stubPath, readFile);
      await echoArtifactMarkdown("Latest QA test document (full markdown)", qaPath, readFile);
      console.log(`[baqa] Word report (binary .docx, path only): ${wordPath}`);
    }

    await recordBugFingerprint(`${item.title}\n${item.summary}`);
  }

  if (redacted.every((i) => i.kind !== "bug")) {
    console.log(
      "[baqa] No bugs parsed — generating QA stubs for action items / features only is skipped.",
    );
  }

  return { items: redacted, memoryChecks, jiraResults, writtenFiles };
}
