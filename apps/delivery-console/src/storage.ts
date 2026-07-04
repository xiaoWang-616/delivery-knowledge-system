import type { DeliveryTask, ProjectScanResult, RunLog, RuntimeState } from "./types";

const taskKey = "delivery-console:task";
const runtimeKey = "delivery-console:runtime";
const logKey = "delivery-console:logs";
const projectScanKey = "delivery-console:project-scan";
const runIdKey = "delivery-console:run-id";

export const defaultTask: DeliveryTask = {
  projectName: "",
  projectPath: "",
  moduleName: "",
  requirement: "",
  apiDocs: "",
  demos: "",
  prds: "",
  permissions: {
    allowWriteCode: true,
    allowRunCommands: true,
    allowAutoFix: true,
    allowKnowledgeWrite: true,
  },
};

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function loadTask(): DeliveryTask {
  const saved = readJson<Partial<DeliveryTask>>(taskKey, {});
  return {
    ...defaultTask,
    ...saved,
    permissions: {
      ...defaultTask.permissions,
      ...(saved.permissions || {}),
    },
  };
}

export function saveTask(task: DeliveryTask) {
  window.localStorage.setItem(taskKey, JSON.stringify(task));
}

export function loadRuntime(): RuntimeState {
  return readJson(runtimeKey, {});
}

export function saveRuntime(runtime: RuntimeState) {
  window.localStorage.setItem(runtimeKey, JSON.stringify(runtime));
}

export function loadLogs(): RunLog[] {
  return readJson(logKey, []);
}

export function saveLogs(logs: RunLog[]) {
  window.localStorage.setItem(logKey, JSON.stringify(logs));
}

export function loadProjectScan(): ProjectScanResult | null {
  return readJson<ProjectScanResult | null>(projectScanKey, null);
}

export function saveProjectScan(scan: ProjectScanResult | null) {
  if (!scan) {
    window.localStorage.removeItem(projectScanKey);
    return;
  }
  window.localStorage.setItem(projectScanKey, JSON.stringify(scan));
}

export function loadRunId(): string {
  return window.localStorage.getItem(runIdKey) || "";
}

export function saveRunId(runId: string) {
  if (!runId) {
    window.localStorage.removeItem(runIdKey);
    return;
  }
  window.localStorage.setItem(runIdKey, runId);
}

export function clearStorage() {
  window.localStorage.removeItem(taskKey);
  window.localStorage.removeItem(runtimeKey);
  window.localStorage.removeItem(logKey);
  window.localStorage.removeItem(projectScanKey);
  window.localStorage.removeItem(runIdKey);
}
