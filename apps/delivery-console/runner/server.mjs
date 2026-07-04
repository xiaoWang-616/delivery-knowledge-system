import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.env.DELIVERY_RUNNER_PORT || 5176);
const runnerDirectory = dirname(fileURLToPath(import.meta.url));
const knowledgeRoot = process.env.DELIVERY_KB_ROOT || join(runnerDirectory, "../../..");
const helperCacheRoot = join(knowledgeRoot, "项目历史辅助文件");
const codingAgentProtocolPath = join(knowledgeRoot, "02-模块交付", "写代码AI单任务协议.md");
const aiProvider = String(process.env.DELIVERY_AI_PROVIDER || "manual").trim().toLowerCase();
const aiCommand = String(process.env.DELIVERY_AI_COMMAND || "").trim();
const aiCommandArgs = String(process.env.DELIVERY_AI_ARGS || "").trim();
const aiCommandTimeoutMs = Math.max(30000, Number(process.env.DELIVERY_AI_TIMEOUT_MS || 10 * 60 * 1000));
const maxRepairRounds = Math.max(1, Number(process.env.DELIVERY_MAX_REPAIR_ROUNDS || 3));
const maxPreviewItems = 80;
const ignoredNames = new Set([
  ".git",
  ".next",
  ".turbo",
  ".vite",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
]);

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        request.destroy();
        reject(new Error("请求体过大"));
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function safeName(value, fallback) {
  const text = String(value || "").trim() || fallback;
  return text.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").slice(0, 80);
}

function formatList(items, emptyText = "未提供") {
  return items?.length ? items.map((item) => `- ${item}`).join("\n") : `- ${emptyText}`;
}

function formatScripts(scripts = {}) {
  const entries = Object.entries(scripts);
  return entries.length ? entries.map(([name, command]) => `- \`${name}\`: \`${command}\``).join("\n") : "- 未识别";
}

function formatTaskLines(value) {
  return String(value || "")
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

function tableCell(value) {
  return String(value || "-").replace(/\|/g, "\\|").replace(/\n/g, "<br />");
}

function statusLabel(status) {
  return {
    locked: "锁定",
    pending: "待执行",
    running: "执行中",
    done: "完成",
    risk: "有风险",
    failed: "阻断",
  }[status] || status || "未知";
}

function validationStatusLabel(status) {
  return {
    passed: "通过",
    failed: "失败",
    skipped: "跳过",
    timeout: "超时",
  }[status] || status || "未知";
}

function inferDependencyHints(task) {
  const text = `${task.moduleName || ""}\n${task.requirement || ""}`;
  const hints = [];
  const add = (keyword, label, reason) => {
    if (text.includes(keyword) && !hints.some((item) => item.label === label)) {
      hints.push({ label, reason });
    }
  };

  add("代理商", "代理商管理", "可能涉及代理商选择、归属、详情或授权区域。表单和接口需确认。");
  add("客户", "客户库", "可能涉及客户主体、联系人、重复校验或客户详情。接口字段需确认。");
  add("商机", "商机与跟进", "可能涉及商机创建、跟进记录、状态流转或线索来源。流程规则需确认。");
  add("跟进", "商机与跟进", "可能涉及跟进记录、下次跟进时间和负责人。接口字段需确认。");
  add("上传", "文件上传", "可能依赖文件对象、上传凭证和回显地址。需要明确上传服务。 ");
  add("区域", "省市区/区域能力", "可能依赖区域树、区域编码和展示口径。不能自行猜参数。 ");
  add("省市区", "省市区/区域能力", "可能依赖区域树、区域编码和展示口径。不能自行猜参数。 ");
  add("权限", "系统设置/权限", "可能依赖角色、权限点或可见范围。需要确认权限策略。 ");
  add("角色", "系统设置/权限", "可能依赖角色、权限点或可见范围。需要确认权限策略。 ");

  if (hints.length === 0) {
    hints.push({ label: "业务依赖待分析", reason: "任务描述中没有足够关键词，后续需要通过 PRD、接口文档和旧项目继续确认。" });
  }

  return hints;
}

function timestampForFile() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function healthPathCheck(name, path, expected = "dir") {
  if (!existsSync(path)) {
    return {
      name,
      status: "error",
      message: "缺失",
      path,
    };
  }

  const stats = statSync(path);
  const ok = expected === "file" ? stats.isFile() : stats.isDirectory();
  return {
    name,
    status: ok ? "ok" : "warning",
    message: ok ? "OK" : `存在但不是${expected === "file" ? "文件" : "目录"}`,
    path,
  };
}

function systemHealth() {
  const consoleDirectory = join(knowledgeRoot, "apps/delivery-console");
  const checks = [
    healthPathCheck("知识库根目录", knowledgeRoot),
    healthPathCheck("项目实例目录", join(knowledgeRoot, "08-项目实例")),
    healthPathCheck("规则库目录", join(knowledgeRoot, "11-规则库")),
    healthPathCheck("控制台目录", consoleDirectory),
    healthPathCheck("控制台 package.json", join(consoleDirectory, "package.json"), "file"),
  ];
  const hasError = checks.some((item) => item.status === "error");
  const hasWarning = checks.some((item) => item.status === "warning");
  const status = hasError ? "error" : hasWarning ? "warning" : "success";

  return {
    status,
    ok: status !== "error",
    service: "delivery-runner",
    port,
    knowledgeRoot,
    runnerDirectory,
    checks,
    summary: status === "success" ? "系统自检通过。" : status === "warning" ? "系统自检有警告，请检查路径状态。" : "系统自检失败，请先修复缺失路径。",
    generatedAt: new Date().toISOString(),
  };
}

function truncateOutput(value, maxLength = 12000) {
  const text = String(value || "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n... 输出已截断，共 ${text.length} 个字符。`;
}

function packageManagerCommand(packageManager, scriptName) {
  if (packageManager === "yarn") return { command: "yarn", args: [scriptName] };
  if (packageManager === "bun") return { command: "bun", args: ["run", scriptName] };
  if (packageManager === "npm") return { command: "npm", args: ["run", scriptName] };
  return { command: "pnpm", args: ["run", scriptName] };
}

function runProcess({ command, args, cwd, timeoutMs = 120000, input = "" }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(command, args, { cwd, shell: false, env: process.env });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolve({
        status: "timeout",
        exitCode: null,
        durationMs: Date.now() - startedAt,
        output: truncateOutput(`${stdout}\n${stderr}`.trim() || "命令超时，无输出。"),
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.stdin.on("error", () => {
      // Some commands exit before reading stdin. Keep the process result authoritative.
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status: "failed",
        exitCode: null,
        durationMs: Date.now() - startedAt,
        output: truncateOutput(error.message),
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status: code === 0 ? "passed" : "failed",
        exitCode: code,
        durationMs: Date.now() - startedAt,
        output: truncateOutput(`${stdout}\n${stderr}`.trim() || "命令无输出。"),
      });
    });
    if (input) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

function existsFile(root, relativePath) {
  const fullPath = join(root, relativePath);
  return existsSync(fullPath) && statSync(fullPath).isFile();
}

function existsDirectory(root, relativePath) {
  const fullPath = join(root, relativePath);
  return existsSync(fullPath) && statSync(fullPath).isDirectory();
}

function detectPackageManager(root) {
  if (existsFile(root, "pnpm-lock.yaml")) return "pnpm";
  if (existsFile(root, "yarn.lock")) return "yarn";
  if (existsFile(root, "package-lock.json")) return "npm";
  if (existsFile(root, "bun.lockb")) return "bun";
  return "unknown";
}

function detectFrameworks(packageJson) {
  const dependencies = {
    ...(packageJson?.dependencies || {}),
    ...(packageJson?.devDependencies || {}),
  };
  const checks = [
    ["React", "react"],
    ["Vue", "vue"],
    ["Vite", "vite"],
    ["Next.js", "next"],
    ["TypeScript", "typescript"],
    ["React Router", "react-router-dom"],
    ["TanStack Query", "@tanstack/react-query"],
    ["Zustand", "zustand"],
    ["Tailwind CSS", "tailwindcss"],
    ["Vitest", "vitest"],
    ["Playwright", "@playwright/test"],
  ];
  return checks.filter(([, name]) => dependencies[name]).map(([label]) => label);
}

function listExisting(root, candidates, predicate) {
  return candidates.filter((item) => predicate(root, item));
}

function walkPreview(root, directory = ".", depth = 0, output = []) {
  if (depth > 3 || output.length >= maxPreviewItems) return output;
  const fullDir = directory === "." ? root : join(root, directory);
  let entries = [];
  try {
    entries = readdirSync(fullDir, { withFileTypes: true });
  } catch {
    return output;
  }

  for (const entry of entries) {
    if (output.length >= maxPreviewItems) break;
    if (ignoredNames.has(entry.name)) continue;
    const relativePath = directory === "." ? entry.name : join(directory, entry.name);
    output.push(entry.isDirectory() ? `${relativePath}/` : relativePath);
    if (entry.isDirectory()) {
      walkPreview(root, relativePath, depth + 1, output);
    }
  }
  return output;
}

const materialExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".proto",
  ".sql",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

function extensionOf(filePath) {
  const name = basename(filePath).toLowerCase();
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index) : "";
}

function isUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

function isReadableMaterialFile(filePath) {
  return materialExtensions.has(extensionOf(filePath));
}

function walkMaterialFiles(root, directory = ".", depth = 0, output = []) {
  if (depth > 3 || output.length >= 16) return output;
  const fullDir = directory === "." ? root : join(root, directory);
  let entries = [];
  try {
    entries = readdirSync(fullDir, { withFileTypes: true });
  } catch {
    return output;
  }

  for (const entry of entries) {
    if (output.length >= 16) break;
    if (ignoredNames.has(entry.name)) continue;
    const relativePath = directory === "." ? entry.name : join(directory, entry.name);
    const fullPath = join(root, relativePath);
    if (entry.isDirectory()) {
      walkMaterialFiles(root, relativePath, depth + 1, output);
      continue;
    }
    if (entry.isFile() && isReadableMaterialFile(fullPath)) {
      output.push({ fullPath, relativePath });
    }
  }
  return output;
}

function readTextSnippet(filePath, maxLength = 8000) {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size > 1024 * 1024 * 2 || !isReadableMaterialFile(filePath)) {
      return { status: "skipped", text: "", summary: "文件不是可读取的文本资料，或文件过大。" };
    }
    return { status: "read", text: truncateOutput(readFileSync(filePath, "utf8"), maxLength), summary: "已读取文本片段。" };
  } catch (error) {
    return { status: "missing", text: "", summary: error instanceof Error ? error.message : "文件读取失败。" };
  }
}

function readMaterialSource(type, source) {
  const value = String(source || "").trim();
  if (!value) {
    return null;
  }
  if (isUrl(value)) {
    return {
      type,
      source: value,
      status: "external",
      files: [],
      content: "",
      fileCount: 0,
      charCount: 0,
      summary: "外部链接未自动抓取，交给 AI 或人工读取。",
    };
  }
  if (!existsSync(value)) {
    return {
      type,
      source: value,
      status: "missing",
      files: [],
      content: "",
      fileCount: 0,
      charCount: 0,
      summary: "本地路径不存在。",
    };
  }

  const stat = statSync(value);
  if (stat.isFile()) {
    const snippet = readTextSnippet(value);
    return {
      type,
      source: value,
      status: snippet.status,
      files: [value],
      content: snippet.text,
      fileCount: snippet.status === "read" ? 1 : 0,
      charCount: snippet.text.length,
      summary: snippet.summary,
    };
  }

  if (stat.isDirectory()) {
    const files = walkMaterialFiles(value);
    const parts = files.map((file) => {
      const snippet = readTextSnippet(file.fullPath, 3000);
      return `## ${file.relativePath}\n\n${snippet.text || snippet.summary}`;
    });
    const content = truncateOutput(parts.join("\n\n"), 16000);
    return {
      type,
      source: value,
      status: files.length ? "read" : "skipped",
      files: files.map((file) => file.fullPath),
      content,
      fileCount: files.length,
      charCount: content.length,
      summary: files.length ? `已读取目录中的 ${files.length} 个文本文件片段。` : "目录中未发现可读取的文本资料。",
    };
  }

  return {
    type,
    source: value,
    status: "skipped",
    files: [],
    content: "",
    fileCount: 0,
    charCount: 0,
    summary: "该路径不是文件或目录。",
  };
}

function collectContextSources(task) {
  const groups = [
    ["api", task.apiDocs],
    ["demo", task.demos],
    ["oldProject", task.oldProjects],
    ["prd", task.prds],
  ];
  return groups.flatMap(([type, value]) => formatTaskLines(value).map((source) => readMaterialSource(type, source)).filter(Boolean));
}

function scanProject(projectPath) {
  const generatedAt = new Date().toISOString();
  const normalizedPath = String(projectPath || "").trim();
  if (!normalizedPath || !existsSync(normalizedPath) || !statSync(normalizedPath).isDirectory()) {
    return {
      status: "missing",
      projectPath: normalizedPath,
      projectName: normalizedPath ? basename(normalizedPath) : "",
      packageManager: "unknown",
      frameworks: [],
      scripts: {},
      keyDirectories: [],
      keyFiles: [],
      ruleFiles: [],
      envFiles: [],
      sourcePreview: [],
      warnings: ["项目路径不存在或不是目录。"],
      summary: "项目路径不存在或不是目录，无法扫描。",
      generatedAt,
    };
  }

  const packageJson = safeReadJson(join(normalizedPath, "package.json"));
  const packageManager = detectPackageManager(normalizedPath);
  const frameworks = detectFrameworks(packageJson);
  const scripts = packageJson?.scripts || {};
  const keyDirectories = listExisting(
    normalizedPath,
    ["src", "app", "pages", "components", "features", "modules", "lib", "shared", "router", "routes", "public", "docs", "tests", "e2e"],
    existsDirectory,
  );
  const keyFiles = listExisting(
    normalizedPath,
    [
      "package.json",
      "vite.config.ts",
      "vite.config.js",
      "tsconfig.json",
      "eslint.config.js",
      ".eslintrc.js",
      ".prettierrc",
      "tailwind.config.ts",
      "README.md",
    ],
    existsFile,
  );
  const ruleFiles = listExisting(
    normalizedPath,
    ["docs/ai-frontend-guide.md", "docs/ai-coding-guide.md", ".cursorrules", ".cursor/rules", "AGENTS.md", "CLAUDE.md"],
    (root, item) => existsFile(root, item) || existsDirectory(root, item),
  );
  const envFiles = listExisting(normalizedPath, [".env", ".env.local", ".env.development", ".env.test", ".env.production"], existsFile);
  const sourcePreview = walkPreview(normalizedPath);
  const warnings = [];
  if (!packageJson) warnings.push("未找到 package.json 或 package.json 无法解析。");
  if (ruleFiles.length === 0) warnings.push("未发现项目内 AI 编码规则文件。建议补充 docs/ai-frontend-guide.md。");
  if (frameworks.length === 0) warnings.push("未从 package.json 识别到前端技术栈。需要人工确认项目类型。");
  const summary = [
    `${packageJson?.name || basename(normalizedPath)}：${frameworks.length ? frameworks.join(" / ") : "技术栈待确认"}`,
    `包管理器：${packageManager}`,
    `关键目录：${keyDirectories.length ? keyDirectories.join("、") : "未识别"}`,
  ].join("；");

  return {
    status: "success",
    projectPath: normalizedPath,
    projectName: packageJson?.name || basename(normalizedPath),
    packageManager,
    frameworks,
    scripts,
    keyDirectories,
    keyFiles,
    ruleFiles,
    envFiles,
    sourcePreview,
    warnings,
    summary,
    generatedAt,
  };
}

function createProjectProfile(task, projectScan) {
  return `# 项目画像（自动生成）

> 本文件由模块项目交付控制台生成。可以人工补充，但建议把手写内容放到非 .auto.md 文件，避免后续重新生成覆盖。

## 基本信息

| 字段 | 内容 |
| --- | --- |
| 项目名称 | ${projectScan?.projectName || task.projectName || "未识别"} |
| 项目路径 | ${projectScan?.projectPath || task.projectPath || "未填写"} |
| 包管理器 | ${projectScan?.packageManager || "unknown"} |
| 技术栈 | ${projectScan?.frameworks?.join(" / ") || "待确认"} |
| 生成时间 | ${new Date().toLocaleString("zh-CN", { hour12: false })} |

## 关键目录

${formatList(projectScan?.keyDirectories, "未识别")}

## 关键文件

${formatList(projectScan?.keyFiles, "未识别")}

## 项目规则文件

${formatList(projectScan?.ruleFiles, "未发现")}

## 环境文件

${formatList(projectScan?.envFiles, "未发现")}

## 可用脚本

${formatScripts(projectScan?.scripts)}

## 扫描风险

${formatList(projectScan?.warnings, "无")}
`;
}

function createMaterialList(task) {
  return `# 资料清单（自动生成）

## 接口文档

${formatList(formatTaskLines(task.apiDocs))}

## Demo / 设计图

${formatList(formatTaskLines(task.demos))}

## 旧项目参考

${formatList(formatTaskLines(task.oldProjects))}

## PRD / 需求资料

${formatList(formatTaskLines(task.prds))}
`;
}

function createModulePackage(task, projectScan) {
  return `# ${task.moduleName || "未命名模块"} 模块资料包（自动生成）

## 目标项目

- 项目名称：${projectScan?.projectName || task.projectName || "未填写"}
- 项目路径：${task.projectPath || "未填写"}

## 模块需求

\`\`\`text
${task.requirement || "未填写"}
\`\`\`

## 自动化授权

| 权限 | 是否允许 |
| --- | --- |
| 自动写代码 | ${task.permissions?.allowWriteCode ? "是" : "否"} |
| 自动运行命令 | ${task.permissions?.allowRunCommands ? "是" : "否"} |
| 自动修复问题 | ${task.permissions?.allowAutoFix ? "是" : "否"} |
| 自动写入知识库 | ${task.permissions?.allowKnowledgeWrite ? "是" : "否"} |

## 开发边界

- 接口路径、参数、响应字段优先以接口文档为准。
- 样式优先以 Demo / 设计图为准，再参考旧项目。
- 旧项目代码只能作为样式、交互和历史逻辑参考，不能无脑照搬。
- 普通接口问题、样式问题、PRD 表述不清先记录，能继续的部分继续推进。
`;
}

function createModuleDependencyGraph(task, projectScan) {
  const moduleName = task.moduleName || "未命名模块";
  const apiDocs = formatTaskLines(task.apiDocs);
  const demos = formatTaskLines(task.demos);
  const oldProjects = formatTaskLines(task.oldProjects);
  const prds = formatTaskLines(task.prds);
  const dependencyHints = inferDependencyHints(task);

  return `# ${moduleName} 模块依赖图（自动生成）

> 这是自动生成的模块依赖视图，用来帮助 AI 在开发前理解资料、接口、页面和工程依赖。业务依赖需要随着 PRD 和接口补充继续修正。

## Mermaid 依赖图

\`\`\`mermaid
flowchart LR
  Task["一次性任务包"] --> Module["${moduleName}"]
  Project["真实项目：${projectScan?.projectName || task.projectName || "未识别"}"] --> Module
  Rules["项目规则文件"] --> Module
  Api["接口文档"] --> Module
  Demo["Demo / 设计图"] --> Module
  Old["旧项目参考"] --> Module
  Prd["PRD / 需求资料"] --> Module
  Module --> Code["代码开发"]
  Module --> Test["测试验收"]
  Module --> Knowledge["知识沉淀"]
  Api --> Matrix["接口能力矩阵"]
  Matrix --> Code
  Demo --> Style["样式验收"]
  Style --> Test
\`\`\`

## 资料依赖

| 类型 | 状态 | 内容 |
| --- | --- | --- |
| 接口文档 | ${apiDocs.length ? "已提供" : "缺失"} | ${tableCell(apiDocs.join("<br />") || "未提供")} |
| Demo / 设计图 | ${demos.length ? "已提供" : "缺失"} | ${tableCell(demos.join("<br />") || "未提供")} |
| 旧项目参考 | ${oldProjects.length ? "已提供" : "缺失"} | ${tableCell(oldProjects.join("<br />") || "未提供")} |
| PRD / 需求资料 | ${prds.length ? "已提供" : "缺失"} | ${tableCell(prds.join("<br />") || "未提供")} |

## 工程依赖

| 类型 | 内容 |
| --- | --- |
| 技术栈 | ${tableCell(projectScan?.frameworks?.join(" / ") || "待确认")} |
| 关键目录 | ${tableCell(projectScan?.keyDirectories?.join("、") || "未识别")} |
| 项目规则 | ${tableCell(projectScan?.ruleFiles?.join("、") || "未发现")} |
| 可用脚本 | ${tableCell(Object.keys(projectScan?.scripts || {}).join("、") || "未识别")} |

## 业务依赖提示

| 依赖 | 原因 | 当前处理方式 |
| --- | --- | --- |
${dependencyHints.map((item) => `| ${tableCell(item.label)} | ${tableCell(item.reason)} | 先记录为待确认，开发时以接口文档和 PRD 为准。 |`).join("\n")}

## 规则

- 接口文档没有明确支持的能力，不允许前端自行猜参数。
- Demo / 设计图优先于旧项目样式，旧项目只作参考。
- 依赖其他页面产生的数据时，要在测试用例中补充前置数据准备步骤。
- 如果接口或 PRD 不清晰，先记录问题并继续开发可确认部分。
`;
}

function createStepCards(steps = []) {
  return `# 开发步骤卡片（自动生成）

> 这些步骤卡片用于给 AI 内部执行，不是人工审批节点。普通风险允许继续，P0 阻断才需要停下。

${steps
  .map(
    (step, index) => `## ${String(index + 1).padStart(2, "0")}. ${step.title || "未命名步骤"}

| 字段 | 内容 |
| --- | --- |
| 状态 | ${statusLabel(step.status)} |
| 依赖 | ${tableCell(step.dependsOn?.join("、") || "无")} |
| 说明 | ${tableCell(step.description)} |
| 输出 | ${tableCell(step.output)} |

${step.issues?.length ? `### 风险\n\n${step.issues.map((issue) => `- ${issue.level} ${issue.title}：${issue.description}`).join("\n")}` : "### 风险\n\n- 无"}
`,
  )
  .join("\n")}
`;
}

function createIssueTracker(issues = []) {
  const rows = issues.length
    ? issues
        .map(
          (issue) =>
            `| ${tableCell(issue.id)} | ${tableCell(issue.level)} | ${tableCell(issue.title)} | ${tableCell(issue.owner)} | ${issue.canContinue ? "继续执行" : "阻断"} | ${tableCell(issue.description)} | 待处理 |`,
        )
        .join("\n")
    : "| 无 | 无 | 无 | 无 | 无 | 无 | 无 |";

  return `# 问题追踪（自动生成）

| 编号 | 等级 | 问题 | 责任方 | 是否阻断 | 描述 | 处理状态 |
| --- | --- | --- | --- | --- | --- | --- |
${rows}

## 分级规则

- P0：无法继续、路径错误、权限不足、可能破坏项目，需要人工处理。
- P1：接口、PRD、样式有缺口，但可以继续开发已确认部分。
- P2：优化项或体验项，记录后排期处理。
`;
}

function inferTestCases(task, projectScan) {
  const text = `${task.moduleName || ""}\n${task.requirement || ""}`;
  const cases = [
    {
      id: "TC-BASE-001",
      type: "功能",
      scenario: "页面首屏可访问",
      precondition: "开发服务器启动，登录态有效。",
      steps: "打开目标模块路由，观察标题、导航、筛选区、主体区域。",
      expected: "页面无白屏、无控制台 error，布局与当前项目风格一致。",
    },
    {
      id: "TC-BASE-002",
      type: "接口",
      scenario: "列表数据加载",
      precondition: "接口文档已提供，后端服务可访问。",
      steps: "进入列表页，观察请求路径、请求参数、响应字段和分页结构。",
      expected: "只调用必要接口；参数和字段以接口文档为准；不能前端自行猜不存在的参数。",
    },
    {
      id: "TC-BASE-003",
      type: "性能",
      scenario: "搜索和筛选局部刷新",
      precondition: "列表页有搜索或筛选控件。",
      steps: "输入中文、连续输入、切换筛选项、翻页。",
      expected: "输入不失焦；搜索 debounce；只刷新列表数据；不使用 window.location.reload；不一次性拉大量数据到前端过滤。",
    },
    {
      id: "TC-BASE-004",
      type: "样式",
      scenario: "Demo 视觉对齐",
      precondition: "已提供 Demo / 设计图或旧项目参考。",
      steps: "对比页面间距、字号、按钮、表格密度、筛选栏、空态、分页和图标悬浮效果。",
      expected: "优先匹配 Demo；Demo 未覆盖时保持项目现有风格；不要出现文字重叠或布局跳动。",
    },
    {
      id: "TC-BASE-005",
      type: "状态",
      scenario: "loading / empty / error 状态",
      precondition: "可通过接口返回空数据或异常数据。",
      steps: "分别验证加载中、空结果、接口失败、重试。",
      expected: "用户能看懂当前状态；错误不会导致页面崩溃；可恢复。",
    },
  ];

  const add = (keyword, testCase) => {
    if (text.includes(keyword) && !cases.some((item) => item.id === testCase.id)) {
      cases.push(testCase);
    }
  };

  add("详情", {
    id: "TC-DETAIL-001",
    type: "路由",
    scenario: "列表进入详情再返回",
    precondition: "列表有可点击详情数据。",
    steps: "从列表点击详情，使用页面返回和浏览器返回，再刷新详情页。",
    expected: "URL 表达真实页面状态；返回路径正确；刷新详情页可恢复数据。",
  });
  add("新增", {
    id: "TC-WRITE-001",
    type: "写操作",
    scenario: "新增成功后局部刷新",
    precondition: "有新增入口和新增接口。",
    steps: "打开新增表单，填写必填项，提交成功。",
    expected: "弹窗关闭；列表局部刷新；不整页刷新；失败时展示明确错误。",
  });
  add("编辑", {
    id: "TC-WRITE-002",
    type: "写操作",
    scenario: "编辑成功后数据回显",
    precondition: "有编辑入口和详情/编辑接口。",
    steps: "进入编辑，修改字段，提交后回到列表或详情。",
    expected: "修改字段准确回显；关联数据不丢失；失败不清空用户输入。",
  });
  add("上传", {
    id: "TC-FILE-001",
    type: "文件",
    scenario: "上传前置依赖",
    precondition: "模块依赖文件上传能力。",
    steps: "选择合法/非法文件，观察上传凭证、上传进度、回显和删除。",
    expected: "上传接口和文件对象字段明确；非法文件有提示；依赖上传产物的页面有前置数据准备。",
  });
  add("省市区", {
    id: "TC-REGION-001",
    type: "交互",
    scenario: "省市区级联选择",
    precondition: "模块包含省市区筛选或授权区域。",
    steps: "选择省、市、区，验证面板展开/收起时机和最终请求参数。",
    expected: "未选到末级不收起；最终参数以接口文档为准；不能擅自写 district_code 等未定义字段。",
  });
  add("区域", {
    id: "TC-REGION-002",
    type: "接口",
    scenario: "区域筛选接口能力确认",
    precondition: "模块包含区域筛选。",
    steps: "查看接口文档是否支持区域筛选字段，实际筛选有数据的区域。",
    expected: "接口不支持时必须记录缺口；不能前端本地伪过滤。",
  });
  add("权限", {
    id: "TC-PERM-001",
    type: "权限",
    scenario: "权限控制和按钮可见性",
    precondition: "模块涉及权限或角色。",
    steps: "使用不同角色进入页面，观察菜单、按钮、字段和接口错误。",
    expected: "前端展示和后端权限一致；无权限操作有明确提示。",
  });
  add("角色", {
    id: "TC-PERM-002",
    type: "权限",
    scenario: "角色变更后权限生效",
    precondition: "模块涉及角色配置。",
    steps: "调整角色权限后重新进入相关模块。",
    expected: "权限变更能生效；缓存不会导致旧权限残留。",
  });

  if (projectScan?.scripts?.typecheck) {
    cases.push({
      id: "TC-CMD-001",
      type: "命令",
      scenario: "类型检查",
      precondition: "项目依赖已安装。",
      steps: "执行 package.json 中的 typecheck 脚本。",
      expected: "类型检查通过，无新增 TypeScript 错误。",
    });
  }
  if (projectScan?.scripts?.lint) {
    cases.push({
      id: "TC-CMD-002",
      type: "命令",
      scenario: "Lint 检查",
      precondition: "项目依赖已安装。",
      steps: "执行 package.json 中的 lint 脚本。",
      expected: "Lint 通过，无新增规则违规。",
    });
  }
  if (projectScan?.scripts?.build) {
    cases.push({
      id: "TC-CMD-003",
      type: "命令",
      scenario: "生产构建",
      precondition: "项目依赖已安装。",
      steps: "执行 package.json 中的 build 脚本。",
      expected: "构建通过，产物正常生成。",
    });
  }

  return cases;
}

function createTestCases(task, projectScan) {
  const rows = inferTestCases(task, projectScan)
    .map(
      (item) =>
        `| ${tableCell(item.id)} | ${tableCell(item.type)} | ${tableCell(item.scenario)} | ${tableCell(item.precondition)} | ${tableCell(item.steps)} | ${tableCell(item.expected)} | 待执行 |`,
    )
    .join("\n");

  return `# 测试用例（自动生成）

> 本文件是模块开发前的验收用例草稿。实际开发完成后，需要根据真实页面、接口和 PRD 继续补充。

| 编号 | 类型 | 场景 | 前置条件 | 步骤 | 期望结果 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
${rows}

## 执行要求

- 功能测试和样式测试都要做，不能只看接口是否成功。
- 列表页必须验证搜索、筛选、分页、空态、错误态和局部刷新。
- 涉及依赖页面的数据，要在测试前准备前置数据，并记录来源。
- 接口缺失或字段不清晰时，记录到问题追踪，不要前端自行猜字段。
`;
}

function createCommandRows(projectScan, validation) {
  if (validation?.commands?.length) {
    return validation.commands
      .map((item) => {
        const result = [
          `执行命令：\`${item.command || "未生成"}\``,
          `退出码：${item.exitCode ?? "-"}`,
          `耗时：${Math.round((item.durationMs || 0) / 1000)}s`,
          item.output ? `输出：${truncateOutput(item.output, 600)}` : "输出：无",
        ].join("<br />");
        return `| ${item.name} | ${item.script ? `\`${tableCell(item.script)}\`` : "未识别"} | ${validationStatusLabel(item.status)} | ${tableCell(result)} |`;
      })
      .join("\n");
  }

  return [
    ["typecheck", projectScan?.scripts?.typecheck],
    ["lint", projectScan?.scripts?.lint],
    ["build", projectScan?.scripts?.build],
  ]
    .map(([name, command]) => `| ${name} | ${command ? `\`${command}\`` : "未识别"} | 待执行 | 待补充 |`)
    .join("\n");
}

function createAcceptanceReport(task, projectScan, steps = [], issues = [], validation = null) {
  const commandRows = createCommandRows(projectScan, validation);
  const stepRowsForReport = steps.length
    ? steps.map((step) => `| ${tableCell(step.title)} | ${statusLabel(step.status)} | ${tableCell(step.output)} |`).join("\n")
    : "| 无 | 无 | 无 |";
  const issueRowsForReport = issues.length
    ? issues.map((issue) => `| ${tableCell(issue.level)} | ${tableCell(issue.title)} | ${tableCell(issue.owner)} | ${issue.canContinue ? "可继续" : "阻断"} |`).join("\n")
    : "| 无 | 无 | 无 | 无 |";
  const validationSummary = validation
    ? `- 命令验收状态：${validation.status}\n- 命令验收摘要：${validation.summary}\n- 命令验收时间：${validation.generatedAt}`
    : "- 命令验收状态：未执行\n- 命令验收摘要：尚未通过控制台执行 typecheck / lint / build。\n- 命令验收时间：未执行";

  return `# 验收报告（自动生成）

> 当前报告由控制台自动生成。命令验收可以自动回填；页面截图、接口结果和人工结论仍需要在真实开发结束后补齐。

## 验收范围

| 字段 | 内容 |
| --- | --- |
| 模块 | ${tableCell(task.moduleName || "未命名模块")} |
| 项目 | ${tableCell(projectScan?.projectName || task.projectName || "未识别")} |
| 项目路径 | ${tableCell(task.projectPath || "未填写")} |
| 技术栈 | ${tableCell(projectScan?.frameworks?.join(" / ") || "待确认")} |

## 命令验收

| 命令 | 脚本 | 状态 | 结果 |
| --- | --- | --- | --- |
${commandRows}

## 命令验收结论

${validationSummary}

## 页面验收

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 首屏渲染 | 待执行 | 页面不白屏，无控制台 error。 |
| 样式对齐 | 待执行 | 对齐 Demo / 设计图，检查间距、字号、表格、按钮和空态。 |
| 搜索筛选 | 待执行 | 中文输入不失焦，debounce，局部刷新。 |
| 分页加载 | 待执行 | 服务端分页，不一次性拉大量数据。 |
| 异常状态 | 待执行 | loading、empty、error、retry 都可理解。 |

## 执行步骤状态

| 步骤 | 当前状态 | 输出 |
| --- | --- | --- |
${stepRowsForReport}

## 遗留问题

| 等级 | 问题 | 责任方 | 处理方式 |
| --- | --- | --- | --- |
${issueRowsForReport}

## 验收结论

- 当前结论：${validation ? validation.summary : "待真实开发和测试后填写。"}
- 不允许仅凭构建通过就判定模块验收通过。
- 如果接口能力缺失，需要把问题转给后端确认，而不是前端自行伪造逻辑。
`;
}

async function runValidation(payload) {
  const task = payload.task || {};
  const projectPath = String(task.projectPath || "").trim();
  const generatedAt = new Date().toISOString();
  if (!projectPath || !existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
    return {
      status: "error",
      projectPath,
      packageManager: "unknown",
      commands: [],
      summary: "项目路径不存在或不是目录，无法执行命令验收。",
      generatedAt,
    };
  }

  const packageJson = safeReadJson(join(projectPath, "package.json"));
  if (!packageJson) {
    return {
      status: "error",
      projectPath,
      packageManager: "unknown",
      commands: [],
      summary: "未找到 package.json 或 package.json 无法解析，无法执行命令验收。",
      generatedAt,
    };
  }

  const packageManager =
    payload.projectScan?.packageManager && payload.projectScan.packageManager !== "unknown" ? payload.projectScan.packageManager : detectPackageManager(projectPath);
  const scripts = packageJson.scripts || {};
  const commandNames = ["typecheck", "lint", "build"];
  const commands = [];

  for (const name of commandNames) {
    const script = scripts[name];
    if (!script) {
      commands.push({
        name,
        script: "",
        command: "",
        status: "skipped",
        exitCode: null,
        durationMs: 0,
        output: `package.json 未声明 ${name} 脚本。`,
      });
      continue;
    }

    const commandSpec = packageManagerCommand(packageManager, name);
    const result = await runProcess({
      command: commandSpec.command,
      args: commandSpec.args,
      cwd: projectPath,
    });

    commands.push({
      name,
      script,
      command: `${commandSpec.command} ${commandSpec.args.join(" ")}`,
      status: result.status,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      output: result.output,
    });
  }

  const runnable = commands.filter((item) => item.status !== "skipped");
  const failed = commands.filter((item) => item.status === "failed" || item.status === "timeout");
  const passed = commands.filter((item) => item.status === "passed");
  const status = runnable.length === 0 ? "skipped" : failed.length === 0 ? "success" : passed.length > 0 ? "partial" : "failed";
  const summary = runnable.length === 0
    ? "目标项目没有声明 typecheck / lint / build，命令验收已跳过。"
    : failed.length === 0
      ? `命令验收通过：${passed.map((item) => item.name).join("、")}。`
      : `命令验收存在问题：${failed.map((item) => `${item.name} ${validationStatusLabel(item.status)}`).join("、")}。`;

  return {
    status,
    projectPath,
    packageManager,
    commands,
    summary,
    generatedAt: new Date().toISOString(),
  };
}

function createModuleIndex(task) {
  return `# 模块清单（自动生成）

| 模块 | 最近资料包 | 说明 |
| --- | --- | --- |
| ${task.moduleName || "未命名模块"} | ${safeName(task.moduleName, "未命名模块")}/模块资料包.auto.md | 由控制台自动生成，可继续补充人工说明。 |
`;
}

function sourceSummaries(sources = []) {
  return sources.map(({ type, source, status, fileCount, charCount, summary }) => ({ type, source, status, fileCount, charCount, summary }));
}

function formatSourceTable(sources = []) {
  return sources.length
    ? sources
        .map((item) => `| ${tableCell(item.type)} | ${tableCell(item.source)} | ${tableCell(item.status)} | ${item.fileCount} | ${item.charCount} | ${tableCell(item.summary)} |`)
        .join("\n")
    : "| 无 | 无 | 无 | 0 | 0 | 未提供资料 |";
}

function extractApiRows(sources = []) {
  const rows = [];
  const seen = new Set();
  const add = (method, path, source) => {
    const key = `${method} ${path}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ method, path, source });
  };

  for (const source of sources.filter((item) => item.type === "api" && item.content)) {
    const methodRegex = /\b(GET|POST|PUT|PATCH|DELETE)\s+([/][A-Za-z0-9_./:{}?=&-]+)/gi;
    let match = methodRegex.exec(source.content);
    while (match) {
      add(match[1].toUpperCase(), match[2], source.source);
      match = methodRegex.exec(source.content);
    }

    const pathRegex = /\/[A-Za-z0-9_-]+-api\/[A-Za-z0-9_./:{}?=&-]+/g;
    match = pathRegex.exec(source.content);
    while (match) {
      add("待确认", match[0], source.source);
      match = pathRegex.exec(source.content);
    }
  }

  return rows.slice(0, 80);
}

function createApiMatrix(task, sources = []) {
  const rows = extractApiRows(sources);
  const matrixRows = rows.length
    ? rows.map((item) => `| ${tableCell(item.method)} | ${tableCell(item.path)} | ${tableCell(item.source)} | 待 AI 根据接口文档确认参数、响应、分页和错误码 |`).join("\n")
    : "| 待确认 | 未从资料片段识别到接口路径 | - | 需要 AI 继续阅读完整接口文档或让用户补充接口资料 |";

  return `# 接口能力矩阵（自动生成）

> 本文件只做资料预处理，不替代接口文档。AI 开发时必须回到原始接口文档确认路径、参数、响应字段、分页结构和错误码。

## 模块

- 模块：${task.moduleName || "未命名模块"}
- 生成时间：${new Date().toLocaleString("zh-CN", { hour12: false })}

## 初步接口识别

| 方法 | 路径 | 来源 | 下一步 |
| --- | --- | --- | --- |
${matrixRows}

## 规则

- 不能因为本文件未识别到接口，就在前端猜参数。
- OpenAPI、proto、接口手册优先级高于旧项目代码。
- 如果接口不支持某个筛选能力，需要记录为后端问题，而不是前端本地伪过滤。
`;
}

function createStyleReference(task, sources = []) {
  const styleSources = sources.filter((item) => item.type === "demo" || item.type === "oldProject");
  const snippets = styleSources.length
    ? styleSources
        .map((item) => `## ${item.type}: ${item.source}\n\n状态：${item.status}\n\n文件数：${item.fileCount}\n\n\`\`\`text\n${truncateOutput(item.content || item.summary, 2400)}\n\`\`\``)
        .join("\n\n")
    : "- 未提供 Demo、设计图或旧项目样式参考。";

  return `# 样式参考摘要（自动生成）

> 前端页面只作为交付辅助；真正开发时，样式优先参考 Demo / 设计图，其次参考旧项目正式页面，最后才按目标项目现有设计系统补齐。

## 模块

- 模块：${task.moduleName || "未命名模块"}

## 参考资料

${snippets}

## AI 开发要求

- 不要凭空创造一套新的后台风格。
- 列表页重点关注筛选栏、表格密度、分页、空态、loading、error。
- 交互和布局以可用、稳定、可复用为第一优先级，不做过度装饰。
`;
}

function createOldProjectRisks(sources = []) {
  const oldContent = sources.filter((item) => item.type === "oldProject").map((item) => item.content).join("\n");
  const risks = [];
  const add = (keyword, title, description) => {
    if (oldContent.includes(keyword)) risks.push({ title, description });
  };

  add("live-data-bridge", "桥接脚本风险", "旧项目可能依赖桥接脚本或本地数据桥，新项目不能继续搬这种临时结构。 ");
  add("app.html", "大文件集中风险", "旧项目可能把大量逻辑集中在 app.html，新项目应拆到 feature/api/model/page/component。 ");
  add("window.location.reload", "整页刷新风险", "旧项目可能通过整页刷新更新列表，新项目应使用局部 query 刷新。 ");
  add("localStorage", "状态残留风险", "旧项目可能用 localStorage 保存页面筛选状态，离开页面是否清空要按业务确认。 ");
  add("mock", "mock 数据风险", "旧项目可能混有 mock 或派生字段，接口字段必须以接口文档为准。 ");
  add("filter(", "前端过滤风险", "旧项目可能拉全量数据后本地过滤，新项目列表默认使用服务端分页和服务端筛选。 ");

  const riskRows = risks.length
    ? risks.map((item) => `| ${tableCell(item.title)} | ${tableCell(item.description)} |`).join("\n")
    : "| 待 AI 继续分析 | 当前片段未识别明显旧项目风险，但不能据此认为旧项目可直接照搬。 |";

  return `# 旧项目风险点（自动生成）

> 旧项目只作为样式、交互和历史业务参考，不能作为接口真相，也不能无脑搬大文件结构。

| 风险 | 说明 |
| --- | --- |
${riskRows}

## 固定规则

- 旧项目代码和接口文档冲突时，以接口文档为准。
- 旧项目里没有的能力，不代表新项目不能做；接口缺失才需要记录问题。
- 旧项目里有的前端猜字段、mock、桥接脚本、全量过滤，不应复制进新项目。
`;
}

function createModuleContextPackage(task, projectScan, steps = [], issues = [], sources = []) {
  return `# 模块上下文包（自动生成）

> 这是给 AI 真正写代码前读取的上下文入口。前端控制台只负责生成和展示文件列表；AI 执行器应以本文件为入口继续读取同目录下其他上下文文件。

## 任务

| 字段 | 内容 |
| --- | --- |
| 项目 | ${tableCell(projectScan?.projectName || task.projectName || "未识别")} |
| 项目路径 | ${tableCell(task.projectPath || "未填写")} |
| 模块 | ${tableCell(task.moduleName || "未命名模块")} |
| 技术栈 | ${tableCell(projectScan?.frameworks?.join(" / ") || "待扫描")} |

## 需求说明

\`\`\`text
${task.requirement || "未填写"}
\`\`\`

## 资料读取摘要

| 类型 | 来源 | 状态 | 文件数 | 字符数 | 摘要 |
| --- | --- | --- | --- | --- | --- |
${formatSourceTable(sources)}

## 当前执行步骤

${steps.length ? steps.map((step) => `- ${statusLabel(step.status)}：${step.title}。${step.output}`).join("\n") : "- 尚未生成步骤。"}

## 当前问题

${issues.length ? issues.map((issue) => `- ${issue.level} / ${issue.owner}：${issue.title}。${issue.description}`).join("\n") : "- 暂无问题。"}

## 生成文件

- 接口能力矩阵.auto.md
- 样式参考摘要.auto.md
- 旧项目风险点.auto.md
- AI执行提示词.auto.md
`;
}

function createAiExecutionPrompt(task) {
  return `# AI 执行提示词（自动生成）

请先阅读本目录下这些文件：

1. 模块上下文包.auto.md
2. 接口能力矩阵.auto.md
3. 样式参考摘要.auto.md
4. 旧项目风险点.auto.md
5. 测试用例.auto.md

然后再进入真实项目：

\`\`\`text
${task.projectPath || "未填写项目路径"}
\`\`\`

开发要求：

- 先分析目标项目结构和已有规范，再写代码。
- 页面不直接 fetch，接口放到 feature/api 或项目既有接口层。
- 类型放到 model 或项目既有类型层。
- 列表页使用服务端分页、服务端筛选、搜索 debounce。
- 不使用 window.location.reload()。
- 不前端一次拉大量数据再过滤。
- 接口文档没有明确支持的字段，不要自行猜。
- 样式优先参考 Demo / 设计图，再参考旧项目。
- 遇到接口、PRD、样式缺口，先记录问题；能继续的部分继续完成。
- 完成后执行项目已有 typecheck / lint / build，并整理问题和修复建议。
`;
}

function prepareContextPackage(payload) {
  const task = payload.task || {};
  const projectScan = payload.projectScan || null;
  const steps = Array.isArray(payload.steps) ? payload.steps : [];
  const issues = Array.isArray(payload.issues) ? payload.issues : [];
  const projectName = safeName(projectScan?.projectName || task.projectName || basename(task.projectPath || "项目实例"), "项目实例");
  const moduleName = safeName(task.moduleName, "未命名模块");
  const projectDirectory = join(knowledgeRoot, "08-项目实例", projectName);
  const moduleDirectory = join(projectDirectory, moduleName);
  const sources = collectContextSources(task);
  const files = [
    [join(moduleDirectory, "模块上下文包.auto.md"), createModuleContextPackage(task, projectScan, steps, issues, sources)],
    [join(moduleDirectory, "接口能力矩阵.auto.md"), createApiMatrix(task, sources)],
    [join(moduleDirectory, "样式参考摘要.auto.md"), createStyleReference(task, sources)],
    [join(moduleDirectory, "旧项目风险点.auto.md"), createOldProjectRisks(sources)],
    [join(moduleDirectory, "AI执行提示词.auto.md"), createAiExecutionPrompt(task)],
  ];

  mkdirSync(moduleDirectory, { recursive: true });
  for (const [filePath, content] of files) {
    writeFileSync(filePath, `${content.trim()}\n`, "utf8");
  }

  return {
    status: "success",
    knowledgeRoot,
    projectDirectory,
    moduleDirectory,
    writtenFiles: files.map(([filePath]) => filePath),
    sources: sourceSummaries(sources),
    summary: `AI 上下文包已生成：${files.length} 个文件，读取 ${sources.filter((item) => item.status === "read").length} 份本地资料。`,
    generatedAt: new Date().toISOString(),
  };
}

function defaultContextFiles(moduleDirectory) {
  return [
    join(moduleDirectory, "模块上下文包.auto.md"),
    join(moduleDirectory, "接口能力矩阵.auto.md"),
    join(moduleDirectory, "样式参考摘要.auto.md"),
    join(moduleDirectory, "旧项目风险点.auto.md"),
    join(moduleDirectory, "AI执行提示词.auto.md"),
  ];
}

function validationCommandRows(projectScan, validationRun) {
  return ["typecheck", "lint", "build"].map((name) => {
    const validationCommand = validationRun?.commands?.find((item) => item.name === name);
    return {
      name,
      script: validationCommand?.script || projectScan?.scripts?.[name] || "",
      status: validationCommand?.status || "pending",
      command: validationCommand?.command || "",
    };
  });
}

function executionManifest(payload, packageDirectory, contextFiles) {
  const task = payload.task || {};
  const projectScan = payload.projectScan || null;
  const steps = Array.isArray(payload.steps) ? payload.steps : [];
  const issues = Array.isArray(payload.issues) ? payload.issues : [];
  const validationRun = payload.validationRun || null;
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    packageDirectory,
    project: {
      name: projectScan?.projectName || task.projectName || "",
      path: task.projectPath || "",
      packageManager: projectScan?.packageManager || "unknown",
      frameworks: projectScan?.frameworks || [],
      ruleFiles: projectScan?.ruleFiles || [],
    },
    module: {
      name: task.moduleName || "",
      requirement: task.requirement || "",
    },
    permissions: task.permissions || {},
    contextFiles,
    validationCommands: validationCommandRows(projectScan, validationRun),
    workflow: steps.map((step) => ({
      id: step.id,
      title: step.title,
      status: step.status,
      dependsOn: step.dependsOn || [],
      output: step.output || "",
    })),
    unresolvedIssues: issues.map((issue) => ({
      id: issue.id,
      level: issue.level,
      title: issue.title,
      owner: issue.owner,
      canContinue: issue.canContinue,
      description: issue.description,
    })),
    policy: {
      shouldAskBeforeEveryStep: false,
      continueOnNonBlockingIssues: true,
      doNotGuessApiFields: true,
      doNotUseFullPageReload: true,
      doNotFilterLargeListsInFrontend: true,
    },
  };
}

function createExecutionPlan(payload, contextFiles) {
  const task = payload.task || {};
  const projectScan = payload.projectScan || null;
  const steps = Array.isArray(payload.steps) ? payload.steps : [];
  const issues = Array.isArray(payload.issues) ? payload.issues : [];
  const stepRows = steps.length
    ? steps.map((step, index) => `| ${index + 1} | ${tableCell(step.title)} | ${statusLabel(step.status)} | ${tableCell(step.dependsOn?.join("、") || "无")} | ${tableCell(step.output)} |`).join("\n")
    : "| 1 | 读取执行包 | 待执行 | 无 | 进入真实项目开发前先补齐步骤 |";
  const issueRows = issues.length
    ? issues.map((issue) => `| ${tableCell(issue.level)} | ${tableCell(issue.title)} | ${tableCell(issue.owner)} | ${issue.canContinue ? "继续并记录" : "谨慎处理"} |`).join("\n")
    : "| 无 | 暂无待确认问题 | 无 | 继续执行 |";

  return `# 系统 AI 交付调度计划（自动生成）

> 这是给系统 AI 看的调度计划，不是给写代码 AI 一把完成整个模块的提示词。系统 AI 应先生成 module design 和 task queue，再把单个小任务派发给写代码 AI。

## 执行目标

| 字段 | 内容 |
| --- | --- |
| 项目 | ${tableCell(projectScan?.projectName || task.projectName || "未识别")} |
| 项目路径 | ${tableCell(task.projectPath || "未填写")} |
| 模块 | ${tableCell(task.moduleName || "未命名模块")} |
| 包管理器 | ${tableCell(projectScan?.packageManager || "unknown")} |
| 技术栈 | ${tableCell(projectScan?.frameworks?.join(" / ") || "待确认")} |

## 必读上下文

${formatList(contextFiles.map((filePath) => basename(filePath)))}

## 调度步骤

| 顺序 | 步骤 | 当前状态 | 依赖 | 产出 |
| --- | --- | --- | --- | --- |
${stepRows}

## 待确认问题处理

| 等级 | 问题 | 责任方 | 执行策略 |
| --- | --- | --- | --- |
${issueRows}

## 执行策略

- 不需要每一步都回问用户；普通不确定性先记录，再继续完成可确认的任务拆解。
- 接口字段、路径、分页结构、错误码必须以接口文档为准。
- 样式优先参考 Demo / 设计图，其次参考旧项目正式页面。
- 写代码前必须先生成 design 和小任务队列。
- 写代码 AI 每次只能接收一个 task-xx.prompt.auto.md。
- 每个任务完成后由系统 AI 轻量 review，通过后再派发下一个任务。
`;
}

function createAiRunPromptForExecution(payload, contextFiles) {
  const task = payload.task || {};
  const projectScan = payload.projectScan || null;
  const ruleFiles = projectScan?.ruleFiles?.length ? projectScan.ruleFiles.map((item) => `- ${item}`).join("\n") : "- 未扫描到规则文件，仍需先阅读 README、package.json 和现有目录结构。";
  const commands = validationCommandRows(projectScan, payload.validationRun)
    .filter((item) => item.script)
    .map((item) => `- ${item.name}: ${item.script}`)
    .join("\n") || "- 未识别到 typecheck / lint / build，完成后至少手动说明未执行原因。";

  return `# 系统 AI 调度总提示词（自动生成）

你是系统 AI，负责真实项目的交付调度。用户已经一次性给齐资料和授权，但你不能要求写代码 AI 一次性完成整个模块。你必须先生成 design 和小任务队列，再把单个任务分段派发给写代码 AI。

## 真实项目

\`\`\`text
${task.projectPath || "未填写项目路径"}
\`\`\`

## 本次模块

- 项目：${projectScan?.projectName || task.projectName || "未识别"}
- 模块：${task.moduleName || "未命名模块"}

## 需求

\`\`\`text
${task.requirement || "未填写"}
\`\`\`

## 先读这些上下文文件

${formatList(contextFiles.map((filePath) => filePath))}

## 再读目标项目规则

${ruleFiles}

## 调度规则

- 先分析目标项目结构，再生成模块 design。
- design 之后生成 task-queue.auto.json。
- 每个任务必须足够小，写代码 AI 每次只拿一个 task-xx.prompt.auto.md。
- 每个任务必须写清允许改动文件、禁止事项、验收标准和完成回报格式。
- 不把本文件直接交给写代码 AI 一次性开发完整模块。
- 不猜接口文档没有定义的参数，例如不能凭空发明 region_code、district_code。
- 普通接口、PRD、样式缺口先记录到待确认问题，能继续的任务继续拆解。

## 验收命令

${commands}

## 最终输出

- module-design.auto.md。
- task-queue.auto.json。
- task-01.prompt.auto.md、task-02.prompt.auto.md 等单任务提示词。
- review-checklist.auto.md。
- progress.auto.md。
- 暂时不能拆解或需要人工确认的问题。
`;
}

function createAcceptanceChecklistForExecution(payload) {
  const task = payload.task || {};
  const projectScan = payload.projectScan || null;
  const validationRun = payload.validationRun || null;
  const commandRows = validationCommandRows(projectScan, validationRun)
    .map((item) => `| ${item.name} | ${tableCell(item.script || "未声明")} | ${tableCell(item.status)} | ${tableCell(item.command || "待执行")} |`)
    .join("\n");

  return `# 验收清单（自动生成）

## 模块

- 模块：${task.moduleName || "未命名模块"}
- 项目路径：${task.projectPath || "未填写"}

## 命令验收

| 命令 | 脚本 | 当前状态 | 执行命令 |
| --- | --- | --- | --- |
${commandRows}

## 功能验收

- [ ] 页面路由可进入，刷新不白屏。
- [ ] 列表、详情、表单等本轮范围内功能完整。
- [ ] loading、empty、error、retry 状态可理解。
- [ ] 搜索支持中文输入，不失焦。
- [ ] 筛选、分页、新增、编辑等更新列表时不整页 reload。
- [ ] 接口参数、响应字段和分页结构与接口文档一致。

## 样式验收

- [ ] 优先对齐 Demo / 设计图。
- [ ] Demo 未覆盖时，对齐目标项目现有后台风格。
- [ ] 表格密度、筛选栏、按钮、弹窗、分页、空态一致。
- [ ] 桌面宽度下文字不重叠，按钮文字不溢出。

## 性能验收

- [ ] 列表不全量拉取大量数据再前端过滤。
- [ ] 搜索 debounce。
- [ ] 写操作成功后局部刷新相关 query。
- [ ] 不调用无效接口，不重复轮询健康检查类接口。
`;
}

function createUnresolvedQuestionsForExecution(payload, contextFiles) {
  const issues = Array.isArray(payload.issues) ? payload.issues : [];
  const contextPackage = payload.contextPackage || null;
  const sourceQuestions = contextPackage?.sources?.filter((source) => source.status !== "read") || [];
  const issueRows = issues.length
    ? issues.map((issue) => `| ${tableCell(issue.level)} | ${tableCell(issue.title)} | ${tableCell(issue.owner)} | ${issue.canContinue ? "不阻断" : "需谨慎"} | ${tableCell(issue.description)} |`).join("\n")
    : "| 无 | 暂无问题 | 无 | 不阻断 | - |";
  const sourceRows = sourceQuestions.length
    ? sourceQuestions.map((source) => `| ${tableCell(source.type)} | ${tableCell(source.source)} | ${tableCell(source.status)} | ${tableCell(source.summary)} |`).join("\n")
    : "| 无 | 所有已提供本地资料均已读取 | read | - |";

  return `# 待确认问题（自动生成）

> AI 开发过程中不要因为普通缺口停下。先完成可确认部分，把这里的问题留给最终测试和人工确认。

## 执行前问题

| 等级 | 问题 | 责任方 | 是否阻断 | 描述 |
| --- | --- | --- | --- | --- |
${issueRows}

## 资料读取问题

| 类型 | 来源 | 状态 | 说明 |
| --- | --- | --- | --- |
${sourceRows}

## 上下文文件

${formatList(contextFiles.map((filePath) => basename(filePath)))}

## 记录规则

- 接口文档缺参数、缺响应字段、缺筛选能力：记录给后端。
- PRD 没说清：记录给产品或用户。
- Demo 和旧项目冲突：记录冲突点，优先 Demo。
- 真实接口和文档不一致：记录请求、响应和截图，等待后端确认。
`;
}

function prepareExecutionPackage(payload) {
  const task = payload.task || {};
  const projectScan = payload.projectScan || null;
  const projectName = safeName(projectScan?.projectName || task.projectName || basename(task.projectPath || "项目实例"), "项目实例");
  const moduleName = safeName(task.moduleName, "未命名模块");
  const projectDirectory = join(knowledgeRoot, "08-项目实例", projectName);
  const moduleDirectory = join(projectDirectory, moduleName);
  const packageDirectory = join(moduleDirectory, "执行包");
  const contextFiles = payload.contextPackage?.writtenFiles?.length ? payload.contextPackage.writtenFiles : defaultContextFiles(moduleDirectory);
  const manifest = executionManifest(payload, packageDirectory, contextFiles);
  const files = [
    [join(packageDirectory, "execution-manifest.auto.json"), JSON.stringify(manifest, null, 2)],
    [join(packageDirectory, "execution-plan.auto.md"), createExecutionPlan(payload, contextFiles)],
    [join(packageDirectory, "ai-run-prompt.auto.md"), createAiRunPromptForExecution(payload, contextFiles)],
    [join(packageDirectory, "acceptance-checklist.auto.md"), createAcceptanceChecklistForExecution(payload)],
    [join(packageDirectory, "unresolved-questions.auto.md"), createUnresolvedQuestionsForExecution(payload, contextFiles)],
  ];

  mkdirSync(packageDirectory, { recursive: true });
  for (const [filePath, content] of files) {
    writeFileSync(filePath, `${String(content).trim()}\n`, "utf8");
  }

  return {
    status: "success",
    knowledgeRoot,
    projectDirectory,
    moduleDirectory,
    packageDirectory,
    writtenFiles: files.map(([filePath]) => filePath),
    summary: `AI 交付执行包已生成：${files.length} 个文件。`,
    generatedAt: new Date().toISOString(),
  };
}

function moduleFeatureFlags(task) {
  const text = `${task.moduleName || ""}\n${task.requirement || ""}`;
  return {
    list: /列表|表格|分页|搜索|筛选|管理/.test(text),
    search: /搜索|查询|筛选|过滤/.test(text),
    detail: /详情|明细|查看/.test(text),
    write: /新增|新建|创建|编辑|修改|保存|删除|停用|启用|作废/.test(text),
    upload: /上传|导入|文件|附件/.test(text),
    permission: /权限|角色|可见|授权/.test(text),
  };
}

function makeTask(id, title, dependsOn, goal, allowedFiles, forbidden, inputs, acceptance) {
  return {
    id,
    title,
    status: "pending",
    dependsOn,
    goal,
    allowedFiles,
    forbidden,
    inputs,
    acceptance,
    promptFile: `${id}.prompt.auto.md`,
  };
}

function createTaskQueue(task, projectScan) {
  const flags = moduleFeatureFlags(task);
  const sourceRoot = projectScan?.keyDirectories?.includes("src") ? "src" : "项目源码目录";
  const baseInputs = [
    "模块上下文包.auto.md",
    "接口能力矩阵.auto.md",
    "样式参考摘要.auto.md",
    "旧项目风险点.auto.md",
    "module-design.auto.md",
  ];
  const tasks = [
    makeTask(
      "task-01",
      "确认模块落点和接口边界",
      [],
      "只分析目标项目结构、模块目录、接口文档能力和不确定项，必要时创建最小目录，不写页面业务逻辑。",
      [`${sourceRoot}/**/*`, "docs/**/*"],
      ["不实现页面", "不接真实数据", "不新增 mock 数据", "不修改无关模块"],
      baseInputs,
      ["确认模块代码落点", "列出接口能力和缺口", "没有猜接口字段", "输出下一步实现建议"],
    ),
    makeTask(
      "task-02",
      "建立类型和 API 封装",
      ["task-01"],
      "只完成请求参数、响应类型、枚举和 API 函数封装，为后续页面接入做准备。",
      [`${sourceRoot}/**/api/**`, `${sourceRoot}/**/model/**`, `${sourceRoot}/**/types/**`],
      ["不写页面 UI", "不写业务状态管理", "不在页面里直接 fetch", "不猜接口文档没有的参数"],
      baseInputs,
      ["API 路径来自接口文档", "类型命名清晰", "页面层没有直接请求", "接口缺口进入待确认问题"],
    ),
    makeTask(
      "task-03",
      "实现静态页面骨架和样式基线",
      ["task-02"],
      "只实现页面结构、路由入口、筛选栏/表格/空态等静态 UI，先不接真实接口。",
      [`${sourceRoot}/**/pages/**`, `${sourceRoot}/**/components/**`, `${sourceRoot}/**/*.css`, `${sourceRoot}/**/*.tsx`],
      ["不调用接口", "不写复杂业务逻辑", "不引入新 UI 框架", "不破坏已有布局"],
      baseInputs,
      ["首屏结构完整", "样式优先对齐 Demo 或项目现有风格", "无明显文字溢出", "组件可继续复用"],
    ),
  ];

  if (flags.list) {
    tasks.push(
      makeTask(
        "task-04",
        "接入列表数据、服务端分页和基础状态",
        ["task-03"],
        "接入列表查询接口、分页、loading、empty、error，不做搜索筛选和写操作。",
        [`${sourceRoot}/**/api/**`, `${sourceRoot}/**/hooks/**`, `${sourceRoot}/**/pages/**`, `${sourceRoot}/**/components/**`],
        ["不做新增编辑", "不做详情", "不前端全量过滤", "不使用 window.location.reload()"],
        baseInputs,
        ["列表接口参数符合文档", "分页由服务端驱动", "有 loading/empty/error", "无重复无效请求"],
      ),
    );
  }

  if (flags.search) {
    tasks.push(
      makeTask(
        `task-${String(tasks.length + 1).padStart(2, "0")}`,
        "接入搜索、筛选和局部刷新",
        [tasks[tasks.length - 1].id],
        "接入搜索 debounce、筛选条件、重置和局部刷新，确保输入中文不失焦。",
        [`${sourceRoot}/**/hooks/**`, `${sourceRoot}/**/pages/**`, `${sourceRoot}/**/components/**`],
        ["不整页刷新", "不前端伪造接口不支持的筛选参数", "不改变已完成的列表分页契约"],
        baseInputs,
        ["中文输入不失焦", "搜索 debounce", "筛选参数以接口文档为准", "重置后只刷新相关数据"],
      ),
    );
  }

  if (flags.detail) {
    tasks.push(
      makeTask(
        `task-${String(tasks.length + 1).padStart(2, "0")}`,
        "接入详情路由或详情抽屉",
        [tasks[tasks.length - 1].id],
        "实现从列表进入详情、返回路径和详情数据加载，刷新详情页可恢复。",
        [`${sourceRoot}/**/routes/**`, `${sourceRoot}/**/pages/**`, `${sourceRoot}/**/components/**`, `${sourceRoot}/**/api/**`],
        ["不实现写操作", "不破坏列表状态", "不把详情数据写死"],
        baseInputs,
        ["浏览器返回可用", "详情接口字段符合文档", "刷新详情页可恢复", "无权限或空数据有状态提示"],
      ),
    );
  }

  if (flags.write) {
    tasks.push(
      makeTask(
        `task-${String(tasks.length + 1).padStart(2, "0")}`,
        "接入新增、编辑或状态变更写操作",
        [tasks[tasks.length - 1].id],
        "按本轮范围接入写操作表单、提交、失败提示和成功后的局部刷新。",
        [`${sourceRoot}/**/api/**`, `${sourceRoot}/**/pages/**`, `${sourceRoot}/**/components/**`, `${sourceRoot}/**/model/**`],
        ["不整页 reload", "不吞掉接口错误", "不清空失败后的用户输入", "不擅自扩展本轮未要求的写操作"],
        baseInputs,
        ["提交参数符合接口文档", "成功后局部刷新", "失败有明确提示", "表单必填和回显正确"],
      ),
    );
  }

  if (flags.upload || flags.permission) {
    tasks.push(
      makeTask(
        `task-${String(tasks.length + 1).padStart(2, "0")}`,
        "补齐依赖能力和权限边界",
        [tasks[tasks.length - 1].id],
        "处理文件上传、权限、角色、授权区域等依赖能力，只做接口文档已确认的部分。",
        [`${sourceRoot}/**/api/**`, `${sourceRoot}/**/components/**`, `${sourceRoot}/**/pages/**`],
        ["不猜权限点", "不猜上传字段", "不隐藏真实接口缺口"],
        baseInputs,
        ["依赖接口明确", "权限或上传缺口进入待确认问题", "无权限状态可理解", "不影响已完成主流程"],
      ),
    );
  }

  tasks.push(
    makeTask(
      `task-${String(tasks.length + 1).padStart(2, "0")}`,
      "样式细节、命令验收和问题整理",
      [tasks[tasks.length - 1].id],
      "做最后样式对齐、交互细节检查、命令验收和问题清单整理，不新增大功能。",
      [`${sourceRoot}/**/*`, "README.md", "docs/**/*"],
      ["不新增未规划功能", "不关闭 lint/typecheck", "不掩盖接口问题"],
      baseInputs,
      ["样式对齐 Demo 或项目风格", "typecheck/lint/build 按项目脚本执行或说明原因", "遗留问题清晰归档", "可进入总验收"],
    ),
  );

  return tasks;
}

function createModuleDesign(payload, tasks) {
  const task = payload.task || {};
  const projectScan = payload.projectScan || null;
  const issues = Array.isArray(payload.issues) ? payload.issues : [];
  return `# ${task.moduleName || "未命名模块"} module design（自动生成）

> 本文件由系统 AI 生成，目标是先设计、再拆任务、再分段派发给写代码 AI。不要把整个模块交给写代码 AI 一次性完成。

## 1. 模块目标

\`\`\`text
${task.requirement || "未填写"}
\`\`\`

## 2. 项目画像

| 字段 | 内容 |
| --- | --- |
| 项目 | ${tableCell(projectScan?.projectName || task.projectName || "未识别")} |
| 路径 | ${tableCell(task.projectPath || "未填写")} |
| 技术栈 | ${tableCell(projectScan?.frameworks?.join(" / ") || "待扫描")} |
| 包管理器 | ${tableCell(projectScan?.packageManager || "unknown")} |
| 规则文件 | ${tableCell(projectScan?.ruleFiles?.join("<br />") || "未发现")} |

## 3. 设计原则

- 系统 AI 负责调度，写代码 AI 只执行单个小任务。
- 接口路径、参数、响应字段、分页结构和错误码必须以接口文档为准。
- 样式优先 Demo / 设计图，其次当前项目组件规范，最后旧项目参考。
- 列表默认服务端分页和服务端筛选，不全量拉取再前端过滤。
- 写操作成功后局部刷新相关数据，不使用 \`window.location.reload()\`。
- 接口、PRD、样式不清楚时先记录问题，不自行猜业务字段。

## 4. 任务拆分

| 任务 | 标题 | 依赖 | 目标 |
| --- | --- | --- | --- |
${tasks.map((item) => `| ${item.id} | ${tableCell(item.title)} | ${tableCell(item.dependsOn.join("、") || "无")} | ${tableCell(item.goal)} |`).join("\n")}

## 5. 已知风险

${issues.length ? issues.map((issue) => `- ${issue.level} / ${issue.owner}：${issue.title}。${issue.description}`).join("\n") : "- 暂无已知风险。"}

## 6. 后续执行方式

1. 系统 AI 读取 \`task-queue.auto.json\`。
2. 系统 AI 复制当前 pending 的单个 \`task-xx.prompt.auto.md\` 给写代码 AI。
3. 写代码 AI 完成后回报改动和测试结果。
4. 系统 AI 按 \`review-checklist.auto.md\` 检查。
5. 通过后进入下一个任务，不通过则生成修复任务。
`;
}

function createTaskPrompt(taskItem, payload) {
  const task = payload.task || {};
  const projectScan = payload.projectScan || null;
  return `# ${taskItem.id} ${taskItem.title}

你是写代码 AI。你只能执行当前这一个任务，不要提前做后续任务。

## 当前项目

- 项目：${projectScan?.projectName || task.projectName || "未识别"}
- 真实路径：${task.projectPath || "未填写"}
- 模块：${task.moduleName || "未命名模块"}

## 当前任务目标

${taskItem.goal}

## 必须读取

${formatList(taskItem.inputs)}

## 必须遵守

- ${codingAgentProtocolPath}

## 允许改动范围

${formatList(taskItem.allowedFiles)}

## 禁止事项

${formatList(taskItem.forbidden)}

## 验收标准

${formatList(taskItem.acceptance)}

## 固定规则

- 不直接在页面里 fetch，优先使用项目既有接口层。
- 不猜接口文档没有定义的参数。
- 不使用 \`window.location.reload()\`。
- 不前端一次拉大量数据再过滤。
- 不关闭 lint/typecheck/build。
- 不修改当前任务允许范围之外的无关文件。

## 完成后回报

请按下面格式回报给系统 AI：

\`\`\`text
任务编号：${taskItem.id}
实际改动文件：
完成内容：
运行命令和结果：
未完成内容：
新增问题：
建议下一步：
\`\`\`
`;
}

function createReviewChecklist(tasks) {
  return `# review checklist（自动生成）

> 系统 AI 用本清单检查写代码 AI 的单任务结果。检查通过后才能进入下一个任务。

## 通用检查

- [ ] 写代码 AI 是否只完成了当前任务。
- [ ] 是否越界修改了无关文件。
- [ ] 是否直接在页面里 fetch。
- [ ] 是否猜了接口文档没有定义的参数。
- [ ] 是否使用 \`window.location.reload()\`。
- [ ] 是否前端全量拉取数据再过滤。
- [ ] 是否破坏项目已有样式风格。
- [ ] 是否补齐 loading / empty / error 状态。
- [ ] 是否按任务要求运行或说明 typecheck / lint / build。

## 任务列表

| 任务 | 标题 | 状态 | 检查结论 |
| --- | --- | --- | --- |
${tasks.map((item) => `| ${item.id} | ${tableCell(item.title)} | ${item.status} | 待检查 |`).join("\n")}

## 结论规则

- 通过：更新任务状态为 \`done\`，派发下一个 pending 任务。
- 小问题：更新任务状态为 \`needs-fix\`，生成修复任务。
- 大问题：更新任务状态为 \`blocked\`，等待人工确认。
`;
}

function createProgressDocument(task, tasks) {
  const firstTask = tasks[0];
  return `# progress（自动生成）

## 当前状态

- 模块：${task.moduleName || "未命名模块"}
- 总任务数：${tasks.length}
- 已完成：0
- 当前建议派发：${firstTask ? `${firstTask.id} ${firstTask.title}` : "暂无任务"}

## 进度表

| 任务 | 标题 | 状态 | prompt |
| --- | --- | --- | --- |
${tasks.map((item) => `| ${item.id} | ${tableCell(item.title)} | ${item.status} | ${item.promptFile} |`).join("\n")}

## 使用方式

1. 系统 AI 复制当前 pending 任务 prompt 给写代码 AI。
2. 写代码 AI 完成后，把结果回填给系统 AI。
3. 系统 AI review 后更新任务状态。
4. 如果通过，继续下一个任务；如果不通过，生成修复任务。
`;
}

function prepareTaskPlan(payload) {
  const task = payload.task || {};
  const projectScan = payload.projectScan || null;
  const projectName = safeName(projectScan?.projectName || task.projectName || basename(task.projectPath || "项目实例"), "项目实例");
  const moduleName = safeName(task.moduleName, "未命名模块");
  const projectDirectory = join(knowledgeRoot, "08-项目实例", projectName);
  const moduleDirectory = join(projectDirectory, moduleName);
  const planDirectory = join(moduleDirectory, "设计与任务");
  const tasks = createTaskQueue(task, projectScan);
  const generatedAt = new Date().toISOString();
  const files = [
    [join(planDirectory, "module-design.auto.md"), createModuleDesign(payload, tasks)],
    [
      join(planDirectory, "task-queue.auto.json"),
      JSON.stringify(
        {
          version: 1,
          generatedAt,
          projectName,
          moduleName,
          tasks,
        },
        null,
        2,
      ),
    ],
    [join(planDirectory, "review-checklist.auto.md"), createReviewChecklist(tasks)],
    [join(planDirectory, "progress.auto.md"), createProgressDocument(task, tasks)],
    ...tasks.map((item) => [join(planDirectory, item.promptFile), createTaskPrompt(item, payload)]),
  ];

  mkdirSync(planDirectory, { recursive: true });
  for (const [filePath, content] of files) {
    writeFileSync(filePath, `${String(content).trim()}\n`, "utf8");
  }

  return {
    status: "success",
    knowledgeRoot,
    projectDirectory,
    moduleDirectory,
    planDirectory,
    writtenFiles: files.map(([filePath]) => filePath),
    tasks,
    summary: `设计与任务队列已生成：${tasks.length} 个任务，${files.length} 个文件。`,
    generatedAt,
  };
}

function planDirectoryForPayload(payload) {
  if (payload.taskPlan?.planDirectory) {
    return payload.taskPlan.planDirectory;
  }

  const task = payload.task || {};
  const projectScan = payload.projectScan || null;
  const projectName = safeName(projectScan?.projectName || task.projectName || basename(task.projectPath || "项目实例"), "项目实例");
  const moduleName = safeName(task.moduleName, "未命名模块");
  return join(knowledgeRoot, "08-项目实例", projectName, moduleName, "设计与任务");
}

function collectTaskPlanFiles(planDirectory) {
  if (!existsSync(planDirectory) || !statSync(planDirectory).isDirectory()) {
    return [];
  }

  const files = [];
  for (const entry of readdirSync(planDirectory, { withFileTypes: true })) {
    const entryPath = join(planDirectory, entry.name);
    if (entry.isFile()) {
      files.push(entryPath);
    } else if (entry.isDirectory() && entry.name === "reviews") {
      for (const reviewEntry of readdirSync(entryPath, { withFileTypes: true })) {
        if (reviewEntry.isFile()) {
          files.push(join(entryPath, reviewEntry.name));
        }
      }
    }
  }

  return files.sort();
}

function loadTaskPlan(payload) {
  const planDirectory = planDirectoryForPayload(payload);
  const queueFile = join(planDirectory, "task-queue.auto.json");
  const queuePayload = safeReadJson(queueFile);
  const tasks = Array.isArray(queuePayload?.tasks) ? queuePayload.tasks : [];
  if (!tasks.length) {
    throw new Error(`未找到可恢复的任务队列：${queueFile}`);
  }

  const task = payload.task || {};
  const projectDirectory = dirname(dirname(planDirectory));
  const moduleDirectory = dirname(planDirectory);
  const writtenFiles = collectTaskPlanFiles(planDirectory);
  return {
    status: "success",
    knowledgeRoot,
    projectDirectory,
    moduleDirectory,
    planDirectory,
    writtenFiles,
    tasks,
    summary: `已恢复任务队列：${tasks.filter((item) => item.status === "done").length}/${tasks.length} 个任务完成。`,
    generatedAt: queuePayload?.generatedAt || new Date().toISOString(),
    projectName: queuePayload?.projectName || task.projectName || basename(projectDirectory),
    moduleName: queuePayload?.moduleName || task.moduleName || basename(moduleDirectory),
  };
}

function taskPlanStateFromPayload(payload) {
  const taskPlan = payload.taskPlan || {};
  if (!taskPlan.planDirectory) {
    throw new Error("缺少 taskPlan.planDirectory，请先生成设计与任务队列。");
  }

  const queueFile = join(taskPlan.planDirectory, "task-queue.auto.json");
  const queuePayload = safeReadJson(queueFile);
  const tasks = Array.isArray(queuePayload?.tasks) ? queuePayload.tasks : Array.isArray(taskPlan.tasks) ? taskPlan.tasks : [];
  if (!tasks.length) {
    throw new Error("任务队列为空，请重新生成设计与任务队列。");
  }

  return {
    taskPlan,
    planDirectory: taskPlan.planDirectory,
    queueFile,
    tasks,
  };
}

function isTaskDone(tasks, taskId) {
  return tasks.some((item) => item.id === taskId && item.status === "done");
}

function canDispatchTask(item, tasks) {
  if (item.status !== "pending") return false;
  if (item.fixOf) return true;
  return item.dependsOn.every((taskId) => isTaskDone(tasks, taskId));
}

function nextDispatchableTask(tasks) {
  return (
    tasks.find((item) => item.status === "assigned") ||
    tasks.find((item) => item.fixOf && item.status === "pending") ||
    tasks.find((item) => canDispatchTask(item, tasks)) ||
    null
  );
}

function updatedTaskPlan(taskPlan, tasks, writtenFiles = []) {
  const uniqueFiles = Array.from(new Set([...(taskPlan.writtenFiles || []), ...writtenFiles]));
  return {
    ...taskPlan,
    writtenFiles: uniqueFiles,
    tasks,
    summary: `任务队列已更新：${tasks.filter((item) => item.status === "done").length}/${tasks.length} 个任务完成。`,
    generatedAt: new Date().toISOString(),
  };
}

function writeTaskPlanState(task, taskPlan, tasks, extraFiles = []) {
  const planDirectory = taskPlan.planDirectory;
  const queueFile = join(planDirectory, "task-queue.auto.json");
  const progressFile = join(planDirectory, "progress.auto.md");
  const checklistFile = join(planDirectory, "review-checklist.auto.md");
  const generatedAt = new Date().toISOString();
  const nextPlan = updatedTaskPlan(taskPlan, tasks, [queueFile, progressFile, checklistFile, ...extraFiles]);

  writeFileSync(
    queueFile,
    `${JSON.stringify(
      {
        version: 1,
        generatedAt,
        projectName: basename(dirname(dirname(planDirectory))),
        moduleName: basename(dirname(planDirectory)),
        tasks,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(progressFile, `${createProgressDocument(task || {}, tasks).trim()}\n`, "utf8");
  writeFileSync(checklistFile, `${createReviewChecklist(tasks).trim()}\n`, "utf8");

  return nextPlan;
}

async function dispatchTask(payload) {
  const task = payload.task || {};
  const { taskPlan, planDirectory, tasks } = taskPlanStateFromPayload(payload);
  const targetTask = payload.taskId ? tasks.find((item) => item.id === payload.taskId) : nextDispatchableTask(tasks);
  if (!targetTask) {
    throw new Error("没有可派发任务。可能是依赖未完成，或任务队列已全部完成。");
  }

  if (!canDispatchTask(targetTask, tasks) && targetTask.status !== "assigned") {
    throw new Error(`任务 ${targetTask.id} 的依赖还未完成，暂不能派发。`);
  }

  if (targetTask.status === "pending") {
    targetTask.status = "assigned";
  }
  if (!Array.isArray(targetTask.baselineChangedFiles)) {
    targetTask.baselineChangedFiles = await collectGitChangedFiles(task);
  }

  const promptPath = join(planDirectory, targetTask.promptFile);
  if (!existsSync(promptPath)) {
    throw new Error(`任务 prompt 不存在：${promptPath}`);
  }

  const promptContent = readFileSync(promptPath, "utf8");
  const nextPlan = writeTaskPlanState(task, taskPlan, tasks);
  return {
    status: "success",
    taskId: targetTask.id,
    promptContent,
    updatedTaskPlan: nextPlan,
    summary: `已派发 ${targetTask.id}：${targetTask.title}，prompt 已可复制给写代码 AI。`,
    generatedAt: new Date().toISOString(),
  };
}

function aiAdapterStatus() {
  const provider =
    aiProvider === "mock" || aiProvider === "disabled" || aiProvider === "command" ? aiProvider : "manual";
  const warnings = [];
  if (provider === "manual") {
    warnings.push("当前为 manual 模式：runner 只生成单任务 prompt，仍需人工复制给写代码 AI。");
  }
  if (provider === "mock") {
    warnings.push("当前为 mock 模式：只生成测试报告，不会修改真实项目，也不能代表真实开发完成。");
  }
  if (provider === "command") {
    if (aiCommand) {
      warnings.push("当前为 command 模式：runner 会把单任务 prompt 通过 stdin 交给本地命令执行。请确认命令可信。");
    } else {
      warnings.push("当前为 command 模式，但未配置 DELIVERY_AI_COMMAND，不能自动执行。");
    }
  }
  if (provider === "disabled") {
    warnings.push("AI adapter 已禁用，只能使用手工派发和回填报告。");
  }

  const commandReady = provider === "command" && Boolean(aiCommand);
  const canAutoRun = provider === "mock" || commandReady;
  return {
    status: provider === "disabled" || (provider === "command" && !aiCommand) ? "warning" : "success",
    provider,
    canAutoRun,
    requiresManualInput: !canAutoRun,
    configSource: "DELIVERY_AI_PROVIDER / DELIVERY_AI_COMMAND / DELIVERY_AI_ARGS",
    warnings,
    summary:
      provider === "mock"
        ? "AI adapter 当前为 mock provider，可用于验证调度流程。"
        : provider === "disabled"
          ? "AI adapter 当前禁用。"
          : provider === "command"
            ? commandReady
              ? `AI adapter 当前为 command provider，将调用本地命令：${aiCommand}。`
              : "AI adapter 当前为 command provider，但缺少 DELIVERY_AI_COMMAND。"
            : "AI adapter 当前为 manual provider，需要人工把 prompt 交给写代码 AI。",
    generatedAt: new Date().toISOString(),
  };
}

function createMockAdapterReport(taskItem) {
  return `任务编号：${taskItem.id}
实际改动文件：
无（mock provider 未修改真实项目）
完成内容：
mock provider 已收到单任务 prompt，并生成这份测试报告，用于验证 AI adapter 调度链路。
运行命令和结果：
未运行。mock provider 不执行真实项目命令。
未完成内容：
mock provider 没有真实写代码，不能作为当前任务完成依据。
新增问题：
mock provider 仅用于测试 adapter 抽象，真实开发仍需要接入人工或真实 AI provider。
建议下一步：
接入真实 provider 前，继续使用 manual 模式把 prompt 交给写代码 AI，并由系统 AI review。`;
}

function writeAiAdapterRunFile(planDirectory, provider, taskId, promptContent, report) {
  const directory = join(planDirectory, "ai-adapter-runs");
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${taskId}-${provider}-${timestampForFile()}.md`);
  writeFileSync(
    file,
    `# AI adapter run

- provider：${provider}
- task：${taskId}
- generatedAt：${new Date().toISOString()}

## prompt 摘要

- prompt 字符数：${promptContent.length}

## report

\`\`\`text
${report || "manual 模式不生成报告。"}
\`\`\`
`,
    "utf8",
  );
  return file;
}

function parseAiCommandArgs(context) {
  if (!aiCommandArgs) return [];
  let parsed;
  try {
    parsed = JSON.parse(aiCommandArgs);
  } catch {
    throw new Error("DELIVERY_AI_ARGS 必须是 JSON 字符串数组，例如 [\"--model\",\"xxx\"]。");
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("DELIVERY_AI_ARGS 必须是 JSON 字符串数组。");
  }
  return parsed.map((item) =>
    item
      .replaceAll("{taskId}", context.taskId)
      .replaceAll("{promptFile}", context.promptFile)
      .replaceAll("{projectPath}", context.projectPath),
  );
}

async function runCommandAdapter({ task, taskId, promptFile, promptContent }) {
  if (!aiCommand) {
    throw new Error("command provider 缺少 DELIVERY_AI_COMMAND。");
  }
  const projectPath = task?.projectPath && existsSync(task.projectPath) && statSync(task.projectPath).isDirectory() ? task.projectPath : knowledgeRoot;
  const args = parseAiCommandArgs({ taskId, promptFile, projectPath });
  const result = await runProcess({
    command: aiCommand,
    args,
    cwd: projectPath,
    timeoutMs: aiCommandTimeoutMs,
    input: promptContent,
  });
  if (result.status !== "passed") {
    throw new Error(`command provider 执行失败：${result.output || result.status}`);
  }
  return result.output.trim();
}

async function runTaskWithAiAdapter(payload) {
  const status = aiAdapterStatus();
  if (status.provider === "disabled") {
    throw new Error("AI adapter 已禁用，不能执行当前任务。");
  }

  const dispatch = await dispatchTask(payload);
  const { planDirectory, tasks } = taskPlanStateFromPayload({ ...payload, taskPlan: dispatch.updatedTaskPlan || payload.taskPlan });
  const taskId = dispatch.taskId;
  const currentTask = tasks.find((item) => item.id === taskId);
  const promptFile = currentTask ? join(planDirectory, currentTask.promptFile) : "";
  const report =
    status.provider === "mock"
      ? createMockAdapterReport({ id: taskId })
      : status.provider === "command"
        ? await runCommandAdapter({ task: payload.task || {}, taskId, promptFile, promptContent: dispatch.promptContent })
        : "";
  const reportFile = writeAiAdapterRunFile(planDirectory, status.provider, taskId, dispatch.promptContent, report);

  return {
    status: status.provider === "manual" ? "manual-required" : "success",
    provider: status.provider,
    taskId,
    promptContent: dispatch.promptContent,
    report,
    reportFile,
    updatedTaskPlan: dispatch.updatedTaskPlan,
    summary:
      status.provider === "manual"
        ? `manual adapter 已准备 ${taskId} prompt，请人工交给写代码 AI。`
        : status.provider === "mock"
          ? `mock adapter 已生成 ${taskId} 测试报告，未修改真实项目。`
          : `command adapter 已执行 ${taskId}，并收集命令输出作为完成报告。`,
    generatedAt: new Date().toISOString(),
  };
}

function lockAgeMs(lock) {
  const startedAt = Date.parse(lock?.startedAt || "");
  return Number.isFinite(startedAt) ? Date.now() - startedAt : Number.POSITIVE_INFINITY;
}

function assertExecutionLock(planDirectory, taskId) {
  const lockFile = join(planDirectory, "controlled-task.lock.json");
  const currentLock = safeReadJson(lockFile);
  if (currentLock?.status === "running" && lockAgeMs(currentLock) < 15 * 60 * 1000) {
    throw new Error(`已有受控任务正在执行：${currentLock.taskId || "未知任务"}。如确认已经结束，请稍后重试或人工检查 lock 文件。`);
  }

  const lock = {
    status: "running",
    taskId,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  return lockFile;
}

function finishExecutionLock(lockFile, status, taskId) {
  writeFileSync(
    lockFile,
    `${JSON.stringify(
      {
        status,
        taskId,
        finishedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function rootTaskId(taskItem) {
  return taskItem?.fixOf || taskItem?.id || "";
}

function repairRoundForTask(tasks, taskItem) {
  const rootId = rootTaskId(taskItem);
  if (!rootId) return 0;
  return tasks.filter((item) => item.fixOf === rootId).length;
}

function createControlledExecutionMarkdown(result) {
  return `# 受控单任务执行记录

> 本文件记录一次受控单任务执行。它不代表整个模块完成，也不会自动提交代码。

## 结论

- 状态：${result.status}
- provider：${result.provider}
- task：${result.taskId}
- review：${result.reviewDecision}
- 修复轮次：${result.repairRound}/${result.maxRepairRounds}

${result.summary}

## 文件

- lock：${result.lockFile || "无"}
- adapter report：${result.adapterReportFile || "无"}
- review：${result.reviewFile || "未执行"}
- fix prompt：${result.fixPromptFile || "无"}

## git diff 范围

### 本任务新增/变更文件

${formatList(result.changedFiles, "无")}

### 超出 allowedFiles 的文件

${formatList(result.outOfScopeFiles, "无")}
`;
}

function writeControlledExecutionFile(planDirectory, result) {
  const directory = join(planDirectory, "controlled-executions");
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${result.taskId}-${timestampForFile()}.md`);
  const nextResult = { ...result, executionFile: file };
  writeFileSync(file, `${createControlledExecutionMarkdown(nextResult).trim()}\n`, "utf8");
  return nextResult;
}

async function runControlledSingleTask(payload) {
  const task = payload.task || {};
  const { taskPlan, planDirectory, tasks } = taskPlanStateFromPayload(payload);
  const targetTask = payload.taskId ? tasks.find((item) => item.id === payload.taskId) : nextDispatchableTask(tasks);
  if (!targetTask) {
    throw new Error("没有可执行任务。请先生成任务队列，或处理阻断/依赖状态。");
  }

  if (targetTask.status === "blocked") {
    throw new Error(`任务 ${targetTask.id} 已阻断，需要人工确认。`);
  }

  const repairRound = repairRoundForTask(tasks, targetTask);
  if (repairRound >= maxRepairRounds && targetTask.fixOf) {
    throw new Error(`任务 ${targetTask.id} 已达到修复轮次上限 ${maxRepairRounds}，需要人工确认。`);
  }

  const lockFile = assertExecutionLock(planDirectory, targetTask.id);
  let lockStatus = "completed";

  try {
    const adapterRun = await runTaskWithAiAdapter({ ...payload, taskId: targetTask.id, taskPlan });
    let review = null;
    let nextTaskPlan = adapterRun.updatedTaskPlan || taskPlan;
    let changedFiles = [];
    let outOfScopeFiles = [];

    if (payload.autoReview !== false && adapterRun.report.trim()) {
      review = await reviewTaskResult({
        task,
        taskPlan: nextTaskPlan,
        taskId: adapterRun.taskId,
        report: adapterRun.report,
      });
      nextTaskPlan = review.updatedTaskPlan || nextTaskPlan;
      changedFiles = review.changedFiles;
      outOfScopeFiles = review.outOfScopeFiles;
    } else {
      const currentState = taskPlanStateFromPayload({ ...payload, taskPlan: nextTaskPlan });
      const currentTask = currentState.tasks.find((item) => item.id === adapterRun.taskId) || targetTask;
      const scope = await collectGitReviewScope(task, currentTask);
      changedFiles = scope.changedFiles;
      outOfScopeFiles = scope.outOfScopeFiles;
    }

    const status =
      adapterRun.status === "manual-required"
        ? "manual-required"
        : review?.decision === "blocked"
          ? "blocked"
          : outOfScopeFiles.length
            ? "blocked"
            : "success";
    if (status === "blocked") {
      lockStatus = "blocked";
    }

    const result = writeControlledExecutionFile(planDirectory, {
      status,
      mode: "single-task",
      provider: adapterRun.provider,
      taskId: adapterRun.taskId,
      lockFile,
      executionFile: "",
      adapterReportFile: adapterRun.reportFile,
      reviewFile: review?.reviewFile || null,
      fixPromptFile: review?.fixPromptFile || null,
      reviewDecision: review?.decision || "not-reviewed",
      repairRound,
      maxRepairRounds,
      changedFiles,
      outOfScopeFiles,
      updatedTaskPlan: nextTaskPlan,
      summary:
        status === "manual-required"
          ? `受控执行已准备 ${adapterRun.taskId}，需要人工把 prompt 交给写代码 AI 后回填报告。`
          : review
            ? `受控执行已完成 ${adapterRun.taskId} 并执行系统 review：${review.decision}。`
            : `受控执行已完成 ${adapterRun.taskId}，等待后续 review。`,
      generatedAt: new Date().toISOString(),
    });

    finishExecutionLock(lockFile, lockStatus, adapterRun.taskId);
    return result;
  } catch (error) {
    lockStatus = "error";
    finishExecutionLock(lockFile, lockStatus, targetTask.id);
    throw error;
  }
}

function hasRequiredTaskInfo(task) {
  return Boolean(
    String(task?.projectName || "").trim() &&
      String(task?.projectPath || "").trim() &&
      String(task?.moduleName || "").trim() &&
      String(task?.requirement || "").trim(),
  );
}

function autoAdvanceResponse({ status = "waiting", action = "wait", didRun = false, nextAction, reason = [], summary, extra = {} }) {
  return {
    status,
    action,
    didRun,
    nextAction,
    reason,
    summary: summary || nextAction,
    generatedAt: new Date().toISOString(),
    ...extra,
  };
}

async function autoAdvanceOnce(payload) {
  const task = payload.task || {};
  if (!hasRequiredTaskInfo(task)) {
    return autoAdvanceResponse({
      status: "blocked",
      action: "blocked",
      nextAction: "先补齐项目名称、真实项目路径、模块名称和需求说明。",
      reason: ["一次性任务包基础信息不完整，不能稳定生成设计与任务队列。"],
      summary: "自动推进已暂停：任务包资料不完整。",
    });
  }

  if (!payload.taskPlan?.tasks?.length) {
    const contextPackage = prepareContextPackage(payload);
    const executionPackage = prepareExecutionPackage({ ...payload, contextPackage });
    const taskPlan = prepareTaskPlan({ ...payload, contextPackage, executionPackage });
    return autoAdvanceResponse({
      status: "success",
      action: "prepare-task-plan",
      didRun: true,
      nextAction: "设计与任务队列已生成，下一步派发第一个可执行任务。",
      reason: ["尚未存在 task queue，因此先生成上下文包、执行包和任务队列。"],
      summary: taskPlan.summary,
      extra: { contextPackage, executionPackage, taskPlan },
    });
  }

  const state = taskPlanStateFromPayload(payload);
  const latestTaskPlan = updatedTaskPlan(state.taskPlan, state.tasks, []);
  const blockedTasks = state.tasks.filter((item) => item.status === "blocked");
  if (blockedTasks.length) {
    return autoAdvanceResponse({
      status: "blocked",
      action: "blocked",
      nextAction: "先处理 blocked 任务，再继续自动推进。",
      reason: blockedTasks.map((item) => `${item.id}：${item.title}`),
      summary: `自动推进已暂停：存在 ${blockedTasks.length} 个阻断任务。`,
      extra: { taskPlan: latestTaskPlan },
    });
  }

  const currentTask = nextDispatchableTask(state.tasks);
  if (currentTask?.status === "assigned") {
    return autoAdvanceResponse({
      status: "waiting",
      action: "wait",
      nextAction: `等待写代码 AI 回填 ${currentTask.id} 完成报告并提交 review。`,
      reason: ["当前任务已派发，系统不能跳过报告和 review。"],
      summary: "自动推进已暂停：等待当前任务报告。",
      extra: { taskPlan: latestTaskPlan },
    });
  }

  if (currentTask?.status === "pending") {
    const adapter = aiAdapterStatus();
    if (adapter.canAutoRun && task.permissions?.allowWriteCode) {
      const controlledExecution = await runControlledSingleTask({ ...payload, taskPlan: latestTaskPlan, taskId: currentTask.id, autoReview: true });
      return autoAdvanceResponse({
        status: controlledExecution.status === "success" ? "success" : controlledExecution.status === "manual-required" ? "waiting" : "blocked",
        action: "controlled-task",
        didRun: controlledExecution.status !== "manual-required",
        nextAction:
          controlledExecution.reviewDecision === "approved"
            ? "当前任务通过 review，下一步继续派发后续任务。"
            : controlledExecution.reviewDecision === "needs-fix"
              ? "当前任务需要修复，下一步优先执行生成的修复任务。"
              : controlledExecution.summary,
        reason: [controlledExecution.summary],
        summary: controlledExecution.summary,
        extra: { controlledExecution, taskPlan: controlledExecution.updatedTaskPlan || latestTaskPlan },
      });
    }

    const taskDispatch = await dispatchTask({ ...payload, taskPlan: latestTaskPlan, taskId: currentTask.id });
    return autoAdvanceResponse({
      status: "waiting",
      action: "dispatch-task",
      didRun: true,
      nextAction: `已派发 ${currentTask.id}，等待写代码 AI 完成后回填报告。`,
      reason: [adapter.summary],
      summary: taskDispatch.summary,
      extra: { taskDispatch, taskPlan: taskDispatch.updatedTaskPlan || latestTaskPlan },
    });
  }

  const allTasksDone = state.tasks.length > 0 && state.tasks.every((item) => item.status === "done");
  if (!allTasksDone) {
    return autoAdvanceResponse({
      status: "waiting",
      action: "wait",
      nextAction: "当前没有可派发任务，请检查任务依赖或 review 状态。",
      reason: ["任务队列未全部完成，但没有 pending 或 assigned 的可执行任务。"],
      summary: "自动推进已暂停：任务依赖需要确认。",
      extra: { taskPlan: latestTaskPlan },
    });
  }

  if (!payload.validationRun) {
    if (!task.permissions?.allowRunCommands) {
      return autoAdvanceResponse({
        status: "waiting",
        action: "wait",
        nextAction: "任务已完成，但缺少运行命令授权，无法执行 typecheck / lint / build。",
        reason: ["权限中 allowRunCommands 为 false。"],
        summary: "自动推进已暂停：等待命令授权。",
        extra: { taskPlan: latestTaskPlan },
      });
    }
    const validationRun = await runValidation(payload);
    return autoAdvanceResponse({
      status: validationRun.status === "success" ? "success" : "waiting",
      action: "run-validation",
      didRun: true,
      nextAction: validationRun.status === "success" ? "命令验收已通过，下一步执行页面点测。" : "命令验收未通过，先沉淀问题并生成修复任务。",
      reason: [validationRun.summary],
      summary: validationRun.summary,
      extra: { validationRun, taskPlan: latestTaskPlan },
    });
  }

  if (payload.validationRun.status !== "success") {
    return autoAdvanceResponse({
      status: "waiting",
      action: "wait",
      nextAction: "命令验收未通过，先把失败命令转成修复任务或环境问题。",
      reason: [payload.validationRun.summary],
      summary: "自动推进已暂停：命令验收未通过。",
      extra: { taskPlan: latestTaskPlan },
    });
  }

  if (!payload.pageSmoke) {
    if (!task.permissions?.allowRunCommands) {
      return autoAdvanceResponse({
        status: "waiting",
        action: "wait",
        nextAction: "命令已通过，但缺少点测授权，无法执行页面点测。",
        reason: ["权限中 allowRunCommands 为 false。"],
        summary: "自动推进已暂停：等待点测授权。",
        extra: { taskPlan: latestTaskPlan },
      });
    }
    const pageSmoke = await runPageSmokeTest({ ...payload, taskPlan: latestTaskPlan });
    return autoAdvanceResponse({
      status: pageSmoke.status === "success" || pageSmoke.status === "skipped" || pageSmoke.status === "warning" ? "success" : "waiting",
      action: "run-page-smoke",
      didRun: true,
      nextAction:
        pageSmoke.status === "success" || pageSmoke.status === "skipped" || pageSmoke.status === "warning"
          ? "页面点测已记录，下一步写入知识库。"
          : "页面点测未通过，先沉淀问题并生成修复任务。",
      reason: [pageSmoke.summary],
      summary: pageSmoke.summary,
      extra: { pageSmoke, taskPlan: latestTaskPlan },
    });
  }

  if (payload.pageSmoke.status === "failed" || payload.pageSmoke.status === "error") {
    return autoAdvanceResponse({
      status: "waiting",
      action: "wait",
      nextAction: "页面点测未通过，先沉淀 URL、缺失关键词和错误文本，再生成修复任务。",
      reason: [payload.pageSmoke.summary],
      summary: "自动推进已暂停：页面点测未通过。",
      extra: { taskPlan: latestTaskPlan },
    });
  }

  if (payload.knowledgeWrite?.status !== "success") {
    if (!task.permissions?.allowKnowledgeWrite) {
      return autoAdvanceResponse({
        status: "waiting",
        action: "wait",
        nextAction: "缺少知识库写入授权，不能生成最终沉淀。",
        reason: ["权限中 allowKnowledgeWrite 为 false。"],
        summary: "自动推进已暂停：等待知识库写入授权。",
        extra: { taskPlan: latestTaskPlan },
      });
    }
    const knowledgeWrite = writeKnowledge(payload);
    return autoAdvanceResponse({
      status: knowledgeWrite.status === "success" ? "success" : "waiting",
      action: "write-knowledge",
      didRun: true,
      nextAction: knowledgeWrite.status === "success" ? "知识库已写入，下一步生成总验收。" : "知识库写入失败，先检查写入路径。",
      reason: [knowledgeWrite.summary],
      summary: knowledgeWrite.summary,
      extra: { knowledgeWrite, taskPlan: latestTaskPlan },
    });
  }

  if (!payload.finalAcceptance) {
    const finalAcceptance = finalizeDelivery({ ...payload, taskPlan: latestTaskPlan });
    return autoAdvanceResponse({
      status: finalAcceptance.status === "success" ? "success" : "waiting",
      action: "finalize-delivery",
      didRun: true,
      nextAction: finalAcceptance.status === "success" ? "交付闭环完成，可以提交代码或进入下一个模块。" : "总验收存在风险，先处理 findings。",
      reason: [finalAcceptance.summary],
      summary: finalAcceptance.summary,
      extra: { finalAcceptance, taskPlan: latestTaskPlan },
    });
  }

  return autoAdvanceResponse({
    status: payload.finalAcceptance.status === "success" ? "success" : "waiting",
    action: payload.finalAcceptance.status === "success" ? "done" : "wait",
    didRun: false,
    nextAction: payload.finalAcceptance.status === "success" ? "当前模块已经完成。" : "总验收仍有风险，先处理验收发现。",
    reason: [payload.finalAcceptance.summary],
    summary: payload.finalAcceptance.summary,
    extra: { taskPlan: latestTaskPlan, finalAcceptance: payload.finalAcceptance },
  });
}

function mergeAutoAdvanceState(state, result) {
  return {
    ...state,
    contextPackage: result.contextPackage || state.contextPackage || null,
    executionPackage: result.executionPackage || state.executionPackage || null,
    taskPlan: result.taskPlan || state.taskPlan || null,
    validationRun: result.validationRun || state.validationRun || null,
    pageSmoke: result.pageSmoke || state.pageSmoke || null,
    knowledgeWrite: result.knowledgeWrite || state.knowledgeWrite || null,
    finalAcceptance: result.finalAcceptance || state.finalAcceptance || null,
  };
}

async function autoRunUntilPause(payload) {
  const maxSteps = Math.min(20, Math.max(1, Number(payload.maxSteps || 20)));
  let state = { ...payload };
  let latest = null;
  const steps = [];

  for (let index = 0; index < maxSteps; index += 1) {
    latest = await autoAdvanceOnce(state);
    steps.push({
      action: latest.action,
      status: latest.status,
      didRun: latest.didRun,
      summary: latest.summary,
      nextAction: latest.nextAction,
      generatedAt: latest.generatedAt,
    });
    state = mergeAutoAdvanceState(state, latest);

    if (latest.status !== "success" || !latest.didRun || latest.action === "done") {
      break;
    }
  }

  if (!latest) {
    return autoAdvanceResponse({
      status: "waiting",
      action: "wait",
      didRun: false,
      nextAction: "没有可执行步骤。",
      reason: ["自动运行未产生任何步骤。"],
      summary: "自动运行到暂停点未执行。",
      extra: { steps },
    });
  }

  const ranCount = steps.filter((item) => item.didRun).length;
  return {
    ...latest,
    steps,
    summary: `自动运行到暂停点：已执行 ${ranCount} 个小步。${latest.summary}`,
  };
}

function smokeDirectoriesForPayload(payload) {
  const task = payload.task || {};
  const projectScan = payload.projectScan || null;
  const taskPlan = payload.taskPlan || null;
  if (taskPlan?.moduleDirectory) {
    return {
      projectDirectory: taskPlan.projectDirectory || dirname(taskPlan.moduleDirectory),
      moduleDirectory: taskPlan.moduleDirectory,
    };
  }

  const projectName = safeName(projectScan?.projectName || task.projectName || basename(task.projectPath || "项目实例"), "项目实例");
  const moduleName = safeName(task.moduleName, "未命名模块");
  const projectDirectory = join(knowledgeRoot, "08-项目实例", projectName);
  return {
    projectDirectory,
    moduleDirectory: join(projectDirectory, moduleName),
  };
}

function visibleHtmlText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractHtmlTitle(html) {
  const match = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? visibleHtmlText(match[1]).slice(0, 160) : "";
}

function createPageSmokeMarkdown(result) {
  return `# 轻量页面点测

> 本文件是本地 runner 对页面 URL 的轻量 smoke test。它只检查可访问性、标题、关键词和明显错误文本，不替代 Playwright、截图对比或人工验收。

## 结论

- 状态：${result.status}
- URL：${result.url || "未提供"}
- HTTP：${result.httpStatus ?? "-"}
- 标题：${result.title || "未识别"}
- HTML 长度：${result.bodyLength}
- 时间：${result.generatedAt}

${result.summary}

## 检查项

| 检查项 | 状态 | 说明 |
| --- | --- | --- |
${result.checks.map((item) => `| ${tableCell(item.name)} | ${tableCell(item.status)} | ${tableCell(item.message)} |`).join("\n")}

## 关键词

### 已检查关键词

${formatList(result.checkedKeywords, "未提供")}

### 缺失关键词

${formatList(result.missingKeywords, "无")}

## 明显错误文本

${formatList(result.detectedErrors, "未发现")}
`;
}

async function runPageSmokeTest(payload) {
  const task = payload.task || {};
  const rawUrl = String(task.pageUrl || "").trim();
  const generatedAt = new Date().toISOString();
  const { projectDirectory, moduleDirectory } = smokeDirectoriesForPayload(payload);
  const smokeFile = join(moduleDirectory, `页面点测-${timestampForFile()}.auto.md`);
  const checkedKeywords = formatTaskLines(task.smokeKeywords);
  const commonErrorTexts = [
    "Cannot read properties",
    "ReferenceError",
    "TypeError",
    "Unhandled Runtime Error",
    "Internal Server Error",
    "Application error",
    "Not Found",
    "页面不存在",
    "服务异常",
  ];

  const baseResult = {
    status: "skipped",
    url: rawUrl,
    httpStatus: null,
    title: "",
    bodyLength: 0,
    checkedKeywords,
    missingKeywords: [],
    detectedErrors: [],
    checks: [],
    knowledgeRoot,
    projectDirectory,
    moduleDirectory,
    smokeFile,
    summary: "",
    generatedAt,
  };

  if (!rawUrl) {
    const result = {
      ...baseResult,
      status: "skipped",
      checks: [{ name: "URL", status: "warning", message: "未填写页面点测 URL，已跳过。" }],
      summary: "未填写页面点测 URL，已跳过轻量页面点测。",
    };
    mkdirSync(moduleDirectory, { recursive: true });
    writeFileSync(smokeFile, `${createPageSmokeMarkdown(result).trim()}\n`, "utf8");
    return result;
  }

  if (!/^https?:\/\//i.test(rawUrl)) {
    const result = {
      ...baseResult,
      status: "error",
      checks: [{ name: "URL", status: "failed", message: "页面点测 URL 必须以 http:// 或 https:// 开头。" }],
      summary: "页面点测 URL 格式不正确。",
    };
    mkdirSync(moduleDirectory, { recursive: true });
    writeFileSync(smokeFile, `${createPageSmokeMarkdown(result).trim()}\n`, "utf8");
    return result;
  }

  const checks = [{ name: "URL", status: "passed", message: "URL 格式正确。" }];
  let httpStatus = null;
  let title = "";
  let bodyLength = 0;
  let missingKeywords = [];
  let detectedErrors = [];

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let response;
    try {
      response = await fetch(rawUrl, {
        redirect: "follow",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    httpStatus = response.status;
    const html = await response.text();
    title = extractHtmlTitle(html);
    bodyLength = html.length;
    const visibleText = visibleHtmlText(html);

    checks.push({
      name: "HTTP",
      status: response.ok ? "passed" : "failed",
      message: `${response.status} ${response.statusText || ""}`.trim(),
    });
    checks.push({
      name: "页面内容",
      status: bodyLength > 0 ? "passed" : "failed",
      message: bodyLength > 0 ? `HTML 长度 ${bodyLength}` : "页面响应为空。",
    });
    checks.push({
      name: "标题",
      status: title ? "passed" : "warning",
      message: title || "未识别到 title。",
    });

    missingKeywords = checkedKeywords.filter((keyword) => !visibleText.includes(keyword));
    if (checkedKeywords.length) {
      checks.push({
        name: "关键词",
        status: missingKeywords.length ? "failed" : "passed",
        message: missingKeywords.length ? `缺失：${missingKeywords.join("、")}` : `已命中 ${checkedKeywords.length} 个关键词。`,
      });
    } else {
      checks.push({
        name: "关键词",
        status: "warning",
        message: "未填写点测关键词，只检查页面是否可访问。",
      });
    }

    detectedErrors = commonErrorTexts.filter((item) => visibleText.includes(item) || title.includes(item));
    checks.push({
      name: "明显错误文本",
      status: detectedErrors.length ? "failed" : "passed",
      message: detectedErrors.length ? `发现：${detectedErrors.join("、")}` : "未发现常见错误文本。",
    });
  } catch (error) {
    checks.push({
      name: "请求页面",
      status: "failed",
      message: error instanceof Error ? error.message : "页面请求失败。",
    });
  }

  const hasFailed = checks.some((item) => item.status === "failed");
  const hasWarning = checks.some((item) => item.status === "warning");
  const status = hasFailed ? "failed" : hasWarning ? "warning" : "success";
  const result = {
    ...baseResult,
    status,
    httpStatus,
    title,
    bodyLength,
    missingKeywords,
    detectedErrors,
    checks,
    summary:
      status === "success"
        ? "轻量页面点测通过。"
        : status === "warning"
          ? "轻量页面点测完成但有提醒，请补齐关键词或检查标题。"
          : "轻量页面点测未通过，请查看缺失关键词、HTTP 状态或错误文本。",
  };

  mkdirSync(moduleDirectory, { recursive: true });
  writeFileSync(smokeFile, `${createPageSmokeMarkdown(result).trim()}\n`, "utf8");
  return result;
}

function reportField(report, label) {
  const labels = ["任务编号", "实际改动文件", "完成内容", "运行命令和结果", "未完成内容", "新增问题", "建议下一步"];
  const nextLabels = labels.filter((item) => item !== label).join("|");
  const pattern = new RegExp(`${label}：([\\s\\S]*?)(?:\\n(?:${nextLabels})：|$)`);
  const match = report.match(pattern);
  return match ? match[1].trim() : "";
}

function isEmptyReportField(value) {
  const normalized = String(value || "").trim();
  return !normalized || /^(无|没有|暂无|无未完成|无新增问题|none|n\/a)$/i.test(normalized);
}

function reviewDecisionFromReport(report) {
  const findings = [];
  const text = String(report || "").trim();
  if (text.length < 80) {
    findings.push("报告内容过短，无法判断任务是否完成。");
  }
  if (!reportField(text, "任务编号")) {
    findings.push("报告缺少“任务编号”。");
  }
  if (!reportField(text, "完成内容")) {
    findings.push("报告缺少“完成内容”。");
  }
  if (!reportField(text, "运行命令和结果")) {
    findings.push("报告缺少“运行命令和结果”，需要说明已运行或为何未运行。");
  }

  const unfinished = reportField(text, "未完成内容");
  if (!isEmptyReportField(unfinished)) {
    findings.push(`存在未完成内容：${unfinished}`);
  }

  const newIssues = reportField(text, "新增问题");
  if (!isEmptyReportField(newIssues) && /阻断|失败|无法|错误|报错|不通过/.test(newIssues)) {
    findings.push(`新增问题可能阻断继续执行：${newIssues}`);
  }

  if (/阻断|无法继续|无法完成/.test(text)) {
    return { decision: "blocked", findings: findings.length ? findings : ["报告中出现阻断性描述。"] };
  }

  if (findings.length || /失败|报错|不通过|未通过/.test(text)) {
    return { decision: "needs-fix", findings: findings.length ? findings : ["报告中出现失败或不通过描述。"] };
  }

  return { decision: "approved", findings: ["报告结构完整，未发现阻断或未完成描述。"] };
}

function normalizePathForMatch(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function globToRegExp(pattern) {
  const normalized = normalizePathForMatch(pattern);
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

function isAllowedChangedFile(filePath, allowedFiles = []) {
  const normalizedPath = normalizePathForMatch(filePath);
  return allowedFiles.some((pattern) => {
    const normalizedPattern = normalizePathForMatch(pattern);
    if (!normalizedPattern || normalizedPattern === "**/*") return true;
    if (normalizedPattern.endsWith("/**/*")) {
      return normalizedPath.startsWith(normalizedPattern.slice(0, -4));
    }
    if (normalizedPattern.endsWith("/**")) {
      return normalizedPath.startsWith(normalizedPattern.slice(0, -2));
    }
    return globToRegExp(normalizedPattern).test(normalizedPath);
  });
}

function parseGitStatusFiles(output) {
  return String(output || "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const value = line.slice(3).trim();
      const renamed = value.includes(" -> ") ? value.split(" -> ").pop() : value;
      return normalizePathForMatch(renamed);
    })
    .filter(Boolean);
}

async function collectGitReviewScope(task, taskItem) {
  const projectPath = task?.projectPath;
  if (!projectPath || !existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
    return {
      status: "skipped",
      changedFiles: [],
      outOfScopeFiles: [],
      message: "目标项目路径不存在，跳过 git diff 越界检查。",
    };
  }

  if (!existsSync(join(projectPath, ".git"))) {
    return {
      status: "skipped",
      changedFiles: [],
      outOfScopeFiles: [],
      message: "目标项目不是 git 仓库，跳过 git diff 越界检查。",
    };
  }

  const result = await runProcess({
    command: "git",
    args: ["status", "--short"],
    cwd: projectPath,
    timeoutMs: 30000,
  });

  if (result.status !== "passed") {
    return {
      status: "error",
      changedFiles: [],
      outOfScopeFiles: [],
      message: `git status 执行失败：${result.output}`,
    };
  }

  const changedFiles = parseGitStatusFiles(result.output);
  const baseline = new Set((taskItem.baselineChangedFiles || []).map((filePath) => normalizePathForMatch(filePath)));
  const taskChangedFiles = changedFiles.filter((filePath) => !baseline.has(filePath));
  const outOfScopeFiles = taskChangedFiles.filter((filePath) => !isAllowedChangedFile(filePath, taskItem.allowedFiles));
  return {
    status: outOfScopeFiles.length ? "warning" : "ok",
    changedFiles: taskChangedFiles,
    outOfScopeFiles,
    message: taskChangedFiles.length
      ? `检测到 ${taskChangedFiles.length} 个本任务新增/变更文件，${outOfScopeFiles.length} 个超出当前任务允许范围。`
      : "派发任务后未检测到新的 git 改动文件。",
  };
}

async function collectGitChangedFiles(task) {
  const projectPath = task?.projectPath;
  if (!projectPath || !existsSync(projectPath) || !statSync(projectPath).isDirectory() || !existsSync(join(projectPath, ".git"))) {
    return [];
  }

  const result = await runProcess({
    command: "git",
    args: ["status", "--short"],
    cwd: projectPath,
    timeoutMs: 30000,
  });

  return result.status === "passed" ? parseGitStatusFiles(result.output) : [];
}

function nextFixTaskId(tasks, taskId) {
  const base = `${taskId}-fix`;
  if (!tasks.some((item) => item.id === base)) return base;
  let index = 2;
  while (tasks.some((item) => item.id === `${base}-${index}`)) {
    index += 1;
  }
  return `${base}-${index}`;
}

function taskIdSegment(value, fallback = "issue") {
  const segment = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42);
  return segment || fallback;
}

function nextIssueFixTaskId(tasks, issueId) {
  const base = `issue-${taskIdSegment(issueId)}-fix`;
  if (!tasks.some((item) => item.id === base)) return base;
  let index = 2;
  while (tasks.some((item) => item.id === `${base}-${index}`)) {
    index += 1;
  }
  return `${base}-${index}`;
}

function collectAllowedFilesFromTasks(tasks) {
  const files = tasks.flatMap((item) => (Array.isArray(item.allowedFiles) ? item.allowedFiles : []));
  return Array.from(new Set(files.length ? files : ["src/**/*", "docs/**/*"]));
}

function createFixTask(originalTask, findings, reviewFile) {
  const id = nextFixTaskId([originalTask], originalTask.fixOf || originalTask.id);
  const rootTaskId = originalTask.fixOf || originalTask.id;
  return {
    id,
    title: `${originalTask.title} 修复`,
    status: "pending",
    fixOf: rootTaskId,
    dependsOn: [],
    goal: `修复 ${rootTaskId} review 中发现的问题，只处理本次 review 反馈，不扩展新功能。`,
    allowedFiles: originalTask.allowedFiles,
    forbidden: [...originalTask.forbidden, "不重新生成整个模块", "不跳过原任务验收标准"],
    inputs: [...originalTask.inputs, originalTask.promptFile, ...(reviewFile ? [basename(reviewFile)] : [])],
    acceptance: [...originalTask.acceptance, "review findings 已逐条处理", "完成后重新提交报告"],
    promptFile: `${id}.prompt.auto.md`,
  };
}

function createFixTaskPrompt(originalTask, fixTask, findings, report, reviewFile) {
  return `# ${fixTask.id} ${fixTask.title}

你是写代码 AI。你现在只修复上一轮 review 指出的问题，不要重写整个模块，不要提前做后续任务。

## 原任务

- ${originalTask.id} ${originalTask.title}

## 修复目标

${fixTask.goal}

## review findings

${formatList(findings)}

## 上一轮报告

\`\`\`text
${report.trim()}
\`\`\`

## review 文件

- ${reviewFile}

## 必须遵守

- ${codingAgentProtocolPath}

## 允许改动范围

${formatList(fixTask.allowedFiles)}

## 禁止事项

${formatList(fixTask.forbidden)}

## 完成后回报

\`\`\`text
任务编号：${fixTask.id}
实际改动文件：
完成内容：
运行命令和结果：
未完成内容：
新增问题：
建议下一步：
\`\`\`
`;
}

function createIssueFixTask(issue, tasks) {
  const id = nextIssueFixTaskId(tasks, issue.id);
  return {
    id,
    title: `修复问题：${issue.title || issue.id}`,
    status: "pending",
    fixOf: issue.id,
    dependsOn: [],
    goal: `修复问题池中的 ${issue.id}：${issue.title}。只处理这个问题，不扩展新功能。`,
    allowedFiles: collectAllowedFilesFromTasks(tasks),
    forbidden: ["不重写整个模块", "不跳过命令验收", "不修改 allowedFiles 之外的文件", "不把接口缺口伪造成前端本地逻辑"],
    inputs: ["问题池", "task-queue.auto.json", "review 文件", "命令验收结果"],
    acceptance: ["问题描述已处理或明确降级", "没有新增越界改动", "完成后重新提交系统 review", "必要时更新问题池和规则沉淀"],
    promptFile: `${id}.prompt.auto.md`,
  };
}

function createIssueFixTaskPrompt(issue, fixTask, task) {
  return `# ${fixTask.id} ${fixTask.title}

你是写代码 AI。你现在只处理系统 AI 问题池中的一个问题，不要顺手做其他功能。

## 真实项目

- 项目：${task.projectName || "未命名项目"}
- 路径：${task.projectPath || "未填写"}
- 模块：${task.moduleName || "未命名模块"}

## 问题卡

- 编号：${issue.id}
- 等级：${issue.level}
- 责任方：${issue.owner}
- 是否阻断：${issue.canContinue ? "不阻断，可继续后续流程" : "阻断，必须先处理"}
- 标题：${issue.title}
- 描述：${issue.description}

## 修复目标

${fixTask.goal}

## 必须遵守

- ${codingAgentProtocolPath}

## 允许改动范围

${formatList(fixTask.allowedFiles)}

## 禁止事项

${formatList(fixTask.forbidden)}

## 验收标准

${formatList(fixTask.acceptance)}

## 完成后回报

\`\`\`text
任务编号：${fixTask.id}
实际改动文件：
完成内容：
运行命令和结果：
未完成内容：
新增问题：
建议下一步：
\`\`\`
`;
}

function createIssueFixTaskFromIssue(payload) {
  const task = payload.task || {};
  const issue = payload.issue || null;
  if (!issue?.id) {
    throw new Error("缺少问题卡 issue.id，不能生成修复任务。");
  }

  const { taskPlan, planDirectory, tasks } = taskPlanStateFromPayload(payload);
  const existingTask = tasks.find((item) => item.fixOf === issue.id && item.status !== "done");
  if (existingTask) {
    return {
      status: "success",
      taskId: existingTask.id,
      issueId: issue.id,
      promptFile: join(planDirectory, existingTask.promptFile),
      updatedTaskPlan: updatedTaskPlan(taskPlan, tasks),
      summary: `问题 ${issue.id} 已有未完成修复任务：${existingTask.id}。`,
      generatedAt: new Date().toISOString(),
    };
  }

  const fixTask = createIssueFixTask(issue, tasks);
  tasks.push(fixTask);
  const promptPath = join(planDirectory, fixTask.promptFile);
  writeFileSync(promptPath, `${createIssueFixTaskPrompt(issue, fixTask, task).trim()}\n`, "utf8");
  const nextPlan = writeTaskPlanState(task, taskPlan, tasks, [promptPath]);

  return {
    status: "success",
    taskId: fixTask.id,
    issueId: issue.id,
    promptFile: promptPath,
    updatedTaskPlan: nextPlan,
    summary: `已为问题 ${issue.id} 生成修复任务：${fixTask.id}。`,
    generatedAt: new Date().toISOString(),
  };
}

function normalizeUserFeedback(feedback = {}) {
  return {
    title: String(feedback.title || "").trim(),
    description: String(feedback.description || "").trim(),
    expected: String(feedback.expected || "").trim(),
    evidence: String(feedback.evidence || "").trim(),
    acceptance: String(feedback.acceptance || "").trim(),
  };
}

function userFeedbackId() {
  return `feedback-${taskIdSegment(timestampForFile(), "feedback")}`;
}

function nextUserFeedbackTaskId(tasks, feedbackId) {
  const base = `user-fix-${taskIdSegment(feedbackId, "feedback")}`;
  if (!tasks.some((item) => item.id === base)) return base;
  let index = 2;
  while (tasks.some((item) => item.id === `${base}-${index}`)) {
    index += 1;
  }
  return `${base}-${index}`;
}

function feedbackCacheDirectory(task) {
  const moduleName = safeName(task?.moduleName, "未命名模块").replace(/\s+/g, "-");
  const directory = join(helperCacheRoot, `feedback-${moduleName}-${dateStamp()}`);
  mkdirSync(directory, { recursive: true });
  return directory;
}

function createUserFeedbackTaskItem(feedback, tasks, feedbackId) {
  const id = nextUserFeedbackTaskId(tasks, feedbackId);
  const acceptance = formatTaskLines(feedback.acceptance);
  return {
    id,
    title: `返工修复：${feedback.title || feedbackId}`,
    status: "pending",
    fixOf: feedbackId,
    dependsOn: [],
    goal: `根据用户最新返工要求修复：${feedback.title || feedback.description}。先判断问题原因，再做最小范围修复。`,
    allowedFiles: collectAllowedFilesFromTasks(tasks),
    forbidden: [
      "不重写整个模块",
      "不扩展到用户未要求的新功能",
      "不修改 allowedFiles 之外的文件",
      "不把接口缺口伪造成前端本地逻辑",
      "不把系统辅助文件写入真实目标项目",
    ],
    inputs: ["用户返工要求", "写代码AI单任务协议", "task-queue.auto.json", "最近 review 和验收结果", "项目资料包和接口资料"],
    acceptance: acceptance.length
      ? acceptance
      : ["用户描述的问题已处理或明确标记为接口/资料阻断", "写代码 AI 回答包含问题原因、改动文件、完整改动摘要和验证结果", "系统 review 后可沉淀规则建议"],
    promptFile: `${id}.prompt.auto.md`,
  };
}

function createUserFeedbackPrompt(feedback, fixTask, task, feedbackId, conversationFile, learningFile) {
  return `# ${fixTask.id} ${fixTask.title}

你是写代码 AI。你现在只处理用户在交付控制台提交的返工要求。不要顺手做其他功能，不要重写整个模块。

## 真实项目

- 项目：${task.projectName || "未命名项目"}
- 路径：${task.projectPath || "未填写"}
- 模块：${task.moduleName || "未命名模块"}

## 用户返工要求

- 编号：${feedbackId}
- 标题：${feedback.title || "未填写"}
- 问题描述：${feedback.description || "未填写"}
- 期望结果：${feedback.expected || "未填写"}
- 证据/页面/接口/截图：${feedback.evidence || "未提供"}
- 验收方式：${feedback.acceptance || "按问题描述和现有验收命令验证"}

## 你的处理步骤

1. 先判断问题属于代码、接口、资料、样式、测试还是权限问题。
2. 如果可以修，做最小范围修复。
3. 如果不能修，不要猜接口、不造假数据，把阻断原因写清楚。
4. 把完整改动摘要写进完成报告，交还系统 AI review。
5. 写出“以后不能这么做”的可沉淀规则候选。

## 必须遵守

- ${codingAgentProtocolPath}

## 允许改动范围

${formatList(fixTask.allowedFiles)}

## 禁止事项

${formatList(fixTask.forbidden)}

## 验收标准

${formatList(fixTask.acceptance)}

## 系统记录位置

- 返工对话：${conversationFile}
- 规则沉淀候选：${learningFile}

## 完成后回报

\`\`\`text
任务编号：${fixTask.id}
问题原因判断：
实际改动文件：
完整改动摘要：
运行命令和结果：
页面/功能验证：
未完成内容：
新增问题：
可沉淀规则候选：
建议下一步：
\`\`\`
`;
}

function createFeedbackConversationMarkdown({ task, feedback, feedbackId, fixTask, promptFile, aiReply, learning }) {
  return `# 返工对话：${feedback.title || feedbackId}

> 本文件属于模块项目交付系统的辅助缓存，不写入真实目标项目。

## 模块

- 项目：${task.projectName || "未填写"}
- 项目路径：${task.projectPath || "未填写"}
- 模块：${task.moduleName || "未填写"}

## 用户提交

- 编号：${feedbackId}
- 标题：${feedback.title || "未填写"}
- 问题描述：${feedback.description || "未填写"}
- 期望结果：${feedback.expected || "未填写"}
- 证据：${feedback.evidence || "未提供"}
- 验收方式：${feedback.acceptance || "未提供"}

## 系统 AI 回答

${aiReply}

## 派发任务

- taskId：${fixTask.id}
- prompt：${promptFile}

## 规则沉淀候选

${formatList(learning)}
`;
}

function createFeedbackLearningMarkdown({ task, feedback, feedbackId, fixTask, learning }) {
  return `# 用户返工沉淀：${feedback.title || feedbackId}

## 来源

- 项目：${task.projectName || "未填写"}
- 模块：${task.moduleName || "未填写"}
- 返工编号：${feedbackId}
- 修复任务：${fixTask.id}

## 问题

${feedback.description || "未填写"}

## 期望

${feedback.expected || "未填写"}

## 可复用规则候选

${formatList(learning)}

## 后续处理

- 写代码 AI 完成后，将完成报告粘贴到控制台。
- 系统 AI review 后，决定是否把候选规则提升到通用规则库。
`;
}

function createUserFeedbackTaskFromPayload(payload) {
  const task = payload.task || {};
  const feedback = normalizeUserFeedback(payload.feedback);
  if (!feedback.title && !feedback.description) {
    throw new Error("请至少填写返工标题或问题描述。");
  }

  const { taskPlan, planDirectory, tasks } = taskPlanStateFromPayload(payload);
  const feedbackId = userFeedbackId();
  const fixTask = createUserFeedbackTaskItem(feedback, tasks, feedbackId);
  tasks.push(fixTask);

  const cacheDirectory = feedbackCacheDirectory(task);
  const feedbackFile = join(cacheDirectory, `${feedbackId}.json`);
  const conversationFile = join(cacheDirectory, `${feedbackId}.conversation.md`);
  const knowledgeDirectory = join(dirname(planDirectory), "返工与规则沉淀");
  mkdirSync(knowledgeDirectory, { recursive: true });
  const knowledgeSuggestionFile = join(knowledgeDirectory, `${feedbackId}.learning.auto.md`);
  const promptPath = join(planDirectory, fixTask.promptFile);
  const learning = [
    "用户验收发现的问题必须通过返工入口转成独立 fix task，不应口头修改后丢失上下文。",
    "写代码 AI 必须说明问题原因、完整改动摘要、验证结果和可沉淀规则候选。",
    "返工辅助文件只保存在交付系统缓存和知识库，不写入真实目标项目。",
  ];
  const aiReply = `系统已记录这次返工要求，并生成受控修复任务 ${fixTask.id}。下一步把该任务派发给写代码 AI；写代码 AI 的回答、改动摘要和验证结果会回到控制台，由系统 AI review 后再沉淀规则。`;

  writeFileSync(
    feedbackFile,
    `${JSON.stringify({ feedbackId, task, feedback, fixTask, createdAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(promptPath, `${createUserFeedbackPrompt(feedback, fixTask, task, feedbackId, conversationFile, knowledgeSuggestionFile).trim()}\n`, "utf8");
  writeFileSync(
    conversationFile,
    `${createFeedbackConversationMarkdown({ task, feedback, feedbackId, fixTask, promptFile: promptPath, aiReply, learning }).trim()}\n`,
    "utf8",
  );
  writeFileSync(
    knowledgeSuggestionFile,
    `${createFeedbackLearningMarkdown({ task, feedback, feedbackId, fixTask, learning }).trim()}\n`,
    "utf8",
  );

  const nextPlan = writeTaskPlanState(task, taskPlan, tasks, [promptPath, knowledgeSuggestionFile]);

  return {
    status: "success",
    taskId: fixTask.id,
    issueId: feedbackId,
    feedbackId,
    promptFile: promptPath,
    feedbackFile,
    conversationFile,
    knowledgeSuggestionFile,
    aiReply,
    changedSummary: `已新增返工任务 ${fixTask.id}，等待写代码 AI 执行；当前还没有真实代码改动。`,
    learning,
    updatedTaskPlan: nextPlan,
    summary: `已记录用户返工要求，并生成修复任务：${fixTask.id}。`,
    generatedAt: new Date().toISOString(),
  };
}

function createReviewFileContent(taskItem, decision, findings, report, nextTaskId, scope) {
  return `# ${taskItem.id} review（自动生成）

## 结论

- decision：${decision}
- next：${nextTaskId || "无"}

## findings

${formatList(findings)}

## git diff 范围检查

- 状态：${scope.status}
- 说明：${scope.message}

### 本任务新增/变更文件

${formatList(scope.changedFiles)}

### 超出当前任务允许范围的文件

${formatList(scope.outOfScopeFiles, "无")}

## 写代码 AI 报告

\`\`\`text
${report.trim()}
\`\`\`
`;
}

async function reviewTaskResult(payload) {
  const task = payload.task || {};
  const report = String(payload.report || "").trim();
  if (!report) {
    throw new Error("缺少写代码 AI 完成报告。");
  }

  const { taskPlan, planDirectory, tasks } = taskPlanStateFromPayload(payload);
  const currentTask = tasks.find((item) => item.id === payload.taskId);
  if (!currentTask) {
    throw new Error(`未找到任务：${payload.taskId}`);
  }

  currentTask.status = "submitted";
  const review = reviewDecisionFromReport(report);
  const scope = await collectGitReviewScope(task, currentTask);
  if (scope.status === "warning") {
    review.findings.push(`存在超出当前任务允许范围的改动：${scope.outOfScopeFiles.join("、")}`);
    if (review.decision === "approved") {
      review.decision = "needs-fix";
    }
  } else if (scope.status === "error") {
    review.findings.push(scope.message);
    if (review.decision === "approved") {
      review.decision = "needs-fix";
    }
  }
  const reviewsDirectory = join(planDirectory, "reviews");
  mkdirSync(reviewsDirectory, { recursive: true });

  let fixPromptFile = null;
  let fixPromptPath = null;
  if (review.decision === "approved") {
    currentTask.status = "done";
    if (currentTask.fixOf) {
      const originalTask = tasks.find((item) => item.id === currentTask.fixOf);
      if (originalTask) {
        originalTask.status = "done";
      }
    }
  } else if (review.decision === "blocked") {
    currentTask.status = "blocked";
  } else {
    currentTask.status = "needs-fix";
    const rootTask = currentTask.fixOf ? tasks.find((item) => item.id === currentTask.fixOf) || currentTask : currentTask;
    const fixTaskId = nextFixTaskId(tasks, rootTask.id);
    const fixTask = {
      ...createFixTask(rootTask, review.findings, ""),
      id: fixTaskId,
      promptFile: `${fixTaskId}.prompt.auto.md`,
    };
    tasks.splice(tasks.findIndex((item) => item.id === currentTask.id) + 1, 0, fixTask);
    fixPromptPath = join(planDirectory, fixTask.promptFile);
    fixPromptFile = fixPromptPath;
  }

  const nextTask = nextDispatchableTask(tasks);
  const reviewFile = join(reviewsDirectory, `${payload.taskId}-review-${timestampForFile()}.md`);
  writeFileSync(reviewFile, `${createReviewFileContent(currentTask, review.decision, review.findings, report, nextTask?.id || null, scope).trim()}\n`, "utf8");

  if (fixPromptPath) {
    const fixTask = tasks.find((item) => item.promptFile === basename(fixPromptPath));
    writeFileSync(fixPromptPath, `${createFixTaskPrompt(currentTask, fixTask, review.findings, report, reviewFile).trim()}\n`, "utf8");
  }

  const nextPlan = writeTaskPlanState(task, taskPlan, tasks, [reviewFile, ...(fixPromptPath ? [fixPromptPath] : [])]);

  return {
    status: "success",
    decision: review.decision,
    taskId: currentTask.id,
    nextTaskId: nextDispatchableTask(tasks)?.id || null,
    findings: review.findings,
    changedFiles: scope.changedFiles,
    outOfScopeFiles: scope.outOfScopeFiles,
    reviewFile,
    fixPromptFile,
    updatedTaskPlan: nextPlan,
    summary:
      review.decision === "approved"
        ? `${currentTask.id} review 通过，可以继续下一任务。`
        : review.decision === "blocked"
          ? `${currentTask.id} review 阻断，需要人工处理。`
          : `${currentTask.id} review 未通过，已生成修复任务。`,
    generatedAt: new Date().toISOString(),
  };
}

function taskCounts(tasks) {
  return {
    total: tasks.length,
    done: tasks.filter((item) => item.status === "done").length,
    pending: tasks.filter((item) => item.status === "pending").length,
    assigned: tasks.filter((item) => item.status === "assigned" || item.status === "submitted" || item.status === "reviewed").length,
    needsFix: tasks.filter((item) => item.status === "needs-fix").length,
    blocked: tasks.filter((item) => item.status === "blocked").length,
  };
}

function dryRunActionForTask(taskItem, tasks, currentTaskId) {
  const checks = [
    "只派发单个 task prompt",
    "检查写代码 AI 完成报告字段",
    "检查派发后的 git diff 是否落在 allowedFiles",
    "失败时生成 fix task，不跳过 review",
  ];

  if (taskItem.status === "done") {
    return {
      id: `dry-${taskItem.id}`,
      title: `${taskItem.id} 已完成`,
      taskId: taskItem.id,
      action: "skip",
      status: "done",
      checks,
      summary: `${taskItem.id} 已完成，自动执行器会跳过。`,
    };
  }

  if (taskItem.status === "blocked") {
    return {
      id: `dry-${taskItem.id}`,
      title: `${taskItem.id} 阻断`,
      taskId: taskItem.id,
      action: "blocked",
      status: "blocked",
      checks,
      summary: `${taskItem.id} 已阻断，必须人工确认后才能继续。`,
    };
  }

  if (taskItem.status === "needs-fix") {
    const hasFixTask = tasks.some((item) => item.fixOf === taskItem.id && item.status !== "done");
    return {
      id: `dry-${taskItem.id}`,
      title: `${taskItem.id} 等待修复`,
      taskId: taskItem.id,
      action: "fix",
      status: hasFixTask ? "waiting" : "ready",
      checks,
      summary: hasFixTask ? `${taskItem.id} 已有未完成修复任务，自动执行器会优先派发修复任务。` : `${taskItem.id} 需要先生成 fix task。`,
    };
  }

  if (taskItem.status === "assigned" || taskItem.status === "submitted" || taskItem.status === "reviewed") {
    return {
      id: `dry-${taskItem.id}`,
      title: `${taskItem.id} 等待 review`,
      taskId: taskItem.id,
      action: "review",
      status: "ready",
      checks,
      summary: `${taskItem.id} 已派发，下一步应收集写代码 AI 报告并执行系统 review。`,
    };
  }

  if (taskItem.id === currentTaskId) {
    return {
      id: `dry-${taskItem.id}`,
      title: `${taskItem.id} 可派发`,
      taskId: taskItem.id,
      action: "dispatch",
      status: "ready",
      checks,
      summary: `${taskItem.id} 是当前可执行任务，自动执行器会锁定它并生成单任务输入。`,
    };
  }

  const waitingFor = taskItem.dependsOn.filter((taskId) => !isTaskDone(tasks, taskId));
  return {
    id: `dry-${taskItem.id}`,
    title: `${taskItem.id} 等待依赖`,
    taskId: taskItem.id,
    action: "wait",
    status: "waiting",
    checks,
    summary: waitingFor.length ? `${taskItem.id} 等待依赖完成：${waitingFor.join("、")}。` : `${taskItem.id} 等待前序任务推进。`,
  };
}

function createAutoDryRunMarkdown(result) {
  const rows = result.steps
    .map((step) => `| ${tableCell(step.id)} | ${tableCell(step.action)} | ${tableCell(step.status)} | ${tableCell(step.summary)} |`)
    .join("\n");
  const warnings = result.warnings.length ? result.warnings.map((item) => `- ${item}`).join("\n") : "- 暂无。";

  return `# 自动执行器干跑计划

> 本文件只描述自动执行器将如何推进任务，不调用 AI，不写真实项目。

## 结论

- 状态：${result.status}
- 当前任务：${result.currentTaskId || "无"}
- 任务进度：${result.taskSummary.done}/${result.taskSummary.total}

${result.summary}

## 风险提示

${warnings}

## 执行步骤

| 步骤 | 动作 | 状态 | 说明 |
| --- | --- | --- | --- |
${rows}

## 固定检查

- 每次只处理一个 task。
- 写代码 AI 必须按单任务协议输出报告。
- 系统 AI 必须检查 git diff 和 allowedFiles。
- review 不通过必须生成 fix task。
- 达到修复上限后必须进入人工确认。
`;
}

function prepareAutoDryRun(payload) {
  const { taskPlan, planDirectory, tasks } = taskPlanStateFromPayload(payload);
  const counts = taskCounts(tasks);
  const currentTask = nextDispatchableTask(tasks);
  const warnings = [];

  if (counts.blocked) {
    warnings.push(`存在 ${counts.blocked} 个阻断任务，自动执行器不会继续推进。`);
  }
  if (counts.needsFix) {
    warnings.push(`存在 ${counts.needsFix} 个需修复任务，必须先进入 fix task。`);
  }
  if (counts.assigned) {
    warnings.push(`存在 ${counts.assigned} 个已派发/待 review 任务，下一步应先收集报告并 review。`);
  }
  if (!currentTask && counts.done < counts.total && !counts.blocked) {
    warnings.push("当前没有可派发任务，可能是依赖状态未满足。");
  }

  const taskSteps = tasks.map((item) => dryRunActionForTask(item, tasks, currentTask?.id || null));
  const allDone = counts.total > 0 && counts.done === counts.total;
  const steps = [
    ...taskSteps,
    {
      id: "dry-validation",
      title: "命令验收",
      taskId: null,
      action: "validate",
      status: allDone ? "ready" : "waiting",
      checks: ["只运行 package.json 已声明的 typecheck/lint/build", "保存命令结果", "失败进入问题池"],
      summary: allDone ? "全部任务完成后可以执行命令验收。" : "等待任务队列全部完成后再执行命令验收。",
    },
    {
      id: "dry-finalize",
      title: "总验收和知识沉淀",
      taskId: null,
      action: "finalize",
      status: allDone ? "planned" : "waiting",
      checks: ["生成 final-acceptance.auto.md", "检查问题池", "生成规则沉淀建议"],
      summary: allDone ? "命令验收和知识写入完成后生成总验收。" : "等待任务、命令验收和知识沉淀完成。",
    },
  ];

  const status = counts.blocked ? "blocked" : warnings.length ? "warning" : "success";
  const dryRunFile = join(planDirectory, "auto-dry-run.auto.md");
  const result = {
    status,
    mode: "dry-run",
    planDirectory,
    dryRunFile,
    currentTaskId: currentTask?.id || null,
    taskSummary: counts,
    steps,
    warnings,
    summary:
      status === "blocked"
        ? "自动执行器干跑发现阻断任务，需要人工确认。"
        : currentTask
          ? `自动执行器干跑完成，下一步应处理 ${currentTask.id}。`
          : allDone
            ? "自动执行器干跑完成，任务队列已完成，可以进入验收。"
            : "自动执行器干跑完成，但当前没有可派发任务。",
    generatedAt: new Date().toISOString(),
  };

  writeFileSync(dryRunFile, `${createAutoDryRunMarkdown(result).trim()}\n`, "utf8");
  return result;
}

function reviewFiles(planDirectory) {
  const reviewsDirectory = join(planDirectory, "reviews");
  if (!existsSync(reviewsDirectory) || !statSync(reviewsDirectory).isDirectory()) {
    return [];
  }

  return readdirSync(reviewsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(reviewsDirectory, entry.name))
    .sort();
}

function createFinalAcceptanceContent(payload, tasks, reviews, counts, status, findings, rules) {
  const task = payload.task || {};
  const validationRun = payload.validationRun || null;
  const knowledgeWrite = payload.knowledgeWrite || null;
  const pageSmoke = payload.pageSmoke || null;
  const issues = Array.isArray(payload.issues) ? payload.issues : [];
  const taskRows = tasks.length
    ? tasks
        .map(
          (item) =>
            `| ${item.id} | ${tableCell(item.title)} | ${item.status} | ${tableCell(item.fixOf || "-")} | ${tableCell(item.promptFile)} |`,
        )
        .join("\n")
    : "| 无 | 无任务 | - | - | - |";
  const issueRows = issues.length
    ? issues
        .map(
          (issue) =>
            `| ${tableCell(issue.id)} | ${tableCell(issue.level)} | ${tableCell(issue.title)} | ${tableCell(issue.owner)} | ${issue.canContinue ? "可继续" : "阻断"} | ${tableCell(issue.description)} |`,
        )
        .join("\n")
    : "| 无 | 无 | 暂无运行问题 | 无 | 可继续 | - |";

  return `# ${task.moduleName || "未命名模块"} 总验收与知识沉淀（自动生成）

## 结论

- 状态：${status}
- 任务完成：${counts.done}/${counts.total}
- 生成时间：${new Date().toLocaleString("zh-CN", { hour12: false })}

## 任务状态

| 任务 | 标题 | 状态 | 修复来源 | prompt |
| --- | --- | --- | --- | --- |
${taskRows}

## 验收发现

${formatList(findings)}

## 运行问题池

| 编号 | 等级 | 问题 | 责任方 | 是否阻断 | 描述 |
| --- | --- | --- | --- | --- | --- |
${issueRows}

## 命令验收

- 状态：${validationRun?.status || "未执行"}
- 摘要：${validationRun?.summary || "未执行命令验收"}

## 页面点测

- 状态：${pageSmoke?.status || "未执行"}
- URL：${pageSmoke?.url || "未提供"}
- 摘要：${pageSmoke?.summary || "未执行页面点测"}
- 报告：${pageSmoke?.smokeFile || "无"}

## 知识库写入

- 状态：${knowledgeWrite?.status || "未写入"}
- 摘要：${knowledgeWrite?.summary || "未写入知识库"}

## review 文件

${formatList(reviews)}

## 可沉淀规则

${formatList(rules)}

## 后续处理建议

- 如果状态为 \`success\`：可以进入人工最终验收或提交代码。
- 如果状态为 \`warning\`：优先处理 pending / assigned / needs-fix 任务。
- 如果状态为 \`blocked\`：先处理 blocked 任务或接口、权限、需求等阻断问题。
`;
}

function createRuleSuggestionContent(payload, tasks, findings, rules) {
  const task = payload.task || {};
  const issues = Array.isArray(payload.issues) ? payload.issues : [];
  const validationRun = payload.validationRun || null;
  const pageSmoke = payload.pageSmoke || null;
  const issueRows = issues.length
    ? issues
        .map(
          (issue) =>
            `| ${tableCell(issue.id)} | ${tableCell(issue.level)} | ${tableCell(issue.owner)} | ${issue.canContinue ? "可继续" : "阻断"} | ${tableCell(issue.title)} | ${tableCell(issue.description)} |`,
        )
        .join("\n")
    : "| 无 | 无 | 无 | 可继续 | 暂无问题 | - |";
  const taskRows = tasks.length
    ? tasks.map((item) => `| ${tableCell(item.id)} | ${tableCell(item.title)} | ${tableCell(item.status)} | ${tableCell(item.goal)} |`).join("\n")
    : "| 无 | 无任务 | - | - |";

  return `# ${task.moduleName || "未命名模块"} 规则沉淀候选（自动生成）

> 本文件只生成候选规则，不自动写入通用规则库。人工确认后，再把稳定规则移动到 \`11-规则库\` 或项目特有规则文件。

## 模块信息

- 项目：${task.projectName || "未填写"}
- 模块：${task.moduleName || "未填写"}
- 生成时间：${new Date().toLocaleString("zh-CN", { hour12: false })}

## 候选规则

${formatList(rules)}

## 证据：验收发现

${formatList(findings)}

## 证据：运行问题池

| 编号 | 等级 | 责任方 | 是否阻断 | 问题 | 描述 |
| --- | --- | --- | --- | --- | --- |
${issueRows}

## 证据：任务队列

| 任务 | 标题 | 状态 | 目标 |
| --- | --- | --- | --- |
${taskRows}

## 证据：命令和页面点测

- 命令验收：${validationRun?.status || "未执行"}，${validationRun?.summary || "无摘要"}
- 页面点测：${pageSmoke?.status || "未执行"}，${pageSmoke?.summary || "无摘要"}

## 人工处理建议

- 能复用于所有项目的规则，人工复制到 \`11-规则库\`。
- 只适用于当前项目的规则，放入项目实例目录。
- 仍然不确定的规则，保留在本文件，不要进入通用规则库。
`;
}

function finalizeDelivery(payload) {
  const { taskPlan, planDirectory, tasks } = taskPlanStateFromPayload(payload);
  const counts = taskCounts(tasks);
  const reviews = reviewFiles(planDirectory);
  const issues = Array.isArray(payload.issues) ? payload.issues : [];
  const findings = [];
  const rules = [];

  if (counts.blocked > 0) {
    findings.push(`存在 ${counts.blocked} 个阻断任务，需要人工处理后再继续。`);
  }
  if (counts.needsFix > 0) {
    findings.push(`存在 ${counts.needsFix} 个需要修复的任务，应先派发 fix prompt。`);
  }
  if (counts.pending > 0 || counts.assigned > 0) {
    findings.push(`还有 ${counts.pending + counts.assigned} 个任务未完成，不建议直接视为交付完成。`);
  }
  if (!reviews.length) {
    findings.push("没有 review 文件，说明还没有经过系统 review。");
  }
  if (!payload.validationRun) {
    findings.push("尚未执行命令验收。");
  } else if (payload.validationRun.status !== "success") {
    findings.push(`命令验收状态为 ${payload.validationRun.status}，需要确认是否可交付。`);
  }
  if (!payload.pageSmoke) {
    findings.push("尚未执行轻量页面点测。");
  } else if (payload.pageSmoke.status !== "success" && payload.pageSmoke.status !== "skipped") {
    findings.push(`轻量页面点测状态为 ${payload.pageSmoke.status}：${payload.pageSmoke.summary}`);
  }
  if (!payload.knowledgeWrite) {
    findings.push("尚未写入知识库沉淀。");
  } else if (payload.knowledgeWrite.status !== "success") {
    findings.push(`知识库写入状态为 ${payload.knowledgeWrite.status}，需要检查沉淀结果。`);
  }
  if (issues.length > 0) {
    findings.push(`运行问题池记录了 ${issues.length} 个问题，需要在最终交付前逐项确认。`);
  }
  if (!findings.length) {
    findings.push("任务队列全部完成，review、命令验收和知识沉淀均已有记录。");
  }

  if (tasks.some((item) => item.status === "needs-fix" || item.fixOf)) {
    rules.push("出现 fix 任务时，后续模块应优先把相关验收点写入原始任务 acceptance，减少返工。");
  }
  if (tasks.some((item) => /接口|API|参数|字段/.test(`${item.goal} ${item.title}`))) {
    rules.push("接口字段、分页、筛选参数必须来自接口文档；缺失时记录问题，不在前端猜参数。");
  }
  if (payload.pageSmoke && payload.pageSmoke.status !== "success" && payload.pageSmoke.status !== "skipped") {
    rules.push("页面点测失败时，应记录 URL、HTTP 状态、缺失关键词和错误文本，再生成修复任务。");
  }
  if (payload.validationRun && payload.validationRun.status !== "success") {
    rules.push("命令验收未通过时，应先根据失败命令生成修复任务，不应直接进入最终交付。");
  }
  if (issues.some((issue) => issue.owner === "后端")) {
    rules.push("接口能力缺失、字段不清或后端错误时，前端只记录问题并继续可做部分，不自行猜测接口参数。");
  }
  rules.push("写代码 AI 每次只执行当前 task prompt，系统 AI review 通过后再派发下一任务。");
  rules.push("最终交付前至少保留 task queue、review 文件、命令验收、页面点测、规则候选和总验收文件。");

  const hasBlockingIssue = issues.some((issue) => issue.level === "P0" && issue.canContinue === false);
  const hasOpenIssues = issues.length > 0;
  const validationPassed = payload.validationRun?.status === "success";
  const pageSmokePassed = payload.pageSmoke?.status === "success" || payload.pageSmoke?.status === "skipped";
  const knowledgeWritten = payload.knowledgeWrite?.status === "success";
  const status =
    counts.blocked > 0 || hasBlockingIssue
      ? "blocked"
      : counts.done === counts.total && validationPassed && pageSmokePassed && knowledgeWritten && !hasOpenIssues
        ? "success"
        : "warning";
  const acceptanceFile = join(planDirectory, "final-acceptance.auto.md");
  const ruleSuggestionFile = join(dirname(planDirectory), "规则沉淀候选.auto.md");
  const content = createFinalAcceptanceContent(payload, tasks, reviews, counts, status, findings, rules);
  const ruleContent = createRuleSuggestionContent(payload, tasks, findings, rules);
  writeFileSync(acceptanceFile, `${content.trim()}\n`, "utf8");
  writeFileSync(ruleSuggestionFile, `${ruleContent.trim()}\n`, "utf8");

  const writtenFiles = Array.from(new Set([...(taskPlan.writtenFiles || []), acceptanceFile, ruleSuggestionFile, ...reviews]));
  return {
    status,
    knowledgeRoot,
    projectDirectory: taskPlan.projectDirectory || dirname(dirname(planDirectory)),
    moduleDirectory: taskPlan.moduleDirectory || dirname(planDirectory),
    planDirectory,
    acceptanceFile,
    ruleSuggestionFile,
    writtenFiles,
    taskSummary: counts,
    findings,
    rules,
    summary:
      status === "success"
        ? "总验收通过，任务队列、review、命令验收和知识沉淀均已具备。"
        : status === "blocked"
          ? "总验收阻断，存在 blocked 任务或阻断问题。"
          : "总验收有风险，仍有任务、命令验收、页面点测或知识沉淀未完成。",
    generatedAt: new Date().toISOString(),
  };
}

function writeKnowledge(payload) {
  const task = payload.task || {};
  const projectScan = payload.projectScan || null;
  const steps = Array.isArray(payload.steps) ? payload.steps : [];
  const issues = Array.isArray(payload.issues) ? payload.issues : [];
  const validation = payload.validation || null;
  const markdown = String(payload.markdown || "").trim();
  const projectName = safeName(projectScan?.projectName || task.projectName || basename(task.projectPath || "项目实例"), "项目实例");
  const moduleName = safeName(task.moduleName, "未命名模块");
  const projectDirectory = join(knowledgeRoot, "08-项目实例", projectName);
  const moduleDirectory = join(projectDirectory, moduleName);
  const reportFile = join(moduleDirectory, `交付报告-${timestampForFile()}.md`);
  const files = [
    [join(projectDirectory, "项目画像.auto.md"), createProjectProfile(task, projectScan)],
    [join(projectDirectory, "资料清单.auto.md"), createMaterialList(task)],
    [join(projectDirectory, "模块清单.auto.md"), createModuleIndex(task)],
    [join(moduleDirectory, "模块资料包.auto.md"), createModulePackage(task, projectScan)],
    [join(moduleDirectory, "模块依赖图.auto.md"), createModuleDependencyGraph(task, projectScan)],
    [join(moduleDirectory, "开发步骤卡片.auto.md"), createStepCards(steps)],
    [join(moduleDirectory, "问题追踪.auto.md"), createIssueTracker(issues)],
    [join(moduleDirectory, "测试用例.auto.md"), createTestCases(task, projectScan)],
    [join(moduleDirectory, "验收报告.auto.md"), createAcceptanceReport(task, projectScan, steps, issues, validation)],
    [reportFile, markdown || "# 交付报告\n\n暂无内容。\n"],
  ];

  mkdirSync(moduleDirectory, { recursive: true });
  for (const [filePath, content] of files) {
    writeFileSync(filePath, `${content.trim()}\n`, "utf8");
  }

  return {
    status: "success",
    knowledgeRoot,
    projectDirectory,
    moduleDirectory,
    writtenFiles: files.map(([filePath]) => filePath),
    summary: `已写入 ${files.length} 个知识库文件。`,
    generatedAt: new Date().toISOString(),
  };
}

function dateStamp(value = new Date()) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function helperRunBaseName(record) {
  const task = record?.task || {};
  const moduleName = safeName(task.moduleName, "未命名模块").replace(/\s+/g, "-");
  const createdAt = record?.createdAt ? new Date(record.createdAt) : new Date();
  const stamp = Number.isNaN(createdAt.getTime()) ? dateStamp() : dateStamp(createdAt);
  return `run-${moduleName}-${stamp}`;
}

function readHelperRunMeta(directory) {
  return safeReadJson(join(directory, "run-record.json"));
}

function runDirectoryForRecord(record) {
  const baseName = helperRunBaseName(record);
  mkdirSync(helperCacheRoot, { recursive: true });

  const entries = readdirSync(helperCacheRoot, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory() && (entry.name === baseName || entry.name.startsWith(`${baseName}-`)),
  );
  const existing = entries.find((entry) => {
    const existingRecord = readHelperRunMeta(join(helperCacheRoot, entry.name));
    return existingRecord?.runId && existingRecord.runId === record?.runId;
  });
  if (existing) {
    return join(helperCacheRoot, existing.name);
  }

  let directoryName = baseName;
  let index = 2;
  while (existsSync(join(helperCacheRoot, directoryName))) {
    directoryName = `${baseName}-${index}`;
    index += 1;
  }

  return join(helperCacheRoot, directoryName);
}

function createRunMetaMarkdown(record, runDirectory) {
  const task = record?.task || {};
  return `# ${basename(runDirectory)}

> 本目录是模块项目交付系统的本地辅助缓存，不写入用户真实项目，也不提交 Git。

## 基本信息

- runId：${record.runId || "未生成"}
- 项目：${task.projectName || "未填写"}
- 项目路径：${task.projectPath || "未填写"}
- 模块：${task.moduleName || "未填写"}
- 进度：${record.progress ?? 0}%
- 创建时间：${record.createdAt || "未知"}
- 更新时间：${record.updatedAt || "未知"}

## 用途

- 保存系统 AI 本次交付的上下文快照。
- 后续用户查询某个模块资料时，优先从本目录检索。
- 如同一模块有多个缓存目录，应按目录名日期和序号让用户选择。
`;
}

function saveRunRecord(payload) {
  const record = payload.record || {};
  const runId = safeName(record.runId, `run-${timestampForFile()}`);
  const runDirectory = runDirectoryForRecord(record);
  const normalizedRecord = {
    ...record,
    runId,
    updatedAt: new Date().toISOString(),
  };
  const runFile = join(runDirectory, `${runId}.json`);
  const latestFile = join(runDirectory, "run-record.json");
  const metaFile = join(runDirectory, "run-meta.md");

  mkdirSync(runDirectory, { recursive: true });
  writeFileSync(runFile, `${JSON.stringify(normalizedRecord, null, 2)}\n`, "utf8");
  writeFileSync(latestFile, `${JSON.stringify(normalizedRecord, null, 2)}\n`, "utf8");
  writeFileSync(metaFile, `${createRunMetaMarkdown(normalizedRecord, runDirectory).trim()}\n`, "utf8");

  return {
    status: "success",
    runId,
    runFile,
    latestFile,
    helperDirectory: runDirectory,
    summary: `运行记录已保存：${runId}`,
    generatedAt: new Date().toISOString(),
  };
}

function loadRunRecord(query) {
  const moduleName = safeName(query.get("moduleName"), "未命名模块");
  const runId = safeName(query.get("runId"), "latest");
  const candidates = listHelperRunDirectories(moduleName);
  const target = runId === "latest" ? candidates[0] : candidates.find((item) => item.name === runId || item.record?.runId === runId);
  const runFile = target ? join(target.directory, "run-record.json") : "";
  const record = safeReadJson(runFile);
  if (!record) {
    throw new Error(`未找到模块辅助缓存：${moduleName}${runId === "latest" ? "" : ` / ${runId}`}`);
  }
  return record;
}

function listHelperRunDirectories(moduleName) {
  const safeModuleName = safeName(moduleName, "未命名模块").replace(/\s+/g, "-");
  if (!existsSync(helperCacheRoot) || !statSync(helperCacheRoot).isDirectory()) {
    return [];
  }

  return readdirSync(helperCacheRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(`run-${safeModuleName}-`))
    .map((entry) => {
      const directory = join(helperCacheRoot, entry.name);
      const record = readHelperRunMeta(directory);
      return { name: entry.name, directory, record };
    })
    .sort((left, right) => String(right.record?.updatedAt || right.name).localeCompare(String(left.record?.updatedAt || left.name)));
}

function listRunRecords(query) {
  const moduleName = safeName(query.get("moduleName"), "未命名模块");
  const candidates = listHelperRunDirectories(moduleName);
  const runs = candidates
    .map((item) => {
      const record = item.record;
      if (!record) return null;
      return {
        runId: item.name,
        summary: record.summary || "无摘要",
        progress: Number(record.progress || 0),
        issueCount: Array.isArray(record.issues) ? record.issues.length : 0,
        validationStatus: record.validationRun?.status || "none",
        knowledgeStatus: record.knowledgeWrite?.status || "none",
        createdAt: record.createdAt || "",
        updatedAt: record.updatedAt || "",
        runFile: join(item.directory, "run-record.json"),
      };
    })
    .filter(Boolean)
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));

  return {
    status: "success",
    projectName: "",
    moduleName,
    runs,
    summary: `已找到 ${runs.length} 个 ${moduleName} 的辅助缓存。`,
    generatedAt: new Date().toISOString(),
  };
}

const server = createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "GET" && request.url === "/api/health") {
    const result = systemHealth();
    sendJson(response, result.status === "error" ? 500 : 200, result);
    return;
  }

  if (request.method === "GET" && request.url === "/api/ai-adapter/status") {
    const result = aiAdapterStatus();
    sendJson(response, result.status === "error" ? 500 : 200, result);
    return;
  }

  if (request.method === "POST" && request.url === "/api/scan-project") {
    try {
      const body = await readBody(request);
      const payload = body ? JSON.parse(body) : {};
      const result = scanProject(payload.projectPath);
      sendJson(response, result.status === "success" ? 200 : 400, result);
    } catch (error) {
      sendJson(response, 500, {
        status: "error",
        projectPath: "",
        projectName: "",
        packageManager: "unknown",
        frameworks: [],
        scripts: {},
        keyDirectories: [],
        keyFiles: [],
        ruleFiles: [],
        envFiles: [],
        sourcePreview: [],
        warnings: [error instanceof Error ? error.message : "未知错误"],
        summary: error instanceof Error ? error.message : "runner 扫描失败",
        generatedAt: new Date().toISOString(),
      });
    }
    return;
  }

  if (request.method === "POST" && request.url === "/api/run-validation") {
    try {
      const body = await readBody(request);
      const payload = body ? JSON.parse(body) : {};
      const result = await runValidation(payload);
      sendJson(response, result.status === "error" ? 400 : 200, result);
    } catch (error) {
      sendJson(response, 500, {
        status: "error",
        projectPath: "",
        packageManager: "unknown",
        commands: [],
        summary: error instanceof Error ? error.message : "命令验收执行失败",
        generatedAt: new Date().toISOString(),
      });
    }
    return;
  }

  if (request.method === "POST" && request.url === "/api/run-page-smoke") {
    try {
      const body = await readBody(request);
      const payload = body ? JSON.parse(body) : {};
      const result = await runPageSmokeTest(payload);
      sendJson(response, result.status === "error" ? 400 : 200, result);
    } catch (error) {
      sendJson(response, 500, {
        status: "error",
        url: "",
        httpStatus: null,
        title: "",
        bodyLength: 0,
        checkedKeywords: [],
        missingKeywords: [],
        detectedErrors: [],
        checks: [
          {
            name: "runner",
            status: "failed",
            message: error instanceof Error ? error.message : "页面点测失败",
          },
        ],
        knowledgeRoot,
        projectDirectory: "",
        moduleDirectory: "",
        smokeFile: "",
        summary: error instanceof Error ? error.message : "页面点测失败",
        generatedAt: new Date().toISOString(),
      });
    }
    return;
  }

  if (request.method === "POST" && request.url === "/api/write-knowledge") {
    try {
      const body = await readBody(request);
      const payload = body ? JSON.parse(body) : {};
      const result = writeKnowledge(payload);
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 500, {
        status: "error",
        knowledgeRoot,
        projectDirectory: "",
        moduleDirectory: "",
        writtenFiles: [],
        summary: error instanceof Error ? error.message : "知识库写入失败",
        generatedAt: new Date().toISOString(),
      });
    }
    return;
  }

  if (request.method === "POST" && request.url === "/api/prepare-context") {
    try {
      const body = await readBody(request);
      const payload = body ? JSON.parse(body) : {};
      const result = prepareContextPackage(payload);
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 500, {
        status: "error",
        knowledgeRoot,
        projectDirectory: "",
        moduleDirectory: "",
        writtenFiles: [],
        sources: [],
        summary: error instanceof Error ? error.message : "AI 上下文包生成失败",
        generatedAt: new Date().toISOString(),
      });
    }
    return;
  }

  if (request.method === "POST" && request.url === "/api/prepare-execution-package") {
    try {
      const body = await readBody(request);
      const payload = body ? JSON.parse(body) : {};
      const result = prepareExecutionPackage(payload);
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 500, {
        status: "error",
        knowledgeRoot,
        projectDirectory: "",
        moduleDirectory: "",
        packageDirectory: "",
        writtenFiles: [],
        summary: error instanceof Error ? error.message : "AI 交付执行包生成失败",
        generatedAt: new Date().toISOString(),
      });
    }
    return;
  }

  if (request.method === "POST" && request.url === "/api/prepare-task-plan") {
    try {
      const body = await readBody(request);
      const payload = body ? JSON.parse(body) : {};
      const result = prepareTaskPlan(payload);
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 500, {
        status: "error",
        knowledgeRoot,
        projectDirectory: "",
        moduleDirectory: "",
        planDirectory: "",
        writtenFiles: [],
        tasks: [],
        summary: error instanceof Error ? error.message : "设计与任务队列生成失败",
        generatedAt: new Date().toISOString(),
      });
    }
    return;
  }

  if (request.method === "POST" && request.url === "/api/load-task-plan") {
    try {
      const body = await readBody(request);
      const payload = body ? JSON.parse(body) : {};
      const result = loadTaskPlan(payload);
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 404, {
        status: "error",
        knowledgeRoot,
        projectDirectory: "",
        moduleDirectory: "",
        planDirectory: "",
        writtenFiles: [],
        tasks: [],
        summary: error instanceof Error ? error.message : "任务队列恢复失败",
        generatedAt: new Date().toISOString(),
      });
    }
    return;
  }

  if (request.method === "POST" && request.url === "/api/dispatch-task") {
    try {
      const body = await readBody(request);
      const payload = body ? JSON.parse(body) : {};
      const result = await dispatchTask(payload);
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 500, {
        status: "error",
        taskId: "",
        promptContent: "",
        updatedTaskPlan: null,
        summary: error instanceof Error ? error.message : "任务派发失败",
        generatedAt: new Date().toISOString(),
      });
    }
    return;
  }

  if (request.method === "POST" && request.url === "/api/ai-adapter/run-task") {
    try {
      const body = await readBody(request);
      const payload = body ? JSON.parse(body) : {};
      const result = await runTaskWithAiAdapter(payload);
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 500, {
        status: "error",
        provider: aiAdapterStatus().provider,
        taskId: "",
        promptContent: "",
        report: "",
        reportFile: "",
        updatedTaskPlan: null,
        summary: error instanceof Error ? error.message : "AI adapter 执行任务失败",
        generatedAt: new Date().toISOString(),
      });
    }
    return;
  }

  if (request.method === "POST" && request.url === "/api/controlled-task/run-once") {
    try {
      const body = await readBody(request);
      const payload = body ? JSON.parse(body) : {};
      const result = await runControlledSingleTask(payload);
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 500, {
        status: "error",
        mode: "single-task",
        provider: aiAdapterStatus().provider,
        taskId: "",
        lockFile: "",
        executionFile: "",
        adapterReportFile: "",
        reviewFile: null,
        fixPromptFile: null,
        reviewDecision: "not-reviewed",
        repairRound: 0,
        maxRepairRounds,
        changedFiles: [],
        outOfScopeFiles: [],
        updatedTaskPlan: null,
        summary: error instanceof Error ? error.message : "受控单任务执行失败",
        generatedAt: new Date().toISOString(),
      });
    }
    return;
  }

  if (request.method === "POST" && request.url === "/api/automation/advance-once") {
    try {
      const body = await readBody(request);
      const payload = body ? JSON.parse(body) : {};
      const result = await autoAdvanceOnce(payload);
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 500, {
        status: "error",
        action: "blocked",
        didRun: false,
        nextAction: "自动推进失败，请查看 runner 错误并决定是否生成修复任务。",
        reason: [error instanceof Error ? error.message : "自动推进失败"],
        summary: error instanceof Error ? error.message : "自动推进失败",
        generatedAt: new Date().toISOString(),
      });
    }
    return;
  }

  if (request.method === "POST" && request.url === "/api/automation/run-until-pause") {
    try {
      const body = await readBody(request);
      const payload = body ? JSON.parse(body) : {};
      const result = await autoRunUntilPause(payload);
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 500, {
        status: "error",
        action: "blocked",
        didRun: false,
        nextAction: "自动运行失败，请查看 runner 错误并决定是否生成修复任务。",
        reason: [error instanceof Error ? error.message : "自动运行失败"],
        steps: [],
        summary: error instanceof Error ? error.message : "自动运行失败",
        generatedAt: new Date().toISOString(),
      });
    }
    return;
  }

  if (request.method === "POST" && request.url === "/api/create-issue-fix-task") {
    try {
      const body = await readBody(request);
      const payload = body ? JSON.parse(body) : {};
      const result = createIssueFixTaskFromIssue(payload);
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 500, {
        status: "error",
        taskId: "",
        issueId: "",
        promptFile: "",
        updatedTaskPlan: null,
        summary: error instanceof Error ? error.message : "问题修复任务生成失败",
        generatedAt: new Date().toISOString(),
      });
    }
    return;
  }

  if (request.method === "POST" && request.url === "/api/create-user-feedback-task") {
    try {
      const body = await readBody(request);
      const payload = body ? JSON.parse(body) : {};
      const result = createUserFeedbackTaskFromPayload(payload);
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 500, {
        status: "error",
        taskId: "",
        issueId: "",
        feedbackId: "",
        promptFile: "",
        feedbackFile: "",
        conversationFile: "",
        knowledgeSuggestionFile: "",
        aiReply: "",
        changedSummary: "",
        learning: [],
        updatedTaskPlan: null,
        summary: error instanceof Error ? error.message : "用户返工任务生成失败",
        generatedAt: new Date().toISOString(),
      });
    }
    return;
  }

  if (request.method === "POST" && request.url === "/api/prepare-auto-dry-run") {
    try {
      const body = await readBody(request);
      const payload = body ? JSON.parse(body) : {};
      const result = prepareAutoDryRun(payload);
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 500, {
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
        warnings: [error instanceof Error ? error.message : "自动执行器干跑失败"],
        summary: error instanceof Error ? error.message : "自动执行器干跑失败",
        generatedAt: new Date().toISOString(),
      });
    }
    return;
  }

  if (request.method === "POST" && request.url === "/api/review-task-result") {
    try {
      const body = await readBody(request);
      const payload = body ? JSON.parse(body) : {};
      const result = await reviewTaskResult(payload);
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 500, {
        status: "error",
        decision: "blocked",
        taskId: "",
        nextTaskId: null,
        findings: [error instanceof Error ? error.message : "任务 review 失败"],
        changedFiles: [],
        outOfScopeFiles: [],
        reviewFile: "",
        fixPromptFile: null,
        updatedTaskPlan: null,
        summary: error instanceof Error ? error.message : "任务 review 失败",
        generatedAt: new Date().toISOString(),
      });
    }
    return;
  }

  if (request.method === "POST" && request.url === "/api/finalize-delivery") {
    try {
      const body = await readBody(request);
      const payload = body ? JSON.parse(body) : {};
      const result = finalizeDelivery(payload);
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 500, {
        status: "error",
        knowledgeRoot,
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
        findings: [error instanceof Error ? error.message : "总验收生成失败"],
        rules: [],
        summary: error instanceof Error ? error.message : "总验收生成失败",
        generatedAt: new Date().toISOString(),
      });
    }
    return;
  }

  if (request.method === "POST" && request.url === "/api/save-run") {
    try {
      const body = await readBody(request);
      const payload = body ? JSON.parse(body) : {};
      const result = saveRunRecord(payload);
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 500, {
        status: "error",
        runId: "",
        runFile: "",
        latestFile: "",
        summary: error instanceof Error ? error.message : "运行记录保存失败",
        generatedAt: new Date().toISOString(),
      });
    }
    return;
  }

  if (request.method === "GET" && request.url?.startsWith("/api/load-run")) {
    try {
      const url = new URL(request.url, `http://localhost:${port}`);
      const result = loadRunRecord(url.searchParams);
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 404, {
        status: "error",
        summary: error instanceof Error ? error.message : "运行记录读取失败",
        generatedAt: new Date().toISOString(),
      });
    }
    return;
  }

  if (request.method === "GET" && request.url?.startsWith("/api/list-runs")) {
    try {
      const url = new URL(request.url, `http://localhost:${port}`);
      const result = listRunRecords(url.searchParams);
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 500, {
        status: "error",
        projectName: "",
        moduleName: "",
        runs: [],
        summary: error instanceof Error ? error.message : "运行记录列表读取失败",
        generatedAt: new Date().toISOString(),
      });
    }
    return;
  }

  sendJson(response, 404, { ok: false, message: "not found" });
});

server.listen(port, () => {
  console.log(`delivery runner listening on http://localhost:${port}`);
});
