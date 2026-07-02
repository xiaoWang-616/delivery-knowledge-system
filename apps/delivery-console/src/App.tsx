import { useEffect, useMemo, useRef, useState } from "react";
import { generateDeliveryMarkdown } from "./markdown";
import {
  autoAdvanceOnce as requestAutoAdvanceOnce,
  autoRunUntilPause as requestAutoRunUntilPause,
  createIssueFixTask as requestIssueFixTask,
  dispatchTask as requestTaskDispatch,
  finalizeDelivery as requestFinalAcceptance,
  getAiAdapterStatus as requestAiAdapterStatus,
  getSystemHealth as requestSystemHealth,
  loadTaskPlan as requestTaskPlanLoad,
  listRunRecords as requestRunRecordList,
  loadRunRecord as requestRunRecordLoad,
  prepareContextPackage as requestContextPackagePrepare,
  prepareAutoDryRun as requestAutoDryRunPrepare,
  prepareExecutionPackage as requestExecutionPackagePrepare,
  prepareTaskPlan as requestTaskPlanPrepare,
  reviewTaskResult as requestTaskReview,
  runAiAdapterTask as requestAiAdapterTaskRun,
  runControlledTask as requestControlledTaskRun,
  runPageSmokeTest as requestPageSmokeTest,
  runValidation as requestValidationRun,
  saveRunRecord as requestRunRecordSave,
  scanProject as requestProjectScan,
  writeKnowledge as requestKnowledgeWrite,
} from "./runner-client";
import {
  clearStorage,
  loadProjectScan,
  defaultTask,
  loadLogs,
  loadRunId,
  loadRuntime,
  loadTask,
  saveProjectScan,
  saveLogs,
  saveRunId,
  saveRuntime,
  saveTask,
} from "./storage";
import type {
  AiAdapterStatusResult,
  AiAdapterTaskRunResult,
  AutoAdvanceResult,
  AutoDryRunResult,
  ContextPackageResult,
  ControlledTaskExecutionResult,
  DeliveryIssue,
  DeliveryRunRecord,
  DeliveryTask,
  ExecutionPackageResult,
  FinalAcceptanceResult,
  KnowledgeWriteResult,
  PageSmokeTestResult,
  PermissionKey,
  ProjectScanResult,
  RunLog,
  RunRecordListItem,
  RunRecordSaveResult,
  RuntimeState,
  StepStatus,
  SystemHealthResult,
  TaskDispatchResult,
  TaskPlanResult,
  TaskReviewResult,
  ValidationRunResult,
  WorkflowStep,
} from "./types";
import { collectIssues, evaluateWorkflow, summarizeProgress } from "./workflow";

type TabKey = "task" | "plan" | "issues" | "result";

type ExecutionDecision = {
  phase: string;
  status: StepStatus;
  owner: "用户" | "系统 AI" | "写代码 AI" | "测试" | "无需处理";
  nextAction: string;
  reason: string[];
  humanAction: string;
  systemAction: string;
  canAutoProceed: boolean;
  currentTaskId: string | null;
  blockers: string[];
};

const permissionLabels: Record<PermissionKey, { title: string; description: string }> = {
  allowWriteCode: {
    title: "允许自动写代码",
    description: "第三阶段中允许执行器进入真实项目新增或修改文件。",
  },
  allowRunCommands: {
    title: "允许自动运行命令",
    description: "允许执行 typecheck、lint、build、测试等命令。",
  },
  allowAutoFix: {
    title: "允许自动修复问题",
    description: "测试失败后，允许 AI 根据问题清单自动修复。",
  },
  allowKnowledgeWrite: {
    title: "允许自动写入知识库",
    description: "允许生成项目实例、问题卡片和规则沉淀。",
  },
};

const statusText: Record<StepStatus, string> = {
  locked: "锁定",
  pending: "待执行",
  running: "执行中",
  done: "完成",
  risk: "有风险",
  failed: "阻断",
};

const statusOrder: StepStatus[] = ["locked", "pending", "running", "done", "risk", "failed"];

const validationRunStatusText: Record<ValidationRunResult["status"], string> = {
  success: "通过",
  failed: "失败",
  partial: "部分通过",
  skipped: "跳过",
  error: "错误",
};

const commandStatusText: Record<ValidationRunResult["commands"][number]["status"], string> = {
  passed: "通过",
  failed: "失败",
  skipped: "跳过",
  timeout: "超时",
};

const runHistoryStatusText: Record<RunRecordListItem["validationStatus"] | RunRecordListItem["knowledgeStatus"], string> = {
  success: "通过",
  failed: "失败",
  partial: "部分通过",
  skipped: "跳过",
  error: "错误",
  none: "未执行",
};

const taskQueueStatusText: Record<string, string> = {
  pending: "待派发",
  assigned: "已派发",
  submitted: "已提交",
  reviewed: "已检查",
  "needs-fix": "需修复",
  done: "完成",
  blocked: "阻断",
};

function nowTime() {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

function hasText(value: string) {
  return value.trim().length > 0;
}

function lineCount(value: string) {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean).length;
}

function currentQueueTask(plan: TaskPlanResult | null) {
  if (!plan?.tasks.length) return null;
  const doneIds = new Set(plan.tasks.filter((item) => item.status === "done").map((item) => item.id));
  return (
    plan.tasks.find((item) => item.status === "assigned") ||
    plan.tasks.find((item) => item.fixOf && item.status === "pending") ||
    plan.tasks.find((item) => item.status === "pending" && item.dependsOn.every((taskId) => doneIds.has(taskId))) ||
    plan.tasks.find((item) => item.status === "needs-fix") ||
    null
  );
}

function currentFixContext(plan: TaskPlanResult | null) {
  if (!plan?.tasks.length) return null;
  const fixTask =
    plan.tasks.find((item) => item.fixOf && item.status === "assigned") ||
    plan.tasks.find((item) => item.fixOf && item.status === "pending") ||
    plan.tasks.find((item) => item.fixOf && item.status === "needs-fix") ||
    null;
  if (!fixTask) return null;
  const sourceTask = plan.tasks.find((item) => item.id === fixTask.fixOf) || null;
  return { fixTask, sourceTask };
}

function taskPlanPanelStatus(plan: TaskPlanResult | null): StepStatus {
  if (!plan?.tasks.length) return "pending";
  if (plan.tasks.some((item) => item.status === "blocked")) return "failed";
  if (plan.tasks.some((item) => item.status === "needs-fix")) return "risk";
  if (plan.tasks.every((item) => item.status === "done")) return "done";
  if (plan.tasks.some((item) => item.status === "assigned" || item.status === "submitted" || item.status === "reviewed")) return "running";
  return "pending";
}

function reviewPanelStatus(review: TaskReviewResult | null): StepStatus {
  if (!review) return "pending";
  if (review.decision === "approved") return "done";
  if (review.decision === "blocked") return "failed";
  return "risk";
}

function validationPanelStatus(result: ValidationRunResult | null): StepStatus {
  if (!result) return "pending";
  if (result.status === "success") return "done";
  if (result.status === "error" || result.status === "failed") return "failed";
  return "risk";
}

function pageSmokePanelStatus(result: PageSmokeTestResult | null): StepStatus {
  if (!result) return "pending";
  if (result.status === "success" || result.status === "skipped") return "done";
  if (result.status === "failed" || result.status === "error") return "failed";
  return "risk";
}

function knowledgePanelStatus(result: KnowledgeWriteResult | null): StepStatus {
  if (!result) return "pending";
  return result.status === "success" ? "done" : "failed";
}

function finalPanelStatus(result: FinalAcceptanceResult | null): StepStatus {
  if (!result) return "pending";
  if (result.status === "success") return "done";
  if (result.status === "blocked" || result.status === "error") return "failed";
  return "risk";
}

function aiAdapterModeLabel(status: AiAdapterStatusResult | null) {
  if (!status) return "未检查";
  if (status.provider === "command") return status.canAutoRun ? "本地命令自动执行" : "本地命令未配置";
  if (status.provider === "mock") return "可自动测试";
  if (status.provider === "disabled") return "已禁用";
  return "需手工交接";
}

function mergeDeliveryIssues(...issueGroups: DeliveryIssue[][]) {
  const merged = new Map<string, DeliveryIssue>();
  for (const issue of issueGroups.flat()) {
    if (!merged.has(issue.id)) {
      merged.set(issue.id, issue);
    }
  }
  return Array.from(merged.values());
}

function runtimeIssue(
  id: string,
  level: DeliveryIssue["level"],
  title: string,
  description: string,
  owner: DeliveryIssue["owner"],
  canContinue: boolean,
): DeliveryIssue {
  return { id, level, title, description, owner, canContinue };
}

function deliveryRuntimeIssues({
  reviewResult,
  pageSmoke,
  validationRun,
  knowledgeWrite,
  finalAcceptance,
}: {
  reviewResult: TaskReviewResult | null;
  pageSmoke: PageSmokeTestResult | null;
  validationRun: ValidationRunResult | null;
  knowledgeWrite: KnowledgeWriteResult | null;
  finalAcceptance: FinalAcceptanceResult | null;
}) {
  const runtimeIssues: DeliveryIssue[] = [];

  if (reviewResult && reviewResult.decision !== "approved") {
    runtimeIssues.push(
      runtimeIssue(
        `REVIEW-${reviewResult.taskId}`,
        reviewResult.decision === "blocked" ? "P0" : "P1",
        `系统 review 未通过：${reviewResult.taskId}`,
        reviewResult.findings.length ? reviewResult.findings.join("；") : reviewResult.summary,
        "AI",
        reviewResult.decision !== "blocked",
      ),
    );
  }

  if (reviewResult?.outOfScopeFiles.length) {
    runtimeIssues.push(
      runtimeIssue(
        `REVIEW-SCOPE-${reviewResult.taskId}`,
        "P1",
        "任务改动越界",
        `以下文件不在当前任务 allowedFiles 内：${reviewResult.outOfScopeFiles.join("、")}。需要生成或执行修复任务。`,
        "AI",
        true,
      ),
    );
  }

  if (validationRun && validationRun.status !== "success" && validationRun.status !== "skipped") {
    const failedCommands = validationRun.commands.filter((item) => item.status === "failed" || item.status === "timeout");
    runtimeIssues.push(
      runtimeIssue(
        "VALIDATION-COMMANDS",
        validationRun.status === "error" ? "P0" : "P1",
        "命令验收未通过",
        failedCommands.length
          ? failedCommands.map((item) => `${item.name}：${commandStatusText[item.status]}`).join("；")
          : validationRun.summary,
        "测试",
        validationRun.status !== "error",
      ),
    );
  }

  if (pageSmoke && pageSmoke.status !== "success" && pageSmoke.status !== "skipped") {
    runtimeIssues.push(
      runtimeIssue(
        "PAGE-SMOKE",
        pageSmoke.status === "error" || pageSmoke.status === "failed" ? "P1" : "P2",
        "轻量页面点测未完全通过",
        pageSmoke.summary,
        "测试",
        true,
      ),
    );
  }

  if (knowledgeWrite && knowledgeWrite.status !== "success") {
    runtimeIssues.push(
      runtimeIssue("KNOWLEDGE-WRITE", "P1", "知识库写入失败", knowledgeWrite.summary, "AI", true),
    );
  }

  if (finalAcceptance && finalAcceptance.status !== "success") {
    runtimeIssues.push(
      runtimeIssue(
        "FINAL-ACCEPTANCE",
        finalAcceptance.status === "blocked" || finalAcceptance.status === "error" ? "P0" : "P1",
        "总验收未完全通过",
        finalAcceptance.findings.length ? finalAcceptance.findings.join("；") : finalAcceptance.summary,
        "AI",
        finalAcceptance.status === "warning",
      ),
    );
  }

  return runtimeIssues;
}

function issueRuleSuggestions(issues: DeliveryIssue[]) {
  const suggestions = new Set<string>();
  if (issues.some((item) => item.id.startsWith("REVIEW-SCOPE"))) {
    suggestions.add("写代码 AI 每次只能修改当前 task 的 allowedFiles，越界必须回到系统 AI 重新拆任务。");
  }
  if (issues.some((item) => item.id.startsWith("REVIEW-"))) {
    suggestions.add("review 失败要先生成并完成 fix task，再派发后续任务。");
  }
  if (issues.some((item) => item.id === "VALIDATION-COMMANDS")) {
    suggestions.add("命令验收失败要沉淀失败命令、失败原因和修复任务，不要跳过 typecheck/lint/build。");
  }
  if (issues.some((item) => item.id === "PAGE-SMOKE")) {
    suggestions.add("页面点测失败先沉淀 URL、缺失关键词和错误文本，再生成修复任务，避免凭感觉改页面。");
  }
  if (issues.some((item) => item.id === "KNOWLEDGE-WRITE")) {
    suggestions.add("知识库写入失败不影响代码修复，但不能视为交付闭环完成。");
  }
  if (issues.some((item) => item.owner === "后端")) {
    suggestions.add("接口能力缺失或字段不清晰时记录后端问题，不在前端猜参数。");
  }
  return Array.from(suggestions);
}

function deliveryNextAction({
  taskPlan,
  pageSmoke,
  validationRun,
  knowledgeWrite,
  finalAcceptance,
}: {
  taskPlan: TaskPlanResult | null;
  pageSmoke: PageSmokeTestResult | null;
  validationRun: ValidationRunResult | null;
  knowledgeWrite: KnowledgeWriteResult | null;
  finalAcceptance: FinalAcceptanceResult | null;
}) {
  if (!taskPlan) return "先生成设计与任务队列。";
  const currentTask = currentQueueTask(taskPlan);
  if (currentTask?.fixOf && currentTask.status === "pending") return `优先复制修复任务 ${currentTask.id} prompt 给写代码 AI。`;
  if (currentTask?.fixOf && currentTask.status === "assigned") return `等待写代码 AI 回填修复任务 ${currentTask.id} 完成报告。`;
  if (currentTask?.status === "needs-fix") return `处理 ${currentTask.id} 的修复任务。`;
  if (currentTask?.status === "assigned") return `等待写代码 AI 回填 ${currentTask.id} 完成报告并提交系统 review。`;
  if (currentTask?.status === "pending") return `复制 ${currentTask.id} prompt 给写代码 AI。`;
  if (taskPlan.tasks.some((item) => item.status === "blocked")) return "存在阻断任务，先看 review 和问题记录。";
  if (!taskPlan.tasks.every((item) => item.status === "done")) return "继续派发下一个可执行任务。";
  if (!validationRun) return "任务队列已完成，下一步执行命令验收。";
  if (validationRun.status !== "success") return "命令验收未通过，先根据失败命令生成修复任务。";
  if (!pageSmoke) return "命令验收已通过，下一步执行轻量页面点测。";
  if (pageSmoke.status === "failed" || pageSmoke.status === "error") return "页面点测未通过，先记录问题并生成修复任务。";
  if (knowledgeWrite?.status !== "success") return "命令验收已通过，下一步写入知识库。";
  if (!finalAcceptance) return "知识沉淀已完成，下一步生成总验收。";
  if (finalAcceptance.status === "success") return "交付闭环已完成，可以提交代码或进入下一个模块。";
  return "总验收仍有风险，先处理验收发现。";
}

function buildExecutionDecision({
  task,
  taskPlan,
  taskDispatch,
  taskReview,
  aiAdapterStatus,
  controlledExecution,
  pageSmoke,
  validationRun,
  knowledgeWrite,
  finalAcceptance,
  issues,
}: {
  task: DeliveryTask;
  taskPlan: TaskPlanResult | null;
  taskDispatch: TaskDispatchResult | null;
  taskReview: TaskReviewResult | null;
  aiAdapterStatus: AiAdapterStatusResult | null;
  controlledExecution: ControlledTaskExecutionResult | null;
  pageSmoke: PageSmokeTestResult | null;
  validationRun: ValidationRunResult | null;
  knowledgeWrite: KnowledgeWriteResult | null;
  finalAcceptance: FinalAcceptanceResult | null;
  issues: DeliveryIssue[];
}): ExecutionDecision {
  const p0Blockers = issues.filter((item) => item.level === "P0" && !item.canContinue);
  if (p0Blockers.length) {
    return {
      phase: "阻断确认",
      status: "failed",
      owner: "用户",
      nextAction: "先处理不可继续的 P0 问题，再恢复自动交付。",
      reason: p0Blockers.map((item) => `${item.id}：${item.title}`),
      humanAction: "确认阻断问题的真实原因，补充接口、权限、需求或项目环境信息。",
      systemAction: "暂停派发新任务，只保留问题池和修复任务入口。",
      canAutoProceed: false,
      currentTaskId: null,
      blockers: p0Blockers.map((item) => item.title),
    };
  }

  if (!hasText(task.projectName) || !hasText(task.projectPath) || !hasText(task.moduleName) || !hasText(task.requirement)) {
    return {
      phase: "资料补齐",
      status: "pending",
      owner: "用户",
      nextAction: "先补齐项目名称、真实项目路径、模块名称和需求说明。",
      reason: ["任务包的基础信息还不完整，系统 AI 不能稳定生成设计与任务队列。"],
      humanAction: "补齐一次性任务包，并尽量提供接口文档、Demo、旧项目和 PRD。",
      systemAction: "等待资料完整后扫描项目并生成上下文。",
      canAutoProceed: false,
      currentTaskId: null,
      blockers: [],
    };
  }

  if (!taskPlan?.tasks.length) {
    return {
      phase: "生成设计",
      status: "pending",
      owner: "系统 AI",
      nextAction: "生成 AI 上下文包、交付执行包和设计与任务队列。",
      reason: ["还没有 task-queue，写代码 AI 不应该直接开始写完整模块。"],
      humanAction: "确认资料路径有效，必要时先点击扫描项目。",
      systemAction: "读取资料并拆成小任务，每个任务带 allowedFiles 和验收标准。",
      canAutoProceed: true,
      currentTaskId: null,
      blockers: [],
    };
  }

  if (controlledExecution?.status === "manual-required") {
    return {
      phase: "等待手工交接",
      status: "running",
      owner: "用户",
      nextAction: `把 ${controlledExecution.taskId} prompt 交给写代码 AI，并回填完成报告。`,
      reason: [controlledExecution.summary],
      humanAction: "复制受控执行生成的 prompt 给写代码 AI，拿到报告后提交系统 review。",
      systemAction: "保留执行锁、adapter 输出和 git diff 检查上下文。",
      canAutoProceed: false,
      currentTaskId: controlledExecution.taskId,
      blockers: [],
    };
  }

  const currentTask = currentQueueTask(taskPlan);
  if (taskPlan.tasks.some((item) => item.status === "blocked")) {
    return {
      phase: "任务阻断",
      status: "failed",
      owner: "用户",
      nextAction: "先查看 blocked 任务的 review 和问题记录。",
      reason: ["任务队列里已有 blocked 状态，继续派发后续任务会扩大风险。"],
      humanAction: "确认 blocked 原因，决定补资料、改接口、还是生成修复任务。",
      systemAction: "保留当前队列状态，不自动推进后续任务。",
      canAutoProceed: false,
      currentTaskId: currentTask?.id || null,
      blockers: taskPlan.tasks.filter((item) => item.status === "blocked").map((item) => `${item.id} ${item.title}`),
    };
  }

  if (currentTask?.fixOf) {
    return {
      phase: "修复优先",
      status: currentTask.status === "assigned" ? "running" : "risk",
      owner: currentTask.status === "assigned" ? "写代码 AI" : "系统 AI",
      nextAction:
        currentTask.status === "assigned"
          ? `等待写代码 AI 回填修复任务 ${currentTask.id} 完成报告。`
          : `优先派发修复任务 ${currentTask.id}。`,
      reason: [`${currentTask.id} 是 ${currentTask.fixOf} 的修复任务，必须先完成它再继续后续任务。`],
      humanAction: currentTask.status === "assigned" ? "把写代码 AI 的完成报告贴回系统。" : "复制修复任务 prompt 给写代码 AI，或使用受控执行。",
      systemAction: "review 修复报告，检查 git diff 是否仍在 allowedFiles 内。",
      canAutoProceed: currentTask.status !== "assigned",
      currentTaskId: currentTask.id,
      blockers: [],
    };
  }

  if (currentTask?.status === "assigned") {
    return {
      phase: "等待报告",
      status: "running",
      owner: "写代码 AI",
      nextAction: `等待写代码 AI 回填 ${currentTask.id} 完成报告，然后提交系统 review。`,
      reason: [taskDispatch?.taskId === currentTask.id ? "当前任务已派发 prompt。" : "任务队列显示当前任务处于 assigned 状态。"],
      humanAction: "收集写代码 AI 的完成报告，包含改动文件、完成内容、命令结果、未完成内容和新增问题。",
      systemAction: "收到报告后执行轻量 review 和 allowedFiles 检查。",
      canAutoProceed: false,
      currentTaskId: currentTask.id,
      blockers: [],
    };
  }

  if (currentTask?.status === "needs-fix") {
    return {
      phase: "生成修复",
      status: "risk",
      owner: "系统 AI",
      nextAction: `为 ${currentTask.id} 生成或派发修复任务。`,
      reason: [taskReview?.summary || "最近一次 review 未通过，需要先修复再继续。"],
      humanAction: "确认 review 发现是否准确；若准确，继续修复任务。",
      systemAction: "把 review 发现转成 fix task，并限制修复范围。",
      canAutoProceed: true,
      currentTaskId: currentTask.id,
      blockers: [],
    };
  }

  if (currentTask?.status === "pending") {
    const canUseAdapter = aiAdapterStatus?.canAutoRun || aiAdapterStatus?.provider === "mock";
    return {
      phase: "派发任务",
      status: "pending",
      owner: "系统 AI",
      nextAction: canUseAdapter ? `受控执行当前任务 ${currentTask.id}。` : `复制 ${currentTask.id} prompt 给写代码 AI。`,
      reason: [`${currentTask.id} 的依赖已满足，可以成为当前唯一执行任务。`],
      humanAction: canUseAdapter ? "确认允许自动写代码和运行命令。" : "把当前 task prompt 交给写代码 AI。",
      systemAction: canUseAdapter ? "锁定当前任务，调用 AI adapter，完成后 review。" : "记录派发基线，等待报告回填。",
      canAutoProceed: Boolean(canUseAdapter && task.permissions.allowWriteCode),
      currentTaskId: currentTask.id,
      blockers: [],
    };
  }

  const allTasksDone = taskPlan.tasks.length > 0 && taskPlan.tasks.every((item) => item.status === "done");
  if (!allTasksDone) {
    return {
      phase: "等待依赖",
      status: "running",
      owner: "系统 AI",
      nextAction: "继续检查任务依赖，等待下一个可派发任务出现。",
      reason: ["当前没有可派发任务，但任务队列还没有全部完成。"],
      humanAction: "检查任务依赖是否合理，必要时重新生成任务队列。",
      systemAction: "保持队列状态，不越过依赖执行。",
      canAutoProceed: false,
      currentTaskId: null,
      blockers: [],
    };
  }

  if (!validationRun) {
    return {
      phase: "命令验收",
      status: "pending",
      owner: "测试",
      nextAction: "执行命令验收：typecheck / lint / build。",
      reason: ["任务队列已完成，但还没有命令级验证。"],
      humanAction: "确认允许运行目标项目已有脚本。",
      systemAction: "只运行 package.json 中声明的受控脚本并记录结果。",
      canAutoProceed: task.permissions.allowRunCommands,
      currentTaskId: null,
      blockers: [],
    };
  }

  if (validationRun.status !== "success") {
    return {
      phase: "命令修复",
      status: "risk",
      owner: "系统 AI",
      nextAction: "根据命令验收失败结果生成修复任务。",
      reason: [validationRun.summary],
      humanAction: "确认失败命令是否来自真实代码问题、依赖缺失还是环境问题。",
      systemAction: "把失败命令和输出沉淀到问题池，并转成修复任务。",
      canAutoProceed: task.permissions.allowAutoFix,
      currentTaskId: null,
      blockers: [],
    };
  }

  if (!pageSmoke) {
    return {
      phase: "页面点测",
      status: "pending",
      owner: "测试",
      nextAction: "执行轻量页面点测。",
      reason: ["命令验收已通过，但页面 URL、关键词和明显错误文本还没有检查。"],
      humanAction: "确认任务包里的页面点测 URL 和关键词是否准确。",
      systemAction: "请求页面并检查 HTTP、标题、关键词和常见错误文本。",
      canAutoProceed: Boolean(task.pageUrl && task.permissions.allowRunCommands),
      currentTaskId: null,
      blockers: [],
    };
  }

  if (pageSmoke.status === "failed" || pageSmoke.status === "error") {
    return {
      phase: "页面修复",
      status: "risk",
      owner: "系统 AI",
      nextAction: "根据页面点测失败结果生成修复任务。",
      reason: [pageSmoke.summary],
      humanAction: "确认缺失关键词是否为真实问题，或更新点测关键词。",
      systemAction: "把 URL、HTTP 状态、缺失关键词和错误文本沉淀到问题池。",
      canAutoProceed: task.permissions.allowAutoFix,
      currentTaskId: null,
      blockers: [],
    };
  }

  if (knowledgeWrite?.status !== "success") {
    return {
      phase: "知识沉淀",
      status: knowledgeWrite ? "risk" : "pending",
      owner: "系统 AI",
      nextAction: "写入知识库，沉淀项目实例、问题和验收记录。",
      reason: [knowledgeWrite?.summary || "任务、命令和页面点测已有结果，但知识库还没有完整记录。"],
      humanAction: "确认允许写入知识库目录。",
      systemAction: "写入模块资料包、问题追踪、测试用例、验收报告和交付报告。",
      canAutoProceed: task.permissions.allowKnowledgeWrite,
      currentTaskId: null,
      blockers: [],
    };
  }

  if (!finalAcceptance) {
    return {
      phase: "总验收",
      status: "pending",
      owner: "系统 AI",
      nextAction: "生成总验收和规则沉淀候选。",
      reason: ["任务、命令、页面点测和知识沉淀已有结果，但还没有最终收口文件。"],
      humanAction: "确认问题池中是否有需要人工解释的问题。",
      systemAction: "生成 final-acceptance.auto.md 和规则沉淀候选.auto.md。",
      canAutoProceed: true,
      currentTaskId: null,
      blockers: [],
    };
  }

  if (finalAcceptance.status === "success") {
    return {
      phase: "交付完成",
      status: "done",
      owner: "无需处理",
      nextAction: "当前模块交付闭环完成，可以提交代码或进入下一个模块。",
      reason: [finalAcceptance.summary],
      humanAction: "人工最终确认后提交代码。",
      systemAction: "保留运行记录和知识沉淀，等待新模块任务。",
      canAutoProceed: false,
      currentTaskId: null,
      blockers: [],
    };
  }

  return {
    phase: "验收风险",
    status: "risk",
    owner: "用户",
    nextAction: "先处理总验收发现，再决定是否修复或人工放行。",
    reason: finalAcceptance.findings.length ? finalAcceptance.findings : [finalAcceptance.summary],
    humanAction: "逐条确认验收发现，必要时转成修复任务。",
    systemAction: "保留规则候选和验收记录，等待人工确认。",
    canAutoProceed: false,
    currentTaskId: null,
    blockers: [],
  };
}

function createRunId() {
  const stamp = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15);
  return `run-${stamp}-${Math.random().toString(16).slice(2, 8)}`;
}

function formatDateTime(value: string) {
  if (!value) return "未知时间";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function createLog(message: string, level: RunLog["level"] = "info"): RunLog {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    message,
    level,
    createdAt: nowTime(),
  };
}

function FieldLabel({ title, hint }: { title: string; hint?: string }) {
  return (
    <label className="field-label">
      <span>{title}</span>
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return <input className="text-input" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />;
}

function TextArea({
  value,
  onChange,
  placeholder,
  rows = 4,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <textarea
      className="text-area"
      value={value}
      rows={rows}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
    />
  );
}

function StatusBadge({ status }: { status: StepStatus }) {
  return <span className={`status-badge status-${status}`}>{statusText[status]}</span>;
}

function StepCard({ step, index }: { step: WorkflowStep; index: number }) {
  return (
    <article className={`step-card step-${step.status}`}>
      <div className="step-card-head">
        <span className="step-index">{String(index + 1).padStart(2, "0")}</span>
        <StatusBadge status={step.status} />
      </div>
      <h3>{step.title}</h3>
      <p>{step.description}</p>
      <dl>
        <div>
          <dt>依赖</dt>
          <dd>{step.dependsOn.length ? step.dependsOn.join(" / ") : "无"}</dd>
        </div>
        <div>
          <dt>输出</dt>
          <dd>{step.output}</dd>
        </div>
      </dl>
      {step.issues.length > 0 ? (
        <ul className="mini-issue-list">
          {step.issues.map((item) => (
            <li key={item.id}>
              <strong>{item.level}</strong>
              <span>{item.title}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

function DependencyRows({ steps }: { steps: WorkflowStep[] }) {
  return (
    <div className="dependency-list">
      {steps.map((step) => (
        <div className="dependency-row" key={step.id}>
          <span className="dependency-title">{step.title}</span>
          <span className="dependency-line">{step.dependsOn.length ? step.dependsOn.join(" -> ") : "入口节点"}</span>
          <StatusBadge status={step.status} />
        </div>
      ))}
    </div>
  );
}

function ProjectScanPanel({ scan }: { scan: ProjectScanResult | null }) {
  if (!scan) {
    return (
      <section className="flat-panel scan-panel">
        <h2>项目画像</h2>
        <p className="empty-text">还没有扫描真实项目。填写项目路径后点击“扫描项目”，这里会显示技术栈、关键目录、规则文件和脚本。</p>
      </section>
    );
  }

  return (
    <section className="flat-panel scan-panel">
      <div className="scan-head">
        <div>
          <h2>项目画像</h2>
          <p>{scan.summary}</p>
        </div>
        <StatusBadge status={scan.status === "success" ? (scan.warnings.length ? "risk" : "done") : "failed"} />
      </div>

      <div className="scan-grid">
        <div>
          <span>项目名</span>
          <strong>{scan.projectName || "未识别"}</strong>
        </div>
        <div>
          <span>包管理器</span>
          <strong>{scan.packageManager}</strong>
        </div>
        <div>
          <span>技术栈</span>
          <strong>{scan.frameworks.length ? scan.frameworks.join(" / ") : "待确认"}</strong>
        </div>
        <div>
          <span>规则文件</span>
          <strong>{scan.ruleFiles.length ? `${scan.ruleFiles.length} 个` : "未发现"}</strong>
        </div>
      </div>

      <div className="scan-columns">
        <div>
          <h3>关键目录</h3>
          <p>{scan.keyDirectories.length ? scan.keyDirectories.join("、") : "未识别"}</p>
        </div>
        <div>
          <h3>关键文件</h3>
          <p>{scan.keyFiles.length ? scan.keyFiles.join("、") : "未识别"}</p>
        </div>
        <div>
          <h3>可用脚本</h3>
          <p>{Object.keys(scan.scripts).length ? Object.keys(scan.scripts).join("、") : "未识别"}</p>
        </div>
        <div>
          <h3>环境文件</h3>
          <p>{scan.envFiles.length ? scan.envFiles.join("、") : "未发现"}</p>
        </div>
      </div>

      {scan.warnings.length ? (
        <ul className="scan-warnings">
          {scan.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function KnowledgeWritePanel({ result }: { result: KnowledgeWriteResult | null }) {
  if (!result) {
    return (
      <section className="flat-panel write-panel">
        <h2>知识库写入结果</h2>
        <p className="empty-text">还没有写入知识库。生成任务包和项目画像后，可点击“写入知识库”。</p>
      </section>
    );
  }

  return (
    <section className="flat-panel write-panel">
      <div className="scan-head">
        <div>
          <h2>知识库写入结果</h2>
          <p>{result.summary}</p>
        </div>
        <StatusBadge status={result.status === "success" ? "done" : "failed"} />
      </div>
      <div className="path-list">
        {result.writtenFiles.map((filePath) => (
          <code key={filePath}>{filePath}</code>
        ))}
      </div>
    </section>
  );
}

function ContextPackagePanel({ result }: { result: ContextPackageResult | null }) {
  if (!result) {
    return (
      <section className="flat-panel context-panel">
        <h2>AI 上下文包</h2>
        <p className="empty-text">还没有生成 AI 上下文包。点击“生成 AI 上下文包”后，runner 会读取本地资料并生成给 AI 使用的 Markdown 文件。</p>
      </section>
    );
  }

  return (
    <section className="flat-panel context-panel">
      <div className="scan-head">
        <div>
          <h2>AI 上下文包</h2>
          <p>{result.summary}</p>
        </div>
        <StatusBadge status={result.status === "success" ? "done" : "failed"} />
      </div>
      <div className="context-source-list">
        {result.sources.map((source) => (
          <article className={`context-source context-${source.status}`} key={`${source.type}-${source.source}`}>
            <strong>{source.type}</strong>
            <span>{source.status}</span>
            <p>{source.source}</p>
            <small>
              文件 {source.fileCount} 个 · 字符 {source.charCount} · {source.summary}
            </small>
          </article>
        ))}
      </div>
      <div className="path-list">
        {result.writtenFiles.map((filePath) => (
          <code key={filePath}>{filePath}</code>
        ))}
      </div>
    </section>
  );
}

function ExecutionPackagePanel({ result }: { result: ExecutionPackageResult | null }) {
  if (!result) {
    return (
      <section className="flat-panel execution-panel">
        <h2>AI 交付执行包</h2>
        <p className="empty-text">还没有生成 AI 交付执行包。生成上下文包后，可点击“生成 AI 交付执行包”，得到可交给 AI 直接执行的任务目录。</p>
      </section>
    );
  }

  return (
    <section className="flat-panel execution-panel">
      <div className="scan-head">
        <div>
          <h2>AI 交付执行包</h2>
          <p>{result.summary}</p>
        </div>
        <StatusBadge status={result.status === "success" ? "done" : "failed"} />
      </div>
      <div className="execution-meta">
        <span>目录：{result.packageDirectory || "未生成"}</span>
        <span>文件：{result.writtenFiles.length} 个</span>
        <span>时间：{new Date(result.generatedAt).toLocaleString("zh-CN", { hour12: false })}</span>
      </div>
      <div className="path-list">
        {result.writtenFiles.map((filePath) => (
          <code key={filePath}>{filePath}</code>
        ))}
      </div>
    </section>
  );
}

function DeliveryControlPanel({
  taskPlan,
  reviewResult,
  pageSmoke,
  validationRun,
  knowledgeWrite,
  finalAcceptance,
}: {
  taskPlan: TaskPlanResult | null;
  reviewResult: TaskReviewResult | null;
  pageSmoke: PageSmokeTestResult | null;
  validationRun: ValidationRunResult | null;
  knowledgeWrite: KnowledgeWriteResult | null;
  finalAcceptance: FinalAcceptanceResult | null;
}) {
  const currentTask = currentQueueTask(taskPlan);
  const doneTasks = taskPlan?.tasks.filter((item) => item.status === "done").length || 0;
  const totalTasks = taskPlan?.tasks.length || 0;
  const hasOutOfScopeFiles = Boolean(reviewResult?.outOfScopeFiles.length);
  const cards: Array<{ title: string; status: StepStatus; meta: string; detail: string }> = [
    {
      title: "任务队列",
      status: taskPlanPanelStatus(taskPlan),
      meta: totalTasks ? `${doneTasks}/${totalTasks} 已完成` : "未生成",
      detail: currentTask ? `${currentTask.id} ${currentTask.title}` : totalTasks ? "暂无待派发任务" : "等待生成 design 和任务队列",
    },
    {
      title: "系统 review",
      status: hasOutOfScopeFiles ? "risk" : reviewPanelStatus(reviewResult),
      meta: reviewResult ? `结论：${reviewResult.decision}` : "未执行",
      detail: hasOutOfScopeFiles ? `越界文件 ${reviewResult?.outOfScopeFiles.length} 个` : reviewResult?.summary || "等待写代码 AI 完成报告",
    },
    {
      title: "命令验收",
      status: validationPanelStatus(validationRun),
      meta: validationRun ? validationRunStatusText[validationRun.status] : "未执行",
      detail: validationRun?.summary || "等待执行 typecheck / lint / build",
    },
    {
      title: "页面点测",
      status: pageSmokePanelStatus(pageSmoke),
      meta: pageSmoke ? pageSmoke.status : "未执行",
      detail: pageSmoke?.summary || "等待轻量检查页面 URL、标题、关键词和错误文本",
    },
    {
      title: "知识沉淀",
      status: knowledgePanelStatus(knowledgeWrite),
      meta: knowledgeWrite?.status === "success" ? "已写入" : knowledgeWrite ? "写入失败" : "未写入",
      detail: knowledgeWrite?.summary || "等待写入项目实例和模块资料",
    },
    {
      title: "总验收",
      status: finalPanelStatus(finalAcceptance),
      meta: finalAcceptance ? finalAcceptance.status : "未生成",
      detail: finalAcceptance?.summary || "等待任务、命令验收和知识沉淀收口",
    },
  ];

  return (
    <section className="flat-panel delivery-control-panel">
      <div className="scan-head">
        <div>
          <h2>交付总览</h2>
          <p>系统 AI 用这个面板判断当前应该继续派任务、生成修复任务，还是进入命令验收和知识沉淀。</p>
        </div>
      </div>
      <div className="delivery-next-action">
        <span>下一步</span>
        <strong>{deliveryNextAction({ taskPlan, pageSmoke, validationRun, knowledgeWrite, finalAcceptance })}</strong>
      </div>
      <div className="delivery-control-grid">
        {cards.map((card) => (
          <article className={`delivery-control-card control-${card.status}`} key={card.title}>
            <div>
              <strong>{card.title}</strong>
              <StatusBadge status={card.status} />
            </div>
            <span>{card.meta}</span>
            <p>{card.detail}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function ExecutionDecisionPanel({ decision }: { decision: ExecutionDecision }) {
  return (
    <section className={`flat-panel execution-decision-panel decision-${decision.status}`}>
      <div className="scan-head">
        <div>
          <h2>执行决策</h2>
          <p>系统 AI 用这个面板判断当前阶段、下一步动作、责任方和能否自动推进。</p>
        </div>
        <StatusBadge status={decision.status} />
      </div>

      <div className="decision-hero">
        <div>
          <span>当前阶段</span>
          <strong>{decision.phase}</strong>
          {decision.currentTaskId ? <small>当前任务：{decision.currentTaskId}</small> : <small>当前任务：无</small>}
        </div>
        <div>
          <span>下一步</span>
          <strong>{decision.nextAction}</strong>
          <small>责任方：{decision.owner}</small>
        </div>
        <div>
          <span>自动推进</span>
          <strong>{decision.canAutoProceed ? "可以" : "不建议"}</strong>
          <small>{decision.canAutoProceed ? "满足授权或可由系统触发" : "需要人工输入、确认或等待报告"}</small>
        </div>
      </div>

      <div className="decision-grid">
        <article>
          <h3>判断依据</h3>
          <ul>
            {decision.reason.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </article>
        <article>
          <h3>人要做</h3>
          <p>{decision.humanAction}</p>
        </article>
        <article>
          <h3>系统做</h3>
          <p>{decision.systemAction}</p>
        </article>
      </div>

      {decision.blockers.length ? (
        <div className="decision-blockers">
          <strong>阻断项</strong>
          {decision.blockers.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function IssueTable({
  issues,
  taskPlan,
  creatingIssueFixId,
  onCreateIssueFix,
}: {
  issues: DeliveryIssue[];
  taskPlan: TaskPlanResult | null;
  creatingIssueFixId: string | null;
  onCreateIssueFix: (issue: DeliveryIssue) => void;
}) {
  if (!issues.length) {
    return <p className="empty-text">暂无问题。</p>;
  }

  return (
    <div className="issue-table">
      {issues.map((item) => (
        <div className="issue-row" key={item.id}>
          <strong>{item.level}</strong>
          <span>{item.title}</span>
          <small>{item.description}</small>
          <button
            className="issue-fix-button"
            onClick={() => onCreateIssueFix(item)}
            disabled={!taskPlan || creatingIssueFixId === item.id}
          >
            {creatingIssueFixId === item.id ? "生成中" : "生成修复任务"}
          </button>
        </div>
      ))}
    </div>
  );
}

function TaskPlanPanel({
  result,
  autoDryRun,
  aiAdapterStatus,
  aiAdapterRun,
  controlledExecution,
  dispatchedPrompt,
  report,
  reviewResult,
  dispatching,
  reviewing,
  preparingAutoDryRun,
  checkingAiAdapter,
  runningAiAdapter,
  runningControlledTask,
  onPrepareAutoDryRun,
  onCheckAiAdapter,
  onRunAiAdapter,
  onRunControlledTask,
  onDispatch,
  onReportChange,
  onReview,
}: {
  result: TaskPlanResult | null;
  autoDryRun: AutoDryRunResult | null;
  aiAdapterStatus: AiAdapterStatusResult | null;
  aiAdapterRun: AiAdapterTaskRunResult | null;
  controlledExecution: ControlledTaskExecutionResult | null;
  dispatchedPrompt: TaskDispatchResult | null;
  report: string;
  reviewResult: TaskReviewResult | null;
  dispatching: boolean;
  reviewing: boolean;
  preparingAutoDryRun: boolean;
  checkingAiAdapter: boolean;
  runningAiAdapter: boolean;
  runningControlledTask: boolean;
  onPrepareAutoDryRun: () => void;
  onCheckAiAdapter: () => void;
  onRunAiAdapter: () => void;
  onRunControlledTask: () => void;
  onDispatch: () => void;
  onReportChange: (value: string) => void;
  onReview: () => void;
}) {
  if (!result) {
    return (
      <section className="flat-panel task-plan-panel">
        <h2>设计与任务队列</h2>
        <p className="empty-text">还没有生成设计与任务队列。它会把大模块拆成多个可单独派发给写代码 AI 的小任务。</p>
      </section>
    );
  }

  const currentTask = currentQueueTask(result);
  const fixContext = currentFixContext(result);
  const finishedCount = result.tasks.filter((item) => item.status === "done").length;
  const canDispatchCurrentTask = Boolean(currentTask && (currentTask.status === "pending" || currentTask.status === "assigned"));
  const canRunAiAdapter = Boolean(currentTask && (currentTask.status === "pending" || currentTask.status === "assigned"));
  const canReviewCurrentTask = Boolean(currentTask && currentTask.status === "assigned" && report.trim());

  return (
    <section className="flat-panel task-plan-panel">
      <div className="scan-head">
        <div>
          <h2>设计与任务队列</h2>
          <p>{result.summary}</p>
        </div>
        <div className="panel-actions">
          <button className="secondary-button" onClick={onPrepareAutoDryRun} disabled={preparingAutoDryRun}>
            {preparingAutoDryRun ? "生成中" : "生成自动执行干跑"}
          </button>
          <StatusBadge status={result.status === "success" ? "done" : "failed"} />
        </div>
      </div>
      <div className="execution-meta">
        <span>目录：{result.planDirectory || "未生成"}</span>
        <span>任务：{result.tasks.length} 个</span>
        <span>完成：{finishedCount}/{result.tasks.length}</span>
        <span>文件：{result.writtenFiles.length} 个</span>
      </div>

      <div className="task-dispatch-panel">
        <div>
          <span>当前任务</span>
          <strong>{currentTask ? `${currentTask.id} ${currentTask.title}` : "暂无可派发任务"}</strong>
          <small>{currentTask?.goal || "所有任务已完成，或当前存在阻断任务。"}</small>
        </div>
        <button className="primary-button" onClick={onDispatch} disabled={!canDispatchCurrentTask || dispatching}>
          {dispatching ? "派发中" : "复制当前任务 prompt"}
        </button>
      </div>

      {fixContext ? (
        <div className="fix-task-callout">
          <div>
            <span>修复任务优先</span>
            <strong>
              {fixContext.fixTask.id} 修复 {fixContext.sourceTask?.id || fixContext.fixTask.fixOf}
            </strong>
            <small>
              上一个任务 review 未通过，当前应先派发并完成这个修复任务。修复任务通过后，原任务会一起标记完成。
            </small>
          </div>
          <code>{fixContext.fixTask.promptFile}</code>
        </div>
      ) : null}

      {autoDryRun ? (
        <div className={`auto-dry-run-panel auto-dry-run-${autoDryRun.status}`}>
          <div>
            <strong>{autoDryRun.summary}</strong>
            <span>模式：{autoDryRun.mode} · 当前任务：{autoDryRun.currentTaskId || "无"}</span>
          </div>
          <div className="execution-meta">
            <span>任务：{autoDryRun.taskSummary.done}/{autoDryRun.taskSummary.total}</span>
            <span>待派发：{autoDryRun.taskSummary.pending}</span>
            <span>待 review：{autoDryRun.taskSummary.assigned}</span>
            <span>需修复：{autoDryRun.taskSummary.needsFix}</span>
            <span>阻断：{autoDryRun.taskSummary.blocked}</span>
          </div>
          {autoDryRun.warnings.length ? (
            <ul>
              {autoDryRun.warnings.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : null}
          <div className="auto-dry-run-list">
            {autoDryRun.steps.map((step) => (
              <article className={`auto-dry-run-step dry-step-${step.status}`} key={step.id}>
                <div>
                  <strong>{step.title}</strong>
                  <span>{step.action} / {step.status}</span>
                </div>
                <p>{step.summary}</p>
                <small>{step.checks.join(" · ")}</small>
              </article>
            ))}
          </div>
          <small>干跑文件：{autoDryRun.dryRunFile}</small>
        </div>
      ) : null}

      <div className="ai-adapter-panel">
        <div>
          <strong>AI adapter</strong>
          <span>{aiAdapterStatus ? `${aiAdapterStatus.provider} · ${aiAdapterModeLabel(aiAdapterStatus)}` : "未检查"}</span>
        </div>
        <p>{aiAdapterStatus?.summary || "用于把当前 task 交给可替换的 AI provider。默认 manual，不会调用外部 AI。"}</p>
        {aiAdapterStatus?.warnings.length ? (
          <ul>
            {aiAdapterStatus.warnings.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        ) : null}
        <div className="adapter-actions">
          <button className="secondary-button" onClick={onCheckAiAdapter} disabled={checkingAiAdapter}>
            {checkingAiAdapter ? "检查中" : "检查 adapter"}
          </button>
          <button className="secondary-button" onClick={onRunAiAdapter} disabled={!canRunAiAdapter || runningAiAdapter}>
            {runningAiAdapter ? "处理中" : "用 adapter 处理当前任务"}
          </button>
          <button className="primary-button" onClick={onRunControlledTask} disabled={!canRunAiAdapter || runningControlledTask}>
            {runningControlledTask ? "执行中" : "受控执行当前任务"}
          </button>
        </div>
        {aiAdapterRun ? (
          <div className={`ai-adapter-result adapter-result-${aiAdapterRun.status}`}>
            <div>
              <strong>{aiAdapterRun.summary}</strong>
              <span>{aiAdapterRun.provider} / {aiAdapterRun.status}</span>
            </div>
            {aiAdapterRun.report ? <pre>{aiAdapterRun.report}</pre> : <small>manual 模式不会生成报告，只生成当前 task prompt。</small>}
            <small>记录文件：{aiAdapterRun.reportFile || "未生成"}</small>
          </div>
        ) : null}
        {controlledExecution ? (
          <div className={`controlled-execution-result controlled-${controlledExecution.status}`}>
            <div>
              <strong>{controlledExecution.summary}</strong>
              <span>{controlledExecution.provider} / {controlledExecution.reviewDecision}</span>
            </div>
            <div className="execution-meta">
              <span>任务：{controlledExecution.taskId || "无"}</span>
              <span>修复轮次：{controlledExecution.repairRound}/{controlledExecution.maxRepairRounds}</span>
              <span>变更：{controlledExecution.changedFiles.length}</span>
              <span>越界：{controlledExecution.outOfScopeFiles.length}</span>
            </div>
            {controlledExecution.outOfScopeFiles.length ? (
              <div className="controlled-file-list">
                {controlledExecution.outOfScopeFiles.map((filePath) => (
                  <code key={filePath}>{filePath}</code>
                ))}
              </div>
            ) : null}
            <small>执行记录：{controlledExecution.executionFile || "未生成"}</small>
            <small>执行锁：{controlledExecution.lockFile || "无"}</small>
          </div>
        ) : null}
      </div>

      {dispatchedPrompt ? (
        <div className="task-prompt-preview">
          <div>
            <strong>{dispatchedPrompt.summary}</strong>
            <span>{dispatchedPrompt.promptContent.length} 字符</span>
          </div>
          <pre>{dispatchedPrompt.promptContent}</pre>
        </div>
      ) : null}

      <div className="task-review-box">
        <FieldLabel title="写代码 AI 完成报告" hint="把当前任务完成后的报告粘贴在这里，再交给系统做轻量 review" />
        <TextArea value={report} onChange={onReportChange} rows={8} placeholder="任务编号：task-01&#10;实际改动文件：&#10;完成内容：&#10;运行命令和结果：&#10;未完成内容：无&#10;新增问题：无&#10;建议下一步：" />
        <button className="secondary-button" onClick={onReview} disabled={!canReviewCurrentTask || reviewing}>
          {reviewing ? "检查中" : "提交系统 review"}
        </button>
      </div>

      {reviewResult ? (
        <div className={`task-review-result review-${reviewResult.decision}`}>
          <div>
            <strong>{reviewResult.summary}</strong>
            <span>结论：{reviewResult.decision}</span>
          </div>
          <ul>
            {reviewResult.findings.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <div className="review-file-grid">
            <article>
              <strong>本任务新增/变更文件</strong>
              {reviewResult.changedFiles.length ? (
                reviewResult.changedFiles.map((filePath) => <code key={filePath}>{filePath}</code>)
              ) : (
                <span>未检测到新增改动</span>
              )}
            </article>
            <article className={reviewResult.outOfScopeFiles.length ? "review-out-of-scope" : ""}>
              <strong>越界文件</strong>
              {reviewResult.outOfScopeFiles.length ? (
                reviewResult.outOfScopeFiles.map((filePath) => <code key={filePath}>{filePath}</code>)
              ) : (
                <span>无</span>
              )}
            </article>
          </div>
          <small>review 文件：{reviewResult.reviewFile || "未生成"}</small>
          {reviewResult.fixPromptFile ? <small>修复任务：{reviewResult.fixPromptFile}</small> : null}
        </div>
      ) : null}

      <div className="task-plan-list">
        {result.tasks.map((item) => (
          <article className={`task-plan-row task-status-${item.status} ${item.fixOf ? "task-plan-fix-row" : ""}`} key={item.id}>
            <div>
              <strong>
                {item.id} {item.title}
              </strong>
              <span>{taskQueueStatusText[item.status] || item.status}</span>
            </div>
            <p>{item.goal}</p>
            <small>
              依赖：{item.dependsOn.length ? item.dependsOn.join(" / ") : "无"} · prompt：{item.promptFile}
              {item.fixOf ? ` · 修复：${item.fixOf}` : ""}
            </small>
          </article>
        ))}
      </div>
      <div className="path-list">
        {result.writtenFiles.map((filePath) => (
          <code key={filePath}>{filePath}</code>
        ))}
      </div>
    </section>
  );
}

function FinalAcceptancePanel({ result }: { result: FinalAcceptanceResult | null }) {
  if (!result) {
    return (
      <section className="flat-panel final-acceptance-panel">
        <h2>总验收与知识沉淀</h2>
        <p className="empty-text">还没有生成总验收。任务 review、命令验收和知识写入完成后，可生成最终收口文件。</p>
      </section>
    );
  }

  const panelStatus: StepStatus = result.status === "success" ? "done" : result.status === "blocked" || result.status === "error" ? "failed" : "risk";

  return (
    <section className="flat-panel final-acceptance-panel">
      <div className="scan-head">
        <div>
          <h2>总验收与知识沉淀</h2>
          <p>{result.summary}</p>
        </div>
        <StatusBadge status={panelStatus} />
      </div>
      <div className="execution-meta">
        <span>任务：{result.taskSummary.done}/{result.taskSummary.total}</span>
        <span>待处理：{result.taskSummary.pending + result.taskSummary.assigned}</span>
        <span>需修复：{result.taskSummary.needsFix}</span>
        <span>阻断：{result.taskSummary.blocked}</span>
      </div>
      <div className="final-grid">
        <article>
          <h3>验收发现</h3>
          <ul>
            {result.findings.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </article>
        <article>
          <h3>沉淀规则</h3>
          <ul>
            {result.rules.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </article>
      </div>
      <div className="path-list">
        <code>{result.acceptanceFile}</code>
        <code>{result.ruleSuggestionFile || "未生成规则沉淀候选文件"}</code>
      </div>
    </section>
  );
}

function ValidationRunPanel({ result }: { result: ValidationRunResult | null }) {
  if (!result) {
    return (
      <section className="flat-panel validation-panel">
        <h2>命令验收结果</h2>
        <p className="empty-text">还没有执行命令验收。点击“执行命令验收”后，会受控运行 typecheck、lint、build 并回填验收报告。</p>
      </section>
    );
  }

  const panelStatus: StepStatus = result.status === "success" ? "done" : result.status === "error" ? "failed" : "risk";

  return (
    <section className="flat-panel validation-panel">
      <div className="scan-head">
        <div>
          <h2>命令验收结果</h2>
          <p>{result.summary}</p>
        </div>
        <StatusBadge status={panelStatus} />
      </div>
      <div className="validation-meta">
        <span>状态：{validationRunStatusText[result.status]}</span>
        <span>包管理器：{result.packageManager}</span>
        <span>时间：{new Date(result.generatedAt).toLocaleString("zh-CN", { hour12: false })}</span>
      </div>
      <div className="command-list">
        {result.commands.map((item) => (
          <article className={`command-row command-${item.status}`} key={item.name}>
            <div>
              <strong>{item.name}</strong>
              <span>{commandStatusText[item.status]}</span>
            </div>
            <code>{item.command || "未执行"}</code>
            <p>{item.script || "package.json 未声明该脚本"}</p>
            <small>
              退出码：{item.exitCode ?? "-"} · 耗时：{Math.round(item.durationMs / 1000)}s
            </small>
          </article>
        ))}
      </div>
    </section>
  );
}

function PageSmokePanel({ result }: { result: PageSmokeTestResult | null }) {
  if (!result) {
    return (
      <section className="flat-panel page-smoke-panel">
        <h2>轻量页面点测</h2>
        <p className="empty-text">还没有执行页面点测。填写页面 URL 和关键词后，可检查页面是否可访问、关键词是否出现、是否有明显错误文本。</p>
      </section>
    );
  }

  const panelStatus = pageSmokePanelStatus(result);

  return (
    <section className="flat-panel page-smoke-panel">
      <div className="scan-head">
        <div>
          <h2>轻量页面点测</h2>
          <p>{result.summary}</p>
        </div>
        <StatusBadge status={panelStatus} />
      </div>
      <div className="validation-meta">
        <span>状态：{result.status}</span>
        <span>HTTP：{result.httpStatus ?? "-"}</span>
        <span>HTML：{result.bodyLength}</span>
        <span>时间：{formatDateTime(result.generatedAt)}</span>
      </div>
      <div className="page-smoke-summary">
        <strong>{result.title || "未识别标题"}</strong>
        <code>{result.url || "未提供 URL"}</code>
      </div>
      <div className="command-list">
        {result.checks.map((item) => (
          <article className={`command-row smoke-check-${item.status}`} key={item.name}>
            <div>
              <strong>{item.name}</strong>
              <span>{item.status}</span>
            </div>
            <p>{item.message}</p>
            <code>{item.status}</code>
            <small>{item.status === "passed" ? "通过" : item.status === "warning" ? "提醒" : "失败"}</small>
          </article>
        ))}
      </div>
      {result.missingKeywords.length || result.detectedErrors.length ? (
        <div className="smoke-warning-grid">
          <article>
            <strong>缺失关键词</strong>
            <span>{result.missingKeywords.length ? result.missingKeywords.join("、") : "无"}</span>
          </article>
          <article>
            <strong>错误文本</strong>
            <span>{result.detectedErrors.length ? result.detectedErrors.join("、") : "无"}</span>
          </article>
        </div>
      ) : null}
      <div className="path-list">
        <code>{result.smokeFile || "未生成点测报告"}</code>
      </div>
    </section>
  );
}

function MaterialStageGuide({
  task,
  projectScan,
  validationRun,
  knowledgeWrite,
}: {
  task: DeliveryTask;
  projectScan: ProjectScanResult | null;
  validationRun: ValidationRunResult | null;
  knowledgeWrite: KnowledgeWriteResult | null;
}) {
  const stages: Array<{ title: string; description: string; status: StepStatus; meta: string }> = [
    {
      title: "项目接入",
      description: "先填写项目名称和真实路径，再扫描项目画像。",
      status: hasText(task.projectPath) && projectScan?.status === "success" ? (projectScan.warnings.length ? "risk" : "done") : hasText(task.projectPath) ? "pending" : "failed",
      meta: projectScan?.summary || (hasText(task.projectPath) ? "可点击扫描项目" : "等待项目路径"),
    },
    {
      title: "模块需求",
      description: "确认本轮模块、边界、不要做什么和验收口径。",
      status: hasText(task.moduleName) && hasText(task.requirement) ? "done" : "pending",
      meta: hasText(task.moduleName) ? task.moduleName : "等待模块名称",
    },
    {
      title: "接口资料",
      description: "接口文档决定路径、参数、分页、字段和错误码。",
      status: lineCount(task.apiDocs) > 0 ? "done" : "risk",
      meta: lineCount(task.apiDocs) > 0 ? `${lineCount(task.apiDocs)} 份资料` : "缺失时只能记录待确认问题",
    },
    {
      title: "样式资料",
      description: "Demo 优先，其次旧项目样式，避免只凭感觉写 UI。",
      status: lineCount(task.demos) > 0 ? "done" : lineCount(task.oldProjects) > 0 ? "risk" : "pending",
      meta: lineCount(task.demos) > 0 ? `${lineCount(task.demos)} 个 Demo` : lineCount(task.oldProjects) > 0 ? "仅有旧项目参考" : "等待 Demo 或设计图",
    },
    {
      title: "验收沉淀",
      description: "命令验收和知识库写入会形成可复盘记录。",
      status: knowledgeWrite?.status === "success" ? "done" : validationRun ? "risk" : "pending",
      meta: knowledgeWrite?.summary || validationRun?.summary || "等待命令验收和知识库写入",
    },
  ];

  return (
    <div className="material-stage-grid">
      {stages.map((stage, index) => (
        <article className={`material-stage-card stage-${stage.status}`} key={stage.title}>
          <div>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <StatusBadge status={stage.status} />
          </div>
          <h3>{stage.title}</h3>
          <p>{stage.description}</p>
          <small>{stage.meta}</small>
        </article>
      ))}
    </div>
  );
}

function RunRecordPanel({
  runId,
  result,
  saving,
  loading,
  onSave,
  onLoad,
}: {
  runId: string;
  result: RunRecordSaveResult | null;
  saving: boolean;
  loading: boolean;
  onSave: () => void;
  onLoad: () => void;
}) {
  return (
    <section className="run-record-panel">
      <div>
        <span>当前运行</span>
        <strong>{runId}</strong>
        <small>{result?.summary || "运行状态会保存到知识库 runs 目录。"}</small>
      </div>
      <div className="run-record-actions">
        <button className="secondary-button" onClick={onLoad} disabled={loading}>
          {loading ? "恢复中" : "恢复最近记录"}
        </button>
        <button className="secondary-button" onClick={onSave} disabled={saving}>
          {saving ? "保存中" : "保存运行记录"}
        </button>
      </div>
    </section>
  );
}

function SystemHealthPanel({ result }: { result: SystemHealthResult | null }) {
  if (!result) return null;

  const panelStatus: StepStatus = result.status === "success" ? "done" : result.status === "warning" ? "risk" : "failed";

  return (
    <section className="system-health-panel">
      <div>
        <span>系统自检</span>
        <strong>{result.summary}</strong>
        <small>
          runner：{result.service} · 端口：{result.port} · {formatDateTime(result.generatedAt)}
        </small>
      </div>
      <StatusBadge status={panelStatus} />
      <div className="health-check-list">
        {result.checks.map((item) => (
          <article className={`health-check health-${item.status}`} key={item.name}>
            <strong>{item.name}</strong>
            <span>{item.message}</span>
            {item.path ? <code>{item.path}</code> : null}
          </article>
        ))}
      </div>
    </section>
  );
}

function RunHistoryPanel({
  runs,
  loading,
  onRefresh,
  onRestore,
}: {
  runs: RunRecordListItem[];
  loading: boolean;
  onRefresh: () => void;
  onRestore: (runId: string) => void;
}) {
  return (
    <section className="run-history-panel">
      <div className="run-history-head">
        <div>
          <h2>历史运行</h2>
          <p>按当前项目名称和模块名称读取 runs 目录，支持恢复任意一次历史状态。</p>
        </div>
        <button className="secondary-button" onClick={onRefresh} disabled={loading}>
          {loading ? "读取中" : "刷新历史"}
        </button>
      </div>
      {runs.length ? (
        <div className="run-history-list">
          {runs.slice(0, 6).map((item) => (
            <article className="run-history-card" key={item.runId}>
              <div className="run-history-card-head">
                <strong>{item.runId}</strong>
                <span>{item.progress}%</span>
              </div>
              <p>{item.summary}</p>
              <dl>
                <div>
                  <dt>命令</dt>
                  <dd>{runHistoryStatusText[item.validationStatus]}</dd>
                </div>
                <div>
                  <dt>知识库</dt>
                  <dd>{runHistoryStatusText[item.knowledgeStatus]}</dd>
                </div>
                <div>
                  <dt>问题</dt>
                  <dd>{item.issueCount}</dd>
                </div>
              </dl>
              <small>{formatDateTime(item.updatedAt)}</small>
              <button className="secondary-button" onClick={() => onRestore(item.runId)}>
                恢复此记录
              </button>
            </article>
          ))}
        </div>
      ) : (
        <p className="empty-text">暂无历史运行。保存运行记录后，这里会出现可恢复的 run。</p>
      )}
    </section>
  );
}

function ModuleDependencyGraph({
  task,
  projectScan,
  steps,
  validationRun,
  knowledgeWrite,
}: {
  task: DeliveryTask;
  projectScan: ProjectScanResult | null;
  steps: WorkflowStep[];
  validationRun: ValidationRunResult | null;
  knowledgeWrite: KnowledgeWriteResult | null;
}) {
  const nodes: Array<{ title: string; type: string; status: StepStatus; meta: string }> = [
    {
      title: "项目路径",
      type: "输入",
      status: hasText(task.projectPath) ? "done" : "failed",
      meta: hasText(task.projectPath) ? task.projectPath : "等待填写",
    },
    {
      title: "项目画像",
      type: "扫描",
      status: projectScan?.status === "success" ? (projectScan.warnings.length ? "risk" : "done") : projectScan ? "failed" : "pending",
      meta: projectScan?.summary || "等待扫描项目",
    },
    {
      title: "接口文档",
      type: "资料",
      status: lineCount(task.apiDocs) ? "done" : "risk",
      meta: lineCount(task.apiDocs) ? `${lineCount(task.apiDocs)} 份` : "缺失时记录待确认",
    },
    {
      title: "Demo / 设计图",
      type: "资料",
      status: lineCount(task.demos) ? "done" : "pending",
      meta: lineCount(task.demos) ? `${lineCount(task.demos)} 个` : "等待补充",
    },
    {
      title: "旧项目参考",
      type: "参考",
      status: lineCount(task.oldProjects) ? "done" : "pending",
      meta: lineCount(task.oldProjects) ? `${lineCount(task.oldProjects)} 个` : "可选",
    },
    {
      title: "模块计划",
      type: "执行",
      status: steps.some((step) => step.status === "failed") ? "failed" : steps.some((step) => step.status === "risk") ? "risk" : "done",
      meta: `${steps.filter((step) => step.status === "done" || step.status === "risk").length}/${steps.length} 步完成或可继续`,
    },
    {
      title: "命令验收",
      type: "测试",
      status: validationRun?.status === "success" ? "done" : validationRun ? "risk" : "pending",
      meta: validationRun?.summary || "等待执行命令验收",
    },
    {
      title: "知识沉淀",
      type: "输出",
      status: knowledgeWrite?.status === "success" ? "done" : knowledgeWrite ? "failed" : "pending",
      meta: knowledgeWrite?.summary || "等待写入知识库",
    },
  ];

  return (
    <section className="flat-panel dependency-graph-panel">
      <div className="scan-head">
        <div>
          <h2>模块依赖图</h2>
          <p>把本次模块交付依赖的资料、扫描结果、执行计划、测试和沉淀串起来，后续 AI 自动交付会按这个顺序消费上下文。</p>
        </div>
      </div>
      <div className="dependency-graph">
        {nodes.map((node, index) => (
          <div className="dependency-node-wrap" key={node.title}>
            <article className={`dependency-node node-${node.status}`}>
              <span>{node.type}</span>
              <strong>{node.title}</strong>
              <small>{node.meta}</small>
              <StatusBadge status={node.status} />
            </article>
            {index < nodes.length - 1 ? <div className="dependency-edge">→</div> : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function App() {
  const [task, setTask] = useState<DeliveryTask>(() => loadTask());
  const [runtime, setRuntime] = useState<RuntimeState>(() => loadRuntime());
  const [logs, setLogs] = useState<RunLog[]>(() => loadLogs());
  const [systemHealth, setSystemHealth] = useState<SystemHealthResult | null>(null);
  const [projectScan, setProjectScan] = useState<ProjectScanResult | null>(() => loadProjectScan());
  const [knowledgeWrite, setKnowledgeWrite] = useState<KnowledgeWriteResult | null>(null);
  const [contextPackage, setContextPackage] = useState<ContextPackageResult | null>(null);
  const [executionPackage, setExecutionPackage] = useState<ExecutionPackageResult | null>(null);
  const [taskPlan, setTaskPlan] = useState<TaskPlanResult | null>(null);
  const [autoDryRun, setAutoDryRun] = useState<AutoDryRunResult | null>(null);
  const [aiAdapterStatus, setAiAdapterStatus] = useState<AiAdapterStatusResult | null>(null);
  const [aiAdapterRun, setAiAdapterRun] = useState<AiAdapterTaskRunResult | null>(null);
  const [controlledExecution, setControlledExecution] = useState<ControlledTaskExecutionResult | null>(null);
  const [lastAutoAdvance, setLastAutoAdvance] = useState<AutoAdvanceResult | null>(null);
  const [taskDispatch, setTaskDispatch] = useState<TaskDispatchResult | null>(null);
  const [taskReport, setTaskReport] = useState("");
  const [taskReview, setTaskReview] = useState<TaskReviewResult | null>(null);
  const [pageSmoke, setPageSmoke] = useState<PageSmokeTestResult | null>(null);
  const [validationRun, setValidationRun] = useState<ValidationRunResult | null>(null);
  const [finalAcceptance, setFinalAcceptance] = useState<FinalAcceptanceResult | null>(null);
  const [currentRunId, setCurrentRunId] = useState(() => loadRunId() || createRunId());
  const [runCreatedAt, setRunCreatedAt] = useState(() => new Date().toISOString());
  const [runRecordSave, setRunRecordSave] = useState<RunRecordSaveResult | null>(null);
  const [runHistory, setRunHistory] = useState<RunRecordListItem[]>([]);
  const [tab, setTab] = useState<TabKey>("task");
  const [copied, setCopied] = useState(false);
  const [checkingHealth, setCheckingHealth] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [preparingContext, setPreparingContext] = useState(false);
  const [preparingExecution, setPreparingExecution] = useState(false);
  const [preparingTaskPlan, setPreparingTaskPlan] = useState(false);
  const [preparingAutoDryRun, setPreparingAutoDryRun] = useState(false);
  const [checkingAiAdapter, setCheckingAiAdapter] = useState(false);
  const [runningAiAdapter, setRunningAiAdapter] = useState(false);
  const [runningControlledTask, setRunningControlledTask] = useState(false);
  const [loadingTaskPlan, setLoadingTaskPlan] = useState(false);
  const [dispatchingTask, setDispatchingTask] = useState(false);
  const [reviewingTask, setReviewingTask] = useState(false);
  const [creatingIssueFixId, setCreatingIssueFixId] = useState<string | null>(null);
  const [writingKnowledge, setWritingKnowledge] = useState(false);
  const [runningPageSmoke, setRunningPageSmoke] = useState(false);
  const [runningValidation, setRunningValidation] = useState(false);
  const [finalizingAcceptance, setFinalizingAcceptance] = useState(false);
  const [autoAdvancing, setAutoAdvancing] = useState(false);
  const [autoRunning, setAutoRunning] = useState(false);
  const [savingRunRecord, setSavingRunRecord] = useState(false);
  const [loadingRunRecord, setLoadingRunRecord] = useState(false);
  const [loadingRunHistory, setLoadingRunHistory] = useState(false);
  const runTimer = useRef<number | null>(null);

  const steps = useMemo(() => evaluateWorkflow(task, runtime, projectScan), [task, runtime, projectScan]);
  const baseIssues = useMemo(() => collectIssues(steps), [steps]);
  const runtimeIssues = useMemo(
    () => deliveryRuntimeIssues({ reviewResult: taskReview, pageSmoke, validationRun, knowledgeWrite, finalAcceptance }),
    [taskReview, pageSmoke, validationRun, knowledgeWrite, finalAcceptance],
  );
  const issues = useMemo(() => mergeDeliveryIssues(baseIssues, runtimeIssues), [baseIssues, runtimeIssues]);
  const issueRules = useMemo(() => issueRuleSuggestions(issues), [issues]);
  const progress = useMemo(() => summarizeProgress(steps), [steps]);
  const markdown = useMemo(() => generateDeliveryMarkdown(task, steps, issues, projectScan), [task, steps, issues, projectScan]);
  const executionDecision = useMemo(
    () =>
      buildExecutionDecision({
        task,
        taskPlan,
        taskDispatch,
        taskReview,
        aiAdapterStatus,
        controlledExecution,
        pageSmoke,
        validationRun,
        knowledgeWrite,
        finalAcceptance,
        issues,
      }),
    [
      task,
      taskPlan,
      taskDispatch,
      taskReview,
      aiAdapterStatus,
      controlledExecution,
      pageSmoke,
      validationRun,
      knowledgeWrite,
      finalAcceptance,
      issues,
    ],
  );

  useEffect(() => {
    saveTask(task);
  }, [task]);

  useEffect(() => {
    saveRuntime(runtime);
  }, [runtime]);

  useEffect(() => {
    saveLogs(logs);
  }, [logs]);

  useEffect(() => {
    saveProjectScan(projectScan);
  }, [projectScan]);

  useEffect(() => {
    saveRunId(currentRunId);
  }, [currentRunId]);

  useEffect(() => {
    return () => {
      if (runTimer.current) {
        window.clearTimeout(runTimer.current);
      }
    };
  }, []);

  function updateTask<K extends keyof DeliveryTask>(key: K, value: DeliveryTask[K]) {
    setTask((current) => ({ ...current, [key]: value }));
  }

  function updatePermission(key: PermissionKey, value: boolean) {
    setTask((current) => ({
      ...current,
      permissions: {
        ...current.permissions,
        [key]: value,
      },
    }));
  }

  function appendLog(message: string, level: RunLog["level"] = "info") {
    setLogs((current) => [createLog(message, level), ...current].slice(0, 80));
  }

  function buildRunRecord(overrides: Partial<DeliveryRunRecord> = {}): DeliveryRunRecord {
    const now = new Date().toISOString();
    const recordTask = overrides.task || task;
    const recordRuntime = overrides.runtime || runtime;
    const recordProjectScan = overrides.projectScan === undefined ? projectScan : overrides.projectScan;
    const recordValidationRun = overrides.validationRun === undefined ? validationRun : overrides.validationRun;
    const recordKnowledgeWrite = overrides.knowledgeWrite === undefined ? knowledgeWrite : overrides.knowledgeWrite;
    const recordFinalAcceptance = overrides.finalAcceptance === undefined ? finalAcceptance : overrides.finalAcceptance;
    const recordPageSmoke = overrides.pageSmoke === undefined ? pageSmoke : overrides.pageSmoke;
    const recordAutoDryRun = overrides.autoDryRun === undefined ? autoDryRun : overrides.autoDryRun;
    const recordControlledExecution =
      overrides.controlledExecution === undefined ? controlledExecution : overrides.controlledExecution;
    const recordSteps = overrides.steps || evaluateWorkflow(recordTask, recordRuntime, recordProjectScan);
    const recordRuntimeIssues = deliveryRuntimeIssues({
      reviewResult: taskReview,
      pageSmoke: recordPageSmoke,
      validationRun: recordValidationRun,
      knowledgeWrite: recordKnowledgeWrite,
      finalAcceptance: recordFinalAcceptance,
    });
    const recordIssues = overrides.issues || mergeDeliveryIssues(collectIssues(recordSteps), recordRuntimeIssues);
    const recordProgress = overrides.progress ?? summarizeProgress(recordSteps);
    return {
      runId: currentRunId,
      task: recordTask,
      runtime: recordRuntime,
      logs,
      projectScan: recordProjectScan,
      validationRun: recordValidationRun,
      knowledgeWrite: recordKnowledgeWrite,
      contextPackage,
      executionPackage,
      taskPlan,
      autoDryRun: recordAutoDryRun,
      controlledExecution: recordControlledExecution,
      pageSmoke: recordPageSmoke,
      finalAcceptance: recordFinalAcceptance,
      steps: recordSteps,
      issues: recordIssues,
      progress: recordProgress,
      summary: `${recordTask.projectName || "未命名项目"} / ${recordTask.moduleName || "未命名模块"}：进度 ${recordProgress}%`,
      createdAt: runCreatedAt,
      updatedAt: now,
      ...overrides,
    };
  }

  async function saveCurrentRunRecord(silent = false, overrides: Partial<DeliveryRunRecord> = {}) {
    setSavingRunRecord(true);
    try {
      const result = await requestRunRecordSave(buildRunRecord(overrides));
      setRunRecordSave(result);
      void refreshRunHistory(true);
      if (!silent) {
        appendLog(result.summary, "success");
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "运行记录保存失败";
      if (!silent) {
        appendLog(message, "error");
      }
      return null;
    } finally {
      setSavingRunRecord(false);
    }
  }

  function applyRunRecord(record: DeliveryRunRecord, message: string) {
    setCurrentRunId(record.runId || createRunId());
    setRunCreatedAt(record.createdAt || new Date().toISOString());
    setTask({
      ...defaultTask,
      ...(record.task || {}),
      permissions: {
        ...defaultTask.permissions,
        ...((record.task || {}).permissions || {}),
      },
    });
    setRuntime(record.runtime || {});
    setLogs([createLog(message, "success"), ...(record.logs || [])].slice(0, 80));
    setProjectScan(record.projectScan || null);
    setValidationRun(record.validationRun || null);
    setKnowledgeWrite(record.knowledgeWrite || null);
    setContextPackage(record.contextPackage || null);
    setExecutionPackage(record.executionPackage || null);
    setTaskPlan(record.taskPlan || null);
    setAutoDryRun(record.autoDryRun || null);
    setControlledExecution(record.controlledExecution || null);
    setPageSmoke(record.pageSmoke || null);
    setFinalAcceptance(record.finalAcceptance || null);
    setTaskDispatch(null);
    setTaskReview(null);
    setAiAdapterRun(null);
    setTaskReport("");
    setTab("plan");
  }

  async function refreshRunHistory(silent = false) {
    if (!hasText(task.projectName) || !hasText(task.moduleName)) {
      if (!silent) {
        appendLog("读取历史运行需要先填写项目名称和模块名称。", "warning");
        setTab("task");
      }
      return;
    }

    setLoadingRunHistory(true);
    try {
      const result = await requestRunRecordList({ projectName: task.projectName, moduleName: task.moduleName });
      setRunHistory(result.runs);
      if (!silent) {
        appendLog(result.summary, "success");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "运行记录恢复失败";
      if (!silent) {
        appendLog(message, "error");
      }
    } finally {
      setLoadingRunHistory(false);
    }
  }

  async function restoreRunRecord(runId?: string) {
    if (!hasText(task.projectName) || !hasText(task.moduleName)) {
      appendLog("恢复运行记录需要先填写项目名称和模块名称。", "warning");
      setTab("task");
      return;
    }

    setLoadingRunRecord(true);
    try {
      const record = await requestRunRecordLoad({ projectName: task.projectName, moduleName: task.moduleName, runId });
      applyRunRecord(record, runId ? `已恢复运行记录：${record.runId}` : `已恢复最近运行记录：${record.runId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "运行记录恢复失败";
      appendLog(message, "error");
    } finally {
      setLoadingRunRecord(false);
    }
  }

  function resetAll() {
    if (runTimer.current) {
      window.clearTimeout(runTimer.current);
    }
    clearStorage();
    setTask(defaultTask);
    setRuntime({});
    setLogs([createLog("已重置控制台本地数据。", "warning")]);
    setSystemHealth(null);
    setProjectScan(null);
    setKnowledgeWrite(null);
    setContextPackage(null);
    setExecutionPackage(null);
    setTaskPlan(null);
    setAutoDryRun(null);
    setControlledExecution(null);
    setPageSmoke(null);
    setFinalAcceptance(null);
    setTaskDispatch(null);
    setTaskReview(null);
    setAiAdapterStatus(null);
    setAiAdapterRun(null);
    setTaskReport("");
    setValidationRun(null);
    setCurrentRunId(createRunId());
    setRunCreatedAt(new Date().toISOString());
    setRunRecordSave(null);
    setRunHistory([]);
    setTab("task");
  }

  async function checkSystemHealth() {
    setCheckingHealth(true);
    appendLog("开始执行系统自检。", "info");

    try {
      const result = await requestSystemHealth();
      setSystemHealth(result);
      appendLog(result.summary, result.status === "success" ? "success" : result.status === "warning" ? "warning" : "error");
    } catch (error) {
      const message = error instanceof Error ? error.message : "系统自检失败";
      setSystemHealth({
        status: "error",
        ok: false,
        service: "delivery-runner",
        port: 5176,
        knowledgeRoot: "",
        runnerDirectory: "",
        checks: [
          {
            name: "runner health",
            status: "error",
            message,
          },
        ],
        summary: message,
        generatedAt: new Date().toISOString(),
      });
      appendLog(message, "error");
    } finally {
      setCheckingHealth(false);
    }
  }

  async function scanCurrentProject() {
    if (!task.projectPath.trim()) {
      appendLog("请先填写真实项目路径。", "warning");
      setTab("task");
      return;
    }

    setScanning(true);
    setTab("plan");
    setRuntime((current) => ({ ...current, "task-package": "done", "project-scan": "running" }));
    appendLog(`开始扫描真实项目：${task.projectPath}`, "info");

    try {
      const result = await requestProjectScan(task.projectPath);
      setProjectScan(result);
      const finalStatus: StepStatus = result.status === "success" ? (result.warnings.length ? "risk" : "done") : "failed";
      const nextRuntime = { ...runtime, "task-package": "done" as StepStatus, "project-scan": finalStatus };
      setRuntime(nextRuntime);
      appendLog(
        result.status === "success" ? `项目扫描完成：${result.summary}` : `项目扫描失败：${result.summary}`,
        result.status === "success" ? (result.warnings.length ? "warning" : "success") : "error",
      );
      await saveCurrentRunRecord(true, { projectScan: result, runtime: nextRuntime });
    } catch (error) {
      const message = error instanceof Error ? error.message : "runner 连接失败";
      const failedScan: ProjectScanResult = {
        status: "error",
        projectPath: task.projectPath,
        projectName: task.projectName,
        packageManager: "unknown",
        frameworks: [],
        scripts: {},
        keyDirectories: [],
        keyFiles: [],
        ruleFiles: [],
        envFiles: [],
        sourcePreview: [],
        warnings: [message],
        summary: `runner 未启动或扫描失败：${message}`,
        generatedAt: new Date().toISOString(),
      };
      setProjectScan(failedScan);
      const nextRuntime = { ...runtime, "task-package": "done" as StepStatus, "project-scan": "failed" as StepStatus };
      setRuntime(nextRuntime);
      appendLog(`runner 未启动或扫描失败：${message}`, "error");
      await saveCurrentRunRecord(true, { projectScan: failedScan, runtime: nextRuntime });
    } finally {
      setScanning(false);
    }
  }

  function startDryRun() {
    if (runTimer.current) {
      window.clearTimeout(runTimer.current);
    }

    const initialSteps = evaluateWorkflow(task, {}, projectScan);
    const hasRunnableStep = initialSteps.some((step) => step.status !== "locked" && step.status !== "failed");
    if (!hasRunnableStep) {
      appendLog("没有可执行步骤，请先补齐任务包的项目路径、模块名称和需求。", "warning");
      return;
    }

    setTab("plan");
    setRuntime({});
    appendLog("启动自动交付演练。当前只演示状态推进，不会写真实项目。", "info");

    const runNext = (currentRuntime: RuntimeState) => {
      const nextSteps = evaluateWorkflow(task, currentRuntime, projectScan);
      const blockedStep = nextSteps.find((item) => item.status === "failed");
      if (blockedStep) {
        appendLog(`自动交付被阻断：${blockedStep.title}。请查看风险归档。`, "error");
        setTab("issues");
        return;
      }
      const step = nextSteps.find((item) => item.status === "pending" || item.status === "risk");
      if (!step) {
        appendLog("自动交付演练完成，已生成交付结果和 Markdown。", "success");
        setRuntime((current) => ({ ...current, "delivery-complete": "done" }));
        setTab("result");
        return;
      }

      setRuntime((current) => ({ ...current, [step.id]: "running" }));
      appendLog(`正在执行：${step.title}`, "info");

      runTimer.current = window.setTimeout(() => {
        const finalStatus: StepStatus = step.issues.length > 0 ? "risk" : "done";
        const nextRuntime = { ...currentRuntime, [step.id]: finalStatus };
        setRuntime(nextRuntime);
        appendLog(`${step.title}：${finalStatus === "risk" ? "完成但有风险" : "完成"}`, finalStatus === "risk" ? "warning" : "success");
        runTimer.current = window.setTimeout(() => runNext(nextRuntime), 420);
      }, 520);
    };

    runNext({});
  }

  async function copyMarkdown() {
    await navigator.clipboard.writeText(markdown);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  async function prepareCurrentContextPackage() {
    if (!task.permissions.allowKnowledgeWrite) {
      appendLog("当前没有授权写入知识库，不能生成 AI 上下文包。", "warning");
      return;
    }
    if (!hasText(task.projectName) || !hasText(task.moduleName)) {
      appendLog("生成 AI 上下文包需要先填写项目名称和模块名称。", "warning");
      setTab("task");
      return;
    }

    setPreparingContext(true);
    appendLog("开始生成 AI 上下文包。", "info");

    try {
      const result = await requestContextPackagePrepare({ task, projectScan, steps, issues });
      setContextPackage(result);
      appendLog(result.summary, "success");
      await saveCurrentRunRecord(true, { contextPackage: result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI 上下文包生成失败";
      const failedContext: ContextPackageResult = {
        status: "error",
        knowledgeRoot: "",
        projectDirectory: "",
        moduleDirectory: "",
        writtenFiles: [],
        sources: [],
        summary: message,
        generatedAt: new Date().toISOString(),
      };
      setContextPackage(failedContext);
      appendLog(message, "error");
      await saveCurrentRunRecord(true, { contextPackage: failedContext });
    } finally {
      setPreparingContext(false);
    }
  }

  async function prepareCurrentExecutionPackage() {
    if (!task.permissions.allowKnowledgeWrite) {
      appendLog("当前没有授权写入知识库，不能生成 AI 交付执行包。", "warning");
      return;
    }
    if (!hasText(task.projectName) || !hasText(task.moduleName)) {
      appendLog("生成 AI 交付执行包需要先填写项目名称和模块名称。", "warning");
      setTab("task");
      return;
    }
    if (!contextPackage) {
      appendLog("建议先生成 AI 上下文包，再生成交付执行包。当前会使用默认上下文文件名继续生成。", "warning");
    }

    setPreparingExecution(true);
    appendLog("开始生成 AI 交付执行包。", "info");

    try {
      const result = await requestExecutionPackagePrepare({ task, projectScan, steps, issues, contextPackage, validationRun });
      setExecutionPackage(result);
      appendLog(result.summary, "success");
      await saveCurrentRunRecord(true, { executionPackage: result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI 交付执行包生成失败";
      const failedExecution: ExecutionPackageResult = {
        status: "error",
        knowledgeRoot: "",
        projectDirectory: "",
        moduleDirectory: "",
        packageDirectory: "",
        writtenFiles: [],
        summary: message,
        generatedAt: new Date().toISOString(),
      };
      setExecutionPackage(failedExecution);
      appendLog(message, "error");
      await saveCurrentRunRecord(true, { executionPackage: failedExecution });
    } finally {
      setPreparingExecution(false);
    }
  }

  async function prepareCurrentTaskPlan() {
    if (!task.permissions.allowKnowledgeWrite) {
      appendLog("当前没有授权写入知识库，不能生成设计与任务队列。", "warning");
      return;
    }
    if (!hasText(task.projectName) || !hasText(task.moduleName)) {
      appendLog("生成设计与任务队列需要先填写项目名称和模块名称。", "warning");
      setTab("task");
      return;
    }
    if (!contextPackage) {
      appendLog("建议先生成 AI 上下文包，再生成设计与任务队列。当前会使用已填写资料继续生成。", "warning");
    }

    setPreparingTaskPlan(true);
    appendLog("开始生成设计与任务队列。", "info");

    try {
      const result = await requestTaskPlanPrepare({
        task,
        projectScan,
        steps,
        issues,
        contextPackage,
        executionPackage,
        validationRun,
      });
      setTaskPlan(result);
      setAutoDryRun(null);
      setTaskDispatch(null);
      setTaskReview(null);
      setAiAdapterRun(null);
      setControlledExecution(null);
      setPageSmoke(null);
      setTaskReport("");
      appendLog(result.summary, "success");
      await saveCurrentRunRecord(true, { taskPlan: result, autoDryRun: null, controlledExecution: null, pageSmoke: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : "设计与任务队列生成失败";
      const failedTaskPlan: TaskPlanResult = {
        status: "error",
        knowledgeRoot: "",
        projectDirectory: "",
        moduleDirectory: "",
        planDirectory: "",
        writtenFiles: [],
        tasks: [],
        summary: message,
        generatedAt: new Date().toISOString(),
      };
      setTaskPlan(failedTaskPlan);
      setAutoDryRun(null);
      setControlledExecution(null);
      setPageSmoke(null);
      appendLog(message, "error");
      await saveCurrentRunRecord(true, { taskPlan: failedTaskPlan, autoDryRun: null, controlledExecution: null, pageSmoke: null });
    } finally {
      setPreparingTaskPlan(false);
    }
  }

  async function loadCurrentTaskPlan() {
    if (!hasText(task.projectName) || !hasText(task.moduleName)) {
      appendLog("恢复任务队列需要先填写项目名称和模块名称。", "warning");
      setTab("task");
      return;
    }

    setLoadingTaskPlan(true);
    appendLog("开始从知识库恢复任务队列。", "info");

    try {
      const result = await requestTaskPlanLoad({ task, projectScan, taskPlan });
      setTaskPlan(result);
      setAutoDryRun(null);
      setTaskDispatch(null);
      setTaskReview(null);
      setAiAdapterRun(null);
      setControlledExecution(null);
      setTaskReport("");
      appendLog(result.summary, "success");
      await saveCurrentRunRecord(true, { taskPlan: result, autoDryRun: null, controlledExecution: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : "任务队列恢复失败";
      appendLog(message, "error");
    } finally {
      setLoadingTaskPlan(false);
    }
  }

  async function prepareCurrentAutoDryRun() {
    if (!taskPlan) {
      appendLog("请先生成或恢复设计与任务队列，再生成自动执行干跑计划。", "warning");
      return;
    }

    setPreparingAutoDryRun(true);
    appendLog("开始生成自动执行器干跑计划。", "info");

    try {
      const result = await requestAutoDryRunPrepare({ task, taskPlan });
      setAutoDryRun(result);
      appendLog(result.summary, result.status === "success" ? "success" : result.status === "blocked" ? "error" : "warning");
      await saveCurrentRunRecord(true, { autoDryRun: result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "自动执行器干跑失败";
      const failedDryRun: AutoDryRunResult = {
        status: "error",
        mode: "dry-run",
        planDirectory: "",
        dryRunFile: "",
        currentTaskId: null,
        taskSummary: {
          total: 0,
          done: 0,
          pending: 0,
          assigned: 0,
          needsFix: 0,
          blocked: 0,
        },
        steps: [],
        warnings: [message],
        summary: message,
        generatedAt: new Date().toISOString(),
      };
      setAutoDryRun(failedDryRun);
      appendLog(message, "error");
      await saveCurrentRunRecord(true, { autoDryRun: failedDryRun });
    } finally {
      setPreparingAutoDryRun(false);
    }
  }

  async function checkCurrentAiAdapter() {
    setCheckingAiAdapter(true);
    appendLog("开始检查 AI adapter。", "info");

    try {
      const result = await requestAiAdapterStatus();
      setAiAdapterStatus(result);
      appendLog(result.summary, result.status === "success" ? "success" : result.status === "warning" ? "warning" : "error");
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI adapter 检查失败";
      setAiAdapterStatus({
        status: "error",
        provider: "disabled",
        canAutoRun: false,
        requiresManualInput: true,
        configSource: "DELIVERY_AI_PROVIDER",
        warnings: [message],
        summary: message,
        generatedAt: new Date().toISOString(),
      });
      appendLog(message, "error");
    } finally {
      setCheckingAiAdapter(false);
    }
  }

  async function runCurrentTaskWithAiAdapter() {
    if (!taskPlan) {
      appendLog("请先生成设计与任务队列。", "warning");
      return;
    }

    const currentTask = currentQueueTask(taskPlan);
    if (!currentTask) {
      appendLog("当前没有可交给 AI adapter 的任务。", "warning");
      return;
    }

    setRunningAiAdapter(true);
    appendLog(`开始通过 AI adapter 处理任务：${currentTask.id}`, "info");

    try {
      const result = await requestAiAdapterTaskRun({ task, taskPlan, taskId: currentTask.id });
      setAiAdapterRun(result);
      setControlledExecution(null);
      setTaskDispatch({
        status: "success",
        taskId: result.taskId,
        promptContent: result.promptContent,
        updatedTaskPlan: result.updatedTaskPlan,
        summary: result.summary,
        generatedAt: result.generatedAt,
      });
      if (result.report) {
        setTaskReport(result.report);
      }
      if (result.updatedTaskPlan) {
        setTaskPlan(result.updatedTaskPlan);
        setAutoDryRun(null);
        await saveCurrentRunRecord(true, { taskPlan: result.updatedTaskPlan, autoDryRun: null, controlledExecution: null });
      }
      await navigator.clipboard.writeText(result.promptContent);
      appendLog(`${result.summary} prompt 已复制到剪贴板。`, result.status === "success" ? "success" : "warning");
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI adapter 执行失败";
      appendLog(message, "error");
    } finally {
      setRunningAiAdapter(false);
    }
  }

  async function runCurrentControlledTask() {
    if (!taskPlan) {
      appendLog("请先生成设计与任务队列。", "warning");
      return;
    }

    const currentTask = currentQueueTask(taskPlan);
    if (!currentTask) {
      appendLog("当前没有可受控执行的任务。", "warning");
      return;
    }

    setRunningControlledTask(true);
    appendLog(`开始受控执行任务：${currentTask.id}`, "info");

    try {
      const result = await requestControlledTaskRun({ task, taskPlan, taskId: currentTask.id, autoReview: true });
      setControlledExecution(result);
      if (result.updatedTaskPlan) {
        setTaskPlan(result.updatedTaskPlan);
        setAutoDryRun(null);
        await saveCurrentRunRecord(true, { taskPlan: result.updatedTaskPlan, autoDryRun: null, controlledExecution: result });
      } else {
        await saveCurrentRunRecord(true, { controlledExecution: result });
      }
      appendLog(
        result.summary,
        result.status === "success" ? "success" : result.status === "blocked" || result.status === "error" ? "error" : "warning",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "受控单任务执行失败";
      appendLog(message, "error");
    } finally {
      setRunningControlledTask(false);
    }
  }

  async function dispatchCurrentTask() {
    if (!taskPlan) {
      appendLog("请先生成设计与任务队列。", "warning");
      return;
    }

    const currentTask = currentQueueTask(taskPlan);
    if (!currentTask) {
      appendLog("当前没有可派发任务。", "warning");
      return;
    }

    setDispatchingTask(true);
    appendLog(`开始派发任务：${currentTask.id}`, "info");

    try {
      const result = await requestTaskDispatch({ task, taskPlan, taskId: currentTask.id });
      setTaskDispatch(result);
      setAiAdapterRun(null);
      setControlledExecution(null);
      if (result.updatedTaskPlan) {
        setTaskPlan(result.updatedTaskPlan);
        setAutoDryRun(null);
        await saveCurrentRunRecord(true, { taskPlan: result.updatedTaskPlan, autoDryRun: null, controlledExecution: null });
      }
      await navigator.clipboard.writeText(result.promptContent);
      appendLog(`${result.summary} 已复制到剪贴板。`, "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : "任务派发失败";
      appendLog(message, "error");
    } finally {
      setDispatchingTask(false);
    }
  }

  async function reviewCurrentTaskReport() {
    if (!taskPlan) {
      appendLog("请先生成设计与任务队列。", "warning");
      return;
    }

    const currentTask = taskDispatch
      ? taskPlan.tasks.find((item) => item.id === taskDispatch.taskId) || currentQueueTask(taskPlan)
      : currentQueueTask(taskPlan);
    if (!currentTask) {
      appendLog("当前没有可 review 的任务。", "warning");
      return;
    }
    if (!taskReport.trim()) {
      appendLog("请先粘贴写代码 AI 完成报告。", "warning");
      return;
    }

    setReviewingTask(true);
    appendLog(`开始 review 任务：${currentTask.id}`, "info");

    try {
      const result = await requestTaskReview({
        task,
        taskPlan,
        taskId: currentTask.id,
        report: taskReport,
      });
      setTaskReview(result);
      if (result.updatedTaskPlan) {
        setTaskPlan(result.updatedTaskPlan);
        setAutoDryRun(null);
        setControlledExecution(null);
        await saveCurrentRunRecord(true, { taskPlan: result.updatedTaskPlan, autoDryRun: null, controlledExecution: null });
      }
      setTaskReport("");
      setTaskDispatch(null);
      appendLog(result.summary, result.decision === "approved" ? "success" : result.decision === "blocked" ? "error" : "warning");
    } catch (error) {
      const message = error instanceof Error ? error.message : "任务 review 失败";
      appendLog(message, "error");
    } finally {
      setReviewingTask(false);
    }
  }

  async function createFixTaskForIssue(issue: DeliveryIssue) {
    if (!taskPlan) {
      appendLog("请先生成设计与任务队列，再把问题转成修复任务。", "warning");
      setTab("result");
      return;
    }

    setCreatingIssueFixId(issue.id);
    appendLog(`开始为问题生成修复任务：${issue.id}`, "info");

    try {
      const result = await requestIssueFixTask({ task, taskPlan, issue });
      if (result.updatedTaskPlan) {
        setTaskPlan(result.updatedTaskPlan);
        setAutoDryRun(null);
        await saveCurrentRunRecord(true, { taskPlan: result.updatedTaskPlan, autoDryRun: null });
      }
      setTaskDispatch(null);
      setTaskReport("");
      appendLog(result.summary, "success");
      setTab("result");
    } catch (error) {
      const message = error instanceof Error ? error.message : "问题修复任务生成失败";
      appendLog(message, "error");
    } finally {
      setCreatingIssueFixId(null);
    }
  }

  async function writeCurrentKnowledge() {
    if (!task.permissions.allowKnowledgeWrite) {
      appendLog("当前没有授权写入知识库。", "warning");
      return;
    }

    setWritingKnowledge(true);
    appendLog("开始写入 Obsidian 知识库。", "info");

    try {
      const result = await requestKnowledgeWrite({ task, projectScan, steps, issues, validation: validationRun, markdown });
      setKnowledgeWrite(result);
      if (result.status === "success") {
        const nextRuntime = { ...runtime, "knowledge-write": "done" as StepStatus, "delivery-complete": "done" as StepStatus };
        setRuntime(nextRuntime);
        appendLog(result.summary, "success");
        await saveCurrentRunRecord(true, { knowledgeWrite: result, runtime: nextRuntime });
      } else {
        const nextRuntime = { ...runtime, "knowledge-write": "failed" as StepStatus };
        setRuntime(nextRuntime);
        appendLog(result.summary, "error");
        await saveCurrentRunRecord(true, { knowledgeWrite: result, runtime: nextRuntime });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "知识库写入失败";
      const failedWrite: KnowledgeWriteResult = {
        status: "error",
        knowledgeRoot: "",
        projectDirectory: "",
        moduleDirectory: "",
        writtenFiles: [],
        summary: message,
        generatedAt: new Date().toISOString(),
      };
      setKnowledgeWrite(failedWrite);
      const nextRuntime = { ...runtime, "knowledge-write": "failed" as StepStatus };
      setRuntime(nextRuntime);
      appendLog(message, "error");
      await saveCurrentRunRecord(true, { knowledgeWrite: failedWrite, runtime: nextRuntime });
    } finally {
      setWritingKnowledge(false);
    }
  }

  async function runCurrentValidation() {
    if (!task.permissions.allowRunCommands) {
      appendLog("当前没有授权运行命令。", "warning");
      return;
    }
    if (!task.projectPath.trim()) {
      appendLog("请先填写真实项目路径。", "warning");
      setTab("task");
      return;
    }

    setRunningValidation(true);
    setRuntime((current) => ({ ...current, "test-running": "running" }));
    appendLog("开始执行受控命令验收：typecheck / lint / build。", "info");

    try {
      const result = await requestValidationRun({ task, projectScan });
      setValidationRun(result);
      const finalStatus: StepStatus = result.status === "success" ? "done" : result.status === "error" ? "failed" : "risk";
      const nextRuntime = { ...runtime, "test-running": finalStatus };
      setRuntime(nextRuntime);
      appendLog(result.summary, finalStatus === "done" ? "success" : finalStatus === "risk" ? "warning" : "error");
      await saveCurrentRunRecord(true, { validationRun: result, runtime: nextRuntime });
    } catch (error) {
      const message = error instanceof Error ? error.message : "命令验收执行失败";
      const failedValidation: ValidationRunResult = {
        status: "error",
        projectPath: task.projectPath,
        packageManager: projectScan?.packageManager || "unknown",
        commands: [],
        summary: message,
        generatedAt: new Date().toISOString(),
      };
      setValidationRun(failedValidation);
      const nextRuntime = { ...runtime, "test-running": "failed" as StepStatus };
      setRuntime(nextRuntime);
      appendLog(message, "error");
      await saveCurrentRunRecord(true, { validationRun: failedValidation, runtime: nextRuntime });
    } finally {
      setRunningValidation(false);
    }
  }

  async function runCurrentPageSmoke() {
    if (!task.permissions.allowRunCommands) {
      appendLog("当前没有授权运行点测。", "warning");
      return;
    }
    if (!task.pageUrl.trim()) {
      appendLog("请先在任务包里填写页面点测 URL。", "warning");
      setTab("task");
      return;
    }

    setRunningPageSmoke(true);
    appendLog(`开始轻量页面点测：${task.pageUrl}`, "info");

    try {
      const result = await requestPageSmokeTest({ task, projectScan, taskPlan });
      setPageSmoke(result);
      appendLog(
        result.summary,
        result.status === "success" || result.status === "skipped"
          ? "success"
          : result.status === "warning"
            ? "warning"
            : "error",
      );
      await saveCurrentRunRecord(true, { pageSmoke: result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "页面点测执行失败";
      const failedSmoke: PageSmokeTestResult = {
        status: "error",
        url: task.pageUrl,
        httpStatus: null,
        title: "",
        bodyLength: 0,
        checkedKeywords: [],
        missingKeywords: [],
        detectedErrors: [],
        checks: [{ name: "runner", status: "failed", message }],
        knowledgeRoot: "",
        projectDirectory: "",
        moduleDirectory: "",
        smokeFile: "",
        summary: message,
        generatedAt: new Date().toISOString(),
      };
      setPageSmoke(failedSmoke);
      appendLog(message, "error");
      await saveCurrentRunRecord(true, { pageSmoke: failedSmoke });
    } finally {
      setRunningPageSmoke(false);
    }
  }

  async function finalizeCurrentDelivery() {
    if (!taskPlan) {
      appendLog("请先生成设计与任务队列。", "warning");
      return;
    }

    setFinalizingAcceptance(true);
    appendLog("开始生成总验收与知识沉淀。", "info");

    try {
      const result = await requestFinalAcceptance({
        task,
        taskPlan,
        issues,
        validationRun,
        pageSmoke,
        knowledgeWrite,
      });
      setFinalAcceptance(result);
      appendLog(result.summary, result.status === "success" ? "success" : result.status === "blocked" || result.status === "error" ? "error" : "warning");
      await saveCurrentRunRecord(true, { finalAcceptance: result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "总验收生成失败";
      const failedAcceptance: FinalAcceptanceResult = {
        status: "error",
        knowledgeRoot: "",
        projectDirectory: "",
        moduleDirectory: "",
        planDirectory: "",
        acceptanceFile: "",
        ruleSuggestionFile: "",
        writtenFiles: [],
        taskSummary: {
          total: 0,
          done: 0,
          pending: 0,
          assigned: 0,
          needsFix: 0,
          blocked: 0,
        },
        findings: [message],
        rules: [],
        summary: message,
        generatedAt: new Date().toISOString(),
      };
      setFinalAcceptance(failedAcceptance);
      appendLog(message, "error");
      await saveCurrentRunRecord(true, { finalAcceptance: failedAcceptance });
    } finally {
      setFinalizingAcceptance(false);
    }
  }

  async function applyAutoAdvanceResult(result: AutoAdvanceResult) {
    setLastAutoAdvance(result);

    const overrides: Partial<DeliveryRunRecord> = {};
    if (result.contextPackage) {
      setContextPackage(result.contextPackage);
      overrides.contextPackage = result.contextPackage;
    }
    if (result.executionPackage) {
      setExecutionPackage(result.executionPackage);
      overrides.executionPackage = result.executionPackage;
    }
    if (result.taskPlan) {
      setTaskPlan(result.taskPlan);
      setAutoDryRun(null);
      overrides.taskPlan = result.taskPlan;
      overrides.autoDryRun = null;
    }
    if (result.taskDispatch) {
      setTaskDispatch(result.taskDispatch);
      overrides.taskPlan = result.taskDispatch.updatedTaskPlan || result.taskPlan || taskPlan;
    }
    if (result.controlledExecution) {
      setControlledExecution(result.controlledExecution);
      overrides.controlledExecution = result.controlledExecution;
      overrides.taskPlan = result.controlledExecution.updatedTaskPlan || result.taskPlan || taskPlan;
    }
    if (result.validationRun) {
      setValidationRun(result.validationRun);
      const finalStatus: StepStatus = result.validationRun.status === "success" ? "done" : result.validationRun.status === "error" ? "failed" : "risk";
      const nextRuntime = { ...runtime, "test-running": finalStatus };
      setRuntime(nextRuntime);
      overrides.validationRun = result.validationRun;
      overrides.runtime = nextRuntime;
    }
    if (result.pageSmoke) {
      setPageSmoke(result.pageSmoke);
      overrides.pageSmoke = result.pageSmoke;
    }
    if (result.knowledgeWrite) {
      setKnowledgeWrite(result.knowledgeWrite);
      const finalStatus: StepStatus = result.knowledgeWrite.status === "success" ? "done" : "failed";
      const nextRuntime = { ...runtime, "knowledge-write": finalStatus, "delivery-complete": result.knowledgeWrite.status === "success" ? "done" : runtime["delivery-complete"] };
      setRuntime(nextRuntime);
      overrides.knowledgeWrite = result.knowledgeWrite;
      overrides.runtime = nextRuntime;
    }
    if (result.finalAcceptance) {
      setFinalAcceptance(result.finalAcceptance);
      overrides.finalAcceptance = result.finalAcceptance;
    }

    appendLog(result.summary, result.status === "success" ? "success" : result.status === "blocked" || result.status === "error" ? "error" : "warning");
    await saveCurrentRunRecord(true, overrides);
  }

  async function autoAdvanceCurrentRun() {
    setAutoAdvancing(true);
    appendLog("系统 AI 开始自动推进一个安全小步。", "info");

    try {
      const result = await requestAutoAdvanceOnce({
        task,
        projectScan,
        steps,
        issues,
        validationRun,
        pageSmoke,
        knowledgeWrite,
        finalAcceptance,
        taskPlan,
        markdown,
      });
      await applyAutoAdvanceResult(result);
    } catch (error) {
      const message = error instanceof Error ? "自动推进失败" : "自动推进失败";
      appendLog(error instanceof Error ? error.message : message, "error");
    } finally {
      setAutoAdvancing(false);
    }
  }

  async function autoRunCurrentRunUntilPause() {
    setAutoRunning(true);
    appendLog("系统 AI 开始自动运行到暂停点。", "info");

    try {
      const result = await requestAutoRunUntilPause({
        task,
        projectScan,
        steps,
        issues,
        validationRun,
        pageSmoke,
        knowledgeWrite,
        finalAcceptance,
        taskPlan,
        markdown,
        maxSteps: 20,
      });
      await applyAutoAdvanceResult(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "自动运行失败";
      appendLog(message, "error");
    } finally {
      setAutoRunning(false);
    }
  }

  const blockingIssues = issues.filter((item) => item.level === "P0" && !item.canContinue);
  const continuableIssues = issues.filter((item) => item.level !== "P0" || item.canContinue);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">交</div>
          <div>
            <strong>模块项目交付控制台</strong>
            <span>一次性任务包到自动交付</span>
          </div>
        </div>

        <nav className="nav-list" aria-label="主导航">
          {[
            ["task", "任务包"],
            ["plan", "执行看板"],
            ["issues", "风险归档"],
            ["result", "交付结果"],
          ].map(([key, label]) => (
            <button key={key} className={tab === key ? "active" : ""} onClick={() => setTab(key as TabKey)}>
              {label}
            </button>
          ))}
        </nav>

        <div className="side-summary">
          <span>执行进度</span>
          <strong>{progress}%</strong>
          <div className="progress-track">
            <div style={{ width: `${progress}%` }} />
          </div>
        </div>

        <div className="status-counts">
          {statusOrder.map((status) => (
            <div key={status}>
              <span>{statusText[status]}</span>
              <strong>{steps.filter((step) => step.status === status).length}</strong>
            </div>
          ))}
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <p className="eyebrow">Delivery Knowledge System</p>
            <h1>自动交付任务控制台</h1>
          </div>
          <div className="top-actions">
            <button className="secondary-button" onClick={resetAll}>
              重置
            </button>
            <button className="secondary-button" onClick={checkSystemHealth} disabled={checkingHealth}>
              {checkingHealth ? "自检中" : "系统自检"}
            </button>
            <button className="secondary-button" onClick={scanCurrentProject} disabled={scanning}>
              {scanning ? "扫描中" : "扫描项目"}
            </button>
            <button className="primary-button" onClick={startDryRun}>
              启动交付演练
            </button>
          </div>
        </header>

        <SystemHealthPanel result={systemHealth} />

        <RunRecordPanel
          runId={currentRunId}
          result={runRecordSave}
          saving={savingRunRecord}
          loading={loadingRunRecord}
          onSave={() => void saveCurrentRunRecord(false)}
          onLoad={() => void restoreRunRecord()}
        />

        <RunHistoryPanel
          runs={runHistory}
          loading={loadingRunHistory}
          onRefresh={() => void refreshRunHistory(false)}
          onRestore={(runId) => void restoreRunRecord(runId)}
        />

        {tab === "task" ? (
          <section className="content-section">
            <div className="section-head">
              <div>
                <h2>一次性任务包</h2>
                <p>把项目路径、模块需求、接口资料、样式资料和授权一次性给齐。当前阶段生成计划和 Markdown，第三阶段再受控写真实项目。</p>
              </div>
            </div>

            <MaterialStageGuide task={task} projectScan={projectScan} validationRun={validationRun} knowledgeWrite={knowledgeWrite} />

            <div className="form-grid">
              <div className="field">
                <FieldLabel title="项目名称" hint="用于生成项目实例目录" />
                <TextInput value={task.projectName} onChange={(value) => updateTask("projectName", value)} placeholder="例如 gil-business-web" />
              </div>
              <div className="field">
                <FieldLabel title="真实项目路径" hint="第三阶段中 runner 会进入这个目录" />
                <TextInput
                  value={task.projectPath}
                  onChange={(value) => updateTask("projectPath", value)}
                  placeholder="/Users/wangxiaoyu/Desktop/object/gil-business-web"
                />
              </div>
              <div className="field">
                <FieldLabel title="模块名称" hint="本次要新增或修改的模块" />
                <TextInput value={task.moduleName} onChange={(value) => updateTask("moduleName", value)} placeholder="例如 客户库 / 代理商管理" />
              </div>
              <div className="field wide">
                <FieldLabel title="需求说明" hint="尽量一次性说清楚要做什么、不要做什么、验收标准" />
                <TextArea
                  value={task.requirement}
                  onChange={(value) => updateTask("requirement", value)}
                  rows={6}
                  placeholder="描述模块目标、页面范围、业务规则、预期交付结果。"
                />
              </div>
              <div className="field">
                <FieldLabel title="接口文档" hint="一行一个路径或链接" />
                <TextArea
                  value={task.apiDocs}
                  onChange={(value) => updateTask("apiDocs", value)}
                  placeholder="/Users/wangxiaoyu/Desktop/object/gil-business-jiekou/接口文档.md"
                />
              </div>
              <div className="field">
                <FieldLabel title="Demo / 设计图" hint="一行一个路径或链接" />
                <TextArea
                  value={task.demos}
                  onChange={(value) => updateTask("demos", value)}
                  placeholder="/Users/wangxiaoyu/Downloads/Demo/xxx.html"
                />
              </div>
              <div className="field">
                <FieldLabel title="旧项目参考" hint="只能参考样式和交互，不能当接口真相" />
                <TextArea
                  value={task.oldProjects}
                  onChange={(value) => updateTask("oldProjects", value)}
                  placeholder="/Users/wangxiaoyu/Desktop/object/gil-business-web-old/gil-business-web"
                />
              </div>
              <div className="field">
                <FieldLabel title="PRD / 需求资料" hint="一行一个路径或链接" />
                <TextArea value={task.prds} onChange={(value) => updateTask("prds", value)} placeholder="飞书文档、本地 Markdown、截图说明。" />
              </div>
              <div className="field">
                <FieldLabel title="页面点测 URL" hint="本地或测试环境页面地址" />
                <TextInput value={task.pageUrl} onChange={(value) => updateTask("pageUrl", value)} placeholder="http://localhost:1688/agent-list" />
              </div>
              <div className="field">
                <FieldLabel title="点测关键词" hint="一行一个页面应出现的文本" />
                <TextArea
                  value={task.smokeKeywords}
                  onChange={(value) => updateTask("smokeKeywords", value)}
                  placeholder="模块标题&#10;关键按钮&#10;表格列名"
                />
              </div>
            </div>

            <div className="permission-grid">
              {(Object.keys(permissionLabels) as PermissionKey[]).map((key) => (
                <label className="permission-card" key={key}>
                  <input type="checkbox" checked={task.permissions[key]} onChange={(event) => updatePermission(key, event.target.checked)} />
                  <span>
                    <strong>{permissionLabels[key].title}</strong>
                    <small>{permissionLabels[key].description}</small>
                  </span>
                </label>
              ))}
            </div>
          </section>
        ) : null}

        {tab === "plan" ? (
          <section className="content-section">
            <div className="section-head">
              <div>
                <h2>执行状态卡片</h2>
                <p>这些卡片不是审批节点，而是 AI 自动交付时的内部进度。普通风险会归档并继续执行，真正危险才阻断。</p>
              </div>
            </div>
            <ExecutionDecisionPanel decision={executionDecision} />
            <div className="step-grid">
              {steps.map((step, index) => (
                <StepCard key={step.id} step={step} index={index} />
              ))}
            </div>
            <ProjectScanPanel scan={projectScan} />
            <ModuleDependencyGraph task={task} projectScan={projectScan} steps={steps} validationRun={validationRun} knowledgeWrite={knowledgeWrite} />
            <section className="flat-panel">
              <h2>依赖关系</h2>
              <DependencyRows steps={steps} />
            </section>
          </section>
        ) : null}

        {tab === "issues" ? (
          <section className="content-section">
            <div className="section-head">
              <div>
                <h2>风险归档</h2>
                <p>默认不中断自动交付。只有无法继续、会破坏项目或权限不足的 P0 才阻断。</p>
              </div>
            </div>
            <div className="issue-layout">
              <section className="flat-panel">
                <h3>阻断问题</h3>
                {blockingIssues.length ? (
                  <IssueTable
                    issues={blockingIssues}
                    taskPlan={taskPlan}
                    creatingIssueFixId={creatingIssueFixId}
                    onCreateIssueFix={(issue) => void createFixTaskForIssue(issue)}
                  />
                ) : (
                  <p className="empty-text">暂无必须打断任务的问题。</p>
                )}
              </section>

              <section className="flat-panel">
                <h3>可继续执行的问题</h3>
                {continuableIssues.length ? (
                  <IssueTable
                    issues={continuableIssues}
                    taskPlan={taskPlan}
                    creatingIssueFixId={creatingIssueFixId}
                    onCreateIssueFix={(issue) => void createFixTaskForIssue(issue)}
                  />
                ) : (
                  <p className="empty-text">暂无可继续执行的问题。</p>
                )}
              </section>
            </div>

            <section className="flat-panel">
              <h3>规则沉淀建议</h3>
              {issueRules.length ? (
                <div className="rule-suggestion-list">
                  {issueRules.map((item) => (
                    <div className="rule-suggestion-row" key={item}>
                      <strong>规则</strong>
                      <span>{item}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="empty-text">暂无由运行问题推导出的新规则。</p>
              )}
            </section>

            <section className="flat-panel">
              <h3>运行日志</h3>
              {logs.length ? (
                <div className="log-list">
                  {logs.map((log) => (
                    <div className={`log-row log-${log.level}`} key={log.id}>
                      <time>{log.createdAt}</time>
                      <span>{log.message}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="empty-text">还没有运行日志。点击“启动交付演练”后会记录状态。</p>
              )}
            </section>
          </section>
        ) : null}

        {tab === "result" ? (
          <section className="content-section">
            <div className="section-head">
              <div>
                <h2>交付结果和 Markdown</h2>
                <p>当前阶段生成可复制的 Markdown，并可把内容写回 Obsidian 知识库和项目实例目录。</p>
              </div>
              <div className="top-actions">
                <button className="primary-button" onClick={autoAdvanceCurrentRun} disabled={autoAdvancing}>
                  {autoAdvancing ? "推进中" : "自动推进一步"}
                </button>
                <button className="primary-button" onClick={autoRunCurrentRunUntilPause} disabled={autoRunning || autoAdvancing}>
                  {autoRunning ? "运行中" : "自动运行到暂停点"}
                </button>
                <button className="secondary-button" onClick={prepareCurrentContextPackage} disabled={preparingContext}>
                  {preparingContext ? "生成中" : "生成 AI 上下文包"}
                </button>
                <button className="secondary-button" onClick={prepareCurrentExecutionPackage} disabled={preparingExecution}>
                  {preparingExecution ? "生成中" : "生成 AI 交付执行包"}
                </button>
                <button className="secondary-button" onClick={prepareCurrentTaskPlan} disabled={preparingTaskPlan}>
                  {preparingTaskPlan ? "生成中" : "生成设计与任务队列"}
                </button>
                <button className="secondary-button" onClick={loadCurrentTaskPlan} disabled={loadingTaskPlan}>
                  {loadingTaskPlan ? "恢复中" : "恢复任务队列"}
                </button>
                <button className="secondary-button" onClick={runCurrentValidation} disabled={runningValidation}>
                  {runningValidation ? "验收中" : "执行命令验收"}
                </button>
                <button className="secondary-button" onClick={runCurrentPageSmoke} disabled={runningPageSmoke}>
                  {runningPageSmoke ? "点测中" : "轻量页面点测"}
                </button>
                <button className="secondary-button" onClick={writeCurrentKnowledge} disabled={writingKnowledge}>
                  {writingKnowledge ? "写入中" : "写入知识库"}
                </button>
                <button className="secondary-button" onClick={finalizeCurrentDelivery} disabled={finalizingAcceptance}>
                  {finalizingAcceptance ? "生成中" : "生成总验收"}
                </button>
                <button className="primary-button" onClick={copyMarkdown}>
                  {copied ? "已复制" : "复制 Markdown"}
                </button>
              </div>
            </div>
            <ExecutionDecisionPanel decision={executionDecision} />
            {lastAutoAdvance ? (
              <section className={`flat-panel auto-advance-result auto-advance-${lastAutoAdvance.status}`}>
                <div>
                  <span>最近自动推进</span>
                  <strong>{lastAutoAdvance.action}</strong>
                </div>
                <p>{lastAutoAdvance.summary}</p>
                <small>下一步：{lastAutoAdvance.nextAction}</small>
                {lastAutoAdvance.steps?.length ? (
                  <ul>
                    {lastAutoAdvance.steps.map((step, index) => (
                      <li key={`${step.action}-${index}`}>
                        {index + 1}. {step.action} / {step.status}：{step.summary}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
            ) : null}
            <DeliveryControlPanel
              taskPlan={taskPlan}
              reviewResult={taskReview}
              pageSmoke={pageSmoke}
              validationRun={validationRun}
              knowledgeWrite={knowledgeWrite}
              finalAcceptance={finalAcceptance}
            />
            <ContextPackagePanel result={contextPackage} />
            <ExecutionPackagePanel result={executionPackage} />
            <TaskPlanPanel
              result={taskPlan}
              autoDryRun={autoDryRun}
              aiAdapterStatus={aiAdapterStatus}
              aiAdapterRun={aiAdapterRun}
              controlledExecution={controlledExecution}
              dispatchedPrompt={taskDispatch}
              report={taskReport}
              reviewResult={taskReview}
              dispatching={dispatchingTask}
              reviewing={reviewingTask}
              preparingAutoDryRun={preparingAutoDryRun}
              checkingAiAdapter={checkingAiAdapter}
              runningAiAdapter={runningAiAdapter}
              runningControlledTask={runningControlledTask}
              onPrepareAutoDryRun={() => void prepareCurrentAutoDryRun()}
              onCheckAiAdapter={() => void checkCurrentAiAdapter()}
              onRunAiAdapter={() => void runCurrentTaskWithAiAdapter()}
              onRunControlledTask={() => void runCurrentControlledTask()}
              onDispatch={() => void dispatchCurrentTask()}
              onReportChange={setTaskReport}
              onReview={() => void reviewCurrentTaskReport()}
            />
            <ValidationRunPanel result={validationRun} />
            <PageSmokePanel result={pageSmoke} />
            <KnowledgeWritePanel result={knowledgeWrite} />
            <FinalAcceptancePanel result={finalAcceptance} />
            <pre className="markdown-preview">{markdown}</pre>
          </section>
        ) : null}
      </main>
    </div>
  );
}

export default App;
