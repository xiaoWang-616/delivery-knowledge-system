import type { DeliveryIssue, DeliveryTask, ProjectScanResult, WorkflowStep } from "./types";

function lines(value: string) {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

function list(value: string) {
  const items = lines(value);
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- 未提供";
}

function issueRows(issues: DeliveryIssue[]) {
  if (issues.length === 0) {
    return "| 无 | 无 | 无 | 无 | 无 |\n";
  }
  return issues
    .map((item) => `| ${item.id} | ${item.level} | ${item.title} | ${item.owner} | ${item.canContinue ? "继续执行" : "需要阻断"} |`)
    .join("\n");
}

function stepRows(steps: WorkflowStep[]) {
  return steps
    .map((step) => `| ${step.title} | ${step.status} | ${step.dependsOn.join(", ") || "无"} | ${step.output} |`)
    .join("\n");
}

function projectScanMarkdown(scan?: ProjectScanResult | null) {
  if (!scan) {
    return "未扫描真实项目。";
  }

  return `| 字段 | 内容 |
| --- | --- |
| 扫描状态 | ${scan.status} |
| 项目名 | ${scan.projectName || "未识别"} |
| 包管理器 | ${scan.packageManager} |
| 技术栈 | ${scan.frameworks.join(" / ") || "待确认"} |
| 关键目录 | ${scan.keyDirectories.join("、") || "未识别"} |
| 规则文件 | ${scan.ruleFiles.join("、") || "未发现"} |
| 风险提示 | ${scan.warnings.join("；") || "无"} |`;
}

export function generateDeliveryMarkdown(task: DeliveryTask, steps: WorkflowStep[], issues: DeliveryIssue[], projectScan?: ProjectScanResult | null) {
  return `# 自动交付任务包：${task.moduleName || "未命名模块"}

## 1. 基本信息

| 字段 | 内容 |
| --- | --- |
| 项目名称 | ${task.projectName || "未填写"} |
| 项目路径 | ${task.projectPath || "未填写"} |
| 模块名称 | ${task.moduleName || "未填写"} |

## 2. 需求说明

\`\`\`text
${task.requirement || "未填写"}
\`\`\`

## 3. 资料输入

### 接口文档

${list(task.apiDocs)}

### Demo / 设计图

${list(task.demos)}

### PRD / 需求资料

${list(task.prds)}

## 4. 自动化授权

| 权限 | 是否允许 |
| --- | --- |
| 自动写代码 | ${task.permissions.allowWriteCode ? "是" : "否"} |
| 自动运行命令 | ${task.permissions.allowRunCommands ? "是" : "否"} |
| 自动修复问题 | ${task.permissions.allowAutoFix ? "是" : "否"} |
| 自动写入知识库 | ${task.permissions.allowKnowledgeWrite ? "是" : "否"} |

## 5. 项目画像

${projectScanMarkdown(projectScan)}

## 6. 执行计划

| 步骤 | 状态 | 依赖 | 输出 |
| --- | --- | --- | --- |
${stepRows(steps)}

## 7. 风险和问题

| 编号 | 等级 | 问题 | 责任方 | 处理方式 |
| --- | --- | --- | --- | --- |
${issueRows(issues)}

## 8. 给 AI 的自动交付提示词

\`\`\`text
请读取 /Users/wangxiaoyu/Documents/delivery-knowledge-system/README.md 和 11-规则库。

真实项目路径：
${task.projectPath || "未填写"}

模块名称：
${task.moduleName || "未填写"}

需求说明：
${task.requirement || "未填写"}

接口资料：
${lines(task.apiDocs).join("\n") || "未提供"}

Demo / 设计图：
${lines(task.demos).join("\n") || "未提供"}

PRD：
${lines(task.prds).join("\n") || "未提供"}

执行方式：
一次性自动完成模块交付。你需要内部拆步骤执行，不要每一步都要求人工确认。
除非继续执行会破坏项目、路径不存在、权限不足或需求冲突，否则记录风险并继续推进可完成部分。

完成后输出：
1. 改动文件
2. 完成功能
3. 测试结果
4. 未解决问题
5. 知识沉淀
\`\`\`

## 9. 知识沉淀建议

- 通用规则沉淀到：\`11-规则库\`
- 项目特有规则沉淀到：\`08-项目实例/${task.projectName || "项目名"}\`
- 模块执行记录沉淀到：\`08-项目实例/${task.projectName || "项目名"}/${task.moduleName || "模块名"}\`
`;
}
