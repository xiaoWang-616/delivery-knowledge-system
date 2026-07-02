export type PermissionKey =
  | "allowWriteCode"
  | "allowRunCommands"
  | "allowAutoFix"
  | "allowKnowledgeWrite";

export type DeliveryTask = {
  projectName: string;
  projectPath: string;
  moduleName: string;
  requirement: string;
  apiDocs: string;
  demos: string;
  oldProjects: string;
  prds: string;
  permissions: Record<PermissionKey, boolean>;
};

export type StepStatus = "locked" | "pending" | "running" | "done" | "risk" | "failed";

export type IssueLevel = "P0" | "P1" | "P2";

export type DeliveryIssue = {
  id: string;
  level: IssueLevel;
  title: string;
  owner: "用户" | "AI" | "后端" | "设计" | "测试";
  description: string;
  canContinue: boolean;
};

export type WorkflowStep = {
  id: string;
  title: string;
  description: string;
  dependsOn: string[];
  status: StepStatus;
  output: string;
  issues: DeliveryIssue[];
};

export type RuntimeState = Record<string, StepStatus | undefined>;

export type RunLog = {
  id: string;
  message: string;
  createdAt: string;
  level: "info" | "success" | "warning" | "error";
};

export type ProjectScanResult = {
  status: "success" | "missing" | "error";
  projectPath: string;
  projectName: string;
  packageManager: string;
  frameworks: string[];
  scripts: Record<string, string>;
  keyDirectories: string[];
  keyFiles: string[];
  ruleFiles: string[];
  envFiles: string[];
  sourcePreview: string[];
  warnings: string[];
  summary: string;
  generatedAt: string;
};

export type SystemHealthCheck = {
  name: string;
  status: "ok" | "warning" | "error";
  message: string;
  path?: string;
};

export type SystemHealthResult = {
  status: "success" | "warning" | "error";
  ok: boolean;
  service: string;
  port: number;
  knowledgeRoot: string;
  runnerDirectory: string;
  checks: SystemHealthCheck[];
  summary: string;
  generatedAt: string;
};

export type KnowledgeWriteResult = {
  status: "success" | "error";
  knowledgeRoot: string;
  projectDirectory: string;
  moduleDirectory: string;
  writtenFiles: string[];
  summary: string;
  generatedAt: string;
};

export type ContextSourceSummary = {
  type: "api" | "demo" | "oldProject" | "prd";
  source: string;
  status: "read" | "missing" | "external" | "skipped";
  fileCount: number;
  charCount: number;
  summary: string;
};

export type ContextPackageResult = {
  status: "success" | "error";
  knowledgeRoot: string;
  projectDirectory: string;
  moduleDirectory: string;
  writtenFiles: string[];
  sources: ContextSourceSummary[];
  summary: string;
  generatedAt: string;
};

export type ExecutionPackageResult = {
  status: "success" | "error";
  knowledgeRoot: string;
  projectDirectory: string;
  moduleDirectory: string;
  packageDirectory: string;
  writtenFiles: string[];
  summary: string;
  generatedAt: string;
};

export type TaskQueueItem = {
  id: string;
  title: string;
  status: "pending" | "assigned" | "submitted" | "reviewed" | "needs-fix" | "done" | "blocked";
  fixOf?: string;
  dependsOn: string[];
  goal: string;
  allowedFiles: string[];
  forbidden: string[];
  inputs: string[];
  acceptance: string[];
  promptFile: string;
  baselineChangedFiles?: string[];
};

export type TaskPlanResult = {
  status: "success" | "error";
  knowledgeRoot: string;
  projectDirectory: string;
  moduleDirectory: string;
  planDirectory: string;
  writtenFiles: string[];
  tasks: TaskQueueItem[];
  summary: string;
  generatedAt: string;
};

export type TaskDispatchResult = {
  status: "success" | "error";
  taskId: string;
  promptContent: string;
  updatedTaskPlan: TaskPlanResult | null;
  summary: string;
  generatedAt: string;
};

export type TaskReviewResult = {
  status: "success" | "error";
  decision: "approved" | "needs-fix" | "blocked";
  taskId: string;
  nextTaskId: string | null;
  findings: string[];
  changedFiles: string[];
  outOfScopeFiles: string[];
  reviewFile: string;
  fixPromptFile: string | null;
  updatedTaskPlan: TaskPlanResult | null;
  summary: string;
  generatedAt: string;
};

export type IssueFixTaskResult = {
  status: "success" | "error";
  taskId: string;
  issueId: string;
  promptFile: string;
  updatedTaskPlan: TaskPlanResult | null;
  summary: string;
  generatedAt: string;
};

export type FinalAcceptanceResult = {
  status: "success" | "warning" | "blocked" | "error";
  knowledgeRoot: string;
  projectDirectory: string;
  moduleDirectory: string;
  planDirectory: string;
  acceptanceFile: string;
  writtenFiles: string[];
  taskSummary: {
    total: number;
    done: number;
    pending: number;
    assigned: number;
    needsFix: number;
    blocked: number;
  };
  findings: string[];
  rules: string[];
  summary: string;
  generatedAt: string;
};

export type ValidationCommandResult = {
  name: "typecheck" | "lint" | "build";
  script: string;
  command: string;
  status: "passed" | "failed" | "skipped" | "timeout";
  exitCode: number | null;
  durationMs: number;
  output: string;
};

export type ValidationRunResult = {
  status: "success" | "failed" | "partial" | "skipped" | "error";
  projectPath: string;
  packageManager: string;
  commands: ValidationCommandResult[];
  summary: string;
  generatedAt: string;
};

export type DeliveryRunRecord = {
  runId: string;
  task: DeliveryTask;
  runtime: RuntimeState;
  logs: RunLog[];
  projectScan: ProjectScanResult | null;
  validationRun: ValidationRunResult | null;
  knowledgeWrite: KnowledgeWriteResult | null;
  contextPackage: ContextPackageResult | null;
  executionPackage: ExecutionPackageResult | null;
  taskPlan: TaskPlanResult | null;
  finalAcceptance: FinalAcceptanceResult | null;
  steps: WorkflowStep[];
  issues: DeliveryIssue[];
  progress: number;
  summary: string;
  createdAt: string;
  updatedAt: string;
};

export type RunRecordSaveResult = {
  status: "success" | "error";
  runId: string;
  runFile: string;
  latestFile: string;
  summary: string;
  generatedAt: string;
};

export type RunRecordListItem = {
  runId: string;
  summary: string;
  progress: number;
  issueCount: number;
  validationStatus: ValidationRunResult["status"] | "none";
  knowledgeStatus: KnowledgeWriteResult["status"] | "none";
  createdAt: string;
  updatedAt: string;
  runFile: string;
};

export type RunRecordListResult = {
  status: "success" | "error";
  projectName: string;
  moduleName: string;
  runs: RunRecordListItem[];
  summary: string;
  generatedAt: string;
};
