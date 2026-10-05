# 子 Agent 超时监督实现与验收记录

> 历史验收：对应旧 worker/期限监督实现。当前同进程方案及已接受的能力边界见 [Subagents](../subagents.md)；以下结果不作为当前实现的验收证据。

日期：2026-09-26。状态：运行协议、确定性验证及三组受控真实模型验证完成；17 个文件共 214 项测试通过，`npm run check` 退出码 0。真实模型统一为 `rrver/gpt-5.5`、思考深度 `low`，修复后 39/39 项场景断言通过。内联扩展的能力边界仍待用户确认，不将整体验收标记完成。

## 实现任务

- [x] A：TaskManager 单一生命周期、委派预算、控制版本和幂等控制。
- [x] B：独立子执行、停止确认、异步 worktree 生命周期和成果交接。
- [x] C：进展存证、有界查询、父通知与用户输入/换窗衔接。
- [x] D：工具、权限、配置、跨窗口来源及文档统一更新。
- [x] E1：三组确定性完整 Agent 调用链测试。
- [x] E2：补充故障测试、17 文件整合回归和最后一次仓库检查。
- [x] E3：三组真实模型验收；发现并修复停止原因被工具错误覆盖的问题，原样重跑全部通过。
- [ ] F：确认独立 worker 的内联扩展边界。

主任务负责 Session 生命周期、工具接线、配置、三组场景与整合；监督子任务负责状态机、幂等控制、分页、worktree 和来源恢复；执行子任务负责进程隔离、真实停止证据、checkpoint IPC 与进程故障测试。没有提交代码，没有修改依赖或锁文件。

## 三组验收

文件：[subagent-supervision-scenarios.test.ts](../../test/suite/subagent-supervision-scenarios.test.ts)，三组共 14 项；包含真实父/子 AgentSession、实际本地工具和独立进程，模型使用 faux provider。

| 组 | 场景 | 断言 |
| --- | --- | --- |
| 1：日常委派，3 项 | 读取实际文件并引用证据；错误路径由 child 修正；缺少宿主预算 | 检查实际父模型请求正文、证据内容和 child 来源；一次工具错误不触发重派；缺少授权时不创建任务 |
| 2：卡住后的父决策，4 项 | child 已保存进展但长查询不返回；父实际调用 wait/cancel/takeover/replace | wait 不换 ID、不刷新预算；其余动作确认真实停止；replace 仅一个后继、继承 delegation 和剩余授权，真实控制来源落盘 |
| 3：交互与竞态，7 项 | 父两工具批次未结束时 child 完成；同时收到用户新要求；最终 transform 移除通知；整个请求超出预算；旧决定失效；父轮次结束后的总预算；大结果分页 | 工具批次完整、没有第二个并发父循环；保留用户输入；未送达不确认且不无限唤醒；期限独立触发；结果可无损拼回 |

测试使用 suite harness 与 faux provider 驱动实际 AgentSession 和工具链；进程停止使用本地夹具。它们验证运行协议与文件效果，不把预设模型响应当作真实模型策略质量证明。

## 最终检查结果

最后整合运行：2026-09-26 16:52:30 开始，耗时 78.66 秒；17 个文件、214 项测试全部通过，无跳过。三组 14 项包含在该总数中，没有重复累计之前的定向运行。新增 3 项停止原因回归先复现失败、修复后通过；随后补齐测试事件的 `toolName` 类型字段，定向 32 项及仓库检查再次通过。

| 测试文件/范围 | 项数 |
| --- | ---: |
| subagent-supervision | 32 |
| subagent-output-pages | 3 |
| subagent-worktree-transaction | 10 |
| subagent-progress | 9 |
| subagent-replacement-handoff | 1 |
| windows-subagent-job | 1 |
| suite/subagent-worker | 14 |
| suite/subagent-supervision-scenarios | 14 |
| suite/subagent-context-rollover | 20 |
| suite/grok-alignment/subagent-task-tool | 9 |
| suite/grok-alignment/subagent-depth | 4 |
| suite/grok-alignment/task-output-kill-task | 16 |
| suite/grok-alignment/lsp-tool | 7 |
| print-mode | 14 |
| suite/context-rollover-queue | 4 |
| settings-manager | 34 |
| permission-policy | 22 |
| 合计 | 214 |

从 `packages/coding-agent` 重现最后整合运行：

```powershell
node ../../node_modules/vitest/dist/cli.js --run test/subagent-supervision.test.ts test/subagent-output-pages.test.ts test/subagent-worktree-transaction.test.ts test/subagent-progress.test.ts test/subagent-replacement-handoff.test.ts test/windows-subagent-job.test.ts test/suite/subagent-worker.test.ts test/suite/subagent-supervision-scenarios.test.ts test/suite/subagent-context-rollover.test.ts test/suite/grok-alignment/subagent-task-tool.test.ts test/suite/grok-alignment/subagent-depth.test.ts test/suite/grok-alignment/task-output-kill-task.test.ts test/suite/grok-alignment/lsp-tool.test.ts test/print-mode.test.ts test/suite/context-rollover-queue.test.ts test/settings-manager.test.ts test/permission-policy.test.ts
```

从根目录执行的 `npm run check` 最终退出码 0：格式、精确依赖版本、相对 import、shrinkwrap/install-lock、TypeScript 和 browser smoke 均通过。保留完整输出，npm 仍提示既有 `min-release-age` 配置在当前 npm 中未知；没有为消除工具版本提示修改仓库安装策略。`git diff --check` 通过。未运行 build、npm test 或全量 vitest。

## 实现的关键约束

- `task` 必须给出有限的 `execution_budget_ms`，宿主必须配置 `subagents.maxExecutionMs`。复查、查询与替换不会刷新同一 delegation 的单调 deadline。
- 子会话及本地工具在独立 worker 执行。Windows 在发送 start 前加入带 KILL_ON_JOB_CLOSE 的 Job Object，只有 ActiveProcesses 为 0 才确认停止；helper 查询失败明确报告 `stop_unconfirmed`。
- `task_control` 使用 ownerRevision、controlRevision 和 operationId；相同请求幂等，不同控制请求不能并发产生后继。取消、发布和接管共享同一状态权威。
- 进展自述标为 `child_report`；证据由父保存不可变内容、hash、来源和范围。报告及分页受 token/字节双限，不复制完整子对话。
- worktree 在子执行停止后冻结 patch，对初始 baseRevision 计算，包含子任务自己的提交。取消先取得裁决则禁止发布；已进入 apply 则等待真实结局。清理失败不删除完成成果或交接证据。
- 通知在最终 provider 请求实际包含材料后确认。用户新输入使旧决定及自动唤醒授权失效；关闭/取消只撤销监督队列项，不清除用户队列。
- print/json 复用 Session 的 awaiting 生命周期。换窗保留 worker、任务 ID、原始委派、父任务关系、控制来源和期限；重启缺句柄不重建执行。

## 验证矩阵与限制

| 规范项 | 实现级证据 |
| --- | --- |
| T01、T08 | task-output-kill-task 查询到期与监督 wait 测试：不取消、不续执行额度 |
| T02 | 三组场景中的 child 局部错误恢复；worker 测试中真实 pi.exec 超时后，child 见到错误并自行完成 |
| T03、T04 | 监督时钟和进展来源测试：不需要新的 child 模型响应；缺失与陈旧进展如实表示 |
| T05、T06 | progress、worker、场景测试：持久化后才 ack；不可变证据、选段、多字节限额；取消 worker 后实际通过父工具读取原证据与历史记录 |
| T07、T09、T11 | 监督状态测试：token 不使控制 CAS 持续失效；无父决策仍停止；替换不能刷新预算 |
| T10、T29 | worker 及 Windows Job 测试：非协作模型、异步/同步工具、扩展初始化同步阻塞、shutdown 回调挂住、派生进程、孤儿孙进程；helper 丢失保持停止未确认 |
| T12、T13、T14、T17、T32、T33、T35、T36 | 监督控制测试：重复参数、操作占位、完成/取消/新输入/预算竞争及启动前守卫 |
| T15、T16、T18 | 监督与 worktree 测试：撤销发布、apply 裁决、失败效果、迟到消息拒绝；实际父文件冲突令发布失败并保留父最新内容 |
| T19、T20、T27、T30、T34 | worktree 真实文件夹具：git lock 导致清理失败仍保留成果；本地接受日志模拟外部响应丢失且不重放；只读接续不发布旧修改；真实 writer 退出前不发布；发布使用冻结产物 |
| T21、T22、T37、T38 | 多任务通知、终态替换、复查/终态各一次、低余额复查截断测试 |
| T23、T24、T26、T31 | 三组场景实际父请求和工具批次断言、用户输入失效、awaiting 自动续跑及送达去重 |
| T25、T28 | subagent-context-rollover 的 SDK/text/json、连续换窗、缺少句柄与来源校验；replacement-handoff 经真实 task/task_control/context_note 链验证原委派、完整控制参数和规范来源 |
| T39 | 固定版本分页、Unicode 无损、旧 owner 游标拒绝；最终 transform 排除通知，以及含通知的整个 provider 请求超预算，两条实际 Agent 路径都不确认送达、不无限续跑 |
| T40 | 监督单调时钟测试：timer 未处理但已到期限时禁止发布和启动后继 |

上述证据覆盖所列具体路径，不表示穷尽任意操作系统或所有事件顺序。本机实际进程测试环境为 Windows、Node 24.14.0；POSIX 进程组实现尚未在本轮环境执行，Node 发布产物与 Bun 二进制也未 build/实跑。远端效果测试使用本地故障夹具，不声称远端写入可以取消或回滚。父宿主进程自身失去调度能力不在 child 隔离保证内。

另外，没有新增连续多次 replace 后再换窗的首个 provider 请求场景；现有证据分别验证单次替换来源恢复和多次普通换窗。git apply 的检查和应用不提供对任意外部写入者的原子文件锁。

本轮实际覆盖 SDK 与 print/text/json 的共享 Session 路径；interactive/RPC 使用同一控制实现，但没有单独启动这两个宿主入口做交互验收。

## 发现并处理的问题

1. Windows `taskkill /T` 被拒绝时根进程未停止：补充 spawn handle 停止，随后增加 Job Object 包含整个执行树；真实孤儿孙进程测试证明退出确认不只看根 PID。
2. `task_control` 已注册但未进入根 Agent 默认活跃工具：补齐默认列表与深度门禁，四种实际控制场景通过。
3. 初始化请求正文之外注入通知会绕过最终 transform：改为在 transform 前组装、实际 request_start 后确认；被移除的事实保留未读。
4. readonly 后继可能发布前任可写工作区的未完成修改：禁止只读发布，同时保留实际交接工作区和 patch。
5. 子任务自行提交后，按 HEAD 计算 diff 会漏提交：改为对初始 baseRevision 冻结并发布。
6. 新增父工具批次夹具初版错误地移除了内置委派工具，后改为仅替换测试 read 执行器；这属于测试夹具问题，未用伪造任务状态绕过。
7. 综合回归中的旧 5 秒完成假设在并行进程启动时失败：改为等待实际终态，并保留委派总预算；不是调大生产超时。
8. 首次 `npm run check` 遇到 Windows 文件映射锁错误 1224；重跑后排除。一次补测使用不存在的 Agent.setTools，改为正式 state.tools 接口后类型检查通过。
9. child 清理未发出正式 `session_shutdown`：补齐关闭事件，并验证关闭 handler 挂住仍能结束独立进程。worker 快照 ResourceLoader 对资源变更明确拒绝；不额外承诺交互扩展命令支持。
10. 真实模型总预算场景暴露了错误优先级问题：harness 写入 `execution_budget_exhausted` 后，停止 bash 返回的 `tool_error` 将其覆盖。现改为工具错误只替换普通工具错误，监督原因保持有效；主动取消也覆盖此前的普通工具错误。新增 deadline/cancel/stop_unconfirmed 三条事件顺序回归，并用未修改的真实验收驱动复验。

## 真实模型验收

用户明确指定 `gpt-5.5`、思考深度 `low`。全部真实父/子请求经已有 rrver 连接发送；检查请求模型与 reasoning 参数，修复后 28 次请求均匹配。使用源码 SDK、实际 child worker、本地文件与进程；仅操作各组独立临时工作区，没有修改全局连接配置或输出凭据。

| 组 | 实际场景与结果 | 断言 | 父/子请求 |
| --- | --- | ---: | ---: |
| 1 | 只读 child 读取 active rows、保存真实来源证据；父读取 evidence 后单次写出 73，排除 decoy 900 | 10/10 | 4/3 |
| 2 | child 保存 checkpoint 后挂起；父读取报告并显式 replace 为仅查 input.json 的后继；旧 PID 已退出，后继保留 delegation 并完成 | 12/12 | 7/5 |
| 3 | 真实 bash 长任务超过 210 秒总预算；自动停止后保留证据；父记录 cancelled、execution_budget_exhausted、executionStopped=true、subtotal=73 和 dependencyCompleted=false，历史输出未重写 | 17/17 | 6/3 |

修复前第一轮：组 1、2 通过；组 3 的进程停止和事实保留已通过，但错误原因被覆盖，导致 2/17 项断言失败。没有修改模型、思考深度、验收提示或断言来规避失败；修复后对三组完整重跑，驱动文件与第一轮逐字节一致，39/39 项通过且清理完成。第一轮组 2 曾出现一次带错参数的 pending 查询，模型收到 `invalid_pending_query` 后完成；复验三组没有父工具调用错误。

此前“认证不可用”的结论已更正：沙箱内读取认证需创建临时锁，实测返回 `EPERM`，AuthStorage 将读取错误隐藏为空快照；经授权在沙箱外运行后，既有 rrver/goaichat 连接均可用。这不是凭据过期。旧 blocked 记录保留为历史尝试，不计入通过次数。

脱敏证据、失败记录、每组 evaluation 及可重跑驱动见[真实验收汇总](C:/Users/16474/AppData/Local/Temp/pi-supervision-real-20260926/summary.md)和[最终请求与断言核验](C:/Users/16474/AppData/Local/Temp/pi-supervision-real-20260926/real-results.json)。三组属于有明确目标和故障夹具的单次真实执行验收，不能据此估计开放任务中的误取消率、重复委派率或模型决策成功率。

## 待确认能力边界

内联扩展闭包不能直接跨进程传递。当前 worker 加载文件形式的扩展，对内联闭包明确报错；父宿主模型传输仍保留既有 provider 和认证连接。这改变了原内联扩展与 child 共用进程的能力边界。

已按仓库 AGENTS.md 的 “Always ask before removing functionality or code that appears intentional.” 请求用户确认。未收到回复前，本项为待确认，不把它当成已批准的功能删除；当前修改供审阅，没有提交。
