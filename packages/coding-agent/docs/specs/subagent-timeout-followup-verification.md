# 前台超时与替换来源修复验收

> 历史验收：对应已移除的 task/replace 监督路径。当前工具与生命周期见 [Subagents](../subagents.md)；以下结果不作为当前实现的验收证据。

日期：2026-09-27。本记录仅覆盖已约定的两个缺陷：决策超时不能结束父侧等待，以及历史回退没有撤销替换执行。原监督系统的其他待办不属于本轮范围。

## 实现完成情况

1. 前台 `task` 和阻塞 `get_task_output` 共用监督等待。在决策超时、终态、停止或授权关闭时返回最新报告；普通查询到期不续预算。同范围子任务的监督事件可以结束同批次的其他子任务等待，并保留真实触发 taskId。
2. 事件只有进入真实父模型请求后才确认送达。已由工具正文表达的事实不重复注入；被变换移除或未提交的事实不提前确认。
3. 替换首次接受时冻结真实控制调用来源。后继执行前同步保存唯一规范结果并绑定请求与结果两条来源；重试不会重新绑定、重复登记或延长原 deadline。
4. 回退撤销 pending 后继资格或正在执行的后继，旧任务已发出的停止继续收尾。停止尚未确认时换窗为 busy，确认后仅排除失去规范来源的旧 retained 依赖；未知来源和模型新写的无效交接仍被拒绝。
5. 完成正常换窗、回退后换窗和三组真实模型验收。没有提交代码。

替换注册还补齐了两个直接相关的失败边界：规范结果写入失败时不登记后继；规范结果成功后的首份报告写入失败时，存在一个真实的失败任务。同步来源或交接写入耗尽预算时，在调用后继 runner 前执行原 deadline 裁决，后继不会执行。

已取得发布资格的执行仍按真实发布结局收尾。历史回退不承诺撤回已经应用的文件修改。

## 确定性验证

最终通过 17 个相关文件、去重 213 项测试。监督层使用可控单调时钟，协调器使用受控 runner 边界；Session 测试使用实际 harness、faux provider 和真实 worker，文件场景使用临时 Git 仓库。

| 范围 | 测试文件 | 项数 |
| --- | --- | ---: |
| 前台等待、批次唤醒、查询边界 | subagent-foreground-wait | 34 |
| 控制、预算、发布顺序、事件 | subagent-supervision | 35 |
| 首次来源、幂等、写入失败、回退阶段、启动期限 | subagent-replacement-ownership | 12 |
| 输出页面与进展证据 | subagent-output-pages / subagent-progress | 12 |
| 真实 worktree 事务 | subagent-worktree-transaction | 10 |
| 完整替换来源恢复 | subagent-replacement-handoff | 1 |
| worker 与真实 Session 场景 | suite/subagent-worker / subagent-supervision-scenarios | 28 |
| 父请求正文交付 | suite/subagent-supervision-delivery | 7 |
| 正常、pending、started 回退及实际换窗 | suite/subagent-replacement-navigation | 6 |
| 原有换窗语义 | suite/subagent-context-rollover | 20 |
| task、查询取消、深度限制 | suite/grok-alignment/subagent-task-tool / task-output-kill-task / subagent-depth | 30 |
| 换窗队列与 print 生命周期 | suite/context-rollover-queue / print-mode | 18 |

验证顺序：16 文件整合首次为 205/206；唯一失败是旧 foreground-timeout 测试仍模拟不再使用的 TaskManager.wait，导致没有触发前台返回。改为配置真实决策超时并检查返回正文后，该文件完整 20/20 通过。新增导航 suite 完整 6/6 通过。最后收紧启动前 deadline 检查后，监督、来源和 worktree 三文件 57/57 通过。上述数字不重复累计测试。

| Spec 矩阵 | 证据 |
| --- | --- |
| A01–A12、A17–A18 | foreground-wait 的正常/终态/超时/abort/监听清理及普通任务查询测试 |
| A13–A16 | 同批次跨任务唤醒、普通工具不被抢占、实际父请求交付、变换与预算排除测试 |
| B01、B07–B09 | 来源冻结、不同调用 ID 重试、参数冲突、规范写入失败、预算继承测试 |
| B02–B06、B10–B14 | 实际 navigateTree、pending 文件门控、规范结果被回退、多次替换、失败/取消/no-op、正常 new_context |
| B15–B16 | 监督发布前/发布中/发布后顺序；真实 worktree 文件验证与 G3 |
| B17–B19 | 未停止时 busy、确认后实际 new_context 恢复、旧分支不复活、未知活跃来源仍 invalid |
| B20 | setup/model_request/tool_execution 的监督状态回归，真实 worker 模型等待和工具阻塞场景 |

实际换窗测试检查首个业务请求中的完整来源、原始指令和替换参数，不只检查门禁返回 ready。手动 compact 原本会调用 Session.abort，本轮没有改变该已有取消语义；运行中后继跨上下文的保证使用实际 new_context 链路验证。

最终 `npm run check` 退出码 0：Biome、精确依赖、相对 import、shrinkwrap/install-lock、TypeScript 和 browser smoke 全部通过；Biome 未改动其他文件，`git diff --check` 通过。新增测试中不被当前 TypeScript lib 支持的两处 findLast 已改为仓库现有的 filter/at 写法，该 6 项 suite 再次全部通过。npm 仍有既有 min-release-age 配置识别提示，没有修改无关安装策略。未运行全量 Vitest、build、依赖更新或提交。

## 真实模型验收

全部使用已有 `rrver/gpt-5.5`、思考深度 `low`；每组硬上限 570 秒、45 次请求。源码 SDK、真实子进程、临时工作区，suite 内没有真实模型调用。

| 组 | 场景 | 结果 |
| --- | --- | --- |
| G1 | 有证据进展，前台决策超时后显式 wait，阻塞查询返回第二次超时，同一 child 完成 | 16/16；10 次父/子请求 |
| G2 | 已保存 checkpoint 的慢查询阻塞，显式 replace，旧 worker 退出后后继完成 | 15/15；12 次父/子请求 |
| G3 | worktree 后继真实写入后，宿主 navigateTree 回退；后继停止且未发布，独立 keeper 完成，新分支继续 | 20/20；18 次父/子请求 |

最终采纳的三组共 51/51 断言。每组都验证真实父子请求中的模型与 reasoning 参数、最终任务状态、单次输出和清理。

G2 保留两次未通过尝试：第一次 child 尚在 model_request、没有到达 checkpoint 与慢查询，不能算覆盖目标场景；第二次目标链路完成，但裸 PID 探针误把后来使用该 PID 的其他进程视为旧 worker。只将临时验收探针改为比较 PID、进程身份及系统创建时间，权限错误或身份不明仍判失败；提示词、预算和其他断言未变。修正后 G2 通过，没有把失败原始记录改成通过。

临时证据目录：`C:/Users/16474/AppData/Local/Temp/pi-supervision-final-20260927`。

- G1：`wait-1790516294181/evaluation.json`。
- G2 最终复验：`replace-1790517325113/evaluation.json`；启动边界最终调整前的通过记录为 `replace-1790517051542/evaluation.json`。
- G3：`navigate-1790516349719/evaluation.json`。
- 未通过尝试：`replace-1790516313416`、`replace-1790516553709`。
- 原驱动：`acceptance-before-process-identity.mjs`；含进程身份探针的驱动：`acceptance.mjs`。每组目录保留实际使用的 `driver.mjs`。

汇总见 [summary.md](C:/Users/16474/AppData/Local/Temp/pi-supervision-final-20260927/summary.md) 和 [real-results.json](C:/Users/16474/AppData/Local/Temp/pi-supervision-final-20260927/real-results.json)。最终采纳的三组共 40 次父/子请求；汇总另外保留两次未通过尝试及一次被最终复验取代的 G2 通过记录。

## 范围与已知限制

本轮后半段生产增量仅涉及 supervision.ts、supervision-types.ts、subagent-coordinator.ts、task-control.ts、agent-session.ts、subagent-continuation.ts。前两阶段涉及 task.ts、get-task-output.ts 的等待与送达接线。没有改通用工具循环、TaskManager 等待、worker/provider/认证、工作区创建清理算法、依赖或默认配置；保留工作区既有修改。

测试期间另外复现：父工具尚未返回时调用 navigateTree，迟到 toolResult 可能写入已没有对应调用的新分支，导致通用换窗事务检查一直 busy。这属于既有导航与父消息写回生命周期，未在本轮顺手扩修。本轮 pending 验收明确发生在 task_control 已返回 pending、父回合结束、旧 child 仍未确认停止的实际状态。此限制不能被表述为任意 streaming 导航都已安全。

持续磁盘写入失败、任意外部文件写入者和宿主自身失去调度能力，不由本轮两项修复保证。真实模型单次通过也不表示模型在所有开放任务中都会作出正确等待或替换决定。
