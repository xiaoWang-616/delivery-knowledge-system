import type {
  ContextPackageResult,
  DeliveryIssue,
  DeliveryRunRecord,
  DeliveryTask,
  ExecutionPackageResult,
  FinalAcceptanceResult,
  IssueFixTaskResult,
  KnowledgeWriteResult,
  ProjectScanResult,
  RunRecordListResult,
  RunRecordSaveResult,
  SystemHealthResult,
  TaskDispatchResult,
  TaskPlanResult,
  TaskReviewResult,
  ValidationRunResult,
  WorkflowStep,
} from "./types";

const runnerBaseUrl = import.meta.env.VITE_RUNNER_URL || "http://localhost:5176";

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) {
    throw new Error("runner 返回了空响应");
  }
  const payload = JSON.parse(text) as T & { summary?: string; message?: string };
  if (!response.ok) {
    throw new Error(payload.summary || payload.message || `runner 请求失败：${response.status}`);
  }
  return payload;
}

export async function getSystemHealth(): Promise<SystemHealthResult> {
  const response = await fetch(`${runnerBaseUrl}/api/health`);
  return readJson<SystemHealthResult>(response);
}

export async function scanProject(projectPath: string): Promise<ProjectScanResult> {
  const response = await fetch(`${runnerBaseUrl}/api/scan-project`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ projectPath }),
  });

  return readJson<ProjectScanResult>(response);
}

export async function writeKnowledge(payload: {
  task: DeliveryTask;
  projectScan: ProjectScanResult | null;
  steps: WorkflowStep[];
  issues: DeliveryIssue[];
  validation: ValidationRunResult | null;
  markdown: string;
}): Promise<KnowledgeWriteResult> {
  const response = await fetch(`${runnerBaseUrl}/api/write-knowledge`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  return readJson<KnowledgeWriteResult>(response);
}

export async function runValidation(payload: {
  task: DeliveryTask;
  projectScan: ProjectScanResult | null;
}): Promise<ValidationRunResult> {
  const response = await fetch(`${runnerBaseUrl}/api/run-validation`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  return readJson<ValidationRunResult>(response);
}

export async function saveRunRecord(record: DeliveryRunRecord): Promise<RunRecordSaveResult> {
  const response = await fetch(`${runnerBaseUrl}/api/save-run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ record }),
  });

  return readJson<RunRecordSaveResult>(response);
}

export async function loadRunRecord(payload: {
  projectName: string;
  moduleName: string;
  runId?: string;
}): Promise<DeliveryRunRecord> {
  const params = new URLSearchParams({
    projectName: payload.projectName,
    moduleName: payload.moduleName,
  });
  if (payload.runId) {
    params.set("runId", payload.runId);
  }

  const response = await fetch(`${runnerBaseUrl}/api/load-run?${params.toString()}`);
  return readJson<DeliveryRunRecord>(response);
}

export async function listRunRecords(payload: {
  projectName: string;
  moduleName: string;
}): Promise<RunRecordListResult> {
  const params = new URLSearchParams({
    projectName: payload.projectName,
    moduleName: payload.moduleName,
  });

  const response = await fetch(`${runnerBaseUrl}/api/list-runs?${params.toString()}`);
  return readJson<RunRecordListResult>(response);
}

export async function prepareContextPackage(payload: {
  task: DeliveryTask;
  projectScan: ProjectScanResult | null;
  steps: WorkflowStep[];
  issues: DeliveryIssue[];
}): Promise<ContextPackageResult> {
  const response = await fetch(`${runnerBaseUrl}/api/prepare-context`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  return readJson<ContextPackageResult>(response);
}

export async function prepareExecutionPackage(payload: {
  task: DeliveryTask;
  projectScan: ProjectScanResult | null;
  steps: WorkflowStep[];
  issues: DeliveryIssue[];
  contextPackage: ContextPackageResult | null;
  validationRun: ValidationRunResult | null;
}): Promise<ExecutionPackageResult> {
  const response = await fetch(`${runnerBaseUrl}/api/prepare-execution-package`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  return readJson<ExecutionPackageResult>(response);
}

export async function prepareTaskPlan(payload: {
  task: DeliveryTask;
  projectScan: ProjectScanResult | null;
  steps: WorkflowStep[];
  issues: DeliveryIssue[];
  contextPackage: ContextPackageResult | null;
  executionPackage: ExecutionPackageResult | null;
  validationRun: ValidationRunResult | null;
}): Promise<TaskPlanResult> {
  const response = await fetch(`${runnerBaseUrl}/api/prepare-task-plan`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  return readJson<TaskPlanResult>(response);
}

export async function loadTaskPlan(payload: {
  task: DeliveryTask;
  projectScan: ProjectScanResult | null;
  taskPlan: TaskPlanResult | null;
}): Promise<TaskPlanResult> {
  const response = await fetch(`${runnerBaseUrl}/api/load-task-plan`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  return readJson<TaskPlanResult>(response);
}

export async function dispatchTask(payload: {
  task: DeliveryTask;
  taskPlan: TaskPlanResult;
  taskId?: string;
}): Promise<TaskDispatchResult> {
  const response = await fetch(`${runnerBaseUrl}/api/dispatch-task`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  return readJson<TaskDispatchResult>(response);
}

export async function createIssueFixTask(payload: {
  task: DeliveryTask;
  taskPlan: TaskPlanResult;
  issue: DeliveryIssue;
}): Promise<IssueFixTaskResult> {
  const response = await fetch(`${runnerBaseUrl}/api/create-issue-fix-task`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  return readJson<IssueFixTaskResult>(response);
}

export async function reviewTaskResult(payload: {
  task: DeliveryTask;
  taskPlan: TaskPlanResult;
  taskId: string;
  report: string;
}): Promise<TaskReviewResult> {
  const response = await fetch(`${runnerBaseUrl}/api/review-task-result`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  return readJson<TaskReviewResult>(response);
}

export async function finalizeDelivery(payload: {
  task: DeliveryTask;
  taskPlan: TaskPlanResult;
  issues: DeliveryIssue[];
  validationRun: ValidationRunResult | null;
  knowledgeWrite: KnowledgeWriteResult | null;
}): Promise<FinalAcceptanceResult> {
  const response = await fetch(`${runnerBaseUrl}/api/finalize-delivery`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  return readJson<FinalAcceptanceResult>(response);
}
