# Agent 工作链路审查

审查对象：`E:\pi-main` 当前工作区，包括未提交和新增实现；HEAD 为 `b17f8c849`。不是只审查某一个提交。

预期依据：`packages/coding-agent/docs/specs/context-engineering-progressive-memory.md`、`long-term-memory-archive.md`、既有换窗与恢复规格、`docs/execution-upgrades.md`、`docs/rpc.md` 及接口契约。现行渐进维护规格优先于历史规格中的自动换窗规则。

结论：正常链路的结构符合现行设计，但来源可信度、恢复门禁、取消传播、状态边界仍有问题。确认 9 项缺陷；另有 1 项仅静态核对、尚未运行崩溃复现的额度风险。没有修改业务代码。

## Standards

未确认独立、实质性的规范问题。不把文件大小、抽象偏好或工具可检查的格式当作缺陷。仓库缺少技能约定的 `docs/agents/issue-tracker.md`，本次使用本地规格，没有查询外部 issue。

## Spec：确认的问题

### 1. P1：恢复完成标记会永久解除正文覆盖门禁

位置：[agent-session.ts:1810](E:/pi-main/packages/coding-agent/src/core/agent-session.ts:1810)。

`_recoveringRollover()` 一旦找到 `context-recovery-complete` 就返回 undefined。随后请求不会再执行恢复覆盖检查，工具守卫也不再限制业务工具。

触发：模型正常换窗并读完要求与 Note；在首次业务请求的 context 扩展中裁掉 History/Note 正文。实际模型可见 content 已不含必读约束，但业务工具仍执行且运行报告 completed。复现保留了内部 details，并仅检查真正给模型的正文，避免把内部元数据误算成模型可见内容。

验证：真实 suite harness + faux provider + context 扩展，正常经过 new_context、Note 保存、恢复查询和业务工具。确认正文缺失时业务工具执行一次。现有测试覆盖恢复尚未完成时移除正文，没有覆盖解锁后的首个业务请求。违反渐进维护规格第 5 节“恢复收据必须对应最终实际请求中仍存在的材料”。

### 2. P1：扩展消息被提升为用户来源

位置：[agent-session.ts:3990](E:/pi-main/packages/coding-agent/src/core/agent-session.ts:3990)、[agent-session.ts:1115](E:/pi-main/packages/coding-agent/src/core/agent-session.ts:1115)。

空闲时，扩展 `sendUserMessage()` 经 `prompt({source: "extension"})` 进入 `_startMemoryRun()`，但 source 没有传下去，原始证据固定记为 `origin: "user"`。归档可据此产生 active/user_asserted 的用户规则。流式队列路径区分了来源，空闲路径没有。

验证：真实 AgentSession harness 调用 sendUserMessage 并运行归档，确认规则来源为 user。违反长期记忆规格 3.1/I02 的来源隔离。缺少“空闲时扩展发消息”的归档测试。

### 3. P1：未验证的工具事实可废止用户规则

位置：[memory-authority.ts:912](E:/pi-main/packages/coding-agent/src/core/memory/memory-authority.ts:912)。

提交逻辑只要看到 `proposedRelation: "replaces"` 就把关联旧记录设为 superseded，没有限制新候选的可信度或被替换记录的类型。

触发：已有“使用 npm”的用户规则；仅来自工具的 implementation_fact 声称项目使用另一个工具，并提出 replaces。新记录自身只能进入 needs_verification，旧用户规则却已失效，默认召回不再返回它。

验证：真实 MemoryArchiveService 和磁盘权威存储复现。违反长期记忆规格 7.3：实现违反用户要求时，原规则仍有效。缺少“低可信候选替换高可信规则”的测试。

### 4. P1：撤销的记忆可由同一来源重新激活

位置：[memory-authority.ts:850](E:/pi-main/packages/coding-agent/src/core/memory/memory-authority.ts:850)。

撤销检查只匹配模型给出的 candidateKey。相同来源再提炼时，只要换 key 就找不到撤销记录。

触发：用户规则被撤销后，一条晚到的无关工具证据触发新的归档 job；同一原始用户来源被模型以新 candidateKey 再次提炼，规则重新 active。

验证：真实 MemoryArchiveService 完整归档和撤销流程复现。违反长期记忆规格 I06/7.3：文字改写、换 job 或同一来源重试不能解除撤销。缺少跨 job、换 key 的撤销测试。

### 5. P1：kill_task 未取消子 Session 的重试/压缩阶段

位置：[pi-child-runner.ts:122](E:/pi-main/packages/coding-agent/src/core/subagents/pi-child-runner.ts:122)。

父任务信号只调用 `session.agent.abort()`，没有取消 Session 层的 retry、compaction，也没有设置 `_promptAborted`。

触发：子 agent 正在自动重试等待时调用 kill_task。core agent 此时已经 idle，abort 是空操作；等待结束后仍会发送请求，甚至继续执行工具。预检及压缩阶段也存在同类信号断点。

验证：静态追踪 TaskManager → runner → Agent.abort → AgentSession 重试链路。已有任务测试通过，但未覆盖这些阶段的取消。

### 6. P1：前台 task 等待不能响应父任务取消

位置：[task.ts:80](E:/pi-main/packages/coding-agent/src/core/tools/task.ts:80)、[task.ts:103](E:/pi-main/packages/coding-agent/src/core/tools/task.ts:103)。

task 工具没有接收/传递调用的 AbortSignal。`run_in_background:false` 的等待持续至子任务终态或 600 秒截止。

触发：父 agent 正在等待前台子任务时，用户取消。父 Session 的 abort 等待主 agent idle，而主 agent 又等待该工具；取消不能中断等待或停止子任务。

验证：静态追踪父 Session.abort → agent 工具执行 → awaitForeground。与第 5 项是两个独立断点：一个在父工具边界，一个在子 Session 内。缺少前台委派运行期间的父取消测试。

### 7. P2：已送达的用户补充要求不能作为 Note 来源

位置：[task-note-projection.ts:545](E:/pi-main/packages/coding-agent/src/core/task-note-projection.ts:545)、[task-note-projection.ts:575](E:/pi-main/packages/coding-agent/src/core/task-note-projection.ts:575)。

History 对已 delivery_receipt 的 steering/follow-up 返回 pending_delivery 的 entryId，但 Note 的来源、块引用和用户证据检查不接受该 entry 类型。

触发：用户在运行中补充约束，模型从 History 获取其 ID 并保存 constraint Note，结果为 invalid_reference，无法按原始来源保存新增要求。

验证：直接执行实际模块；普通 user message 引用 accepted，已交付 pending delivery 引用（省略 blockIndex 或使用 -1）均 rejected。现有引用测试未覆盖队列交付来源。

### 8. P2：更新其他 Todo 会删除已接受的空内容项

位置：[todo-write.ts:64](E:/pi-main/packages/coding-agent/src/core/tools/todo-write.ts:64)、[todo-state.ts:84](E:/pi-main/packages/coding-agent/src/core/todo/todo-state.ts:84)。

工具 schema 和 applyMerge 允许把已有项更新为 `content: ""`，但下一次更新用 `fromJSON(toJSON())` 复制，fromJSON 会过滤该项。

触发：创建 pending 项 a；把 a.content 设为空；再更新 b。a 未被完成、取消或显式删除，却从持久化候选中消失，可能影响待办完成判断。

验证：直接执行实际 TodoStateStore 模块确认。现有 round-trip 测试无空字符串；候选复制引入了运行期间的静默丢项路径。

### 9. P2：RPC prompt 吞掉预检拒绝

位置：[rpc-client.ts:200](E:/pi-main/packages/coding-agent/src/modes/rpc/rpc-client.ts:200)。

`prompt()` 只 await send，不检查 response.success。服务端返回缺少认证等 `success:false` 时，客户端 Promise 仍正常 resolve；promptAndWait 继续等不会发生的完成事件，最终超时。

验证：真实 RpcClient 连接本地 JSONL 子进程；相同拒绝响应下 prompt resolved，getState rejected。违反 rpc.md 的预检接受/拒绝语义。此项是当前实现已有问题，不声称由未提交改动引入。

## 尚未运行崩溃复现的风险

### 10. P2：保存阶段可能在崩溃后返还模型调用额度

位置：[agent-session.ts:1713](E:/pi-main/packages/coding-agent/src/core/agent-session.ts:1713)、[agent-session.ts:5046](E:/pi-main/packages/coding-agent/src/core/agent-session.ts:5046)。

`_saveStateUsage()` 仅统计已持久化 assistant 消息。保存请求已经发送、但 assistant message_end 尚未落盘时进程退出，恢复会重算出较少的 samplesUsed，并允许继续调用。重复中断可能超过该保存操作的 3 次调用上限。

静态路径已核对；没有运行进程崩溃复现。已有测试只覆盖 assistant 已落盘后的耗尽恢复。应验证“request_start 已发生、assistant 未保存”的断点。这里不把换窗后 dispatch 的 outcome_unknown 协议直接套用于保存请求。

## 验证范围

- 14 个现有定向测试文件，165 项通过：agent-core 35、上下文维护/换窗 51、记忆归档 16、执行升级/任务/RPC/print 63。
- 4 个临时 Vitest 复现用例通过，断言并确认错误现状：第 1–4 项。第 7–9 项另以实际模块/客户端最小脚本验证。
- 第 5–6 项为静态全调用链确认；第 10 项保留为尚未运行崩溃复现的风险。
- 仅使用本地 faux provider 和本地子进程，没有真实模型调用。没有运行 build、npm test 或完整 Vitest suite。
- 临时复现文件已清理。未修改业务代码、未提交。现有测试通过不等于上述未覆盖边界正确。

Standards：0 项确认问题。Spec：9 项确认缺陷（6 个 P1、3 个 P2），另 1 个 P2 静态风险；最严重问题集中在恢复材料缺失后仍执行业务、用户规则可信度和取消失效。
