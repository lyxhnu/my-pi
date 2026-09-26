# 子 Agent 跨上下文窗口：实施与功能评估

日期：2026-09-26。依据：[已确认 spec](subagent-context-rollover.md)。

**代码改造、定向自动验证和 A01–A04 真实 Agent 场景验收完成。** 使用用户指定的 `rrver/gpt-5.5`、`low`，提高临时验收时限后，取消场景 9/9、前台已完成但未消费结果的跨窗场景 21/21 通过，均有正常最终回复。结合此前成功的 SDK、text/json 慢任务及历史任务场景，所需实跑证据已齐全。此前超时和失败记录保留，不将单次成功解释为任意模型调用都不会失败。

## 1. 小任务拆分与结果

| 小任务 | 结果 | 修改范围 |
| --- | --- | --- |
| 1. 固定委派身份与来源 | 完成 | 新增 `core/subagent-continuation.ts`；复用 History 规范来源，关联真实 toolCallId 与调用参数，校验分支和 live owner/kind；真实验收后补齐 `tools/task.ts` 的前台结果正文 taskId |
| 2. 保存父任务关系和结果处理计划 | 完成 | `task-note-projection.ts`、`tools/context-note.ts`；必填 `subagentContinuations`，无任务用空数组，拒绝重复 ID、空关系和超长文本 |
| 3. 接通跨窗存储和正文恢复 | 完成 | `context-rollover.ts`、`task-note-query.ts`、`context-window.ts`；目录、必需集合、Note 来源随原 rollover 记录保存，按预算分页和内容覆盖校验 |
| 4. 统一换窗门禁 | 完成 | `agent-session.ts` 与 rollover 的 execute/resume/resumeInterrupted；busy 才延期，invalid 明确失败，已交接 subagent 不等待终态 |
| 5. 保证 headless 续跑生命周期 | 完成 | `print-mode.ts` 和 Session 的 settled/waitForIdle；完整等待主 Session 续跑，仅非 subagent 活跃任务保留终态等待 |
| 6. 校验首个业务请求 | 完成 | Agent `controlRequest` 接收最终 Context；最终转换删掉恢复正文时返回 `recovery_request_incomplete`，不调用业务模型和工具 |
| 7. 回归、文档与真实验收 | 完成 | 新增完整 Agent 集成测试，更新相关 Note 夹具、门禁文档与两个包的 Unreleased；真实 SDK/text/json、显式取消及前台已完成任务跨窗续办均有完整成功证据 |

采用一次统一协议变更，没有兼容开关或旧恢复分支。没有改造 Coordinator、Child Runner、TaskManager 的执行、取消或重试实现；它们由集成测试实际调用。SessionManager 的记录字段复用现有 `ContextRecoveryReferences` 类型，因此无需新增持久化机制。

本次没有修改依赖、lockfile、Memory 算法、子任务权限/深度、worktree 补丁事务，也没有添加生产任务硬超时、自动取消、重派、降级或自动结果唤醒。没有提交代码。

## 2. 行为与边界

`task` 返回原 ID 且父工具批次完整后，运行时建立可追溯目录。必须恢复的集合包括当前 Task Note scope 的全部委派、仍 active 的早期任务、当前 Note 关联的历史任务及重准备保留的 ID。终态不是删除依赖的依据。

每个必需任务必须有原委派参数、`parentRelation` 和 `onResult`。正文通过 `resumeRef` 分页进入恢复请求；仅有 ID 或链接不满足覆盖。首次开放业务工具后，还校验最终实际 provider Context，避免后续转换丢失材料。工具结果已生成与正文确实进入请求分别验证。

任务继续使用原 TaskManager、ID 和取消信号。换窗不读取或假造未来结果，不替模型执行结果消费。新窗口可以先做独立工作，再查询原 ID。历史目录项不是自动待办，子任务历史指令不覆盖最新用户要求。跨进程重建只恢复可验证引用，不恢复执行句柄。

明确失败包括：缺少来源或关系的 `subagent_handoff_invalid`、恢复内容不足的 `recovery_request_incomplete`、原有预算和有限重准备错误。正在执行的父工具调用、待审批交互及活跃非 subagent Task 继续阻挡提交。

## 3. 自动验证结果

| 验证层 | 本次结果 | 证据 |
| --- | --- | --- |
| Agent 核心 | 6 文件、67/67 通过 | `agent-core-tests.json` |
| coding-agent 定向回归 | 原 15 文件、162/162；追加前台 blocked 案例后累计 163 项通过 | `coding-agent-tests.json`、`foreground-id-tests.json` |
| 新增子任务跨窗测试 | 20/20 通过，已计入上项 | `test/suite/subagent-context-rollover.test.ts` |
| 静态检查 | 最新 `npm run check` 退出码 0；Biome、类型、导入、依赖锁校验及 browser smoke 通过 | 995 个文件；仅格式化本次修改的 subagent-task-tool 测试 |
| Diff 空白检查 | `git diff --check` 退出码 0 | 本次运行输出 |

累计 **230 项唯一测试通过**，不把重跑次数计为新增测试。最新 task ID 修复后重跑 subagent-task-tool、subagent-context-rollover、task-output-kill-task 共 44 项，随后将前台结果测试扩为 completed/blocked 两种并再次运行该文件，9/9 通过；合计覆盖 45 项不同用例。npm 仍报告仓库已有 `min-release-age` 配置不被当前 npm 识别的警告；没有修改无关 npm 配置或隐藏警告。未运行 build、根 `npm test` 或全量 vitest。

新增必填字段使工具 schema 和保存提示略增。`progressive-context-memory` 中验证“同一次决策最多 3 次采样”的测试模型窗口由 42000 调整为 43000，保持原采样次数、持久化耗尽及重启不返还额度的断言；生产预算常量未修改。

定向文件包括 context-window-memory、progressive-context-memory、warehouse-continuation、context-rollover-queue、task-note-projection、context-note-history-reference、print-mode、session-manager/build-context、subagent-task-tool、subagent-depth、task-output-kill-task、subagent-worktree-transaction、memory-archive-task-dependency-v2 和 memory-archive-run-v2。

### 完整 Agent 运行证据

新增测试使用真正的 Agent、AgentSession、内置 task、Coordinator 和 Child Runner，只有模型响应来自 faux provider。父子响应按子会话的 `submit_subagent_result` 工具路由，子任务由异步 gate 持续阻塞，不直接伪造 TaskManager 状态。

SDK、text 和 json 场景实际断言：委派工具返回 → rollover 提交 → 子任务仍 running 时进入新窗口 provider 请求 → 写入独立文件 → 释放 gate → 子任务真实终态 → 查询原 ID → 写最终文件。每次只委派一次，独立和最终文件各写一次；text/json 通过真实 `runPrintMode` 与 AgentSessionRuntime 执行，不使用 FakeSession。

| Spec 关注点 | 自动证据与限制 |
| --- | --- |
| T01、T11 子任务跨窗和 headless 生命周期 | SDK/text/json 完整链路通过；进程级真实 CLI 单列，不能由这里替代 |
| T02 同批委派与请求换窗 | 父结果完整落地后缺少新 ID 关系即明确失败；没有 commit、自动补写或等待子终态 |
| T03 前台调用 | 调用未返回时 gate=busy；用真实 TaskManager.wait 的短测试期限触发等待超时，再以原 ID 完成跨窗。生产 600 秒期限未修改 |
| T04、T08 状态/取消 | running、cancelling 跨窗，显式取消后真实 cancelled；6 种状态的来源校验及既有结果/取消回归通过 |
| T05、T13 并发变化 | 子任务在 prepare 中完成，重准备一次且引用保留；既有一/两次来源变化测试验证有限准备。并未逐一新建所有完成时点排列的专用用例 |
| T06、T15 来源与正文 | 缺少关系、错误来源、兄弟分支、遗漏目录、裁剪正文均被拒绝；首个业务请求丢正文时零业务 write |
| T07 连续窗口与多任务 | 同一活跃子任务连续两次换窗；21 个原始委派完整分页、不受 8 项限制。单次结果查询的 20 ID 限制仍由原工具回归验证 |
| T09、T10 范围保护 | worktree 成功/阻塞/冲突、非 subagent 后台等待及原工具批次等相关回归通过；没有修改取消后的迟到补丁规则 |
| T12 重建 Session | 销毁原 Session 后从 JSONL 创建新 Session：引用有效，live registry 为空，原 ID 查询返回 not found，未重建任务 |
| T14 原预算与 dispatch | prepare、未知 dispatch 不重放、恢复预算、队列与持久化回归通过 |
| T16、T17 语义集合与分页 | 历史目录与当前必需项分离，早期 active 任务终态后仍保留；长中文/emoji 委派按 512-token 页预算完整恢复，篡改片段不计覆盖 |

这些测试证明所列运行时性质。faux 模型预写的正确动作不能证明真实模型理解父子任务关系，也不能视为真实模型 A04 已通过。

## 4. 真实 SDK 与源码 CLI 实跑

所有运行在独立临时目录和 Session 目录中，沿用当前已配置模型连接，不输出凭据、不修改全局模型配置。

| 运行 | 模型 | 结果 |
| --- | --- | --- |
| SDK，第 1 次 | rrver/gpt-5.4 | 首个请求返回 502，0 child、0 rollover、无业务产物 |
| SDK，第 2 次 | rrver/gpt-5.4 | 同样返回上游 502，未进入委派 |
| SDK，另一现有连接 | goaichat/glm-5.3 | 首个请求返回 403，未进入委派 |
| 源码 CLI text | rrver/gpt-5.4 | 实际进程启动，既有请求重试耗尽后返回 502，退出码 1 |
| 源码 CLI json | rrver/gpt-5.4 | 同上，JSON 记录错误及重试事件，退出码 1 |

CLI 日志记录了默认 3 次请求重试，临时项目 settings 中的关闭重试设置未生效；本次没有进一步修改项目配置加载机制，也没有新增重试策略。SDK 使用内存设置关闭重试。后续实跑须检查夹具设置的信任与加载结果，不能把写入配置文件当作设置已经生效的证明。

截至上述初轮，A01–A04 均未验证。没有将服务商错误当成子任务正常完成，没有修改 Session 日志补造成功，也没有把“启动过 CLI”表述为 CLI 换窗成功。以下为换用用户指定模型后的新证据。

### 2026-09-26 连接复测

按用户要求，使用源码 `ModelRuntime.completeSimple` 对两条当前已配置连接分别发送最小请求 `Reply with exactly OK.`，不加载 Agent、工具或换窗上下文，每个请求设置 45 秒测试时限。

| 模型 | 响应耗时 | 结果 |
| --- | --- | --- |
| goaichat/glm-5.3 | 1.30 秒 | HTTP 403，响应无正文，未得到模型文本 |
| rrver/gpt-5.4 | 3.27 秒 | HTTP 502，`Upstream service temporarily unavailable`，未得到模型文本 |

两次都在模型请求阶段失败，未触及换窗链路；这两条连接的复测不计为 Agent 验收。该步骤未修改生产代码或模型配置。原始结果：`C:/Users/16474/AppData/Local/Temp/pi-subagent-rollover-20260925/connection-probe-1790352296988/results.json`。

### gpt-5.5 / low 的实际结果

沿用现有 rrver 认证，仅在验收运行中注册 `gpt-5.5`，没有修改全局 models.json。最小请求约 29.37 秒返回 `OK`。实际请求记录确认父模型使用 `gpt-5.5`、`reasoning.effort=low`；SDK 同时记录父、子请求的模型与思考级别。测试沿用现有连接元数据，不将这些测试配置视为模型官方规格。

| 场景 | 结果与证据 |
| --- | --- |
| SDK 基础跨窗 | `real-sdk-1790356126352`：1 个原任务、1 次换窗；新窗口写 independent 时任务仍 running，最终原 ID 返回 completed，final.txt 为 73。人工 provider gate 未实际触发，因此不以此替代真实工具慢任务场景 |
| json：真实工具慢任务 + 历史任务 | `real-cli-gpt55-json-1790356487090`：进程退出 0，21 条证据断言全部通过；历史 receipt 为 HIST-41，当前 included=[19,54]、excluded=[900]，结果 73；两个原 ID，历史与当前输出均只写一次 |
| text 首轮 | `real-cli-gpt55-text-1790356486024`：退出 1，subagent_handoff_invalid。历史任务以前台方式完成，但结果正文没有 ID，Note 漏掉该任务的 continuation；未提交 rollover，也未伪造成功 |
| 取消首轮 | `real-cancel-gpt55-1790356580001`：未通过。子模型将内部 bash 放入后台，随后未提交结构化结果而结束，父任务观察到 failed 并如实记录；没有测到运行中取消。重跑夹具明确要求子会话内 bash 保持前台，不改变生产执行权限 |
| text 重跑 | `real-cli-gpt55-text-1790356844992`：退出 0，生命周期及语义恢复的 21 条断言通过；2 次委派、1 次换窗、正确结果 73。子任务在换窗和独立写入时仍 running，但工具 gate 晚于独立写入才启动；该运行不计作 A01 的严格工具阻塞证据，A01 由前述 json 实跑覆盖。`evaluation.json` 保留严格慢工具断言失败，`evaluation-lifecycle.json` 单独记录 A03 的正确范围 |
| 取消第 2 轮 | `real-cancel-gpt55-1790356847996`：模型流返回 `excel_incomplete_stream`；0 rollover，驱动取消并清理仍 running 的任务。不能计为取消成功场景 |
| 取消第 3 轮 | `real-cancel-gpt55-1790357399283`：8/9 断言通过。子工具 gate 始终未释放，换窗后的独立写入时原任务 running；父调用 kill_task 后真实 running → cancelling → cancelled，再查询到 cancelled 并写 outcome.json。最终回复请求约 120.15 秒未完成，由单请求测试期限中止，runState=aborted；因此整场仍未通过。cleanup.json 确认任务 cancelled |
| 前台已完成但未消费的补充场景 | `real-cli-gpt55-terminal-json-1790357463221`：未通过。第一项前台历史任务已完成，真实返回正文及下一次父模型请求均含 taskId `87170ec9-11a4-4ddc-95c3-ed201cfc88cc`，历史文件正确写出；后续请求未返回，360 秒整场期限触发 SIGTERM，尚未委派第二项任务或换窗。这个局部证据验证了 ID 修复，不能证明整项补充语义场景通过 |

json 的实际顺序（北京时间）：01:16:17 子任务 running → 01:16:24 真实工具进入文件 gate → 01:16:49 rollover 提交 → 01:17:09 新窗口写 independent → 驱动写 release → 01:17:26 子任务 completed → 原 ID 查询完成 → 写验证与最终文件。新窗口第一个请求没有旧委派调用序列；首次业务请求完整包含两个任务的原委派正文、parentRelation 和 onResult。验证由 `evaluate-real-cli.mjs` 独立执行并写入 evaluation.json，不只检查模型自述。

json 子模型曾把 verification 数组写成对象，工具严格拒绝，模型修正后提交成功；这是一次有记录的格式错误及恢复，没有修改 schema 放行。text 暴露的 ID 缺口则通过真正父模型请求入口回归复现：修复前缺少 taskId，修复后 completed/blocked 均可见。生产修复仅为前台结果 JSON 增加 taskId，保留结果、TaskManager 和交接校验语义。

取消第 3 轮使用 120 秒单请求时限和 360 秒整场时限，限额只存在于临时驱动，不属于生产子任务运行超时。不能把测试中止解释为新实现会在 120 秒自动结束子任务；该轮子任务先因父模型的显式 kill_task 进入 cancelled，随后才发生父最终回复超时。只读进程检查没有发现遗留的 wait-release.mjs 进程。

### 提高测试时限后的补测

用户要求继续使用 `gpt-5.5 / low`，并提高测试时限以容纳中转站慢响应。本轮仅创建临时 longwait 驱动：SDK 单请求从 120 秒提高至 600 秒；SDK 和 CLI 整场从 360 秒提高至 1800 秒；取消夹具的文件等待脚本及其 bash 调用上限提高至 2100 秒，确保等待工具不会先于整场期限自行结束。没有修改生产代码、全局模型配置或自动重试策略。每次运行保存了驱动副本、limits.json、prompt、Session、请求与事件证据。

| 场景 | 实跑结果 | 独立验证 |
| --- | --- | --- |
| A02 持续阻塞后显式取消 | `real-cancel-gpt55-longwait-1790358262077`：原任务 `84129117-1733-43aa-bfaf-5c187619b4cf` 跨窗时仍 running；写 independent 后由父模型调用 kill_task，经过 cancelling 进入 cancelled，查询同一 ID 并写 outcome.json；父任务正常最终回复，runState=completed | evaluation.json：9/9 通过；cleanup.json 确认 cancelled；16 次父请求均正常结束，最长约 67.32 秒 |
| A04 前台已完成但未消费结果 | `real-cli-gpt55-longwait-terminal-json-1790358258820`：历史任务 `859dcdca-7b5b-41ba-9132-5a40409a6417` 已处理；当前任务 `467a7a56-3a35-4e0e-8d8f-39f21c748c33` 在换窗前 completed，父任务换窗后先写 independent，再查询原 ID、验证 included=[19,54] 和 excluded=[900]，写 verification.json 及 final.txt=73；进程退出 0，最终回复正常 | evaluation-terminal.json：21/21 通过；两次委派、一次换窗、每份业务文件仅写一次；首次业务请求含两个任务的原委派、parentRelation 和 onResult；16 次父请求均正常结束，最长约 65.79 秒 |

前台场景的时间顺序（北京时间）：01:46:11 当前子任务 completed → 01:46:45 rollover 提交 → 01:47:06 新窗口写 independent → 查询原 ID 并验证 → 写验证与最终文件。已终态没有被当成“父业务已经处理”，历史任务也没有被重派或重复写入。

本轮两场均未触发新的请求或整场期限，最长父请求也低于旧 120 秒限制，因此结果证明这次复测完成，不能仅凭成功就确定上轮超时的服务端或网络根因。验收标准和断言没有因调高时限而放宽。所有测试驱动与 wait-release.mjs 进程已退出。

开始本轮补测前，对上次 manifest 的 24 个相关文件逐一校验 SHA-256，全部一致；因此沿用已完成的 230 项自动回归和 `npm run check` 结果，没有为本次仅修改临时驱动与报告重复运行自动测试。文档更新后再次执行 `git diff --check`。

| Spec 验收项 | 当前判定 |
| --- | --- |
| A01 真实工具慢任务 | 通过，json 21 条独立断言及完整最终回复 |
| A02 持续不返回后显式取消 | 通过，longwait SDK 的 9 条断言、真实取消状态、正常最终回复及清理证据 |
| A03 text/json 进程生命周期 | 两种模式均有退出 0、完整跨窗业务和正常最终回复 |
| A04 语义与历史任务 | 通过，text/json 的历史已处理与当前受约束任务场景，加上 longwait CLI 的前台已完成但未消费结果场景，共同覆盖要求 |

## 5. Agent 功能评估

| 能力 | 评估 |
| --- | --- |
| 避免子 Agent 长期不返回阻塞主换窗 | 已由完整运行时链路验证；有效交接后主任务可在 gate 未释放时执行业务 |
| 换窗后保留任务身份和必要语义 | 已验证来源、目录、分页、正文和首个业务请求的强制覆盖 |
| 原任务继续、取消与查询 | 自动验证通过；真实模型完成显式取消、原 ID 查询、正常最终回复及清理；早期超时单独保留 |
| 不完整交接停止而非无限等待 | 已验证明确失败，且不静默生成关系或重新委派 |
| 真实模型按约束处理结果、不重复历史业务 | text/json 均验证正确选择 included、排除 excluded、查询原 ID、不重写历史结果；另验证已终态但未消费结果的跨窗续办，不据此声称任意模型行为都有保证 |

尚不具备任务运行硬超时、跨进程恢复执行、自动结果消费或业务 exactly-once 保证；这些属于 spec 明确非目标。

## 6. 证据和变更范围

本次证据目录：`C:/Users/16474/AppData/Local/Temp/pi-subagent-rollover-20260925/`。

- `agent-core-tests.json`、`coding-agent-tests.json`：最终定向测试完整结果。
- `real-agent.mts`、`real-cli.mjs`：本次临时验收驱动；SDK 用受控 provider gate，CLI 提示使用真实工具等待 release 文件。因首请求失败，两者均未实际走到 gate。
- `real-sdk-1790338081778`、`real-sdk-1790338753342`、`real-sdk-1790338820796`：SDK 提示、事件、请求材料和结果。
- `real-cli-text-1790339049817`、`real-cli-json-1790339077551`：CLI 提示、stdout/stderr、Session JSONL 和退出结果。
- `baseline-status.txt`、`baseline-hashes.json`、`baseline.patch`：修改前基线。`turn-files.json`：相对基线的文件核对。
- `gpt55-low-probe.mts` 与 `gpt55-low-probe-1790356023961/result.json`：指定模型最小连接成功。
- `real-agent-gpt55-low.mts`、`real-cli-gpt55-low.mjs`、`model-acceptance-extension.ts`、`real-cancel-gpt55-low.mts`：本轮隔离 SDK/CLI 驱动；每次原始 prompt 保存在各 run 目录。CLI 显式信任测试夹具，关闭重试的项目设置按本轮配置加载。
- `evaluate-real-cli.mjs`、`evaluate-real-cancel.mjs`：对实际产物、原 ID、事件顺序和恢复请求正文执行独立断言；各 run 的 evaluation 文件保留 pass/fail。
- `validation-manifest.json`：当前源码 HEAD、24 个本任务相关文件的基线及现行 SHA-256；不含其他会话的新文档。
- `real-cancel-gpt55-low-longwait.mts`、`real-cli-gpt55-low-longwait.mjs`：本轮延长时限的验收驱动；对应 run 目录保存不可变驱动副本、limits.json、evaluation、latency.json 和完整运行证据。

变更限于上文模块、7 个相关测试文件和关联文档。workspace 已有大量未提交修改，均按基线保留；核对中另发现其他会话新增 `jev-routing-research.md` 和 `jev-codex-router-review.md`，本次未写入这两个文件。最新完整静态检查仅格式化本次修改的 subagent-task-tool 测试，没有范围外格式化修改。

原 spec 的 A01–A04 完成标准保持不变，现均有完整通过证据；所有失败尝试与后续成功分别记录。该结论限于报告中的矩阵和实际夹具，不扩大本次实现的非目标。
