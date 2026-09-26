# 上下文换代恢复 Spec

| 项目 | 内容 |
| --- | --- |
| Spec ID | `context-rollover` |
| 状态 | 已实现（持续以本文件的验收矩阵回归） |
| 日期 | 2026-09-03 |
| 适用范围 | `packages/agent`、`packages/coding-agent` |
| 前置能力 | Context Maintenance、SessionManager、TodoStateStore、Trace、Memory、history_get |
| 需求来源 | 当 Shake 和 Compaction 无法恢复上下文时，在同一任务中建立新的上下文周期并继续工作 |

本文中的“必须”“不得”是实现和验收约束。接口片段描述目标契约，不表示当前代码已存在同名导出。

## 1. 决策摘要

本能力命名为 **Context Rollover（上下文换代）**。它不创建新的进程、终端窗口、Session 或用户 prompt，而是在同一个 AgentSession 和 Session 分支中建立新的 Context Epoch。

新 epoch 的模型上下文只包含：

- 当前系统提示词和工具定义；
- 提前生成并校验的结构化 Checkpoint Note；
- 当前分支最新 TodoState，而不是换代时的陈旧 Todo 副本；
- Checkpoint 未覆盖的有界 Active Suffix；
- 按现有队列规则为第一次 continuation 预留的 steering/follow-up 消息；
- 换代之后新产生并已提交的消息。

完整旧历史仍保存在 Session JSONL。Handoff 明确引用的旧 entry 可以通过 `history_get` 按 entry/block 白名单读取；Memory 仍通过 `memory_search` 和 `memory_get` 获取当前视图。

Context Rollover 不是第四种压缩算法。Context Maintenance 仍以 `blocked` 结束；AgentSession 只把符合本 Spec 容量门禁的终态交给独立的 Context Rollover 模块。

换代后的自动续跑不承诺跨进程严格 exactly-once。系统提供：

- 同进程 single-flight；
- 持久化 dispatch journal；
- 自动 dispatch at-most-once；
- crash 落在 Provider/工具执行不确定区间时 fail closed，不自动重放。

## 2. 第一性原理

```text
语义连续性 = 结构化 Checkpoint Note
事实连续性 = 当前 Todo + Session entry + 可验证证据
执行连续性 = PreparedContinuation + 持久化队列 + dispatch journal
历史完整性 = 原 Session JSONL，不等于新请求上下文
安全连续性 = 不扩大系统指令、权限和用户授权
```

必须同时满足两个相反约束：

1. 恢复材料足够少，使新请求显著低于窗口上限；
2. 恢复材料足够完整，使 Agent 能确定目标、当前状态和唯一下一动作。

解决方式是：

```text
结构化 Checkpoint + 当前 Todo + 原子 Tool Transaction + 有界 Active Suffix
+ 持久化 Pending Delivery + 可取回历史引用
```

不能把模型自述当作系统事实。不能把 Preview 和真正发送实现为两套请求构造。不能在无法判断外部调用是否发生时自动重放。

## 3. 目标

- 常规上下文维护确定失败后，为未完成任务建立显著更小的新 epoch。
- 新上下文能确定原始目标、用户约束、决策、已完成工作、当前状态、失败尝试和下一动作。
- Preview 与第一次真实 Provider Request 使用同一个 PreparedContinuation。
- steering/follow-up 的正文、顺序和消费状态可以跨 Session resume 恢复。
- nextTurn 保持“仅随下一次新用户 prompt 注入”的原语义。
- 换代提交具备单一线性化点，不提交陈旧 Handoff。
- Checkpoint、维护额度、rollover 次数和 dispatch 状态可以从 Session 重建。
- 无强进展或达到累计上限时确定停止，不形成资源无限增长。
- Provider 或副作用工具结果不确定时停止，不自动重放。
- CLI、RPC、子代理和 Trace 能区分维护失败、换代、dispatch 和不确定终态。

## 4. 非目标

- 不创建新的操作系统进程、终端窗口、Codex task 或 Session 文件。
- 不注入完整旧历史、完整 Trace、完整工具输出或全部 Memory。
- 不使用固定最近 N 轮作为信息选择策略。
- 不在容量已经耗尽后启动第一份 Checkpoint 模型请求。
- 不自动切换模型、扩大 context window 或降低输出预留。
- 不把 Rollover 用于认证、网络、权限、扩展 veto 或普通 Provider 错误。
- 不依赖 Provider 一定支持幂等键。
- 不在 crash 后猜测 Provider 请求或副作用工具是否已经执行。
- 第一版不增加用户配置项；阈值和次数按本 Spec 固定。
- 不保留旧 continuation 发送路径作为兼容分支。

## 5. 术语

### 5.1 Context Epoch

同一用户 prompt 内连续使用同一上下文历史的周期。新 prompt 创建 epoch 0；一次成功 Rollover 创建下一个 epoch，promptGeneration 不变。

### 5.2 Rollover Checkpoint

容量仍可用时，模型对一个不可变且以完整 Tool Transaction 结束的 Session 前缀生成的结构化交接笔记。

### 5.3 Tool Transaction

以下任一不可拆分组：

- 不含 tool call 的单条消息；
- user、custom 或不含 tool call 的 assistant message 是单条 transaction；
- 一条包含一个或多个 tool call 的 assistant message，以及这些 call 的全部 terminal toolResult messages，是一个 transaction；
- toolResult 永远不能独立成为 transaction。

Checkpoint 结束位置、Compaction 保留起点和 Active Suffix 起点均不得落在 Tool Transaction 内部。

### 5.4 Active Suffix

当前有效上下文中未被 Checkpoint 覆盖的连续 Tool Transaction 集合。它与 Checkpoint 不重叠，不使用单 assistant bridge。

### 5.5 Pending Delivery

已接收但尚未交付给 Agent loop 的 steering、follow-up 或 next-prompt message。它有稳定 deliveryId，并以 Session entry 持久化。

### 5.6 PreparedContinuation

由 Agent 模块一次性构造的不可变、进程内 opaque handle。它封装第一次 Provider Request 的最终 Context、模型参数、预算、指纹及预留 delivery；Preview 和真实发送必须消费同一个 handle。

### 5.7 Strong Progress

由系统事件和证据验证、可计数且不可重复使用的里程碑进展。Todo 文案变化、普通 write 或变化的命令输出不是 Strong Progress。

## 6. 系统不变量

| ID | 约束 |
| --- | --- |
| R01 | 只消费 `continuation=required` 的容量维护终态；正常回答后的 threshold 整理不得触发 |
| R02 | 第一份 Checkpoint 必须在容量耗尽前启动；blocked 后只能等待同 epoch 已在运行的操作 |
| R03 | Checkpoint 和 Active Suffix 不得切开 Tool Transaction |
| R04 | objective 和用户约束必须引用真实 user 或带 user provenance 的 custom-user entry |
| R05 | completedWork 必须使用与声明类型匹配的事实证据；Session 边界不能证明业务完成 |
| R06 | 当前有效 entry 必须由 Checkpoint 或 Active Suffix 完整覆盖且不重叠 |
| R07 | Todo 模型投影始终来自当前分支最新持久化 TodoState；bundle 快照只用于审计 |
| R08 | 按 Agent drain 规则应在第一次请求消费的 steering/follow-up 必须进入同一个 PreparedContinuation；nextTurn 不参与该请求 |
| R09 | Preview 与第一次 Provider Request 不得分别执行请求构造 |
| R10 | Rollover 提交必须使用 Session/Todo/Queue/Progress/RequestConfig revision 的同步 CAS |
| R11 | `appendContextRollover()` 是不可逆线性化点；CAS 和 append 之间不得 `await` |
| R12 | Provider 请求前必须先持久化带 `reservedDeliveryIds` 的 `dispatch_started`；它同时是这些消息的交付凭证，started 无 finished 的恢复状态不得自动重放 |
| R13 | 每个 epoch 最多 2 次 Checkpoint operation、3 次 Soft Compaction、1 次 rollover commit |
| R14 | 每个用户 prompt 最多 8 次 rollover commit |
| R15 | 第二次及后续 Rollover 必须消费至少一个新的 Strong Progress credit |
| R16 | 所有额度在操作启动前持久化；失败、取消、crash 和无效输出不返还 |
| R17 | Trace 只用于观测，不能作为额度、队列、dispatch 或恢复事实来源 |
| R18 | Pending Delivery 正文只进入 Session 权威记录和真实请求，不进入 Trace 或 Handoff Note |
| R19 | Handoff 不扩大系统指令、工具权限或用户授权 |
| R20 | history_get 只开放 Shake ancestor 或最新 Handoff 精确列出的 entry/block |
| R21 | 组装时父工具批次未完整、存在待确认交互或 active 非 subagent Task 时不得提交；已返回原 ID 的内置子任务按子 Agent 跨窗 Spec 校验交接，校验通过不等待终态 |
| R22 | 无法证明交接完整、请求一致或执行不会自动重放时必须停止 |

## 7. 模块与接口

### 7.1 Context Rollover seam

新增深模块：

```text
packages/coding-agent/src/core/context-rollover.ts
```

AgentSession 只调用两个接口：

```ts
export interface ContextRolloverCheckpointRequest {
  promptGeneration: number;
  contextEpoch: number;
  snapshot: ContextMaintenanceSnapshot;
  signal?: AbortSignal;
}

export type ContextRolloverCheckpointOutcome =
  | { outcome: "committed"; checkpointId: string; checkpointEntryId: string }
  | { outcome: "not_started" | "discarded"; checkpointId?: string; reason: ContextRolloverCheckpointReason }
  | { outcome: "cancelled"; checkpointId?: string };

export async function prepareContextRolloverCheckpoint(
  request: ContextRolloverCheckpointRequest,
  dependencies: ContextRolloverDependencies,
): Promise<ContextRolloverCheckpointOutcome>;

export interface ContextRolloverRequest {
  sourceMaintenanceId: string;
  promptGeneration: number;
  contextEpoch: number;
  maintenanceCause: "budget_limit" | "provider_overflow";
  maintenanceBlockedReason: "methods_exhausted" | "no_progress" | "attempt_limit";
  continuation: "required";
  sourceRequestFingerprint: string;
  signal?: AbortSignal;
}

export type ContextRolloverOutcome =
  | {
      outcome: "ready";
      rolloverId: string;
      entryId: string;
      targetContextEpoch: number;
      preparation: PreparedContinuation;
    }
  | {
      outcome: "blocked";
      rolloverId: string;
      committed: boolean;
      reason: ContextRolloverBlockedReason;
    }
  | { outcome: "cancelled"; rolloverId: string; committed: false };

export async function runContextRollover(
  request: ContextRolloverRequest,
  dependencies: ContextRolloverDependencies,
): Promise<ContextRolloverOutcome>;
```

Checkpoint 选择、Handoff 组装、证据校验、Strong Progress、预算门禁、revision proposal 和提交后校验都隐藏在模块内。`ContextRolloverDependencies` 是包内 seam，不从包顶层导出通用持久化 port。

### 7.2 PreparedContinuation seam

在 `packages/agent` 中增加 PreparedContinuation 深模块，并让现有 `Agent.continue()` 改为调用同一实现：

```ts
export interface PreparedContinuation {
  readonly preparationId: string;
  readonly baseContextFingerprint: string;
  readonly requestFingerprint: string;
  readonly budget: ContextBudget;
  readonly queueRevision: string;
  readonly reservedQueueItemIds: readonly string[];
}

export interface PrepareContinuationOptions {
  signal?: AbortSignal;
  requiredQueueItemIds?: readonly string[];
}

export interface QueuedAgentMessage {
  queueItemId: string;
  message: AgentMessage;
}

class Agent {
  steer(item: QueuedAgentMessage): void;
  followUp(item: QueuedAgentMessage): void;
  prepareContinuation(
    candidateMessages: AgentMessage[],
    options?: PrepareContinuationOptions,
  ): Promise<PreparedContinuation>;
  dispatchPreparedContinuation(preparation: PreparedContinuation): Promise<void>;
  releasePreparedContinuation(preparation: PreparedContinuation): void;
}
```

`PreparedContinuation` 对调用者只暴露摘要；最终 Provider Context 和队列正文保存在 Agent 内部的单个进程内记录中。模块必须：

- 按当前最后消息角色、steering/follow-up mode 选择第一次请求实际会消费的消息；
- 预留而非立即丢弃所选消息；
- 应用当前 `transformContext`、`convertToLlm`、system prompt、tools、model、thinking、append-only context 语义和预算选项；
- 验证最终 LLM messages 非空，且最后角色满足现有 continuation 约束；
- 缓存最终第一次 Provider Context，dispatch 时不得重新执行这些转换；
- append-only context 必须在可丢弃快照上准备，只有 dispatch 才提交缓存状态；release 不得改变缓存前缀；
- 第一次请求之后恢复正常队列轮询；
- release 时把预留消息按原顺序恢复到队头；
- queueRevision 只用于 preparation 到 rollover commit 之间的 CAS；commit 后 dispatch 只校验 reservation 所有权，不能因后来追加的队列消息失效；
- 同时最多存在一个未结算 preparation。

相同 base/queue revision 的并发 prepare 共享同一个 Promise 和 handle；不同来源在已有 preparation 时明确失败。coding-agent 以 deliveryId 作为 queueItemId，因此 RolloverEntry 可以持久化并校验精确的预留消息。

首次 prepare 不传 requiredQueueItemIds，由 Agent 按 drain 规则选择。恢复 rollover prepared 状态时必须传入 RolloverEntry.reservedDeliveryIds；这些 ID 必须仍未 receipt 且顺序一致。空数组表示第一次请求明确不消费当前新增队列消息。

baseContextFingerprint 对预留队列和 transformContext 之前的候选 AgentContext 计算；requestFingerprint 对预留队列、transformContext、convertToLlm 和最终请求配置全部应用后的 Provider Context 计算。两者用途不同，不得互换。

`Agent.continue()` 不保留原直接发送实现；它通过 prepare + dispatch 完成普通 continuation。这样测试和 Rollover 复用同一个 seam。

### 7.3 Pending Delivery seam

`pending-delivery.ts` 隐藏 Session entry 扫描、稳定 ID、队列 revision 和 receipt 投影：

```ts
export type PendingDeliveryChannel = "steering" | "follow_up" | "next_prompt";

export interface PendingDeliverySnapshot {
  readonly revision: string;
  readonly items: ReadonlyArray<{
    queueItemId: string;
    channel: PendingDeliveryChannel;
    message: AgentMessage;
  }>;
}

class PendingDeliveryStore {
  enqueue(channel: PendingDeliveryChannel, message: AgentMessage): QueuedAgentMessage;
  snapshot(): PendingDeliverySnapshot;
  markDelivered(queueItemId: string, preparationId?: string): void;
}
```

构造时从 Session 当前分支恢复；snapshot 返回不可变 revision 和按 channel 排序的未交付 item。AgentSession 不再维护字符串镜像作为业务状态，UI queue_update 也从该 snapshot 派生。

### 7.4 状态

```ts
export type ContextRolloverState =
  | "idle"
  | "checking"
  | "waiting_checkpoint"
  | "assembling"
  | "validating"
  | "preparing_continuation"
  | "committing"
  | "committed"
  | "dispatching"
  | "ready"
  | "superseded"
  | "blocked"
  | "cancelled";
```

来源 superseded 最多重新组装一次；第二次返回 `blocked(source_changed)`。

## 8. 持久化账本

### 8.1 Context Operation

新增权威 Session entry：

```ts
export interface ContextOperationEntry extends SessionEntryBase {
  type: "context_operation";
  operationId: string;
  operationKind: "checkpoint" | "soft_compaction" | "overflow_retry";
  state: "started" | "finished";
  promptGeneration: number;
  contextEpoch: number;
  sourceFingerprint: string;
  outcome?: string;
}

export interface ContextProgressEntry extends SessionEntryBase {
  type: "context_progress";
  evidenceId: string;
  evidenceKind: "non_read_effect" | "verification" | "task_completed";
  targetFingerprint: string;
  resultFingerprint: string;
  outcome: "succeeded" | "failed";
  toolCallId?: string;
  taskId?: string;
}
```

`started` 必须在模型调用或 retry 开始前同步落盘。额度按当前分支中唯一 operationId 的 started entry 计数；finished 只记录结果，不返还额度。Trace 写入失败不影响计数。

ContextMaintenanceBudget 只是从账本构造的内存视图，不再是权威状态。Session resume、fork 和新 AgentSession 必须重新扫描当前分支。ContextProgressEntry 由成功工具 effect、验证结果和 Task completed 事件同步生成，只保存稳定 ID/哈希，不保存参数和结果正文；Strong Progress 只读取该权威证据，不读取 Trace。

ContextOperationEntry 和未交付的 PendingDeliveryEntry 不进入 LLM source fingerprint；DeliveryReceiptEntry 或引用该 deliveryId 的 dispatch_started 会把消息投影到上下文，因此必须进入 source fingerprint。Pending queue 的变化只由 queue revision 表达，不能混入 Session 消息指纹。

### 8.2 Pending Delivery

```ts
export interface PendingDeliveryEntry extends SessionEntryBase {
  type: "pending_delivery";
  deliveryId: string;
  channel: "steering" | "follow_up" | "next_prompt";
  message: AgentMessage;
}

export interface DeliveryReceiptEntry extends SessionEntryBase {
  type: "delivery_receipt";
  deliveryId: string;
  preparationId?: string;
}

export interface DeliveryCancelledEntry extends SessionEntryBase {
  type: "delivery_cancelled";
  deliveryId: string;
}
```

入队时先持久化 PendingDeliveryEntry，再写入内存队列。普通 continuation 中，消息真正进入 Agent context 时持久化 DeliveryReceiptEntry。Rollover continuation 不另写 DeliveryReceiptEntry：dispatch_started 同时记录 reservedDeliveryIds 并作为这些消息的权威交付凭证。上下文重建在 receipt 或 dispatch_started 的位置投影原 PendingDeliveryEntry.message，因此无需再保存第二份消息正文。

当前分支存在 PendingDeliveryEntry，且没有对应 DeliveryReceiptEntry、DeliveryCancelledEntry，也没有被 dispatch_started.reservedDeliveryIds 引用时即为未交付。Session resume 按 channel 和 entry 顺序恢复；已由任一交付凭证消费或显式取消的消息不得重排或再次入队。清空队列必须追加 DeliveryCancelledEntry，不能只清除内存状态。

queue revision 对按交付顺序排列的 `{deliveryId, channel, canonicalMessage}` 计算。canonicalMessage 包含所有文本、图片数据及 detail 元数据、customType、display 和可序列化 details；不得使用纯文本镜像。PendingDeliveryEntry 无法完整序列化时 enqueue 失败，不得只把部分消息放入内存队列。

### 8.3 Rollover 与 Dispatch

```ts
export interface ContextRolloverEntry extends SessionEntryBase {
  type: "context_rollover";
  rolloverId: string;
  dispatchId: string;
  promptGeneration: number;
  sourceContextEpoch: number;
  targetContextEpoch: number;
  checkpointEntryId: string;
  bundle: ContextRolloverBundle;
  expectedRevisions: ContextRolloverRevisions;
  sourceTokens: number;
  preparedTokens: number;
  sourceRequestFingerprint: string;
  preparedRequestFingerprint: string;
  preparationBaseFingerprint: string;
  reservedDeliveryIds: string[];
  strongProgressCreditIds: string[];
}

export interface ContextRolloverDispatchEntry extends SessionEntryBase {
  type: "context_rollover_dispatch";
  dispatchId: string;
  rolloverId: string;
  state: "started" | "finished" | "blocked" | "cancelled";
  requestFingerprint: string;
  reservedDeliveryIds?: string[];
  outcome?: "completed" | "context_limit" | "aborted" | "failed";
  reason?: ContextRolloverBlockedReason;
}
```

RolloverEntry 本身表示 dispatch 已 prepared。`dispatchId = sha256("context-rollover-dispatch-v1" + rolloverId + preparedRequestFingerprint)`，恢复时必须得到相同值。dispatch started/finished 使用独立追加 entry。Trace 不是这些状态的替代品。

## 9. Checkpoint 提前生成

### 9.1 Prefire 界限

```text
prefirePercent = max(0, min(70, autoCompactThresholdPercent - 10))
```

同时满足以下条件时启动后台 Checkpoint：

- 当前用户 prompt 未结束；
- 当前 epoch 的 checkpoint started 少于 2；
- 没有 Checkpoint 或 two-pass compaction summary 正在占用共享后台总结槽；
- 输入 token 使用率达到 prefirePercent，但预算仍不是 context_limit；
- 存在以完整 Tool Transaction 结束的可覆盖前缀；
- 当前 epoch 没有有效 Checkpoint，或未覆盖增量达到窗口 10%。

默认阈值 85% 时第一次在 70% 附近启动，单 epoch 最多刷新一次。operation started 在调用模型前持久化；失败、取消、crash、无效输出和来源变化都消耗额度。

同一次预算测量中若 Rollover Checkpoint 和 two-pass prefire 同时首次满足条件，Checkpoint 先取得共享总结槽，因为它是容量终态后的必要恢复材料。已经运行的 two-pass operation 不被抢占或取消。

### 9.2 blocked 时已有 Checkpoint operation

Maintenance blocked 时：

- 已有有效 Checkpoint：直接继续评估；
- 同 epoch Checkpoint 正在运行：进入 `waiting_checkpoint`，只等待该 operation 的原始 deadline 或用户 abort；
- 不得重置 deadline、增加 retry 或启动新的 Checkpoint；
- 既有 operation 成功后重新评估一次；失败后返回 `blocked(checkpoint_missing)`。

这不违反“blocked 后不新开总结请求”，因为等待的是容量耗尽前已经启动且计费的同一 operation。

### 9.3 前缀与 Tool Transaction

Checkpoint 快照必须包含：

- coveredStartEntryId、coveredEndEntryId、coveredEntryIds；
- sourcePrefixFingerprint；
- promptGeneration、contextEpoch；
- TodoState entry ID 和指纹；
- requestConfigFingerprint；
- coveredEndEntryId 所属 Tool Transaction 已完整结束的证明。

生成期间允许在前缀之后追加 entry。覆盖前缀、Todo 来源或 request config 变化时丢弃。Checkpoint 提交后发生 Compaction 不自动使其失效；选择时以当前 `buildContextEntries()` 重新验证有效覆盖。

### 9.4 Note 协议

```ts
export interface ContextRolloverNote {
  version: 1;
  objective: { text: string; sourceEntryIds: string[] };
  userConstraints: Array<{ text: string; sourceEntryIds: string[] }>;
  decisions: Array<{ text: string; reason: string; sourceEntryIds: string[] }>;
  completedWork: Array<{
    text: string;
    todoIds: string[];
    evidenceEntryIds: string[];
  }>;
  currentState: { text: string; evidenceEntryIds: string[] };
  failedAttempts: Array<{ text: string; reason: string; evidenceEntryIds: string[] }>;
  nextAction: { text: string; evidenceEntryIds: string[] };
  historyRefs: Array<{ entryId: string; blockIndex?: number; purpose: string }>;
}
```

模型不得复制或改写 TodoState，也不得声明任务终态。

### 9.5 Evidence 规则

- objective 至少引用一条 user entry 或明确记录 user provenance 的 custom-user entry；
- userConstraints 的每项也必须满足同一来源要求；
- 文件已修改：至少引用成功写入 effect 和其后的目标状态读取/hash；
- 测试已通过：引用对应 process entry，必须有 exitCode=0 和命令指纹；
- 后台任务完成：引用 TaskManager completed terminal result；
- 用户确认：引用明确 user entry；
- Compaction、Rollover、Checkpoint 或其他 Session 边界只能证明边界发生，不能证明业务工作完成；
- toolResult 必须能解析到完整 Tool Transaction；
- 多文本块 historyRef 必须指定 blockIndex；指定后只授权该 block。

第二次及后续 rollover 的引用来源是“当前 Checkpoint 覆盖前缀 + 当前 Handoff 的 provenance closure”。provenance closure 只包含上一份 Note 已明确引用、且在真实 Session ancestor 中存在的 source/evidence/history entry；不得从完整旧历史任意新增引用。模型若仍需某个旧引用，必须在新 Note 中再次明确列出，系统不自动复制整份旧 allowlist。

每份 Note 的全部不同 entry 引用最多 64 个，其中 historyRefs 最多 32 个。超过上限判定 invalid_evidence，不截断。这样原始用户目标可以跨多个 epoch 保持可验证来源，同时引用集合不会无限增长。

Note 还必须通过 TypeBox 严格 schema、Secret 检查、引用存在性和 10% window 上限。失败正文不得写入有效 Checkpoint 或 Trace。

### 9.6 Checkpoint 持久化

有效 Checkpoint 使用 log-only `context-rollover-checkpoint` custom entry 保存。只选择当前 promptGeneration、contextEpoch、分支上覆盖范围最晚且仍有效的一条。它不直接进入 LLM context，也从 Context Maintenance 来源指纹中排除。

## 10. Rollover 启动界限

### 10.1 唯一入口

只有 `_handlePostAgentRun()` 收到以下终态时开始一次有终态的 Rollover 评估：

```text
ContextMaintenanceOutcome.outcome == blocked
AND trigger.continuation == required
AND terminalCapacityStop
AND eligibleMaintenanceFailure
AND taskIsIncomplete
```

`taskIsIncomplete` 只考虑容量中断、pending/in_progress Todo、未交付 steering 或 follow-up。next_prompt message 不表示当前任务需要自动继续。

第一版在门禁成立时默认启用，不增加手动强制入口。

### 10.2 原因矩阵

| Maintenance cause/reason | 评估 |
| --- | --- |
| budget_limit + methods_exhausted | 是 |
| budget_limit + no_progress | 是 |
| provider_overflow + methods_exhausted | 是 |
| provider_overflow + no_progress | 是 |
| provider_overflow + attempt_limit | 是 |
| verification_unknown | 否 |
| reduction_failed | 否 |
| extension_veto、superseded、cancelled | 否 |
| Provider、认证、网络、权限错误 | 否 |
| 正常 stop 后 threshold 整理 | 否 |

### 10.3 组装门禁

评估开始后必须同时满足：

- 没有前台 tool call；
- PendingInteractionRegistry 为空；
- TaskManager 没有 running/cancelling 的非 subagent task；内置子任务的委派来源、父任务关系和结果处理计划满足 [子 Agent 跨窗 Spec](subagent-context-rollover.md)，缺失时明确返回 subagent_handoff_invalid；
- 有有效 Checkpoint，或正在等待同 epoch 既有 Checkpoint；
- 当前 epoch 尚未 rollover；
- 当前 prompt rollover 次数少于 8；
- 第一次 rollover，或存在未消费 Strong Progress credit。

活动操作进入终态后重新测量，不取消、不复制。门禁失败返回明确 blocked reason，不静默跳过。

## 11. Handoff Bundle

```ts
export interface ContextRolloverBundle {
  version: 1;
  checkpointId: string;
  checkpointEntryId: string;
  promptGeneration: number;
  sourceContextEpoch: number;
  targetContextEpoch: number;
  note: ContextRolloverNote;
  activeTodosAtCommit: Array<{
    id: string;
    content: string;
    priority: "high" | "medium" | "low";
    status: "pending" | "in_progress";
  }>;
  todoStateEntryIdAtCommit: string | null;
  todoStateFingerprintAtCommit: string;
  activeEntryIds: string[];
  historyAllowlist: Array<{ entryId: string; blockIndex?: number }>;
  sourceFingerprint: string;
  progressBaselineFingerprint: string;
}
```

historyAllowlist 必须由 note.historyRefs 规范化派生，不能由调用方额外扩展。

### 11.1 Todo

`activeTodosAtCommit` 来自提交时最新 TodoState，只用于审计、CAS 和首次 PreparedContinuation。它不是长期恢复来源。

`buildSessionContext()` 以及 rollover 后每个 `prepareNextTurnWithContext` 必须根据当前分支最新 `todo-state` entry 重新生成唯一隐藏 Todo 投影，并替换旧投影。模型 Note 无权覆盖 TodoState。

如果没有 active Todo，Note.nextAction 仍必须非空；第一次 rollover 不因未使用 Todo 工具而被拒绝。后续 rollover 的 Strong Progress 规则仍适用。

### 11.2 Active Suffix

Active Suffix 基于提交前 `buildContextEntries()`：

- entry 顺序与当前 Session 分支一致；
- 应用已提交 Shake redaction；
- 不包含 trace、label、session_info、账本和普通 custom state；
- 从 Checkpoint 之后第一个完整 Tool Transaction 开始；
- 不与 Checkpoint 重叠，不使用 bridge；
- 每个 assistant tool-call group 必须有全部 terminal results；
- 当前每个有效 context entry 必须由 Checkpoint 或 Active Suffix 覆盖；
- token 不超过 context window 20%。

无法保持完整 Tool Transaction 时返回 `tool_transaction_incomplete`。完整 suffix 超过 20% 时不得截断，返回 `active_suffix_too_large`。

### 11.3 历史和 Memory

- Handoff 只注入 historyAllowlist，不注入旧正文；
- `history_get` 保留 Shake ancestor 读取，并允许最新 Handoff 精确授权的 entry/block；
- 指定 blockIndex 时不得读取同 entry 的其他 block；多块文本未指定 blockIndex 时拒绝；
- 没有被 Shake 或当前 Handoff 授权的普通历史不可见；
- 历史读取只返回落盘文本并保持分页上限，不执行工具、不恢复队列；
- memory_get/memory_search 的历史结果不可回放，必须查询当前 Memory 视图。

## 12. Durable Queue 与 PreparedContinuation

### 12.1 channel 语义

- steering：按 steeringMode 选择，在下一次 Provider Request 前交付；
- follow_up：只在 Agent 原本将停止时，按 followUpMode 选择；
- next_prompt：只随下一次显式新用户 prompt 注入，永不参与自动 Rollover continuation。

Rollover 不自行实现 drain 规则。Agent.prepareContinuation 使用与普通 Agent.continue 相同的选择逻辑。

### 12.2 Preparation

Context Rollover 先构建候选 session messages，再调用 `Agent.prepareContinuation()`。该调用：

1. 对真实未交付队列建立 revision；
2. 按当前 drain 规则预留第一次请求会消费的 deliveryIds；
3. 合并候选上下文和预留消息；
4. 执行 transformContext；
5. 执行 convertToLlm；
6. 应用 system、tools、model、thinking、append-only context 语义；
7. 使用真实 outputReserveTokens、thresholdPercent、reserveTokens 计算预算；
8. 缓存最终 Provider Context 并返回 opaque handle 摘要。

Preparation 不写 RolloverEntry、不写 delivery receipt、不发送 Provider 请求。期间新入队消息改变 queue revision，使提交 proposal superseded；提交完成后才到达的新消息留给后续请求，不改变已线性化的第一次请求。

### 12.3 预算提交条件

```text
preparedBudget.decision == fits
AND preparedBudget.tokens <= floor(contextWindow * 0.50)
AND preparedRequestFingerprint != sourceRequestFingerprint
AND preparedBudget.tokens < sourceBudget.tokens
```

Checkpoint Note 上限 10%，Active Suffix 上限 20%；第一次请求实际预留的队列消息已经包含在 50% 总上限内。任何子项不得静默截断。

### 12.4 Preview 与真实发送一致

Preview 展示 PreparedContinuation 的 budget 和 requestFingerprint。真实第一次请求必须调用 `dispatchPreparedContinuation()` 消费同一个 handle；不得重新执行 queue drain、transformContext、convertToLlm 或预算构造。

提交后重新 `buildSessionContext()`，比较 baseContextFingerprint、Todo/RequestConfig revision，并确认 reservedDeliveryIds 仍关联当前 dispatch 且未 receipt。提交之后新入队的消息允许改变当前 queue revision，但不得替换或插入已线性化的 reservedDeliveryIds；它们留给后续请求。匹配后发送缓存的 Provider Context。若不匹配，先追加 dispatch blocked entry，再释放 preparation 并返回 `blocked(committed=true, post_commit_mismatch)`；仅返回内存错误不足以阻止 resume 后错误发送。

## 13. 原子提交

### 13.1 Revision 集合

```ts
export interface ContextRolloverRevisions {
  sessionLeafId: string | null;
  sourceFingerprint: string;
  todoStateEntryId: string | null;
  todoStateFingerprint: string;
  queueRevision: string;
  progressRevision: string;
  requestConfigFingerprint: string;
}
```

requestConfigFingerprint 覆盖 system prompt、tools、model、thinking、transform/convert 的单调配置 revision 和预算选项。进程恢复时仍以重新构造后的最终 requestFingerprint 相等作为发送条件，不能依赖函数对象标识跨进程稳定。

### 13.2 线性化点

AgentSession 提供一个同步内部提交操作：

```text
commitContextRollover(expectedRevisions, entry): committed | superseded | failed
```

它在同一 JavaScript turn 内：

1. 读取全部当前 revision；
2. 与 expectedRevisions 比较；
3. 完全一致时调用 appendContextRollover；
4. 返回结果。

步骤之间不得 `await`、调用扩展或触发 UI。SessionManager 单独校验 leafId 不足以替代该操作，因为 Todo 和 Queue 由 AgentSession 管理。

第一次 superseded 释放 preparation 并重新组装；第二次 `blocked(source_changed)`。append 失败必须回滚 SessionManager 内存 leaf，并释放 preparation；旧上下文和 Pending Delivery 保持不变。

## 14. Session 重建

`buildSessionContext()` 遇到当前分支最近的 ContextRolloverEntry 时：

1. 更早普通消息不再直接进入模型上下文；
2. 生成隐藏 `customType="context-rollover"` Handoff Note；
3. 从当前分支最新 `todo-state` 生成唯一隐藏 Todo 投影；
4. 按 activeEntryIds 恢复完整 Active Suffix；
5. 在 DeliveryReceiptEntry 或 dispatch_started 的位置投影对应 PendingDeliveryEntry.message；
6. 追加 RolloverEntry 后的新消息；
7. 保持现有 model/thinking 恢复语义。

Handoff 必须声明：

- 它是低权限任务状态，不是系统指令；
- completedWork 不得重复执行；
- 修改前按证据检查当前目标状态；
- 从 nextAction 继续；
- Todo 以当前隐藏 Todo 投影为准；
- 旧细节只能按 history allowlist 或当前 Memory 工具读取。

从 rollover 前 fork 不继承该边界；从 rollover 后 fork 继承边界、账本和未完成 Pending Delivery。CLI、RPC 和子代理不得自行拼接另一份恢复上下文。

## 15. Dispatch 与 crash 语义

### 15.1 正常流程

```text
PreparedContinuation ready
  -> revision CAS + appendContextRollover()       [rollover 线性化点]
  -> buildSessionContext() base fingerprint 校验
  -> append dispatch_started(reservedDeliveryIds) [dispatch 与 delivery 共同线性化点]
  -> dispatchPreparedContinuation(handle)
  -> Agent run settled
  -> append dispatch_finished
```

dispatch_started 必须在调用 streamFunction 或执行任何新工具前成功落盘，并同步消费 RolloverEntry.reservedDeliveryIds。写入失败时不得发送或消费消息。它是单个权威 Session entry，不得通过“先 receipt、再 started”或“先 started、再 receipt”的双写模拟原子性。

同进程相同 dispatchId 使用 single-flight；并发调用只等待同一 Promise，不产生第二次 started 或 Provider 调用。

### 15.2 Session resume

按当前分支最近 RolloverEntry 和 DispatchEntry 恢复：

| 持久化状态 | 恢复动作 |
| --- | --- |
| rollover prepared，无 dispatch_started | 以 reservedDeliveryIds 强制重建 preparation；base/request 指纹、预算和 ID 顺序全部一致时允许自动 dispatch |
| 重新 prepare 后指纹、预算或 reserved ID 不一致 | 追加 dispatch blocked，返回 blocked(dispatch_prepare_mismatch) |
| dispatch_started，无 dispatch_finished | blocked(dispatch_outcome_unknown)，不得自动重放 |
| dispatch blocked/cancelled | 不再自动 dispatch，保留任务未完成语义 |
| dispatch_finished=completed | 不再 dispatch |
| dispatch_finished=context_limit | 进入对应 target epoch 的 Context Maintenance |
| dispatch_finished=aborted/failed | 保持未完成终态，不把 Rollover 当成成功完成 |

自动语义是 at-most-once，不是严格 exactly-once。`dispatch_started` 后 crash 可能发生在请求真正发出之前，也可能发生在 Provider 响应或副作用工具执行之后；没有事务性 Provider/工具幂等协议时无法区分。因此 started 未 finished 一律停止。

用户之后可以通过新的显式 prompt 检查文件、外部系统和 Session 证据，再决定是否继续；系统不得替用户猜测或自动重放。

### 15.3 Pending Delivery 结算

- 普通 continuation 在 Agent 发出 `queue_delivery`、且 Provider request 尚未开始时持久化 DeliveryReceiptEntry；随后由 message_start/message_end 投影消息，但不得再保存第二份正文；
- Rollover continuation 只有带 reservedDeliveryIds 的 dispatch_started 成功落盘后才算 delivered；不得为同一批消息再写 DeliveryReceiptEntry；
- Rollover 的 message_start/message_end 从 dispatch_started 派生，在第一次 Provider 调用之前结算；
- rollover preparation 释放时 delivery 仍为 pending；
- dispatch_started 后 outcome unknown 时，reserved delivery 保持关联于该 dispatch，不重新入队；
- 新显式用户 prompt 不自动清除这些不确定 delivery，CLI 必须提示检查。

## 16. Context Epoch 与持久化额度

固定上限：

```text
MAX_CHECKPOINT_OPERATIONS_PER_EPOCH = 2
MAX_SOFT_COMPACTION_OPERATIONS_PER_EPOCH = 3
MAX_OVERFLOW_RETRIES_PER_EPOCH = 1
MAX_ROLLOVERS_PER_EPOCH = 1
MAX_ROLLOVERS_PER_PROMPT = 8
```

规则：

- 新用户 prompt：promptGeneration + 1，contextEpoch = 0；
- rollover commit：promptGeneration 不变，contextEpoch + 1；
- 所有 operation 上限从当前分支 ContextOperationEntry 和 ContextRolloverEntry 重建；
- started 即消费额度，finished、失败、取消或 crash 不返还；
- TodoGate 的 maxFiresPerPrompt 不因 rollover 重置；
- Provider 常规 retry 规则不因 rollover 重置；
- 第 8 次 rollover 后再次满足容量门禁时返回 `blocked(rollover_limit)`；
- 新的显式用户 prompt 才能建立新的累计上限周期。

原 Context Maintenance Spec 中“单 prompt 最多 3 次 Soft Compaction”统一修订为“单 context epoch 最多 3 次”，并改为从持久化账本读取。不得保留只在内存计数的旧路径。

8 次是第一版固定安全预算：一个 prompt 最多经历 9 个 Context Epoch，足以覆盖长任务，同时给 Provider 调用和副作用执行提供确定上界。达到上限后保留 Todo 和 Session 证据，由用户通过新的显式 prompt 审核并决定是否继续。

## 17. Strong Progress

### 17.1 Weak Progress

以下事件可以进入诊断指纹，但不能单独获得下一次 rollover 资格：

- Todo content、priority 变化；
- pending -> in_progress；
- 新建 Todo；
- 普通 workspace-write 或目标 hash 变化；
- process/network/external 输出发生变化；
- assistant 文本、只读工具、Trace、Checkpoint、Compaction、Rollover。

### 17.2 Strong Progress credit

第一次 rollover 不要求 credit。第二次及以后必须存在至少一个在最近 RolloverEntry 之后产生且未被此前 rollover 消费的 credit：

1. **Todo milestone**：Todo ID 已存在于最近 RolloverEntry.activeTodosAtCommit，当前稳定为 completed；系统证据账本包含该 epoch 内发生在完成之前的成功 non-read effect，以及 effect 之后的成功验证证据。
2. **Background task milestone**：最近 rollover 后创建的 Task 进入 completed，且权威 ContextProgressEntry 记录非空 terminal result fingerprint；blocked/failed/cancelled 不计入。
3. **Verified acceptance transition**：同一验证目标从失败或未知变为成功，成功结果发生在对应 non-read effect 之后，并有稳定 verification target fingerprint。

creditId 由类别、稳定目标 ID 和 ContextProgressEntry evidenceIds 规范化哈希生成，写入 RolloverEntry.strongProgressCreditIds。一条 credit 只能消费一次。Checkpoint.completedWork 仍必须通过第 9.5 节的声明证据校验，但它不参与 Strong Progress 资格计算，避免真实进展发生在最后一次 Checkpoint 之后时被误判。

Todo 重命名、删除后重建、文件 hash 来回切换、重复命令和新建再立即完成的临时 Todo 都不能复用旧 credit。强进展仍是通用 Agent 能力下的保守判据；严格资源有界性由每 prompt 最多 8 次 rollover 保证。

### 17.3 Verification evidence

verification 不从模型文本或“输出发生变化”推断，只由以下确定事件生成：

- workspace-write 后，对同一规范化目标执行 read/stat，观测到当前 hash 与 effect 结果 hash 一致；
- non-read effect 后执行 process，进程正常退出且 exitCode=0，记录稳定 command fingerprint；
- network/external effect 后，通过同一工具 adapter 对同一目标进行成功 read-back，并记录目标和结果 fingerprint。

无法给出稳定目标、明确成功状态或后置顺序的工具结果只记为 Weak Progress。verification entry 只保存哈希和关联 ID，原始命令与结果仍留在原 Session message 中。

## 18. 并发与取消

- Checkpoint 与 two-pass compaction 共用一个后台总结槽；同时只能有一个模型总结操作。
- 同一个 AgentSession 同时最多一个 Rollover operation 和一个未结算 PreparedContinuation。
- 相同 source fingerprint 共享 Rollover Promise；不同来源等待后重新测量。
- prepare 前后的 Session、Todo、Queue、Progress 或 RequestConfig 变化在提交前都通过 revision CAS 发现。
- 用户 abort 取消未提交的 Checkpoint/Rollover，释放 preparation；已提交但未 started 时必须先追加 dispatch cancelled entry，RolloverEntry 不删除。
- dispatch_started 后 abort 通过 Agent 正常结算为 aborted；若在落盘 finished 前 crash，则按 outcome unknown 处理。
- PendingInteraction 未解决时不得把未获得授权写入 Handoff。
- running/cancelling 的非 subagent Task 必须先到终态；已交接内置子任务可使用原 TaskManager 跨窗运行，Rollover 不取消或重建任务。父工具批次、版本比较、正文恢复覆盖和预算门禁继续有效。

## 19. 失败原因

```ts
export type ContextRolloverCheckpointReason =
  | "below_prefire_threshold"
  | "operation_limit"
  | "operation_in_flight"
  | "no_complete_tool_transaction"
  | "provider_failed"
  | "authorization_failed"
  | "wall_clock_exhausted"
  | "invalid_output"
  | "invalid_evidence"
  | "unsafe_content"
  | "note_too_large"
  | "source_changed";

export type ContextRolloverBlockedReason =
  | "ineligible_maintenance_reason"
  | "continuation_forbidden"
  | "task_complete"
  | "operation_in_flight"
  | "rollover_already_used"
  | "rollover_limit"
  | "checkpoint_missing"
  | "checkpoint_invalid"
  | "tool_transaction_incomplete"
  | "active_suffix_too_large"
  | "handoff_invalid"
  | "subagent_handoff_invalid"
  | "source_changed"
  | "todo_changed"
  | "queue_changed"
  | "request_config_changed"
  | "no_strong_progress"
  | "invalid_continuation_context"
  | "prepared_context_limit"
  | "prepared_over_half_window"
  | "unchanged_request"
  | "post_commit_mismatch"
  | "dispatch_prepare_mismatch"
  | "dispatch_outcome_unknown";

export type ContextRolloverWarning = "trace_write_failed" | "ui_notification_failed";
```

`dispatch_outcome_unknown` 覆盖该 Agent run 中 Provider 和副作用工具的不确定结果。它是任务未完成的安全终态，不映射为 completed，也不触发自动 retry。

## 20. Trace、CLI、RPC 与子代理

新增 `context/rollover` 事件，最少包含：

```ts
{
  type: "context/rollover";
  data: {
    rolloverId: string;
    checkpointId?: string;
    dispatchId?: string;
    turn: number;
    promptGeneration: number;
    sourceContextEpoch: number;
    targetContextEpoch?: number;
    phase: "checkpoint" | "rollover" | "preparation" | "dispatch";
    outcome:
      | "entered"
      | "waiting"
      | "committed"
      | "discarded"
      | "prepared"
      | "started"
      | "finished"
      | "blocked"
      | "cancelled"
      | "outcome_unknown";
    sourceRequestFingerprint?: string;
    preparedRequestFingerprint?: string;
    sourceTokens?: number;
    preparedTokens?: number;
    reservedDeliveryCount?: number;
    strongProgressCreditCount?: number;
    reasonCode?: ContextRolloverBlockedReason | ContextRolloverCheckpointReason;
  };
}
```

要求：

- Trace 能还原 checkpoint、rollover、preparation、dispatch started/finished 顺序；
- 权威状态始终来自 Session entry，Trace 丢失不能改变恢复结果；
- Trace 不含 Note、Todo、Pending Delivery、Active Suffix、工具参数/结果、Memory 或系统提示词正文；
- `/trace` 显示 epoch、rollover 次数、预算前后值、dispatch 状态和停止原因；
- CLI 对 dispatch outcome unknown 明确显示“Provider 或工具结果未知，未自动重放，需要检查外部状态”；
- RPC get_state 暴露 contextEpoch、rolloverCount、dispatchState 和最终 context_limit，不提供绕过门禁的推进命令；
- 子代理只有真正完成 submit_subagent_result 才能 completed；unknown、blocked、context_limit 均保持未完成。

## 21. 代码改动范围

### 21.1 新增

- `packages/agent/src/prepared-continuation.ts`
- `packages/agent/test/prepared-continuation.test.ts`
- `packages/coding-agent/src/core/context-rollover.ts`
- `packages/coding-agent/src/core/pending-delivery.ts`
- `packages/coding-agent/test/suite/context-rollover-policy.test.ts`
- `packages/coding-agent/test/suite/context-rollover-checkpoint.test.ts`
- `packages/coding-agent/test/suite/context-rollover-handoff.test.ts`
- `packages/coding-agent/test/suite/context-rollover-queue.test.ts`
- `packages/coding-agent/test/suite/context-rollover-dispatch.test.ts`
- `packages/coding-agent/test/suite/context-rollover-persistence.test.ts`

### 21.2 修改

- `packages/agent/src/agent.ts`
  - 普通 continue 改为统一 PreparedContinuation 路径；
  - 队列预留、释放和第一次请求固定化。
- `packages/agent/src/agent-loop.ts`
  - 支持第一次请求消费已准备 Provider Context，之后恢复正常 loop。
- `packages/coding-agent/src/core/agent-session.ts`
  - Checkpoint prefire 和等待；
  - Pending Delivery 持久化和恢复；
  - 唯一 rollover 入口、revision CAS、dispatch journal；
  - 每轮刷新当前 Todo 投影。
- `packages/coding-agent/src/core/session-manager.ts`
  - 新 Session entry 类型；
  - Rollover、Pending Delivery、receipt、账本和 dispatch 重建语义。
- `packages/coding-agent/src/core/messages.ts`
  - 隐藏 Handoff 和当前 Todo 投影。
- `packages/coding-agent/src/core/compaction/context-maintenance.ts`
  - epoch 预算由持久化 operation ledger 构建；方法顺序不变。
- `packages/coding-agent/src/core/tools/history-get.ts`
  - 最新 Handoff 的 entry/block allowlist。
- `packages/coding-agent/src/core/trace.ts`
- `packages/coding-agent/src/extensions/trace/index.ts`
- `packages/coding-agent/src/modes/rpc/rpc-types.ts`
- `packages/coding-agent/docs/specs/context-maintenance-state-machine.md`
- `packages/agent/CHANGELOG.md`
- `packages/coding-agent/CHANGELOG.md`

不得保留旧 direct continuation、内存权威额度、文本队列镜像作为业务事实或单 tool-call bridge。

## 22. 测试规范

### 22.1 通用要求

- 使用 faux provider、临时 Session 文件和确定性时钟/ID factory；
- 不调用真实 Provider，不读取真实认证，不消耗付费 token；
- PreparedContinuation 测试通过 Agent 公共接口，不读取内部缓存的 Provider Context；
- Context Rollover 测试通过模块接口和 AgentSession 可观察结果，不断言私有游标；
- 并发和 crash window 使用 barrier/deferred promise，不使用长 sleep；
- resume 测试必须销毁原 Agent/AgentSession/SessionManager，再从 JSONL 创建新实例；
- 每个集成测试断言 Provider 请求次数、首次请求指纹、工具次数、Session entry、队列 receipt、Trace 和 runState；
- Trace 安全测试扫描序列化 JSONL，确认正文和凭据不进入 Trace event。

### 22.2 PreparedContinuation 测试

| ID | 场景 | 必须断言 |
| --- | --- | --- |
| PC01 | 无队列的普通 continue | Preview 指纹等于第一次真实 Provider Request 指纹 |
| PC02 | 最后消息为 assistant 且有 steering | 按 steeringMode 预留，真实请求包含同一批消息 |
| PC03 | 最后消息为 assistant、无 steering、有 follow-up | 按 followUpMode 预留同一批消息 |
| PC04 | 最后消息为 user/toolResult 且有 steering | 初始 poll 的 steering 已进入 PreparedContinuation |
| PC05 | 最后消息非 assistant 且只有 follow-up | 第一次请求不提前消费 follow-up |
| PC06 | queue mode 分别为 one-at-a-time/all | 预留数量与现有语义一致 |
| PC07 | 图片、custom message、同文本不同图片 | 完整语义载荷产生不同指纹 |
| PC08 | transformContext 会改变消息 | 只执行一次，Preview 与真实请求一致 |
| PC09 | convertToLlm 会改变消息 | 只执行一次，Preview 与真实请求一致 |
| PC10 | append-only context 开启 | Prepared budget/fingerprint 与真实第一次请求一致 |
| PC11 | preparation release | 消息恢复队头、顺序不变、无 receipt |
| PC12 | 同时请求第二个 preparation | 相同 base/queue revision 共享；不同来源明确拒绝；不出现两个 reservation |
| PC13 | dispatch 同一个 handle 两次 | 第二次拒绝，Provider 只调用一次 |
| PC14 | 普通 Agent.continue | 内部也走 prepare + dispatch，不存在旧发送路径 |
| PC15 | append-only preparation 被 release | 缓存前缀和已发送游标不改变 |
| PC16 | resume 使用 requiredQueueItemIds | 只预留指定 ID；缺失、已 receipt 或顺序不符时拒绝 |
| PC17 | 最终转换后没有消息或最后角色不可 continuation | prepare 明确失败，Provider 不调用 |

### 22.3 Durable Queue 测试

| ID | 场景 | 必须断言 |
| --- | --- | --- |
| DQ01 | enqueue steering/follow-up/next_prompt | PendingDeliveryEntry 先于内存入队完成 |
| DQ02 | crash 后恢复未交付消息 | channel、完整正文和顺序一致 |
| DQ03 | 已有 DeliveryReceiptEntry 或引用该 ID 的 dispatch_started 后恢复 | 不重新入队、不重复投影 |
| DQ04 | 普通 delivery 被 Agent 接收 | receipt 位于 Provider 请求前，context 只出现一次正文 |
| DQ05 | next_prompt 存在时 rollover | 不进入第一次 continuation，不使当前 taskIsIncomplete |
| DQ06 | rollover prepare 后、commit 前新 steering | queue revision 变化，proposal superseded |
| DQ07 | commit 后、dispatch 前新 steering | 不改变已准备请求，留到后续 Agent turn |
| DQ08 | preparation 被释放 | 所有 reserved delivery 恢复 pending |
| DQ09 | dispatch outcome unknown | reserved delivery 不重新入队，CLI 显示需检查 |

### 22.4 启动策略测试

| ID | 场景 | 必须断言 |
| --- | --- | --- |
| TG01 | budget_limit + methods_exhausted + required | 开始 rollover 评估 |
| TG02 | budget_limit + no_progress + required | 开始 rollover 评估 |
| TG03 | provider_overflow + attempt_limit + required | 开始 rollover 评估 |
| TG04 | 正常 stop 后 threshold 整理 | 不评估 rollover |
| TG05 | continuation forbidden | 不评估 rollover |
| TG06 | verification_unknown/reduction_failed | 不评估 rollover |
| TG07 | extension_veto/superseded/cancelled | 不评估 rollover |
| TG08 | Provider/auth/network/permission 错误 | 不评估 rollover |
| TG09 | 只有 next_prompt pending | 不视为当前任务未完成 |
| TG10 | 前台工具或 PendingInteraction 活动 | 不提交，稳定后重新测量 |
| TG11 | TaskManager running/cancelling | 非 subagent 继续等待；已交接内置子任务不等待终态，缺失交接明确失败；均不因换窗取消任务 |
| TG12 | 当前 epoch 已 rollover | blocked(rollover_already_used) |
| TG13 | 当前 prompt 已 8 次 rollover | blocked(rollover_limit) |

### 22.5 Checkpoint 测试

| ID | 场景 | 必须断言 |
| --- | --- | --- |
| CP01 | 未达到 prefirePercent | 不创建 operation、不调用模型 |
| CP02 | 首次达到 prefirePercent | 先写 started，再调用模型并提交有效 Checkpoint |
| CP03 | 未覆盖 delta 达到 10% | 最多刷新一次 |
| CP04 | 单 epoch 第 3 次请求 | 从持久化账本拒绝，不调用模型 |
| CP05 | provider failed/timeout/invalid JSON | started 额度不返还，无有效 Checkpoint |
| CP06 | crash 于 started 后 | resume 后仍计入额度 |
| CP07 | objective/currentState/nextAction 为空 | invalid_output |
| CP08 | objective 只引用 assistant | invalid_evidence |
| CP09 | user constraint 只引用普通 custom | invalid_evidence |
| CP10 | completedWork 只引用 Session 边界 | invalid_evidence |
| CP11 | “测试通过”引用非零退出命令 | invalid_evidence |
| CP12 | 证据不存在或超出覆盖前缀 | invalid_evidence |
| CP13 | 覆盖结束点位于多 tool-call transaction 中部 | no_complete_tool_transaction |
| CP14 | 生成期间只追加完整尾部 transaction | 前缀仍有效，允许提交 |
| CP15 | 被覆盖前缀/Todo/request config 变化 | discarded(source_changed) |
| CP16 | Note 超过 10% 或命中 Secret | 不持久化正文，Trace 不泄漏 |
| CP17 | Maintenance blocked 时同 epoch Checkpoint 正在运行 | 等待同一 operation，不新增模型请求 |
| CP18 | 既有 operation 等待后成功/失败 | 成功重新评估；失败 checkpoint_missing |
| CP19 | Checkpoint 与 two-pass 同次首次满足 prefire | Checkpoint 先取得共享槽；已有 two-pass 不被取消 |

### 22.6 Handoff、Todo、Tool Transaction 与历史测试

| ID | 场景 | 必须断言 |
| --- | --- | --- |
| HB01 | Todo 同时含四种状态 | commit 快照只含 pending/in_progress，Store 不变 |
| HB02 | Note 中描述与 TodoState 冲突 | 当前 TodoState 投影胜出 |
| HB03 | rollover 后 Todo 状态变化 | 下一 Provider turn 投影最新状态，不保留旧投影 |
| HB04 | rollover 后 Todo 变化再 crash/reload | 从最新 todo-state 重建，不使用 bundle 快照 |
| HB05 | 无 active Todo、nextAction 有效 | 允许第一次 rollover |
| HB06 | Checkpoint 后是普通完整 transaction | Active Suffix 完整、有序、不重叠 |
| HB07 | assistant 含两个 tool calls 和两个 results | 四者作为一个 Tool Transaction 保留 |
| HB08 | Checkpoint 试图覆盖 assistant + 第一个 result | Checkpoint 无效，不构造 bridge |
| HB09 | Compaction 后首个有效 entry 落在 transaction 内 | blocked(tool_transaction_incomplete) |
| HB10 | 完整 transaction 使 suffix 超过 20% | blocked(active_suffix_too_large)，不截断 |
| HB11 | preview 总预算 fits 且 <=50% | 允许提交 |
| HB12 | queue 加入后总预算超过 50% | prepared_over_half_window，不提交 |
| HB13 | prepared 指纹等于 source | unchanged_request |
| HB14 | history_get 读取 Handoff 精确 allowlist block | 只返回该 block，保持分页，不执行工具 |
| HB15 | history_get 请求同 entry 未授权 block | 明确拒绝 |
| HB16 | history_get 请求未 Shake 且未 allowlist entry | 明确拒绝 |
| HB17 | Memory 历史结果被引用 | 拒绝回放，要求查询当前 Memory |
| HB18 | 第二次 rollover 继续引用原始 user entry | 只有上一 Handoff provenance closure 已授权时通过 |
| HB19 | 新 Note 任意引用未授权旧 ancestor 或引用数超限 | invalid_evidence，不扩大 allowlist |

### 22.7 原子提交测试

| ID | 场景 | 必须断言 |
| --- | --- | --- |
| AC01 | revisions 全部相同 | 只追加一个 RolloverEntry |
| AC02 | session leaf/source 变化 | superseded，无 entry、释放 preparation |
| AC03 | Todo revision 变化 | superseded，无陈旧 Todo commit |
| AC04 | Queue revision 变化 | superseded，新消息参与第二次 prepare |
| AC05 | Progress revision 变化 | superseded，重新计算 credit |
| AC06 | RequestConfig 变化 | superseded，重新构造真实请求 |
| AC07 | 第一次 superseded 后再次变化 | blocked(source_changed) |
| AC08 | append 持久化失败 | leaf 回滚、队列仍 pending、Provider 未调用 |
| AC09 | CAS 与 append 之间注入 mutation hook | 没有可运行 hook/await，提交保持线性化 |

### 22.8 Dispatch 与恢复测试

| ID | 场景 | 必须断言 |
| --- | --- | --- |
| DR01 | 正常 ready | RolloverEntry -> started(reserved IDs) -> Provider -> finished 顺序固定，且无重复 receipt |
| DR02 | started 写入失败 | Provider 和工具调用均为 0 |
| DR03 | 两个并发 dispatch 相同 dispatchId | 一个 started、一个 Provider 调用，其余共享结果 |
| DR04 | crash 于 RolloverEntry 后、started 前 | resume 重建 preparation；指纹一致才自动发送一次 |
| DR05 | resume 重建 preparation 指纹/预算/reserved ID 变化 | 持久化 dispatch_prepare_mismatch，不发送 |
| DR06 | crash 于 started 后、Provider 调用前 | dispatch_outcome_unknown，不自动重放 |
| DR07 | crash 于 Provider 响应后、finished 前 | dispatch_outcome_unknown，不自动重放 |
| DR08 | crash 于副作用工具执行后、结果持久化前 | tool/dispatch outcome unknown，不重放工具 |
| DR09 | finished=completed 后 resume | 不再 dispatch |
| DR10 | finished=context_limit | 只进入 target epoch 的维护流程 |
| DR11 | committed 后 base fingerprint 不匹配 | post_commit_mismatch，释放 preparation，不发送 |
| DR12 | committed 后、started 前用户取消 | 持久化 dispatch cancelled，resume 不发送 |

### 22.9 Strong Progress 和额度测试

| ID | 场景 | 必须断言 |
| --- | --- | --- |
| PG01 | 第一次 rollover | 不要求 credit |
| PG02 | 只有 Todo 文案/priority 变化 | no_strong_progress |
| PG03 | pending -> in_progress 或新建临时 Todo | no_strong_progress |
| PG04 | 只有普通 write/hash 变化 | no_strong_progress |
| PG05 | 文件状态 x->y->x | 不产生可复用 credit |
| PG06 | 不同 process/network 输出但无验证 | no_strong_progress |
| PG07 | 上一 bundle 中 Todo completed + effect + 后置验证 | 生成一个 Todo milestone credit |
| PG08 | completedWork 缺 effect 或后置验证 | 不生成 credit |
| PG09 | completed background Task 有权威 terminal result fingerprint | 生成一个 Task credit |
| PG10 | failed/blocked/cancelled Task | 不生成 credit |
| PG11 | 同一 credit 已被前次 rollover 消费 | 不可再次使用 |
| PG12 | 每段均有 Strong Progress 但达到第 8 次 | 下一次仍 blocked(rollover_limit) |
| PG13 | crash/reload 后 | 已消费 credit 和全部 operation 次数不重置 |
| PG14 | effect 后同目标 read-back hash 一致 | 生成 verification evidence |
| PG15 | process 非零退出或 external 无 read-back | 只有 Weak Progress |
| PG16 | 第 3 次 Soft Compaction started 后 crash | resume 后仍耗尽，不启动第 4 次 |
| PG17 | overflow retry started 后 crash | resume 后仍耗尽，不启动第二次 |

### 22.10 Session、Trace 和协议集成测试

| ID | 场景 | 必须断言 |
| --- | --- | --- |
| IT01 | Maintenance blocked -> rollover -> dispatch | epoch+1，首次 Provider payload 等于 prepared payload |
| IT02 | rollover 后继续修改文件 | 旧工具不重放，新工具按正常 loop 执行 |
| IT03 | 多次 rollover 和 Session reload | 只使用当前分支最近边界，Todo/queue/额度一致 |
| IT04 | 从 rollover 前/后分别 fork | 前分支不继承；后分支继承边界和账本 |
| IT05 | Trace 写入失败 | 权威状态和恢复结果不变，仅产生 warning |
| IT06 | Trace 安全扫描 | 不含 Note/Todo/queue/tool/Memory/system 正文或凭据 |
| IT07 | CLI /trace | 显示 checkpoint、epoch、次数、预算、dispatch 终态 |
| IT08 | RPC get_state | 暴露只读状态，不可强制推进 |
| IT09 | 子代理出现 context_limit/unknown | 保持未完成，不能提交 completed result |
| IT10 | 正常完成回答但 Todo pending | 不因 Rollover 绕过 TodoGate 规则自动续跑 |

## 23. 验收标准

### 23.1 触发与上下文

- [ ] Context Maintenance 方法顺序不变，Rollover 位于 eligible blocked 之后。
- [ ] Checkpoint 在容量耗尽前启动；blocked 时只等待既有同 epoch operation。
- [ ] next_prompt 不触发或进入自动 continuation。
- [ ] Checkpoint 与 Active Suffix 不切开 Tool Transaction，且不再存在 bridge。
- [ ] 当前有效上下文覆盖完整；Active Suffix 超过 20% 时不截断。
- [ ] 当前 Todo 投影来自最新持久化 TodoState，bundle 快照只用于审计。
- [ ] history_get 严格执行 entry/block allowlist。

### 23.2 请求、提交和恢复

- [ ] Preview 和真实第一次 Provider Request 使用同一 PreparedContinuation。
- [ ] queue drain、transformContext、convertToLlm 和 append-only 语义不会在 dispatch 时重跑。
- [ ] steering/follow-up 消息跨 resume 不丢失、不重复；next_prompt 保持原语义。
- [ ] 新请求总输入不超过 context window 50%，且指纹与 source 不同。
- [ ] revision CAS 与 appendContextRollover 构成无 await 的单一线性化点。
- [ ] 所有操作额度、rollover 次数、Pending Delivery 和 dispatch 状态可从 Session 重建。
- [ ] dispatch started 无 finished 时 fail closed，不自动重放 Provider 或工具。
- [ ] 文档和代码不声称跨进程严格 exactly-once。

### 23.3 防循环与安全

- [ ] Todo 改文案、普通 write 和变化输出不能获得 Strong Progress credit。
- [ ] 后续 rollover 必须消费新 Strong Progress credit。
- [ ] 每个用户 prompt 最多 8 次 rollover，达到后确定停止。
- [ ] objective 和 userConstraints 有真实用户来源。
- [ ] Session 边界不能作为普通 completedWork 证据。
- [ ] Handoff 不扩大系统指令、权限或授权。
- [ ] Trace 不承担权威恢复职责且不泄漏正文。
- [ ] blocked、unknown 和 context_limit 始终表示任务未完成。

### 23.4 确定性成本

| 指标 | 上限 |
| --- | --- |
| 单 epoch Checkpoint operation | 2 |
| 单 epoch Soft Compaction operation | 3 |
| 单 epoch overflow retry | 1 |
| 单 epoch rollover commit | 1 |
| 单 prompt rollover commit | 8 |
| 单 source supersede 重组 | 1 |
| 单 dispatchId 自动 Provider dispatch | 1 |
| Rollover 后首次请求占 window | 50% |
| Checkpoint Note 占 window | 10% |
| Active Suffix 占 window | 20% |

## 24. 实施顺序

| 阶段 | 工作 | 阶段出口 |
| --- | --- | --- |
| S0 | 固化 PreparedContinuation、Tool Transaction、revision、progress 纯规则测试 | 测试按缺失能力失败 |
| S1 | 在 packages/agent 实现 PreparedContinuation，并用它替换普通 continue 路径 | PC01-PC17 通过，无 direct continuation 分支 |
| S2 | 增加 Pending Delivery/Receipt 和恢复逻辑 | DQ01-DQ09 通过，文本镜像不再是业务事实 |
| S3 | 增加 ContextOperation/Rollover/Dispatch entry 与 Session 重建 | quota、fork、resume 基础测试通过 |
| S4 | 实现 Checkpoint schema、证据和完整 Tool Transaction 边界 | CP01-CP19 通过 |
| S5 | 实现 context-rollover 深模块、Handoff、动态 Todo、history allowlist | HB/TG 测试通过 |
| S6 | 接入 PreparedContinuation、revision CAS 和预算门禁 | AC/IT01 通过 |
| S7 | 接入 dispatch journal、crash 恢复和 fail-closed unknown | DR01-DR12 通过 |
| S8 | 接入 Strong Progress credit 和每 prompt 8 次硬上限 | PG01-PG17 通过 |
| S9 | 接入 Trace、CLI、RPC、子代理终态 | IT05-IT10 通过 |
| S10 | 删除旧计数、direct continuation、bridge 和文本队列事实路径 | 搜索确认不存在双路径 |
| S11 | 修订 Maintenance Spec/CHANGELOG，执行定向和完整离线回归 | 所有证据落盘 |

## 25. 测试命令

在 `packages/agent` 目录运行：

```bash
node ../../node_modules/vitest/dist/cli.js --run \
  test/prepared-continuation.test.ts \
  test/agent.test.ts \
  test/agent-loop.test.ts \
  test/append-only-context.test.ts
```

在 `packages/coding-agent` 目录运行：

```bash
node ../../node_modules/vitest/dist/cli.js --run \
  test/suite/context-rollover-policy.test.ts \
  test/suite/context-rollover-checkpoint.test.ts \
  test/suite/context-rollover-handoff.test.ts \
  test/suite/context-rollover-queue.test.ts \
  test/suite/context-rollover-dispatch.test.ts \
  test/suite/context-rollover-persistence.test.ts \
  test/suite/context-maintenance-state-machine.test.ts \
  test/suite/agent-session-compaction.test.ts \
  test/suite/context-budget-integrity.test.ts \
  test/suite/agent-session-trace.test.ts \
  test/suite/agent-session-runtime.test.ts \
  test/rpc-prompt-response-semantics.test.ts \
  test/suite/grok-alignment/subagent-task-tool.test.ts
```

代码实现完成后在仓库根目录运行：

```bash
npm run check
bash ./test.sh
```

不得直接运行未经隔离的完整 Vitest。Windows 无法执行 `bash ./test.sh` 时必须记录为未验证，不能用定向测试代替完整离线回归。

## 26. 交付证据

实现交付必须包含：

- 实际修改文件清单；
- 每个测试 ID 到具体测试名称的映射；
- PreparedContinuation 的 preview/actual fingerprint 相等证据；
- 有队列、transformContext 和 append-only context 的首次请求一致性证据；
- revision CAS 并发 mutation 被拒绝的证据；
- Checkpoint attempt 和维护额度 crash/reload 后不重置的证据；
- dispatch started 无 finished 后不自动重放的证据；
- 动态 Todo reload 后不回退的证据；
- 多 tool-call transaction 不被切开的证据；
- 无 Strong Progress 和第 9 次 rollover 被停止的证据；
- Provider、工具和 delivery receipt 次数断言；
- Trace 正文与凭据扫描结果；
- `npm run check`、全部定向测试和 `bash ./test.sh` 的实际输出；
- 所有未执行项和环境限制，不得计为通过。
