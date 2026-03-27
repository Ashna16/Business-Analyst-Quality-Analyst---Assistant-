import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AlignmentType,
  Document,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { config } from "./config.js";
import type { JiraPayload } from "./jira.js";
import type { RedactedWorkItem } from "./types.js";

/**
 * Directory for Word QA reports (Desktop BA_QA_DEMO_OUTPUT). Each bug writes its own file:
 * QA_Report_<bugId>_<YYYYMMDD_HHmmss>.docx — nothing is overwritten.
 */
export const QA_REPORT_DOCX_PATH = join(homedir(), "Desktop", "BA_QA_DEMO_OUTPUT");

function qaReportTimestamp(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${y}${m}${day}_${h}${min}${s}`;
}

/** Shared date segment for IDs: `TC-YYYYMMDD`. */
function testCaseIdDatePrefix(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `TC-${y}${m}${day}`;
}

/** Per-step ID for Word table rows: `TC-YYYYMMDD-STY0`, `TC-YYYYMMDD-STY1`, … */
export function makeStepTestCaseId(stepIndex: number): string {
  return `${testCaseIdDatePrefix()}-STY${stepIndex}`;
}

/** Primary ID for markdown (first step index); same family as `makeStepTestCaseId`. */
export function makeTestCaseId(): string {
  return makeStepTestCaseId(0);
}

/** Payload for Word QA report; use `fileSlug` for stable per-bug filenames */
export type QaBugReportData = {
  item: RedactedWorkItem;
  jira: JiraPayload;
  /** Sanitized bug id for `QA_Report_<fileSlug>_<timestamp>.docx` */
  fileSlug?: string;
};

function cellParagraph(text: string, opts?: { header?: boolean; size?: number }): Paragraph {
  const size = opts?.size ?? (opts?.header ? 22 : 20);
  return new Paragraph({
    children: [
      new TextRun({
        text,
        bold: opts?.header === true,
        size,
      }),
    ],
  });
}

function formatReportDate(): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date());
}

function normalizeStepDedupeKey(step: string): string {
  return step.replace(/\s+/gu, " ").trim().toLowerCase();
}

/**
 * Actual test steps only: non-empty, trimmed, duplicates removed (case-insensitive / whitespace-normalized).
 */
function distinctTestStepsFromJira(jira: JiraPayload): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of jira.stepsToReproduce) {
    const t = raw.replace(/\s+/gu, " ").trim();
    if (!t) {
      continue;
    }
    const key = normalizeStepDedupeKey(t);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(t);
  }
  return out;
}

/**
 * Builds QA_Report_<bugId>_<timestamp>.docx under QA_REPORT_DOCX_PATH (one file per bug, no overwrites).
 */
export async function generateWordQAReport(bugData: QaBugReportData): Promise<string> {
  const { jira, item } = bugData;
  const bugId =
    (bugData.fileSlug ?? "bug")
      .replace(/[^a-zA-Z0-9-_]+/gu, "_")
      .replace(/^_+/u, "")
      .replace(/_+$/u, "") || "bug";
  const outPath = join(QA_REPORT_DOCX_PATH, `QA_Report_${bugId}_${qaReportTimestamp()}.docx`);
  mkdirSync(QA_REPORT_DOCX_PATH, { recursive: true });

  const steps = distinctTestStepsFromJira(jira);

  const tableRows: TableRow[] = [
    new TableRow({
      children: [
        new TableCell({
          shading: { fill: "D9E2F3", type: ShadingType.CLEAR },
          width: { size: 18, type: WidthType.PERCENTAGE },
          children: [cellParagraph("Test Case ID", { header: true })],
        }),
        new TableCell({
          shading: { fill: "D9E2F3", type: ShadingType.CLEAR },
          width: { size: 28, type: WidthType.PERCENTAGE },
          children: [cellParagraph("Action/Step", { header: true })],
        }),
        new TableCell({
          shading: { fill: "D9E2F3", type: ShadingType.CLEAR },
          width: { size: 32, type: WidthType.PERCENTAGE },
          children: [cellParagraph("Expected Result", { header: true })],
        }),
        new TableCell({
          shading: { fill: "D9E2F3", type: ShadingType.CLEAR },
          width: { size: 22, type: WidthType.PERCENTAGE },
          children: [cellParagraph("Pass/Fail Status", { header: true })],
        }),
      ],
    }),
    ...steps.map(
      (action, i) =>
        new TableRow({
          children: [
            new TableCell({
              width: { size: 18, type: WidthType.PERCENTAGE },
              children: [cellParagraph(makeStepTestCaseId(i))],
            }),
            new TableCell({
              width: { size: 28, type: WidthType.PERCENTAGE },
              children: [cellParagraph(`${i + 1}. ${action}`)],
            }),
            new TableCell({
              width: { size: 32, type: WidthType.PERCENTAGE },
              children: [cellParagraph(jira.expectedResult || "—")],
            }),
            new TableCell({
              width: { size: 22, type: WidthType.PERCENTAGE },
              children: [cellParagraph("Pending")],
            }),
          ],
        }),
    ),
  ];

  const doc = new Document({
    sections: [
      {
        properties: {},
        children: [
          new Paragraph({
            spacing: { after: 120 },
            children: [
              new TextRun({ text: "Project: ", bold: true, size: 22 }),
              new TextRun({ text: "CCMS 2.0", size: 22 }),
            ],
          }),
          new Paragraph({
            spacing: { after: 120 },
            children: [
              new TextRun({ text: "Role: ", bold: true, size: 22 }),
              new TextRun({ text: "Lead BA/QA", size: 22 }),
            ],
          }),
          new Paragraph({
            spacing: { after: 240 },
            children: [
              new TextRun({ text: "Date: ", bold: true, size: 22 }),
              new TextRun({ text: formatReportDate(), size: 22 }),
            ],
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 200, before: 120 },
            children: [
              new TextRun({
                text: "CCMS 2.0 - QA Validation Report",
                bold: true,
                size: 36,
              }),
            ],
          }),
          new Paragraph({
            spacing: { after: 200 },
            children: [
              new TextRun({
                text: `Bug / feature under test: ${item.title}  |  Component: ${item.component}`,
                italics: true,
                size: 22,
              }),
            ],
          }),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: tableRows,
          }),
          new Paragraph({
            spacing: { before: 240 },
            children: [
              new TextRun({ text: "Actual result (defect): ", bold: true }),
              new TextRun(jira.actualResult),
            ],
          }),
        ],
      },
    ],
  });

  const buf = await Packer.toBuffer(doc);
  await writeFile(outPath, buf);
  console.log("📄 Word Doc generated successfully for CCMS 2.0!");
  return outPath;
}

/** Markdown link opening the local .docx via file:// URL */
export function wordReportMarkdownLink(wordAbsPath: string): string {
  const href = pathToFileURL(wordAbsPath).href;
  return `[📂 Open Word QA Report](${href})`;
}

export function buildQaMarkdown(
  item: RedactedWorkItem,
  jira: JiraPayload,
  testCaseId: string,
): string {
  const acList = jira.acceptanceCriteria.map((c) => `- ${c}`).join("\n");
  const steps = jira.stepsToReproduce.map((s, i) => `${i + 1}. ${s}`).join("\n");

  return `## QA Test Case

- **Test Case ID:** ${testCaseId}
- **Test Objective:** Verify resolution / behavior for: ${item.title}
- **Pre-requisites:** Environment matches target release; test data approved for non-prod use; no live PII.

### Test Steps

${steps}

### Expected vs Actual (ticket)

- **Expected Result:** ${jira.expectedResult}
- **Actual Result (defect):** ${jira.actualResult}

### Acceptance Criteria

${acList}

### Screenshot Evidence

> [PLACEHOLDER: Attach Screenshot Here]

### Status

**Status:** Blocked (pending implementation — update to Pass/Fail after execution)

---
_Linked work item kind: ${item.kind} | Component: ${item.component}_
`;
}

export async function writeTestDoc(slug: string, markdown: string): Promise<string> {
  const safe = slug.replace(/[^a-z0-9-_]+/gi, "_").slice(0, 80);
  const path = join(config.outputDir, `QA-${safe}.md`);
  await writeFile(path, markdown, "utf8");
  return path;
}
