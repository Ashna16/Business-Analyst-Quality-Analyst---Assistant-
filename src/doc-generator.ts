import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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

/** Fixed deliverable path (Desktop BA_QA_DEMO_OUTPUT), portable via homedir(). */
export const QA_REPORT_DOCX_PATH = join(
  homedir(),
  "Desktop",
  "BA_QA_DEMO_OUTPUT",
  "QA_Report.docx",
);

export function makeTestCaseId(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const rnd = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `TC-${y}${m}${day}-${rnd}`;
}

/** Payload for Word QA report + markdown; aligns with pipeline bug rows */
export type QaBugReportData = {
  testCaseId: string;
  item: RedactedWorkItem;
  jira: JiraPayload;
  /** @deprecated path is fixed to QA_Report.docx; kept for call-site compatibility */
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

/**
 * At least 3 table rows: prefer stepsToReproduce; pad from transcript summary + bug description.
 */
function buildAtLeastThreeActionSteps(item: RedactedWorkItem, jira: JiraPayload): string[] {
  const fromTicket = jira.stepsToReproduce.map((s) => s.trim()).filter(Boolean);
  if (fromTicket.length >= 3) {
    return fromTicket;
  }

  const narrative = [item.summary.trim(), jira.description.trim()].filter(Boolean).join("\n");
  const chunks = narrative
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 12);

  const derived: string[] = [];
  for (const c of chunks) {
    if (fromTicket.length + derived.length >= 3) {
      break;
    }
    if (
      fromTicket.some((t) => t.includes(c.slice(0, 40))) ||
      derived.some((d) => d.includes(c.slice(0, 40)))
    ) {
      continue;
    }
    derived.push(c.length > 220 ? `${c.slice(0, 217)}…` : c);
  }

  const fallbacks = [
    `Open CCMS 2.0 and navigate to the area related to: ${item.title}`,
    `Reproduce the reported behavior using the defect narrative and capture evidence (screens / logs).`,
    `Verify resolution against expected behavior: ${jira.expectedResult || "documented acceptance criteria"}.`,
  ];

  let out = [...fromTicket];
  for (const d of [...derived, ...fallbacks]) {
    if (out.length >= 3) {
      break;
    }
    if (!out.includes(d)) {
      out.push(d);
    }
  }

  return out.slice(0, Math.max(3, out.length));
}

/**
 * Builds QA_Report.docx on Desktop BA_QA_DEMO_OUTPUT (see QA_REPORT_DOCX_PATH).
 */
export async function generateWordQAReport(bugData: QaBugReportData): Promise<string> {
  const { testCaseId, jira, item } = bugData;
  const outPath = QA_REPORT_DOCX_PATH;
  mkdirSync(dirname(outPath), { recursive: true });

  const steps = buildAtLeastThreeActionSteps(item, jira);

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
              children: [cellParagraph(i === 0 ? testCaseId : "↳")],
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
