import type { DeliveryIssue, DeliveryTask, ProjectScanResult, RuntimeState, StepStatus, WorkflowStep } from "./types";

const knowledgeRoot = "/Users/wangxiaoyu/Documents/delivery-knowledge-system";

function filled(value: string) {
  return value.trim().length > 0;
}

function listLines(value: string) {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

function issue(
  id: string,
  level: DeliveryIssue["level"],
  title: string,
  description: string,
  owner: DeliveryIssue["owner"],
  canContinue: boolean,
): DeliveryIssue {
  return { id, level, title, description, owner, canContinue };
}

function mergeRuntime(status: StepStatus, runtime?: StepStatus): StepStatus {
  if (status === "locked" || status === "failed") {
    return status;
  }
  if (!runtime) {
    return status;
  }
  if (runtime === "running") {
    return "running";
  }
  if (runtime === "done" && status === "risk") {
    return "risk";
  }
  return runtime;
}

function hasDoneOrRisk(step?: WorkflowStep) {
  return step?.status === "done" || step?.status === "risk";
}

function statusFromIssues(required: boolean, issues: DeliveryIssue[]): StepStatus {
  if (!required) {
    return "locked";
  }
  if (issues.some((item) => item.level === "P0" && !item.canContinue)) {
    return "failed";
  }
  if (issues.length > 0) {
    return "risk";
  }
  return "pending";
}

export function evaluateWorkflow(task: DeliveryTask, runtime: RuntimeState, projectScan?: ProjectScanResult | null): WorkflowStep[] {
  const steps: WorkflowStep[] = [];
  const apiDocs = listLines(task.apiDocs);
  const demos = listLines(task.demos);
  const oldProjects = listLines(task.oldProjects);
  const prds = listLines(task.prds);

  const taskIssues: DeliveryIssue[] = [];
  if (!filled(task.projectPath)) {
    taskIssues.push(issue("T-PATH", "P0", "缺少项目路径", "没有项目路径就无法进入真实项目执行。", "用户", false));
  }
  if (!filled(task.moduleName)) {
    taskIssues.push(issue("T-MODULE", "P0", "缺少模块名称", "没有模块名称就无法生成模块级交付计划。", "用户", false));
  }
  if (!filled(task.requirement)) {
    taskIssues.push(issue("T-REQ", "P0", "缺少模块需求", "没有需求说明，AI 无法判断要新增还是修改什么。", "用户", false));
  }

  const taskStatus = statusFromIssues(true, taskIssues);
  steps.push({
    id: "task-package",
    title: "任务包接收",
    description: "一次性收集项目路径、模块需求、资料路径和自动化授权。",
    dependsOn: [],
    status: mergeRuntime(taskStatus, runtime["task-package"]),
    output: filled(task.projectPath) ? `项目路径：${task.projectPath}` : "等待填写项目路径",
    issues: taskIssues,
  });

  const projectIssues: DeliveryIssue[] = [];
  if (!filled(task.projectPath)) {
    projectIssues.push(issue("P-PATH", "P0", "项目扫描被锁定", "项目路径未填写，不能生成项目画像。", "用户", false));
  }
  if (projectScan?.status === "missing") {
    projectIssues.push(issue("P-MISSING", "P0", "项目路径不存在", "runner 没有找到这个真实项目路径，必须修正路径后才能继续自动交付。", "用户", false));
  }
  if (projectScan?.status === "error") {
    projectIssues.push(issue("P-SCAN", "P0", "项目扫描失败", projectScan.summary, "AI", false));
  }
  const projectStatus = hasDoneOrRisk(steps[0]) ? statusFromIssues(true, projectIssues) : "locked";
  steps.push({
    id: "project-scan",
    title: "项目扫描",
    description: "识别技术栈、路由、接口封装、组件目录、样式入口和测试命令。",
    dependsOn: ["task-package"],
    status: mergeRuntime(projectStatus, runtime["project-scan"]),
    output: projectScan?.status === "success" ? projectScan.summary : projectStatus === "locked" ? "等待任务包完成" : "可以点击“扫描项目”生成真实项目画像。",
    issues: projectIssues,
  });

  const ruleIssues: DeliveryIssue[] = [];
  if (apiDocs.length === 0) {
    ruleIssues.push(issue("R-API", "P1", "接口资料缺失", "可以继续搭建模块结构，但接口能力矩阵只能标记为待补充。", "用户", true));
  }
  if (demos.length === 0) {
    ruleIssues.push(issue("R-STYLE", "P1", "样式资料缺失", "没有 Demo 或设计图时，只能按项目现有风格生成样式方案。", "设计", true));
  }
  const ruleStatus = hasDoneOrRisk(steps[1]) ? statusFromIssues(true, ruleIssues) : "locked";
  steps.push({
    id: "rule-loading",
    title: "规则读取",
    description: `读取 ${knowledgeRoot}/11-规则库 和项目内 AI 编码规则。`,
    dependsOn: ["project-scan"],
    status: mergeRuntime(ruleStatus, runtime["rule-loading"]),
    output: "接口、样式、性能、AI 写代码、项目差异规则进入执行上下文。",
    issues: ruleIssues,
  });

  const moduleIssues: DeliveryIssue[] = [];
  if (!filled(task.moduleName)) {
    moduleIssues.push(issue("M-NAME", "P0", "模块名称缺失", "不能建立模块状态卡片和模块目录。", "用户", false));
  }
  if (!filled(task.requirement)) {
    moduleIssues.push(issue("M-REQ", "P0", "模块需求缺失", "不能判断页面范围、接口范围和验收标准。", "用户", false));
  }
  const moduleStatus = hasDoneOrRisk(steps[2]) ? statusFromIssues(true, moduleIssues) : "locked";
  steps.push({
    id: "module-analysis",
    title: "模块依赖分析",
    description: "生成模块范围、依赖页面、依赖接口、依赖组件和 P0/P1/P2 风险。",
    dependsOn: ["rule-loading"],
    status: mergeRuntime(moduleStatus, runtime["module-analysis"]),
    output: filled(task.moduleName) ? `模块：${task.moduleName}` : "等待模块名称",
    issues: moduleIssues,
  });

  const apiIssues: DeliveryIssue[] = [];
  if (apiDocs.length === 0) {
    apiIssues.push(issue("A-DOC", "P1", "接口能力矩阵降级", "接口文档未提供，矩阵会标记接口能力待确认。", "后端", true));
  }
  const apiStatus = hasDoneOrRisk(steps[3]) ? statusFromIssues(true, apiIssues) : "locked";
  steps.push({
    id: "api-matrix",
    title: "接口能力矩阵",
    description: "根据接口文档判断请求路径、参数、响应字段、分页结构和缺口。",
    dependsOn: ["module-analysis"],
    status: mergeRuntime(apiStatus, runtime["api-matrix"]),
    output: apiDocs.length > 0 ? `已接收 ${apiDocs.length} 份接口资料。` : "等待后续补充接口文档。",
    issues: apiIssues,
  });

  const planIssues: DeliveryIssue[] = [];
  if (prds.length === 0) {
    planIssues.push(issue("D-PRD", "P1", "PRD 缺失", "会按任务描述生成开发计划，但业务边界可能需要后续确认。", "用户", true));
  }
  const planStatus = hasDoneOrRisk(steps[4]) ? statusFromIssues(true, planIssues) : "locked";
  steps.push({
    id: "delivery-plan",
    title: "执行计划生成",
    description: "生成内部执行步骤，不要求用户逐步确认，只作为进度可视化。",
    dependsOn: ["api-matrix"],
    status: mergeRuntime(planStatus, runtime["delivery-plan"]),
    output: "计划包含项目画像、资料包、代码开发、测试、修复和知识沉淀。",
    issues: planIssues,
  });

  const codeIssues: DeliveryIssue[] = [];
  if (!task.permissions.allowWriteCode) {
    codeIssues.push(issue("C-PERM", "P0", "未授权写代码", "用户未授权自动写代码，代码开发步骤被锁定。", "用户", false));
  }
  const codeStatus = hasDoneOrRisk(steps[5]) ? statusFromIssues(true, codeIssues) : "locked";
  steps.push({
    id: "code-development",
    title: "代码开发",
    description: "根据执行计划进入真实项目新增或修改代码。",
    dependsOn: ["delivery-plan"],
    status: mergeRuntime(codeStatus, runtime["code-development"]),
    output: task.permissions.allowWriteCode ? "已授权写代码；第三阶段由 runner 和 AI 受控执行。" : "等待写代码授权。",
    issues: codeIssues,
  });

  const testIssues: DeliveryIssue[] = [];
  if (!task.permissions.allowRunCommands) {
    testIssues.push(issue("T-CMD", "P1", "未授权运行命令", "不能自动跑 typecheck/lint/build，只能生成测试清单。", "用户", true));
  }
  const testStatus = hasDoneOrRisk(steps[6]) ? statusFromIssues(true, testIssues) : "locked";
  steps.push({
    id: "test-running",
    title: "测试执行",
    description: "执行类型检查、lint、build、页面点测、接口和样式验收。",
    dependsOn: ["code-development"],
    status: mergeRuntime(testStatus, runtime["test-running"]),
    output: task.permissions.allowRunCommands ? "已授权执行命令。" : "命令执行未授权，记录为风险。",
    issues: testIssues,
  });

  const fixIssues: DeliveryIssue[] = [];
  if (!task.permissions.allowAutoFix) {
    fixIssues.push(issue("F-PERM", "P1", "未授权自动修复", "测试问题会归档，但不会自动修改代码。", "用户", true));
  }
  const fixStatus = hasDoneOrRisk(steps[7]) ? statusFromIssues(true, fixIssues) : "locked";
  steps.push({
    id: "auto-fix",
    title: "自动修复",
    description: "根据问题清单进行二次修复，尽量不断开用户流程。",
    dependsOn: ["test-running"],
    status: mergeRuntime(fixStatus, runtime["auto-fix"]),
    output: task.permissions.allowAutoFix ? "已授权自动修复。" : "自动修复未授权，仅生成修复提示词。",
    issues: fixIssues,
  });

  const knowledgeIssues: DeliveryIssue[] = [];
  if (!task.permissions.allowKnowledgeWrite) {
    knowledgeIssues.push(issue("K-PERM", "P1", "未授权写知识库", "可生成沉淀预览，但不会自动写入 Markdown。", "用户", true));
  }
  if (oldProjects.length > 0 && demos.length === 0) {
    knowledgeIssues.push(issue("K-STYLE", "P2", "旧项目参考优先级待确认", "有旧项目但没有 Demo，样式优先级需要在沉淀中标注。", "设计", true));
  }
  const knowledgeStatus = hasDoneOrRisk(steps[8]) ? statusFromIssues(true, knowledgeIssues) : "locked";
  steps.push({
    id: "knowledge-write",
    title: "知识沉淀",
    description: "生成项目实例、模块看板、问题卡片、规则沉淀和交付报告。",
    dependsOn: ["auto-fix"],
    status: mergeRuntime(knowledgeStatus, runtime["knowledge-write"]),
    output: task.permissions.allowKnowledgeWrite ? "已授权写知识库。" : "仅生成 Markdown 预览。",
    issues: knowledgeIssues,
  });

  const completeStatus = hasDoneOrRisk(steps[9]) ? mergeRuntime("pending", runtime["delivery-complete"]) : "locked";
  steps.push({
    id: "delivery-complete",
    title: "交付完成",
    description: "输出最终报告，列出改动、测试、风险、未解决问题和沉淀规则。",
    dependsOn: ["knowledge-write"],
    status: completeStatus,
    output: runtime["delivery-complete"] === "done" ? "交付报告已生成，可复制 Markdown 给 AI 或沉淀到知识库。" : "等待自动交付链路完成。",
    issues: [],
  });

  return steps;
}

export function collectIssues(steps: WorkflowStep[]): DeliveryIssue[] {
  return steps.flatMap((step) => step.issues);
}

export function summarizeProgress(steps: WorkflowStep[]) {
  const executable = steps.filter((step) => step.status !== "locked");
  const complete = executable.filter((step) => step.status === "done" || step.status === "risk").length;
  const total = executable.length || 1;
  return Math.round((complete / total) * 100);
}
