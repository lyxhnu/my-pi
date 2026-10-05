# 子 Agent 超时监督与执行交接 Spec

> 历史规范（2026-09）：当前实现已删除 worker、整体期限、复审、replace/takeover 和 worktree 发布控制；当前契约见 [Subagents](../subagents.md)。本文的待确认项及验收矩阵属于旧方案。

| 项目 | 内容 |
| --- | --- |
| 状态 | 运行时、确定性及三组 gpt-5.5 / low 真实模型验证完成；能力边界待确认，详见实施报告 |
| 日期 | 2026-09-26 |
| 适用范围 | coding-agent 内置 subagent 的监督、查询、取消、替换、接管和跨窗口交接 |
| 核心决定 | 工具级超时由子 Agent 处理；委派级复查由主 Agent 决策；明确的执行上限由 harness 执行 |
| 交付要求 | 有界且可追溯的决策材料、有限执行授权、真实停止确认、幂等替换、可恢复的父任务关系 |

本文中的“必须”是实现和验收要求，“不得”是禁止行为。工具参数按此协议实现；验收状态以[实施报告](subagent-timeout-supervision-implementation-report.md)为准。

## 1. 问题与目标

现有实现将等待超时与子任务执行分开：前台 task 最多等待 600 秒，get_task_output 可等待指定时长，但等待到期不会停止子任务。主模型通常只能看到 running/no output yet，不能取得足够的进展材料；取消是协作式请求，不保证不响应取消的执行已经停止。

本规范解决以下问题：

1. 主 Agent 不接收子 Agent 的完整轨迹，仍能判断继续等待、取消、调整委派或接手。
2. 超时报告不依赖已经卡住的子 Agent 临时生成摘要。
3. 主模型没有响应时，子执行仍受已授予的期限约束。
4. 重派和接手不能仅凭旧快照启动冲突执行。
5. 取消、自然完成、结果应用、响应丢失与重复请求有明确裁决。
6. 多子任务通知受单次请求总预算约束，并保持未读信息可发现。
7. 父 Agent 换窗不重启子执行、重置期限或丢失委派语义。

不实现通用自动重试、自动换模型、通用副作用回滚、语义重复任务识别或跨宿主重启后的执行恢复。主模型的业务判断不被宣称为确定正确。

## 2. 责任划分

| 责任 | 所属 |
| --- | --- |
| 一次模型请求或工具的操作期限、错误返回 | 该操作的执行层 |
| 工具错误之后的局部处理 | 子 Agent，在剩余委派授权内决定 |
| 时间、阶段、进程、调用结果、控制版本 | harness |
| 当前进展、下一步和明确阻塞的短摘要 | 子 Agent 提交，harness 限长、存证 |
| 继续等待、改变委派、接手的业务选择 | 主 Agent |
| 执行上限、停止、发布资格和替换原子操作 | harness |
| 结果是否满足用户目标、证据是否足够 | 主 Agent；必要时依赖用户或外部事实 |

活动不等于进展；进展自述不等于验证通过。harness 不得根据 token 数、工具次数或心跳推断“任务正在有效推进”。

## 3. 身份、版本与保证边界

### 3.1 委派和执行

- delegationId：一项逻辑委派及其执行授权。首次创建时取首个 taskId，替换后不变。
- taskId：一次实际执行的身份。沿用当前 TaskManager 的任务 ID 语义；每次替换产生新 taskId，旧记录保持可查询。
- currentTaskId：该 delegation 当前执行，或最近一次已结束执行。
- operationId：一次控制意图的幂等标识。
- owner：父 session、当前分支上规范委派来源及其 taskScopeId。沿用真实 toolCallId/sourceEntryId；rootPromptId 可用于关联，不作为唯一归属依据。

一次显式 replace 只能生成一个后继 taskId。一次委派同一时刻最多有一个可执行的子 attempt；旧 attempt 已停止但待查询的记录不算活跃执行。

成功 completed、takeover、父 taskScope 关闭或执行预算耗尽后，不再允许在该 delegation 下启动子执行。普通 cancel 只停止当前 attempt；主 Agent 之后仍可在原授权有效且有剩余预算时显式 replace。该资格由监督者保存和检查，不能只根据旧 attempt 的 cancelled 状态推导。

子执行授权的关闭及原因随 controlRevision 原子更新。wait、新用户输入或幂等重放不能重新打开它；再次 replace 返回 delegation_closed。

新的独立 task 不自动被判断为旧工作的重试。通过任意新 prompt 创建语义相同任务的识别不在本规范中；若要限制父 Agent 总资源，必须另有父执行预算，不能声称单个 delegation 的上限覆盖了所有新任务。

### 3.2 三类版本

| 版本 | 变化时机 | 用途 |
| --- | --- | --- |
| controlRevision | 当前执行者、控制操作占位、停止状态、终态、发布资格、影响接续安全的效果状态改变 | 控制操作的原子前置条件 |
| progressSeq | 阶段改变、checkpoint 接收、操作结果更新 | 报告和事件的新鲜度 |
| ownerRevision | 新用户输入或宿主明确变更当前任务约束 | 使基于旧用户上下文的控制决定失效 |

token、心跳、时钟流逝不得递增 controlRevision。阶段和普通 checkpoint 更新不得让持续活跃的任务永远无法被取消或替换。真实执行动作仍需检查最新终态、提交状态及剩余期限。

用户的新消息使旧决定需要重新确认，不自动认定原子任务已被撤销；语义适用性由主 Agent 结合最新需求判断。正常换窗不增加 ownerRevision。

### 3.3 本规范可以保证什么

harness 保证通过正式控制接口执行的取消、替换和接管遵守本规范，并在接管成功后拒绝旧 attempt 的迟到发布。

本规范不声称能够识别主 Agent 任意 Bash 与子 Agent 是否在语义上重复同一项工作。主模型必须通过 takeover 接管明确委派的可写工作；仅有这一协议不能证明任意共享工作区写入绝不冲突。现有隔离方式的写入范围必须如实反映，不能用状态字段冒充文件系统隔离。

## 4. 时间语义和授权

### 4.1 四种时限

| 名称 | 到期动作 |
| --- | --- |
| query wait | 结束本次 get_task_output 等待，返回快照；不改变监督安排或执行状态 |
| review window | 生成一次 review_due，交回主 Agent 判断；不自动取消 |
| execution deadline | harness 请求停止；不依赖主模型此刻能否响应 |
| cancellation grace | 协作式停止未完成时，终止受管理的本地执行并等待退出证据 |

操作自身的超时仍由子 Agent 内部处理，不因一次工具失败就自动唤醒父模型；明确的子任务阻塞、任务终态及监督事件才进入父监督流程。

### 4.2 参数及来源

- task 创建必须显式提供 execution_budget_ms，单位毫秒，必须是有限正整数。
- 宿主必须提供有限的 subagents.maxExecutionMs；创建请求不得超过它，也不得超过已有父执行期限。
- 宿主未提供执行上限时，创建返回 subagent_policy_missing，不以旧的无限执行路径继续。
- review_after_ms 默认 600000；它仅是初始复查间隔，不能用来判断任务应该多久完成。
- 初始及显式继续等待的复查间隔必须为有限正整数，至少为 minReviewIntervalMs。实际检查时间截取到原 deadline；剩余时间不足该最小间隔时也不增加预算。minReviewIntervalMs 初始值为 30000，由宿主配置。
- cancellationGraceMs 初始值为 5000，由宿主配置，模型不得通过工具参数放大它。
- query wait 可为 0，表示立即查询；它没有续期含义。

600 秒、30 秒和 5 秒是可配置的初始工程参数，不是经过实测的最优值。执行总预算没有隐式的 600 秒默认值，由任务请求和宿主上限明确确定。

### 4.3 计时与继承

先登记 delegation 和首个 task，再开始 setup。使用监督者的单调时钟计算执行截止点，墙钟时间只供显示与审计：

~~~text
deadline = registeredMonotonicTime + execution_budget_ms
remaining = max(0, deadline - nowMonotonicTime)
nextReview = min(nowMonotonicTime + review_after_ms, deadline)
~~~

- 这是自登记起持续经过时间的上限，不是 CPU 用时；包含 setup、子执行、等待父决策以及同一 delegation 的替换间隔。
- wait、查询、token 活动、checkpoint、换窗、replace 均不改变 deadline。
- 新 attempt 只获得剩余时间；余额为 0 时不得启动。
- takeover 不产生新的子执行额度。父 Agent 自己的后续工作受父执行规则约束，不能将其宣称为仍被子执行计时器强制管理。
- 硬期限已到时优先执行停止，合并旧的未交付复查事件，防止主 Agent 再对过期授权续等。

已进入父侧修改提交的阶段可能需要超过截止点才能确定实际结果，见第 8 节。不得声称 deadline 是整个 setup/apply/cleanup 事务绝对返回的时间保证。

## 5. 当前进展 checkpoint

### 5.1 写入协议

增加子 Agent 专用 report_subagent_progress，不对父 Agent 暴露。子 Agent 在取得可用结果、完成关键步骤、改变下一步或发现明确阻塞时提交：

~~~typescript
interface ProgressSubmission {
  summary: string;      // 已确认的结果及剩余关键工作
  nextStep: string;     // 接下来实际准备做什么
  blocker: string | null;
  evidenceRefs: string[];
}
~~~

监督者赋予 taskId、progressSeq、recordedAt 和来源身份。checkpoint 不改变 task 的 running 状态，不代替 submit_subagent_result，也不自动延长期限或唤醒父模型。

正常执行不要求每次工具调用、每轮模型生成都提交 checkpoint。不得仅为维持“活跃”而定时生成空洞进度。

### 5.2 有界和存证

- checkpoint 正文初始上限：512 个估算 tokens、4096 UTF-8 字节，二者都必须满足。
- evidenceRefs 最多 3 个。
- 超限提交明确拒绝，不把截断后的不完整事实静默接受。上一份有效 checkpoint 保持不变。
- token 估算使用仓库统一估算方法；这不是所有 provider 精确 tokenizer 的等价承诺。实际父请求仍经过既有请求预算检查。
- 每个 task 对外只有一份当前 checkpoint；历史版本可保存为证据，不默认进入父模型上下文。
- checkpoint 确认接收前，将所选的有限证据片段保存到父 session 拥有的不可变监督记录中。

证据记录必须包括原 child sessionId、toolCallId 或来源条目、读取范围、内容版本、是否为选段及是否完整。不能只保存即将 dispose 的内存 child session 的 entryId。

文件路径只表示一个可检查的位置。要作为历史证据，必须绑定保存的内容、内容哈希及版本；引用自身必须能读取，哈希不能替代内容。

不要求将全部子对话持久化到父 session。证据抽取不能执行新模型调用。

evidenceRefs 只能引用当前执行层登记的原始来源或已有监督证据 ID，不能作为任意路径或网络 URL 执行读取。监督者验证归属和读取权限，将来源转换为父 session 可解析的 evidenceId。单片段最多 2048 估算 tokens / 16384 字节，每次 checkpoint 存证合计最多 4096 估算 tokens / 32768 字节；超限返回选段要求，不静默转存全部工具日志。

可引用的来源句柄及选段方式必须由执行层提供给子模型，不能要求它猜测内部 entryId。子模型填写的句柄不是授权；实际内容和来源由监督者解析并验证。

### 5.3 正确表达缺失与未知

报告区分 runtime_fact、child_report、unknown。没有 checkpoint 表示“没有进展报告”，不能等同于“没有进展”。旧 checkpoint 必须显示年龄，不设“更新即证明有效进展”的判断规则。

明确错误可报告 request_timeout、tool_deadline_exceeded 等观察到的代码。无明确错误时保持原因未知，不能从无输出推断网络故障、死锁或推理循环。

## 6. 父模型可见报告和读取接口

### 6.1 报告内容

正式报告至少包含：

| 组 | 字段 |
| --- | --- |
| 身份与控制 | taskId、delegationId、currentTaskId、controlRevision、ownerRevision |
| 观察 | observedAt、progressSeq、status、phase、当前工具名或 null |
| 时间 | elapsedMs、phaseElapsedMs、lastActivityAgeMs 或 null、remainingMs |
| 监督 | trigger、reviewEpoch、reviewDue、下一次检查时间或 null |
| 进展 | 最新 checkpoint 及其来源、年龄；缺失时为 null |
| 错误 | 已确认的错误代码、受限摘要及证据引用；没有时为 null |
| 执行与效果 | executionStopped、publicationState、effectsState、交接记录引用 |
| 完整性 | reportComplete、未展开证据数量、可继续读取的游标或引用 |

phase 必须来自真实运行事件，至少覆盖 setup、model_request、tool_execution、context_maintenance、stopping、applying、cleanup。不能从静默时长猜阶段。多工具并发时显示阶段及活跃数量，按需读取工具目录，不任意选一个冒充全部操作。

status 沿用 running/cancelling/completed/blocked/failed/cancelled；review_due 是监督事件，不新增一个伪终态 timed_out。具体期限耗尽或错误通过 reasonCode 表达。

### 6.2 大小上限和分层读取

初始工程限额：

| 对象 | 上限 |
| --- | --- |
| 完整 task 报告 | 1024 估算 tokens，8192 UTF-8 字节 |
| 自动通知摘要 | 256 估算 tokens，2048 UTF-8 字节 |
| 单次父模型请求中的自动通知总量 | 2048 估算 tokens，16384 UTF-8 字节，并服从剩余请求预算 |
| 任务目录一页 | 最多 20 项且不超过 2048 估算 tokens |
| 证据或结果详情一页 | 最多 2048 估算 tokens，必须给范围与完整性 |

自动通知可以只带任务 ID、触发事实、短摘要及正式报告引用；不得把这种摘要标为完整报告。主模型在需要判断时读取正式报告，不能默认索取全量运行日志。

get_task_output 扩展为明确的读取视图：

| view | 输入 | 输出 |
| --- | --- | --- |
| pending | 可选目录 cursor，不要求 task_ids | 当前 owner 范围的未交付事件目录、pendingCount、nextCursor、sampledAt |
| report | task_ids，可选 query wait | 受限报告及关联控制操作的状态；超出单次总量时附后续游标 |
| result | 单个 taskId，可选结果 cursor | 指定 attempt 的结果正文页面 |
| evidence | evidenceId，可选证据 cursor | 不可变证据的指定页面与来源 |

各 view 的身份和游标参数互斥；游标绑定 view、owner、固定读取版本和范围，不能相互解释。pending 首页固定一个目录版本，后续页读该版本；分页期间新事件进入更新版本并计入后续首页，不插进旧页或静默丢弃。旧页同时给出是否存在更新版本。目录可包含 operationId 对应的 control_settled，并关联相关 taskId。

只读查询不改变监督期限，不执行任务或重复应用修改。所有 view 的单次返回还受 2048 估算 tokens / 16384 字节总量限制；数量限制不能替代总量限制。

正文必须进入实际 provider request 的 content，不能只存在于 details、trace、UI 或测试 harness 的内部对象。

结果过大时返回完整性标记和可继续读取的正文页面；状态、取消未确认、提交不确定及未读数量不得因限额被静默省略。不能截断 JSON 后假称已完整返回。

证据页面绑定不可变来源、固定版本及范围。任务目录页绑定采样版本和时间，不声称所有分页反映同一实时状态。控制动作始终重新检查 live registry。

## 7. 控制 Interface

### 7.1 工具映射

- task：创建新 delegation，增加 execution_budget_ms 和 review_after_ms。
- get_task_output：有界读取与查询等待。
- task_control：父 Agent 的 wait/cancel/replace/takeover 决策入口。
- kill_task：作为跨任务种类的取消工具，取消 subagent 时必须调用同一控制实现，不能绕过终止、发布或效果规则。
- report_subagent_progress：子 Agent 提交当前 checkpoint。
- submit_subagent_result：保留完成/阻塞结构化结果职责。

task_control 与 task/get_task_output/kill_task 同样受 subagent 深度及权限门禁；子 Agent 不能通过新工具创建孙任务或控制父任务。

不保留新旧两套独立子任务状态或取消实现。实现变更时统一更新工具 schema、提示、调用链、恢复协议及测试。

### 7.2 控制请求

~~~typescript
interface TaskControlBase {
  taskId: string;            // 预期的旧执行
  controlRevision: number;
  ownerRevision: number;
  operationId: string;
}

type TaskControlRequest =
  | (TaskControlBase & {
      action: "wait";
      reviewAfterMs: number;
      reason: string;
      reviewCondition: string;
    })
  | (TaskControlBase & {
      action: "cancel";
      reason: string;
    })
  | (TaskControlBase & {
      action: "replace";
      reason: string;
      strategyChange: string;
      nextTask: {
        description: string;
        prompt: string;
        agentType: string;
        capabilityMode: string;
      };
      reviewAfterMs: number;
    })
  | (TaskControlBase & {
      action: "takeover";
      reason: string;
    });
~~~

控制原因和 strategyChange 各不超过 512 UTF-8 字节，reviewCondition 不超过 256 字节。nextTask 使用原 task 的合法类型和权限验证，不通过这些字段扩大权限。replace 不接受新的 execution_budget_ms，不修改原 isolation；新的独立工作应作为新 task 创建。

replace 的 reviewAfterMs 指后继的首次复查间隔，按 wait 的区间约束在接收时校验；实际启动时复查点取启动时间加该间隔与原 deadline 的较早者。停止过程不会为后继重新计发总预算。

非空理由不等于理由正确。harness 只校验结构、引用及可执行条件，主模型负责业务合理性。

### 7.3 幂等、版本与占位

对每个 delegation 串行处理控制状态：

1. 验证调用者、任务归属和请求结构。
2. 在已授权范围内查 operationId：
   - 相同 ID、相同规范化请求：返回同一操作及其当前结果，包括 pending；
   - 相同 ID、不同请求：返回 operation_id_reused，不能重新执行；
   - 已关闭父任务的重复读取只返回已有事实，不重新激活操作。
3. 对新操作检查 ownerRevision、当前 taskId 和 controlRevision。
4. 不匹配时返回 stale_decision 和最新报告，不执行旧动作。
5. 若该 delegation 已有未结束的改变控制状态的流程，普通新请求返回 control_in_progress 及其 operationId；即使请求持有最新版本，也不能再占位。显式 cancel 可以在同一流程内撤销待启动后继或待授予接管的资格，并关联现有停止过程；不启动第二个异步流程。
6. 无在途流程时，原子登记唯一控制占位并消耗当前控制版本，然后启动必要的异步停止工作。合并 cancel 时只更新原流程的禁止接续标记和版本，保存新 operationId 到原停止结果的关联，不重新占位。

先查幂等记录，再检查是否因该操作自身成功而发生版本变化。否则响应丢失后的重试会错误地被当作过期请求。

operationId 由同一逻辑工具调用稳定产生；传输重试必须复用。不同 operationId 竞争时，只有一个能占据当前版本。每个旧 task 最多建立一个 successor。

异步步骤不能长时间持有全局锁。仅串行化同一 delegation 的控制状态和共享父工作区的发布入口；其他独立任务继续执行。

控制响应分为 completed、pending、stale_decision、rejected，均带 operationId 和当前事实。completed 表示控制流程结束，必须另带 outcome：waiting/cancelled/replaced/taken_over/already_completed/ended_without_successor/ended_without_handoff，以及 reasonCode；它不等于子任务 completed。rejected 表示新操作未获准执行。

工具等待到期可以返回 pending，不能把它当作控制失败或允许再次创建操作。get_task_output 的 report 视图包含关联控制操作的状态和结果引用；重复读取或提交相同 operationId 不重新发送取消或新建执行。

replace 在创建后继前必须再次原子检查：原控制占位仍属本 operation、本 operation 的后继资格未被取消撤销、owner 和 ownerRevision 仍有效、当前执行关系未变、发布和停止条件已满足、子执行授权未关闭且剩余额度大于 0。条件失效时保留已经发生的停止和效果，结束为 ended_without_successor 并返回具体原因，不撤销停止、不启动旧策略。takeover 在授予接管资格前执行同样的归属和版本复核，并确认本 operation 的接管资格未被取消撤销。资格检查与实际启动/授予必须属于同一次原子裁决。

takeover 不要求仍有子执行余额：期限耗尽后，父 Agent 仍可在有效父授权下接收已经停止执行的材料；父关闭或旧 ownerRevision 则不能授予新接管资格，返回 ended_without_handoff。replace/发布入口必须实时比较单调 deadline，不等待过期定时器回调才执行守卫。

### 7.4 各动作含义

| 动作 | 效果 |
| --- | --- |
| wait | 为当前活跃 attempt 建立新 reviewEpoch；不重启、不重置总期限 |
| cancel | 撤销尚未获得提交资格的发布，停止本地执行；不创建后继 |
| replace | 停止并确认旧执行、确定发布结局、保存交接，再创建一次新 attempt |
| takeover | 完成相同的停止与发布裁决，返回交接材料，将该 delegation 的子执行权交给父 Agent |

wait 只对仍有执行授权的 running attempt 生效。cancelling、终态或预算耗尽时返回真实状态，不能通过 wait 撤销取消。

replace 请求包含明确的新委派和策略变化；它不是自动重放旧 transcript。checkpoint、实际产物、未完成工作和未知效果作为新执行的交接上下文。原工具调用不能从历史自动重放。

若旧任务在停止期间实际完成且发布成功，replace/takeover 返回完成结果，不创建后继。若确实还有新的工作，主 Agent 必须依据完成结果重新提出独立委派。

replace 可以接续仍在执行或已 blocked/failed/cancelled 的 attempt，但必须满足同一授权与交接守卫。接收控制请求不暂停硬期限；预算到期、父关闭和用户取消可以撤销待启动后继的资格，并与已有停止流程合并，不另建竞争操作。

kill_task 对 subagent 的取消只针对传入的具体 taskId，不沿 currentTaskId 隐式取消后继；同样验证当前归属并使用稳定 operationId。它进入同一停止流程，不能绕过已有控制占位建立第二条取消链；显式取消会撤销 pending replace 的后继资格，并在其操作记录中保留这一裁决。

## 8. 执行停止、修改发布与资源清理

### 8.1 生命周期先后

~~~text
登记任务和授权
  -> setup
  -> 子 Agent 执行
  -> 接收候选结果
  -> 停止确认 / 发布裁决
  -> 确定真实终态和可读交接材料
  -> 清理不再需要的独占资源
~~~

当前在 TaskManager.start 之前同步创建 worktree 的方式必须调整。setup 失败、启动前取消和初始超时都属于已登记任务的生命周期，不能形成没有清理责任人的目录或进程。

监督者不得在自己的事件循环中运行可能无限阻塞的同步 setup 命令，导致监督计时器失效。

### 8.2 独立执行单元

内置子 Agent 移到受监督的独立进程；模型请求、工具执行、子 session dispose 以及派生的本地工具进程均纳入受管理的执行范围。

- 正常完成后也必须核对受管理工具的状态，不能仅以 prompt 返回证明所有工具结束。
- cancellation grace 到期后终止受管理的执行，并收集退出确认。
- 不能阻止脱管进程逃逸时，不得报告其已停止；相应能力必须受执行约束或报告停止未确认。
- 若终止请求之后仍无法证明停止，维持 cancelling、executionStopped=false，控制操作保持未完成并报告 stop_unconfirmed；禁止 replace/takeover 成功。
- 超时不是强制停止成功的证据，状态字段不能代替实际退出确认。

该保证仅覆盖受管理的本地执行。父模型、操作系统或宿主永久失效不可能由此获得无条件的墙钟完成保证。

### 8.3 发布资格和取消竞态

对于 worktree 结果，子进程只能提交候选结果，父工作区修改由监督者统一应用。发布资格绑定 taskId，不能由迟到 worker 自行获得。

父侧 apply 取得资格之前，必须确认所有受管理的 worktree 写入者已经停止，并固定候选产物版本及其基线。停止检查和发布使用同一份不可变产物，不能检查旧 diff 后应用仍在变化的目录。直接写父目录的现有隔离模式没有这一提交屏障，必须按实际效果记录，不虚称修改可在取消时撤回。

取得发布资格时直接检查单调 deadline。只有截止前已取得资格的 apply 可以在期限之后确定结局；已过期但定时器尚未处理的任务不能抢到提交资格。

| 谁先获得原子裁决 | 行为 |
| --- | --- |
| 取消先撤销发布资格 | 候选结果可保存为交接材料，不得再应用到父工作区；确认执行停止后结束取消 |
| apply 先取得发布资格 | 进入提交阶段；取消等待实际提交结局，不强杀后假称未修改 |
| 已有 completed 和已提交结果 | 保留完成结果，取消/替换返回该结果 |
| apply 部分失败或结局不明确 | 报告实际失败及已知/未知修改，不能返回空白取消结果 |

收到 submit_subagent_result 不等于完成整个任务。completed 需要验证结构化提交、受管理执行的结束状态，并确认应执行的父侧应用已经有明确结果。

现有父侧 apply 不是可以任意强杀的通用事务。提交阶段可能超出 execution deadline；必须显示 applying 及其耗时，不宣称已经停止或回滚。若要求整个提交具有绝对墙钟上限，需要另行改变提交机制，本规范不虚构这一保证。

取消在 apply 之前生效时，未应用的修改保留在交接工作区；不得在交接材料可读之前将其删除。

### 8.4 真实终态与效果

每个 attempt 的终态只提交一次，不能因后来读取、重试控制或清理失败而改变。

所有终态都要求受管理的本地执行已经结束，且共享发布/清理的结局足以判断接续是否安全。worker 报错或退出、工具仍在执行时先进入停止流程，不能提前标为 failed。尚未启动任何执行的 setup 失败可以确认其执行范围为空。

- completed：有效完成结果及必要发布成功。
- blocked：子 Agent 有效提交明确阻塞，执行已经结束；不自动发布未完成修改。
- failed：执行或发布失败，附真实原因和已发生的效果。
- cancelled：取消已生效，受管理执行已停止，且没有被先完成的发布结果取代。
- cancelling：仍在停止或等待提交结局；不是终态。

deadline 到达记录 execution_budget_exhausted；实际停止后可为 cancelled，若提交已先完成则保留 completed。不得仅由原因代码决定虚假的终态。

effectsState 至少区分 none、known、unknown；本地和外部效果分别表达。任意 Bash 或远端操作无法完整归因时必须为 unknown，不能因 checkpoint 没提到修改就填 none。

本地进程退出不证明远端请求已撤销。结果未知时，禁止控制器自动重复发送相关操作。主 Agent 可以先做只读核对，或显式委派只读调查；写入是否可重做仍取决于实际证据及该操作已有的契约。

### 8.5 接管与清理

takeover 成功的前置条件：

1. 旧 attempt 的受管理执行已停止。
2. 旧发布资格已经撤销，或已开始的发布结局已经确定。
3. 旧 attempt 的后续消息不能再触发父工作区应用。
4. 交接工作区、已保存证据和效果记录仍可读取。
5. 返回原委派、最新 checkpoint、当前基线、实际已发生修改、未验证工作和未知效果。

接管凭据证明上述执行事实，不证明父模型已经理解或验证工作内容。父模型必须先检查实际工作区，再继续写入。

交接使用明确的工作区/产物版本。新 attempt 不得从干净 HEAD 启动却假装已继承旧 checkpoint 声称完成的修改。需要转移的候选修改和工作区由控制操作交接；基线冲突明确失败，不自动覆盖父目录。

独占资源的清理与工作成果分开记账。交接材料被接收前必须保留；之后才允许清理。仅清理独占临时目录失败，可以单独报告，不把完成成果改称不存在。仍会触碰共享资源的清理未结束时，不得放行冲突接续。

## 9. 通知、父执行授权和上下文

### 9.1 监督授权有明确的开始和结束

监督使用有界的一次性交付授权，不把运行中的 timer 与通知资格混为同一状态：

- task 创建时，为 attempt 建立一次终态交付授权和首个复查授权，均绑定 owner、ownerRevision、taskId；复查还绑定 reviewEpoch。
- 成功 wait 替换尚未消费的旧复查授权，建立新 reviewEpoch；不增加终态通知次数。此前因新输入失效的终态授权可以在新 ownerRevision 下重新绑定，但已交付的同一终态不能再交付。
- 终态停止复查计时并替代未交付的 review_due，使用一次终态交付权。即使 review_due 已交付，终态仍保有单独一次交付权。
- 事件实际进入提交给父模型的请求后，其授权消费；同一授权不再次唤醒。复查授权不因没有作决定而无限续订。子执行始终受原 deadline 约束，终态授权不能延长它。
- cancel/replace/takeover 返回 pending 时，另建一个绑定 operationId 的 control_settled 交付授权；终止旧复查计时不撤销它。该事件带控制 outcome、后继 ID 或交接引用，不能用旧 attempt 终态冒充控制流程结束。
- replace 实际启动后继时，为新 taskId 建立首次复查和终态授权。旧操作结局与新执行状态关联去重，不能以旧 taskId 假称后继仍是同一次执行。

工具正文与自动通知通过同一事件 ID 去重；已经通过工具结果实际交付的结局不再触发一次自动续跑。准备后未提交、被新输入取消的请求不算已交付。普通只读状态查询不续期、不撤销尚未到期的复查安排。

用户取消、宿主关闭对应父 taskScope 或 session dispose 撤销其全部交付授权。新用户输入使旧 ownerRevision 的授权失效：保留事实和未读记录，取消旧授权的自动唤醒权；主 Agent 根据新上下文查询，再决定是否继续监督。已经生效的停止不会因授权失效被撤销。

AgentSession 必须维护父执行的 active/awaiting/closed 生命周期。一次无工具的 agent_end 只结束当前模型循环；若仍有有效的明确交付授权，可进入 awaiting，而不是把它误作业务完成。宿主结束父任务时必须发出明确的 taskScope 关闭事实，撤销授权和后继启动资格，并请求停止该范围内所有子执行，不能仅删除 UI 状态。

监督者仍负责完成停止、记录已开始的发布结局和保管交接材料；这些工作不需要重新启动已关闭的父模型。用户的普通补充消息不自动等同于关闭。

### 9.2 交付规则

- 父模型活跃时，通知排入 runtime steering，在完整工具批次结束后交付，不中断正在执行的工具。
- 父模型 awaiting 时，有效授权可触发一次原父任务续跑；不得并发启动第二个父循环。
- 父模型闭合、用户已取消或会话销毁时，只保存事件事实，不唤醒。
- 不得直接使用会重置父 prompt、清除 abort 状态的新用户 prompt 路径模拟监督续跑。
- 用户消息优先进入有效上下文；旧 ownerRevision 的控制决定不能穿过该消息执行。
- 撤销通知时按通知 ID 移除运行时项，不清除用户排队消息。

checkpoint 更新、token 和普通工具事件不自动产生父通知。父模型因其他工具阻塞而暂时无法接收事件时，执行 deadline 仍由监督者生效。

### 9.3 合并、分页和完整性

每个 task 最多一份未交付状态通知。新的终态可以替代旧 review_due；替代记录旧投递取消和新投递，不改写已经交付的历史。

control_settled 按 operationId 单独去重；它不能被旧 task 的终态覆盖。相关状态和控制结局可合并在一个有界通知中，但必须保留各自的事件身份、结果引用及未读标记。

多任务事件采用有界目录及详情读取。预算容不下时必须提供 pendingCount 和后续读取入口，不能静默丢弃任务。目录页与证据页有不同的固定版本游标。

事件入队、放入目录或准备请求不等于交付。只有最终提交给 provider 的正文实际包含对应事件材料，才能消费交付授权；transform 移除或预算排除的项目保持未交付。连目录都无法容纳时，沿用已有上下文维护和请求失败处理，保留可查询事件；不得因 pendingCount 非零反复自动启动父循环。

同一 epoch 不因定时器、轮询或事件重放反复追加通知。主 Agent 主动重复查询仍会产生工具历史；不宣称整个会话历史恒定。所有新增内容计入实际请求预算，历史增长由既有上下文管理处理。

## 10. 与现有跨窗口协议的关系

依赖 [子 Agent 跨上下文窗口执行 Spec](subagent-context-rollover.md)，保留真实委派来源、父任务关系、原指令正文及 onResult 的恢复覆盖。

本规范对其中“终态不自动启动主调用”的规则作有限扩展：仅仍有效的监督授权可以触发原父任务续跑；普通 completion 没有无条件唤醒权。

- 正常换窗保留原 taskId、delegation、受监督 worker、TaskManager、工作区、控制操作、deadline 和 reviewEpoch。
- worker 不能因为父窗口编号变化而重建；窗口身份不是业务身份。
- checkpoint 不能代替原委派要求、parentRelation、onResult 或最新用户要求。
- 控制替换产生的新 taskId 必须有真实 task_control 请求及结果作为规范来源，并关联原 delegation；更新来源解析与恢复覆盖，不仅更新提示词。
- 旧 attempt 的终态与新 attempt 的当前状态分开表示；旧 ID 查询可以指向 currentTaskId，但不能把旧记录改写成新任务的 running。
- 已准备请求的来源、用户输入或控制状态改变时，沿用既有重新准备和 dispatch 校验；不修改已提交的 prepared payload。
- 不提供跨宿主重启恢复正在执行的 worker。宿主关闭必须管理其子进程；重启后缺少执行句柄时报告 execution_handle_missing/状态未知，不自动重建或重派，也不伪造失败或成功。

关联跨窗口规范已同步修订执行隔离、授权通知、缺少句柄和替换来源条款。原跨窗验收作为历史证据保留，不代替本次监督验收。

## 11. 主 Agent 决策契约

主 Agent 在正式报告与当前用户目标的基础上选择：

| 信息 | 动作指导 |
| --- | --- |
| 有可用结果，剩余步骤明确，当前操作合理且仍有授权 | wait，写明下一检查条件 |
| 原方案不可行，已有可执行的新方案 | replace，明确 strategyChange |
| 调查已足够，剩余工作适合父 Agent | takeover，成功后先核对交接状态 |
| 外部条件缺失 | 处理阻塞；换 taskId 不会自动消除它 |
| 进展未知或 checkpoint 很旧 | 在剩余授权内有限观察或取消，不能把猜测写成根因 |
| 已完成 | 使用并验证成果，不按旧超时事件重新委派 |

取消和重新委派是两个决定。单纯需要停止消耗，不构成再次运行同一方案的理由。harness 不强制“超时 N 次就重派”，也不以关键词自动选择方案。

非空 reason、strategyChange 或 checkpoint 不能证明策略正确；运行时只保证决策材料可读、状态守卫正确和动作按协议执行。

## 12. Module 落点

| Module | 职责 |
| --- | --- |
| TaskManager | 单写者状态、版本、监督期限、控制占位、幂等操作、当前报告、执行与效果事实 |
| SubagentCoordinator | 创建、替换和接管的流程；worker 及工作区归属；发布资格和交接 |
| Child Runner | 独立进程内执行；回传真实事件、checkpoint 和候选结果；受管理工具停止 |
| AgentSession | owner 生命周期、指令版本、通知总预算、串行父续跑、用户取消和换窗衔接 |
| task/get_task_output/task_control/kill_task | 校验输入、调用同一控制 Interface、构造模型可读正文 |
| checkpoint/监督证据记录 | 保存少量不可变证据及当前摘要，提供有界且可追溯的读取 |

控制 Interface 是测试入口。业务状态不得散落在 UI、工具包装器和模型提示中各维护一份。实现不需要另加一个自主“诊断 Agent”，超时报告不启动额外模型调用。

## 13. 全链路验收

### 13.1 确定性验收矩阵

| ID | 场景 | 必须证明 |
| --- | --- | --- |
| T01 | query wait 到期 | 返回 running 快照，不取消、不续期、不新建任务 |
| T02 | 工具操作超时后子 Agent 继续 | 错误在子内部处理，未自动转成父级替换 |
| T03 | review 到期，子模型永不返回 | 读取已保存报告，不依赖新的子模型请求 |
| T04 | 无 checkpoint、旧 checkpoint、持续空洞自述 | 如实区分来源与未知，不按更新时间宣称有效进展 |
| T05 | child 接收 checkpoint 后被终止/dispose | 父拥有的证据仍可读取，引用版本与选段标记正确 |
| T06 | 超限及包含多字节文本的 checkpoint | token/字节双限生效，不静默截断接受 |
| T07 | token 持续输出时 replace | progressSeq 更新不会使控制版本 CAS 永久失效 |
| T08 | 连续查询与 wait | 查询不续期；wait 只续复查及交付授权，不改 deadline 或执行身份 |
| T09 | 父模型永久无响应 | execution deadline 独立触发停止 |
| T10 | setup、模型、工具或 dispose 不响应取消 | 受管理执行可被终止；未确认退出时不放行后继 |
| T11 | 预算在 setup 或替换间隔耗尽 | 没有额度刷新，没有未登记的资源或新 attempt |
| T12 | 相同 operationId 请求重复或响应丢失 | 返回同一个 pending/完成操作，只产生一个后继 |
| T13 | 相同 operationId 配不同参数 | 明确拒绝，不修改原操作 |
| T14 | 两个不同 replace 请求竞争 | 仅一个占位成功，另一个取得最新事实 |
| T15 | 取消先于发布资格 | 迟到结果可查询但绝不再应用到父目录 |
| T16 | apply 先于取消、apply 部分失败 | 根据实际提交裁决；不假称回滚、不丢失已发生修改 |
| T17 | 旧任务在控制期间先取得完成裁决 | 返回其完成结果，不创建替代执行 |
| T18 | takeover 成功后收到旧 worker 消息 | 不能重新发布、改变终态或夺回执行权 |
| T19 | 独占清理失败与交接引用 | 成果仍可读；交接前不删除引用资源 |
| T20 | 远端已接受写入但响应丢失 | 本地停止不被写成无副作用，不自动重放 |
| T21 | 25 个任务同时到期 | 自动通知总量受限，分页及 pendingCount 无静默遗漏 |
| T22 | 未交付超时事件被完成事件替代 | 合并待发项，已交付历史不可变 |
| T23 | 父工具执行期间事件到达 | 工具批次完整，之后才交付，无第二个并发父循环 |
| T24 | 用户新输入/abort/关闭与事件、控制请求竞争 | 过期 ownerRevision 不执行旧决定，不清用户队列、不自动复活 |
| T25 | 多次父窗口切换 | ID、deadline、控制操作不变；原委派、父关系和结果处理语义仍覆盖真实请求 |
| T26 | details 有报告但模型 content 没有 | 验收失败；必须检查实际 provider 请求 |
| T27 | 只读调查接续未知效果任务 | 不误称效果已确认，也不一律禁止无副作用核对 |
| T28 | 宿主重启或句柄缺失 | 不伪造 live 状态，不自动重建执行 |
| T29 | stop 请求返回但进程仍活跃 | 保持 cancelling/stop_unconfirmed，replace/takeover 不成功 |
| T30 | 新 attempt 的交接基线 | 继承实际产物或明确失败，不用干净 HEAD 冒充已继承修改 |
| T31 | awaiting 时提前终态或 pending 控制结束 | 计时结束不丢一次性交付权；工具已交付则不重复唤醒 |
| T32 | replace 已占位，停止期间收到新输入/关闭/预算耗尽 | 启动前再检查，保留停止效果且不创建过期后继 |
| T33 | pending 操作期间用新 controlRevision 再发 replace | 返回 control_in_progress，不产生第二个异步控制流程 |
| T34 | 提交结果后 dispose 或派生工具继续修改 worktree | 未停止且未固定产物版本前不能取得 apply 资格 |
| T35 | 显式取消与 pending replace/takeover 竞争 | 共享停止流程、最终守卫拒绝已撤销的后继/接管资格；不取消其他已启动 taskId |
| T36 | completed/takeover 后再次 replace | 子执行授权已关闭；普通取消后的显式接续仍受原余额约束 |
| T37 | 复查已交付而父未决策时子任务终态 | 终态仍有一次授权；关闭或用户输入失效的授权不能唤醒 |
| T38 | 剩余预算小于最小复查间隔 | 复查点截取到 deadline；不刷新余额、不造成参数重试循环 |
| T39 | 目录分页期间新增事件，或通知被最终请求预算排除 | 正式 pending 视图可读完整目录和更新版本；未交付不丢失、不无限自唤醒 |
| T40 | 实时期限已到但定时器回调未运行 | 发布和后继启动守卫仍拒绝过期动作 |

### 13.2 验证方法

- 状态机测试通过正式控制 Interface 注入时钟、进程事件和发布结果；不要直接篡改状态后当作集成通过。
- packages/coding-agent/test/suite 使用现有 harness 和 faux provider，运行真正父子 Agent/AgentSession/工具链。
- 停止保证用独立临时目录下的本地子进程夹具验证，包含忽略协作取消、派生工具进程、dispose 不返回；不调用真实 provider。
- 检查实际模型请求中的报告、通知总预算、缺失/未知字段和恢复材料。测试能读取 details 不等于模型收到正文。
- writer 夹具验证父工作区应用次数、未发布候选修改、部分失败和交接后实际文件内容。
- 模型策略质量不能用预写好的 faux 响应证明。后续真实模型评估应分别统计误取消、无效续等、重复委派及任务完成情况，并遵守获准的 provider 和调用预算。

自动验收通过可以证明协议和所测故障场景，不证明模型对任意任务均能正确识别超时根因。

### 13.3 完成条件

1. T01–T40 有可重复的实现级证据，关键竞态覆盖两个事件次序。
2. 不存在超时报告依赖新的模型调用、仅更新状态就宣称停止、重复替换生成多个后继的路径。
3. 已交付正文、不可变证据、实际文件效果与运行状态一致。
4. UI、SDK、interactive、RPC、print/json 都使用相同控制事实，退出和续跑语义不分叉。
5. 关联工具、深度门禁、跨窗口规范和文档同步更新。
6. 修改的测试实际运行；代码变更后按仓库要求运行 npm run check。不得用本文代替这些验证。

## 14. 当前交付状态

运行时、工具协议、独立进程执行及相关文档已修改。17 个文件共 214 项确定性测试通过，包含三组 14 项完整 Agent 场景；`npm run check` 退出码 0。三组 `gpt-5.5` / `low` 真实模型验收发现停止原因被工具错误覆盖的问题，修复后使用相同驱动重跑，39/39 项场景断言通过。内联扩展的能力边界待用户确认。可重复证据、已修复问题和未验证范围统一记录在[实施报告](subagent-timeout-supervision-implementation-report.md)，不将整体验收标记完成。
