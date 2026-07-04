# 模块项目交付控制台

这是 `delivery-knowledge-system` 的前端可视化操作台。它服务于“系统 AI 调度写代码 AI”的交付方式：资料一次性给齐，但代码开发必须拆成小任务分段执行。

当前控制台目标不是把前端做重，而是跑通“资料录入、任务调度、review、修复、验收、沉淀”的轻量可视化：

- 用户一次性填写任务包。
- 用户可以点击“系统自检”，确认 runner 和知识库关键路径正常。
- 任务包页用阶段卡提示资料依赖顺序。
- 系统生成自动交付执行计划。
- 用状态卡片展示 AI 内部走到哪一步。
- 用执行决策面板展示当前阶段、责任方、下一步动作、判断依据和是否建议自动推进。
- 用“自动推进一步”触发 runner 执行一个安全动作，前端只负责展示结果。
- 用“自动运行到暂停点”让 runner 连续推进多个安全小步，直到需要人或写代码 AI 处理。
- 在交付结果页用交付总览聚合任务队列、review、命令验收、页面点测、知识沉淀和总验收状态。
- 在风险归档页自动汇总运行问题池，并推导规则沉淀建议。
- 本地 runner 只读扫描真实项目路径，生成项目画像。
- 本地 runner 受控执行目标项目已有的 `typecheck`、`lint`、`build` 脚本，并把结果回填验收报告。
- 本地 runner 把运行状态自动保存到系统根目录的本地辅助缓存。
- 本地 runner 根据任务包读取接口文档、Demo、旧项目参考和 PRD，生成给 AI 开发前使用的上下文包。
- 本地 runner 生成 AI 交付执行包，把上下文、执行计划、验收清单和待确认问题整理为系统 AI 的调度输入。
- 本地 runner 生成 design、小任务队列、单任务 prompt、review checklist 和进度文件。
- 本地 runner 支持派发当前任务、回填写代码 AI 报告、轻量 review、按 `allowedFiles` 检查本任务 git 改动范围和生成修复任务。
- 本地 runner 生成总验收与规则沉淀候选文件，判断任务闭环是否可收口。
- 本地 runner 支持轻量页面点测，检查页面 URL、标题、关键词和明显错误文本，并写入知识库报告。
- 把项目画像、资料清单、模块资料包、模块依赖图、步骤卡片、问题追踪、测试用例、验收报告和交付报告写入知识库。
- 普通问题归档后继续执行。
- 生成 Markdown 和 AI 自动交付提示词。

## 启动

推荐从知识库根目录启动：

```bash
bash scripts/start-console.sh
```

启动前可先检查环境：

```bash
bash scripts/check-console.sh
```

停止前端和 runner：

```bash
bash scripts/stop-console.sh
```

只查看会停止哪些进程：

```bash
bash scripts/stop-console.sh --dry-run
```

默认地址：

- 前端控制台：`http://localhost:5174`
- 本地 runner：`http://localhost:5176`

如果需要手动启动，请进入控制台目录后分别开两个终端：

```bash
cd apps/delivery-console
pnpm install
pnpm run dev
```

```bash
cd apps/delivery-console
pnpm run runner
```

## 系统自检

点击“系统自检”后，控制台会请求 runner 的 `/api/health`，检查：

- runner 是否在线。
- 知识库根目录是否正确。
- `08-项目实例` 是否存在。
- `11-规则库` 是否存在。
- 控制台目录和 `package.json` 是否存在。

命令行也可以运行：

```bash
bash scripts/check-console.sh
```

系统自检只读取路径状态，不会写真实项目。

## AI 上下文包

点击“生成 AI 上下文包”后，runner 会读取任务包里填写的本地资料路径，并把资料整理成 AI 开发前可以直接消费的 Markdown。URL 资料只登记为外部资料，不在本地抓取；超大文件会跳过，避免控制台变成重型文档解析器。

生成文件位于：

```text
08-项目实例/{项目名}/{模块名}/
```

包括：

- `模块上下文包.auto.md`
- `接口能力矩阵.auto.md`
- `样式参考摘要.auto.md`
- `旧项目风险点.auto.md`
- `AI执行提示词.auto.md`

这一步的定位是“把资料压成 AI 上下文”，不是替代 AI 写代码。前端只负责触发和展示结果，核心处理在本地 runner。

## AI 交付执行包

点击“生成 AI 交付执行包”后，runner 会在模块目录下生成 `执行包/`，把上下文文件、执行计划、验收清单和待确认问题整理成系统 AI 的调度输入。它不是给写代码 AI 一把写完整模块的提示词。

生成文件位于：

```text
08-项目实例/{项目名}/{模块名}/执行包/
```

包括：

- `execution-manifest.auto.json`
- `execution-plan.auto.md`
- `ai-run-prompt.auto.md`
- `acceptance-checklist.auto.md`
- `unresolved-questions.auto.md`

这一步仍然不直接写真实项目。它的作用是让系统 AI 有完整上下文和调度口径，再进入下一步生成 design 和小任务队列。

## 设计与任务队列

点击“生成设计与任务队列”后，runner 会在模块目录下生成 `设计与任务/`。这一步把大模块拆成多个小任务，每个任务都有独立 prompt、允许改动范围和验收标准，方便系统 AI 分段派发给写代码 AI。

生成文件位于：

```text
08-项目实例/{项目名}/{模块名}/设计与任务/
├── module-design.auto.md
├── task-queue.auto.json
├── task-01.prompt.auto.md
├── task-02.prompt.auto.md
├── review-checklist.auto.md
└── progress.auto.md
```

生成后，控制台会显示当前可派发任务：

- 点击“复制当前任务 prompt”：任务状态变为 `assigned`，prompt 自动复制到剪贴板。
- 写代码 AI 做完后，把完成报告贴回“写代码 AI 完成报告”。
- 点击“提交系统 review”：runner 会对比派发时的 git baseline，只检查本任务新增改动是否落在 `allowedFiles` 内；通过则当前任务变为 `done`，越界或报告不合格则生成 `task-xx-fix.prompt.auto.md`。
- review 不通过后，控制台会清空旧报告和旧派发态，并把 `task-xx-fix` 标为当前优先任务；用户需要先复制修复任务 prompt 给写代码 AI，再回填修复报告。
- review 记录写入 `设计与任务/reviews/`，队列状态回写到 `task-queue.auto.json`。
- 点击“恢复任务队列”：按当前项目名和模块名读取 `设计与任务/task-queue.auto.json`，用于刷新页面或换人接手后继续任务。

执行看板和交付结果页都会展示“执行决策”。它会告诉用户：

- 当前阶段是什么。
- 下一步该派任务、等报告、review、修复、命令验收、页面点测、知识沉淀还是总验收。
- 当前责任方是用户、系统 AI、写代码 AI 还是测试。
- 为什么这么判断。
- 人需要做什么。
- 系统可以做什么。
- 当前是否建议自动推进。

交付结果页顶部的“交付总览”会把任务队列、最近一次系统 review、命令验收、页面点测、知识沉淀和总验收聚合成状态卡，并显示下一步建议。它只读取当前页面已有状态，不直接写真实项目。

风险归档页会把资料缺口、review 失败、越界改动、命令验收失败、知识写入失败和总验收风险统一成问题池。问题池会随 Markdown、知识库写入和总验收传递，不只是页面展示。

问题池中的单个问题可以生成修复任务。控制台会调用 runner 将问题追加进当前任务队列，生成独立 `issue-xxx-fix.prompt.auto.md`；修复任务仍需要派发 prompt、回填报告、系统 review，不会直接修改真实项目。

如果问题来自人类验收，而不是系统问题池，可以在风险归档页的“提交修改要求”里写明问题、期望、证据和验收方式。控制台会生成 `user-fix-xxx.prompt.auto.md`，展示系统 AI 的回应和沉淀文件位置；写代码 AI 完成后仍回到任务队列做系统 review。

## 总验收与知识沉淀

点击“生成总验收”后，runner 会读取任务队列、review 文件、命令验收结果、页面点测结果、知识库写入结果和运行问题池，生成：

```text
08-项目实例/{项目名}/{模块名}/设计与任务/final-acceptance.auto.md
08-项目实例/{项目名}/{模块名}/规则沉淀候选.auto.md
```

状态含义：

- `success`：任务队列全部完成，review、命令验收、页面点测和知识沉淀都有记录。
- `warning`：仍有未完成任务、未执行命令验收或未写入知识库。
- `blocked`：存在阻断任务，需要人工处理。
- `error`：runner 生成总验收失败。

`规则沉淀候选.auto.md` 只作为候选清单，不会自动写入 `11-规则库`。人工确认适用于多个项目后，再复制到通用规则库；只适用于当前项目的经验，保留在项目实例里。

## 当前已实现

- 任务包表单
- 系统自检按钮和结果面板
- 资料依赖阶段卡
- 自动化授权选项
- 执行步骤卡片
- 步骤依赖展示
- 可视化模块依赖图
- P0/P1/P2 风险归档
- 运行日志
- 执行决策面板
- 交付总览和下一步建议
- 运行问题池和规则沉淀建议
- Markdown 结果生成和复制
- 本地 runner 只读项目扫描
- 项目画像面板
- 受控命令验收，只运行目标项目 `package.json` 中已有的 `typecheck` / `lint` / `build`
- 命令验收结果面板
- 运行状态自动快照
- AI 上下文包生成
- AI 交付执行包生成
- 设计与任务队列生成
- 自动执行器干跑计划，只推演任务顺序和检查点，不调用 AI，不写真实项目
- AI adapter 状态检查和单任务入口，支持 `manual`、`mock`、`command` 与 `disabled`
- 自动推进一步：根据当前状态执行一个安全小步，不跳过 review，不无限循环
- 自动运行到暂停点：最多连续执行 20 个安全小步，遇到等待、阻断或失败即暂停
- 受控单任务执行入口，记录 lock、adapter 输出、review、git diff 和修复轮次
- 轻量页面点测，检查页面 URL、标题、关键词和明显错误文本
- 当前任务派发、报告回填、轻量 review、git 改动范围检查和修复任务生成
- 总验收与规则沉淀候选生成
- 知识库写入
- 自动生成 `08-项目实例/{项目名}` 记录
- 自动生成模块上下文包、接口能力矩阵、样式参考摘要、旧项目风险点和 AI 执行提示词
- 自动生成执行 manifest、执行计划、AI 总提示词、验收清单和待确认问题
- 自动生成 design、小任务队列、单任务 prompt、review checklist 和进度文件
- 自动生成模块依赖图、开发步骤卡片、问题追踪、测试用例和验收报告
- localStorage 本地保存

## 当前暂不实现

- 不自动写真实项目文件。
- 不接受任意命令，只支持用户手动触发的受控命令验收。
- 默认不直接调用外部 AI，`manual` 模式仍需人工复制 prompt。
- `mock` provider 只用于验证调度链路，不代表真实代码开发完成。
- 受控单任务执行只处理当前 task，不会自动 commit / push，也不会无限修复。
- 自动执行器干跑计划只生成预演结果，不替代真实 AI 执行。
- 不深度读取业务文件内容，只做目录、脚本、规则文件和技术栈画像。

## AI adapter

runner 通过 `DELIVERY_AI_PROVIDER` 选择 provider：

- `manual`：默认模式，只生成当前任务 prompt，需要人交给写代码 AI。
- `mock`：测试模式，生成一份 mock 报告，不修改真实项目。
- `command`：本地命令模式，把当前任务 prompt 通过 stdin 传给可信命令，并在目标项目目录下执行。
- `disabled`：禁用 adapter，只保留手工派发和回填报告。

mock 示例：

```bash
DELIVERY_AI_PROVIDER=mock bash scripts/start-console.sh
```

本地命令示例：

```bash
DELIVERY_AI_PROVIDER=command \
DELIVERY_AI_COMMAND=your-ai-cli \
DELIVERY_AI_ARGS='["--flag","value","--prompt","{promptFile}"]' \
bash scripts/start-console.sh
```

`DELIVERY_AI_ARGS` 必须是 JSON 字符串数组，支持 `{taskId}`、`{promptFile}`、`{projectPath}` 占位符。`command` provider 可能修改真实项目，所以只应该配置可信命令；它仍必须遵守单任务 prompt、执行锁、`allowedFiles` 和系统 review。

## 自动推进一步

“自动推进一步”调用 runner 的 `/api/automation/advance-once`，每次只执行一个安全动作：

- 没有任务队列时，生成上下文包、执行包和设计与任务队列。
- 有 pending 任务时，按 provider 能力派发任务或受控执行当前任务。
- 任务全部完成后，依次执行命令验收、页面点测、知识库写入和总验收。
- 遇到 assigned、blocked、命令失败、页面点测失败、缺少授权时停止，并返回原因和下一步。

这个入口是系统 AI 调度循环的最小单元，不是让前端接管业务逻辑。

“自动运行到暂停点”调用 runner 的 `/api/automation/run-until-pause`，内部连续执行多个“自动推进一步”，默认最多 20 步。它适合资料和权限都给齐后使用：系统会自动走到等待报告、阻断、验收失败、缺少授权或交付完成的位置，并返回每个小步的摘要。

## 受控单任务执行

“受控执行当前任务”会调用 runner 的 `/api/controlled-task/run-once`：

- 先写入 `controlled-task.lock.json`，避免同一模块并发执行。
- 通过 AI adapter 处理当前 task。
- 如果 provider 返回报告，会自动进入系统 review。
- 记录 git diff、越界文件、review 文件和修复任务。
- 写入 `设计与任务/controlled-executions/`。

修复轮次上限默认 3，可通过 `DELIVERY_MAX_REPAIR_ROUNDS` 调整。达到上限后必须人工确认。

## 写入规则

点击“写入知识库”后，runner 只会写入当前知识库的 `08-项目实例`：

- `项目画像.auto.md`
- `资料清单.auto.md`
- `模块清单.auto.md`
- `{模块名}/模块资料包.auto.md`
- `{模块名}/模块依赖图.auto.md`
- `{模块名}/开发步骤卡片.auto.md`
- `{模块名}/问题追踪.auto.md`
- `{模块名}/测试用例.auto.md`
- `{模块名}/验收报告.auto.md`
- `{模块名}/交付报告-{时间戳}.md`

`.auto.md` 是自动生成文件，适合反复刷新；人工沉淀建议写到单独 Markdown，避免和机器生成内容混在一起。

## 命令验收规则

点击“执行命令验收”后，runner 会读取目标项目 `package.json`，只按顺序尝试运行这三个脚本：

- `typecheck`
- `lint`
- `build`

没有声明的脚本会标记为“跳过”。命令输出会截断保存到页面结果和 `{模块名}/验收报告.auto.md`，用于后续人工验收和问题复盘。

## 轻量页面点测

任务包里可以填写：

- 页面点测 URL：本地或测试环境页面，例如 `http://localhost:1688/agent-list`。
- 点测关键词：一行一个页面应该出现的文本，例如模块标题、按钮文案、表格列名、空态文案。

点击“轻量页面点测”后，runner 会请求这个 URL，并检查：

- HTTP 状态是否正常。
- 页面 HTML 是否为空。
- `<title>` 是否可识别。
- 点测关键词是否出现在页面文本中。
- 是否出现 `Cannot read properties`、`ReferenceError`、`TypeError`、`Internal Server Error` 等明显错误文本。

结果会显示在交付结果页，并写入：

```text
08-项目实例/{项目名}/{模块名}/页面点测-{时间戳}.auto.md
```

这一步是低成本 smoke test，不启动浏览器、不截图、不做视觉回归。失败时会进入风险归档，后续应转成修复任务，而不是让 AI 凭感觉直接改。

## 运行状态快照

控制台会给每次交付生成一个 `runId`，并在关键步骤后自动保存当前状态：

```text
项目历史辅助文件/run-{模块名}-{YYYYMMDD}/run-record.json
项目历史辅助文件/run-{模块名}-{YYYYMMDD}/run-meta.md
```

运行状态快照包含任务包、步骤状态、运行日志、项目画像、命令验收结果、页面点测结果、知识库写入结果和问题清单。它是系统内部的调试和复盘资料，正常用户不需要手动保存、恢复或管理历史记录。`项目历史辅助文件/` 已写入 `.gitignore`，不会提交 Git，也不会进入用户真实项目。

## 模块依赖图

执行看板里的“模块依赖图”会展示本次模块交付的关键上下文顺序：

- 项目路径
- 项目画像
- 接口文档
- Demo / 设计图
- 旧项目参考
- 模块计划
- 命令验收
- 知识沉淀

它不是替代 Markdown 依赖图，而是给人看的轻量可视化入口。后续第三阶段自动执行器会基于这个顺序继续扩展上下文解析和真实执行。

这些能力放到第三阶段：

- 本地 runner 在明确授权下读写真实项目。
- 系统 AI 分段调度写代码 AI，自动分析、派发、检查、修复和沉淀。
- 完整浏览器交互点测、截图对比和接口验收回填。
