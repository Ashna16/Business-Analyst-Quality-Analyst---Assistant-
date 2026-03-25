export type WorkItemKind = "bug" | "feature_request" | "action_item";

export type WorkItem = {
  kind: WorkItemKind;
  component: string;
  title: string;
  summary: string;
  stepsToReproduce: string[];
  actualResult: string;
  expectedResult: string;
  acceptanceCriteria: string[];
  sourceQuote?: string;
};

export type RedactedWorkItem = WorkItem & {
  redactionNotes?: string;
};

export type MemoryHit = {
  id: string;
  summary: string;
  similarity: number;
  createdAt: string;
};

export type PipelineResult = {
  items: RedactedWorkItem[];
  memoryChecks: Map<string, MemoryHit[]>;
  jiraResults: Map<string, { ok: boolean; detail: string }>;
  writtenFiles: string[];
};
