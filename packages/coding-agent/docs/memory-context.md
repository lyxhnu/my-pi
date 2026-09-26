# 记忆与上下文

自动容量管理采用 **Shake → Compaction → 模型决策换窗**。设计契约见 [渐进式短期记忆 Spec](specs/context-engineering-progressive-memory.md)。手动 [/compact](compaction.md) 和确定性 /shake 仍可单独使用。

## 窗口与恢复

首次请求前持久化 windowId。换窗和分支建立新身份，并记录 previousWindowId；自动及手动 Compaction 都保持当前窗口身份。换窗后的首个请求只包含常规 system/tools 和不超过 512 个估算 token 的 bootstrap：窗口 ID、resume_ref、恢复指令。旧消息后缀、Todo 和 Note 正文不会自动注入。

模型先用 context_note query 解析 resumeRef，再从 history 读取有效任务要求、后续用户约束、Todo 或所需证据。Note 只记录语义变化；默认 query 返回元数据，item 指定 eventId 才读取正文和 freshness。旧成功结果不会自动成为当前状态证明。单次变更和 64 条活跃笔记受限，累计审计事件不设 256 条失效门槛。

首次写入 Note 的最小参数是 `operation`、`kind`、`key`、`text` 和至少一个 `sourceRefs`；`evidenceRefs` 缺省为空，`resume` 可省略。更新或撤回已有 Note 时才传当前 `eventId` 作为 `supersedesEventId`，不得传空字符串。恢复引用只放在 `resume` 内。

new_context({reason}) 持久化模型的换窗意图，是提交新窗的必要条件。容量压力和 provider 容量拒绝只触发渐进维护，合法 Note 本身不授权换窗。当前 assistant 的整批工具调用和结果落盘后才能提交；待审批交互和 active 非 subagent Task 会推迟提交。内置 task 已返回原 ID 且交接校验通过后，子任务仍在 running/cancelling 也可跨窗，继续使用原 TaskManager；换窗不取消或重派任务。每个来源窗口最多提交一次，每个用户 prompt 最多换窗 8 次；同一请求幂等，实际目标请求必须缩小并满足工作预算。

next_action/current 的 resume 必须包含 subagentContinuations 数组，无关联子任务时为空。当前任务 scope 的全部委派、仍 active 的早期子任务和 Note 关联任务，均须填写 taskId、parentRelation 和 onResult。运行时从原委派记录构造目录，分页恢复原调用正文、父任务关系和结果处理步骤，并在首个业务请求前检查正文覆盖。缺少交接返回 subagent_handoff_invalid，正文在最终请求中丢失返回 recovery_request_incomplete。终态或一次查询均不表示结果已处理；进程重启后查不到原 ID 只表示当前 runtime 没有句柄。详细契约见 [子 Agent 跨窗 Spec](specs/subagent-context-rollover.md)。

换窗前先同步 Todo，再保存有效 next_action/current Note。恢复清单从权威 Todo 快照包含全部 pending/in_progress，以及模型显式选择的其他依赖，不受 resume.todoIds 的 8 项上限截断。必需要求、Note 和 Todo 全部进入实际请求后才开放业务工具。Todo 先持久化候选快照，再发布内存状态。

## 最终请求预算

get_context_remaining 返回最近一次最终请求的 inputTokens、remainingInputTokens、remainingWorkTokens、测量位置和配置修订。未知值是 null，measurement 为 unknown。工具返回本身仍消耗上下文。

请求预检在 transform、消息转换和 append-only 构造之后、provider 调用之前执行。system、工具 schema、图片、整批工具结果和已交付队列都计入输入。usage 只有在模型及请求前缀指纹匹配时才作为估算锚点。

~~~text
输入 I + 输出预留 R + 安全余量 S <= 模型窗口 W
R = min(请求输出上限或模型上限, 模型上限, 32768)
S = max(4096, ceil(R * 0.2))
remainingWork = max(0, min(W * 阈值 - I, remainingInput) - 3072)
~~~

阈值由 compaction.autoCompactThresholdPercent 配置，默认 85%。最终请求出现压力时先执行 Shake 并重测，仍不足则语义压缩旧前缀并重测。Compaction 保留生效要求、当前 Note/Todo 和最近完整工具交互；候选请求必须严格变小才能提交。同一业务来源和请求配置只尝试一次 Shake、一次 Compaction，额度在执行前持久化，控制工具与重启不会返还额度。

两级减负后仍有压力且请求可发送时，进入模型决策与保存阶段。每个窗口和 promptGeneration 只建立一个持久化 save_state 操作，最多使用 3 次 sampling、2048 个输出 token 和 3072 个查询/结果控制 token。该阶段开放获准的 history、context_note、todo_write、get_context_remaining 和 new_context。模型可以结束任务或显式请求换窗；没有换窗意图且额度耗尽时停止，不自动切窗。完成的 continuation contract 在提交前还会对并发到达的用户约束、Todo、工具配置和来源 revision 重新验证。

rollover 提交前会用实际 transform、append-only 和完整业务工具定义预检整个恢复工作集。必读 Note、任务要求、History 引用和 Todo 正文无法与正常输出、安全余量及后续保存空间共同容纳时，返回 recovery_workset_too_large 并保留旧窗口。

compaction.enabled=false 关闭自动容量触发，最终容量检查仍然执行。显式工具 allowlist、deny、Plan Mode、子代理可见性均生效；缺少获准的 history/context_note 时不能提交不可恢复窗口。

## history

~~~json
{"operation":"list_windows"}
{"operation":"list_items","windowId":"window-uuid"}
{"operation":"read_item","entryId":"saved-id","blockIndex":0}
{"operation":"search","text":"literal text"}
~~~

所有操作共享当前分支中已向模型公开的投影。搜索只匹配字面文本，返回 entry/block/offset 和短片段。隐藏推理、未交付队列、兄弟分支、内部日志及历史 memory_get/memory_search、history/context_note 结果不进入语料。Todo 仅暴露公开投影；附件返回引用元数据，不展开二进制。

每页连同元数据和 cursor 最多 2048 估算 token，可用 budgetTokens 缩小。read_item 的 offset/end 使用 UTF-16，分页末尾不会拆开代理对。原始字符串 blockIndex=-1，多块内容需指定块。cursor 绑定会话、分支、窗口、查询和可见性版本。搜索扫描也受上限约束，零命中且 exhausted=false 时必须继续 cursor 才能判断整个范围无结果。

回读只返回 Session 保存的内容，不重跑工具、不读取源文件当前版本。当前窗口已返回的片段从工具结果推导并跳过；verify=true 可显式复核。Note 正文回读也按有效投影修订去重。

## 持久化与诊断

提交前校验恢复引用和 session/Todo/queue/progress/config/Note 修订；来源变化最多重试一次。持久化 rollover 后，使用预检得到的同一个 PreparedContinuation 续发。dispatch_started 与预留队列收据在发送前写入；完成后记录 finished。

已提交但未 started 的恢复必须重新得到相同请求指纹、预算和队列集合，才能发送一次。started 没有 finished 表示 outcome_unknown，禁止自动重放。完整的无末尾换行 JSONL 条目可继续追加；不完整的最后一条记录阻止自动恢复。此顺序保证针对进程崩溃；未使用 fsync，不承诺断电持久性。

/trace 可检查 context/budget、context/rollover、context/task_note、compaction/summary、memory/archive 和 turn/end。context_maintenance 将控制交回宿主；未解决的 context_maintenance、context_limit 或 context_transition 表示任务尚未完成。print/JSON 模式对未完成结果返回退出码 1，即使尚未产生助手回复。SDK/RPC 应在 agent_settled 后检查 runState.lastOutcome 和 contextRolloverState，而非把 prompt 接受成功当作完成。

## 长期记忆权威与归档

长期记忆使用项目目录中的 `memory-state.v2.json` 作为唯一有效性权威。顶层请求在进入运行时前建立稳定 `rootPromptId`；模型重试、Todo 续跑和自动换窗沿用该 ID。原始用户输入、扩展转换、助手输出、完整工具结果及 Task 输出分别登记为带 origin、哈希和完整性状态的证据。旧轮后台 Task 始终写回创建它的 Run。

业务执行、证据持久化和归档各有独立状态。Run 只有在主执行静止、续跑关闭、全部 dependency Task 的终态证据可回读且没有 pending evidence 时才封存固定 Manifest。封存建立可恢复 job；自动换窗和 `/compact` 不触发晋升。`memory.enabled` 和 `memory.archive.enabled` 都为 true 时，顶层 Session 才在后台处理归档 job；子代理不独立归档。

提炼与逐候选校验是无业务工具的独立模型调用。模型只能提出结论、范围、引用和关系；宿主校验来源集合、覆盖收据、安全规则、冲突集合版本和项目要求版本。支持检查与全 Manifest 反证检查均通过后才能提交。达到候选上限、缺少完整证据、冲突版本变化或语义校验不可用时不会产生 active 记录。

job 通过项目锁、lease、attempt token、提炼检查点和逐候选校验收据恢复。旧 worker 的晚到结果无法写入。每项目小时调用预留持久化；额度不足进入 `waiting_budget`，在 `retryAt` 后继续，不增加技术失败次数。相同 candidateKey 生成稳定 memoryId，最终提交和重复 flush 保持幂等。

所有写入入口执行相同的敏感内容过滤。被过滤的证据在归档视图中只保留缺口、哈希和原因，不能计为完整反证覆盖；被拒绝内容不会在状态或 trace 中回显。原 Session 的保存策略与项目归档视图分离。

## 有效读取和手动入口

`memory_search` 和 `memory_get` 都从 v2 authority 计算结果。默认只返回最新 `active`、来源仍可验证且当前 machineConditions 适用的项目记录。`memory_get` 仅接受 memoryId；`includeUnverified` 和 `includeHistory` 只扩大同一项目内可调查的状态，不能绕过来源和适用性检查。规则命中会展开 replacement、exception 和 conflict 关系；例外条件未知时，基础规则不会作为无条件事实返回。

启用 `memory.enabled` 且使用默认工具集合时，Memory 工具加入默认候选后再经过 allowlist、deny 和能力过滤。显式工具集合不会被扩充。当前用户要求始终高于历史记忆。

- `/memory remember <rule>` 原子保存原始用户规则和 active 修订。
- `/memory flush` 只封存和处理当前已闭合 Run，不压缩或改写上下文；返回 job、Manifest、实际写入数、剩余来源和原因。
- `/memory status` 显示记录、证据、失败、预算等待、下次调度时间和各 job 状态。
- `/memory undo <memoryId>` 写入 revoked 修订；搜索和直接读取立即遵守撤销状态。

旧 `MEMORY.md`、Session notes、`.dream-state.json`、提交日志和撤销 sidecar 原样保留为历史数据。新归档不读取这些文件作为 active 知识，不运行 autoDream，不覆盖人工 Markdown。显式旧数据导入尚未提供，因此旧条目不会自动获得用户规则或已验证事实身份。

JSONL 原始消息不被 shake、compaction 或归档改写。Memory trace 为 log-only，不推进逻辑叶子。真实模型的晋升准确率、召回率、冲突判断和成本仍需要固定人工标注数据集评估；faux provider 回归只验证控制契约。
