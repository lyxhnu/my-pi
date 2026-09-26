# my-pi 长期记忆归档 Spec

| 项目 | 内容 |
| --- | --- |
| Spec ID | `long-term-memory-archive` |
| 版本 | 2，契约补全稿 |
| 状态 | 首版已实现并完成真实 Agent 写入、重启召回、撤销与换窗恢复验证；剩余限制见[实施报告](long-term-memory-archive-implementation-report.md) |
| 日期 | 2026-09-07 |
| 源码基线 | `b17f8c84905a1e6cceea1c3e62b617a1a503e1a4` |
| 主要范围 | `packages/coding-agent` 的运行归属、证据持久化、Memory 写入与读取 |
| 需求来源 | 用户提供的《my-pi 长期记忆修改方案》及随后五项契约审查 |

本文可独立用于实现与验收。“必须”“不得”是目标约束。源码基线已有本地未提交修改，实施未覆盖其他工作的修改。

本 Spec 接替旧 Memory 的压缩后笔记晋升、摘要 flush、autoDream 门槛及混合有效检索契约。[窗口记忆 Spec](context-window-memory-proposal.md)中的容量管理、Task Note 和 History 恢复职责保持独立；[完整性 Spec](memory-context-integrity.md)中的来源完整性、撤销、安全过滤和失败不伪报成功仍须满足。旧文档记录的测试结果不构成本 Spec 的实现证据。

## 1. 目标与设计决策

工作时保存可回读证据；本轮主执行和自动续跑停止、依赖 Task 的结果持久化后，独立提炼；逐条校验通过后进入长期记忆；读取时检查范围、状态和已声明的依赖条件。

| 层次 | 内容 | 默认作为长期有效知识返回 |
| --- | --- | --- |
| Session / Task Evidence | 原始输入、工具事务、Task 结果和执行时采集的材料 | 否，仅作为依据回读 |
| Task Note / Memory Candidate | 任务重点、恢复导航、假设和待归档结论 | 否，调查入口明确标注性质 |
| Memory Record | 有来源、范围、验证记录和修订关系的知识 | 仅 `active` 且当前适用的记录 |

执行结束与业务成功分别记录。失败任务中已验证的经验可以归档；尚未验证的修复不能成为成功事实。自动换窗和手动 `/compact` 只处理上下文，不触发知识晋升。

本版明确采用以下决策，替代原方案中相应的模糊约定：

| 契约 | 决策 |
| --- | --- |
| 冲突可见性 | 共享权威存储、权限与来源校验；有效检索与冲突检查使用不同读取契约 |
| 依赖与适用性 | 显式依赖清单、可执行条件和文字限制分离；仅保证已记录依赖的检查结果 |
| 分批晋升 | 提炼进度、支持检查、全批反证检查分别持久化；未完成反证检查的候选不晋升 |
| 恢复与预算 | 已持久化检查点可复用，未落盘模型调用可能重做，知识提交幂等；预算让出不算失败 |
| 跨 Session 输入 | 本轮输入版本与共享项目要求版本分离；项目要求按登记顺序生效，普通输入不使其他 Session 全量失效 |

第一版使用现有工作目录分桶，不新增数据库或守护进程，不自动跨 worktree 共享，不增加全局自动写入。实现一次切换写入与读取契约，不保留旧新双写、旧摘要自动晋升或兼容性分支。原用户数据保留，显式迁移见第 11 节。

## 2. 不变量

| ID | 必须保持的行为 |
| --- | --- |
| I01 | 本轮身份使用宿主生成的 `rootPromptId`；换窗、重试和自动续跑不更换身份 |
| I02 | 来源身份、归属、可见性、哈希与验证状态由宿主确定，模型只能提议结论与引用 |
| I03 | 业务执行状态、证据持久化状态、归档状态互不冒充 |
| I04 | 提交基于固定来源清单；未读片段和未解决依赖不能被处理收据隐去 |
| I05 | 晋升同时要求来源合法、支持检查通过、反证检查闭合、冲突已判定、提交版本匹配 |
| I06 | 默认不召回的冲突记录仍参与内部冲突检查；撤销记录阻止原结论被自动重新提炼复活 |
| I07 | 文件指纹相同仅证明已观测依赖在检查点相同，不证明依赖集合穷尽或执行期间无变化 |
| I08 | 归档重试可能重复无副作用的模型调用；同一知识提交最多生效一次 |
| I09 | 正常分页、预算让出、锁竞争和版本重校验不消耗技术失败重试次数 |
| I10 | 普通 Session 输入不能反复使无关项目归档失效；共享要求登记后必须阻止相冲突的旧结果提交 |
| I11 | 搜索、直接读取和异步向量结果返回前遵守同一项目、权限、状态与适用性检查 |
| I12 | 归档器不执行业务工具、不重放未知结果 Task、不通过 `AgentSession.prompt` 递归归档 |

## 3. 本轮身份与证据采集

### 3.1 Run 与输入来源

顶层请求通过前置检查、即将进入运行时，分配 UUID 并持久化 `memory_run_started`。Run 至少包含：

| 字段 | 契约 |
| --- | --- |
| `rootPromptId`, `sessionId`, `projectKey` | 稳定运行与项目身份；`projectKey` 沿用 `projectMemoryDir(memoryRoot, cwd)` 的分桶 |
| `branchStartEntryId`, `taskSourceEntryId`, `promptGeneration` | Session 分支起点、原始任务来源与现有上下文坐标；不代替本轮身份 |
| `mainState` | `running / quiescent` |
| `continuationState` | `pending / none / outcome_unknown`，含自动重试、Todo 续跑、延期换窗和待决交互 |
| `outcome` | 静止后为 `completed / stopped / failed / aborted / interrupted / superseded`；运行时为空 |
| `requiredTaskIds`, `sourceRevision` | 依赖集合、影响归档的单调来源版本 |
| `pendingEvidenceIds`, `sealedManifestIds` | 尚未完成的持久化事务与已封存来源清单 |

同一请求的重试、Todo 自动续跑和自动换窗沿用 `rootPromptId`。已实际交付的 steering / follow_up 绑定接收它的本轮，同时保留原始输入身份。`next_prompt` 只在随下一轮实际交付时绑定下一轮。新顶层请求创建新 ID；旧后台 Task 始终保留旧归属。

导航到历史分支或 fork 后的新执行创建自己的 Run，来源范围由分支祖先关系和允许读取的历史确定。fork 复制的旧事件保留原来源身份，不能变成新用户输入或另一份新知识依据。Git 分支属于工作区条件，与 Session 分支分别表示。

每条输入在模板展开、扩展转换前保存原文引用及 `origin = user / runtime / extension / tool / subagent / assistant`。转换后内容关联原始来源，但不继承超出原文的用户授权。`role === "user"` 不能代替 `origin`。无法确定身份的旧来源不得用于自动授予用户规则身份。

### 3.2 证据写入的顺序与恢复

Session JSONL 和宿主持久化附件保存原文；项目状态保存归档需要的 Run 版本与来源登记。所有影响归档的变更通过同一证据登记接口串行化：

1. 为事务分配稳定 `evidenceEventId`；在项目短锁内递增对应 Run 的 `sourceRevision`，登记 `pendingEvidenceId`。此后旧版本 job 不可晋升。
2. 锁外将原始记录或附件写入持久存储，记录引用、哈希及覆盖范围。输入必须在交付运行时前完成原始身份保存；Task 结果先持久化再通知归档。
3. 项目短锁内完成来源登记并清除 pending。Session 原文、项目登记和事件引用必须可通过同一个 `evidenceEventId` 对账。
4. 只有完成登记的来源才能进入封存清单；仅有内存对象或 JSONL 延迟刷盘队列不算落盘成功。

第 1 步成功后进程退出：恢复对账原始记录，存在则校验并补齐登记；不存在则保持 `evidence_unavailable`，不能静默清除 pending 或将相关材料算作已处理。登记操作可按事件 ID 幂等重试，不重跑原工具。

落盘失败不改变真实业务结果。失败状态能够持久化时必须使相关 Run 和 job 停止晋升；完全无法写入时当前进程也必须停止相关归档并报告故障。此时不承诺其他进程能感知尚未落盘的事实，恢复后须先完成对账。保留现有无 `fsync` 的边界，只保证正常文件系统条件下的进程崩溃恢复。

### 3.3 Task 与子代理证据

业务 Task 创建时由宿主注入 `ownerSessionId`、`rootPromptId` 和 `archiveRole`。Coordinator 在每次执行时解析归属，不能在构造时捕获上一轮身份。`TaskRunContext` 必须让宿主采集器获得稳定 `taskId`，模型不得指定它。

`archiveRole = dependency` 用于一次性测试、处理和子代理任务；`service` 用于宿主明确识别的服务进程，例如 LSP。超时不能使 dependency 自动变成 service。服务产生的具体诊断作为独立来源保存。

终态证据保存真实结果、退出码或其不可用原因、异常、完整输出引用和内容哈希。业务终态与 `evidenceState = pending / durable / unavailable` 分离。输出必须在内存缓冲裁剪前保存；宿主存储限额导致丢失时记录丢失区间、总字节范围和 `completeness = partial`，尾部不可冒充全量结果。

子代理证据从实际工具事务、结果及执行时文件观测采集，在子 Session dispose 和临时 worktree 清理前移交父级持久存储。移交覆盖成功、blocked、失败和取消路径；失败路径中已完整保存的独立观测仍可使用。`verification.status = passed` 只作为模型自述。

子 worktree 的证据只证明其对应观测。另存变更应用到父工作区的结果；不能由补丁应用成功推导父工作区测试通过。证据移交失败不伪造工具失败，也不允许模型自述替代原始证据。

### 3.4 来源契约

每个 SourceRef 包含 `sourceId`、`origin`、`sessionId`、`rootPromptId`、`entryId / durableArtifactId`、可选 `toolCallId / taskId`、内容哈希、采集时间、可见性与完整性。文本范围使用 `[offset, end)`；Session 文本统一 UTF-16，文件原始片段使用字节并显式标注单位、编码和父内容哈希。UTF-16 分页不能拆开代理对。

引用必须可解析、哈希一致且处于授权分支与运行来源范围。Task Note 和助手最终回复只提供查找线索；历史 Memory 结果不得成为新事实的独立依据。隐藏推理、不可见消息、兄弟分支及未交付输入不因后台归档获得额外可见性。

证据原文不被 30/180 天笔记老化改写。敏感内容过滤作用于发给提炼器的可见片段、候选、读取及 embedding；过滤掉的片段保留覆盖缺口标记，不标作已经检查。原 Session 保存规则独立执行。

## 4. 来源封存与归档资格

`checkArchiveEligibility(rootPromptId)` 返回 `ready / waiting_main / waiting_continuation / waiting_task_evidence / sealed_partial / no_new_sources / disabled`，并携带明确原因及等待 ID。

正常 `ready` 必须同时满足：主执行静止、无本轮续跑或待决交互、全部 dependency 终态且证据可回读、所有已交付材料登记完成、无 pending evidence。`agent_settled`、Task 证据落盘、队列或续跑状态变化、Session 恢复只请求重查，不直接调用提炼模型。

资格读取、Run 版本检查和封存准备由同一宿主入口处理。固定 Manifest 包含 Run 身份、分支起点、`sourceRevision`、排序后的 SourceRef 与哈希、完整工具事务分组、缺口、封存种类及允许补读的历史来源清单。身份来自规范序列化内容的哈希，不含当前时间；封存时间另存。

Session 先保存 Manifest；项目短锁内比较 Run 版本和 pending 集合后创建稳定 job。若版本变化，旧 Manifest 不能用于晋升，重新封存。两步之间退出，启动对账从有效 Manifest 补建 job。来源变化产生新 Manifest 和新 job 身份；技术重试及预算续处理使用原 jobId。

封存后新来源到达必须先执行第 3.2 节的版本失效登记。旧 job 不再晋升；新 Manifest 建立后，旧 job 标 superseded 并保存 successorJobId。新 job 可复用来源和版本仍一致的提炼检查点，反证检查必须针对新清单完成。旧轮 Task 的晚到结果只能更新旧 Run，不得按当前 Session 叶子归给新轮。

已经通过有限批次晋升的事实保存 `validatedSourceRevision`。同一 Run 后续来源登记时，旧反证凭据同步失效；在新来源增量校验完成前，这些事实默认读取为 unknown，不能等下一次归档写入才处理反证。增量校验通过后新增验证修订；发现反证则更新 conflict/状态。用户规则的权威性仍只受可信要求变更影响，普通工具输出或模型意见不能撤销规则。

中断或崩溃后，无法证明终态的外部 Task 标记 `outcome_unknown`，不自动重放。可以建立 `sealed_partial`，将未完成登记和未知 Task 明列为缺口，而不是清除它们；仅晋升不依赖缺失材料的独立结论，缺口可能影响候选时保持 deferred。明确被新请求取代的旧自动续跑记录 `superseded` 和原因，不永久保持 pending。

用户明确的长期要求或活跃任务中的 `/memory flush` 可以建立有限来源批次。前者以已交付原始要求及此前已交付修正为闭合范围；后者只处理已闭合证据。它们不把整个 Run 封存为成功。后续新来源仍须经过反证、冲突和去重检查。

## 5. 候选、依赖与验证契约

### 5.1 候选结构与宿主字段

TypeBox schema 拒绝额外字段。模型可提交 `kind`、单条结论 `text`、`subject`、范围提议、条件提议、允许的 `sourceIds`、`relatedMemoryIds` 及 `proposedRelation = new / equivalent / replaces / exception / conflicts`。`kind = user_rule / decision / implementation_fact / lesson`。

模型提议不等于宿主认可。宿主确定 `candidateId`、规范化 subject、projectKey、来源身份、scope、验证状态、依赖清单及提交版本。`relatedMemoryIds` 不是冲突扫描的上限。空候选数组合法；候选持久化于 job，不进入有效索引。

`scope` 至少区分项目、可选模块路径/场景、Git ref 条件及 `temporal = current / historical`。decision 明确 `decisionState = decided / implemented`；后者必须另有实现证据。历史缺陷 lesson 带 `resolution = unresolved / fixed / unknown` 及相应来源。

### 5.2 依赖清单由谁确定

`DependencyManifest` 包含稳定 ID、声明的命题范围、依赖条目、采集方式与未覆盖项。模型只能提出需要哪些依赖；宿主解析、授权并从真实保存材料形成清单。归档时读取的当前文件不得冒充执行时快照。

| 条目 | 最小内容与采集时点 |
| --- | --- |
| 文件 | 规范路径、存在/缺失状态、内容哈希、证据引用；观测时采集，提交/读取时复核 |
| 目录成员 | 当命题涉及模块或目录整体时记录相关文件集合指纹，包含新增、删除与未跟踪文件；仅记录现有文件哈希不足以发现新增实现 |
| 配置与依赖 | 命题使用的配置文件、清单和 lockfile，以及实际执行器报告的版本；lockfile 不冒充实际安装树证明 |
| 测试执行 | 实际 argv/命令、cwd、runner 版本、选择的测试、报告/断言引用、退出状态、执行前后观测 |
| 环境 | 影响所述结论的 OS、运行时、已声明非敏感配置等；未采集的环境条件标为未知 |

清单保留每条依赖的 `basis = host_observed / declared`；声明条目仍必须由宿主采集真实值。`coverage = bounded / incomplete` 描述清单是否覆盖当前声明的有限命题；`bounded` 不是程序证明全项目依赖已穷尽。测试命令、代码读取或报告无法支撑的外部依赖必须列入 `unknownDependencies`。

第一版不实现通用依赖分析器，也不为归档自动创建 worktree 或运行测试。模块级、项目级命题必须有相应范围依据；缺少依据就 deferred，不通过省略未知依赖取得 accepted。静态源码可以支持有限的实现观察，但不能单凭代码片段确认所有运行场景。

### 5.3 可执行条件与文字限制

每条记录将条件分成 `machineConditions` 与 `limitations`。前者仅使用宿主支持的确定性谓词：项目一致、规范路径/目录集合指纹一致、已声明配置或依赖版本一致、指定场景/平台/运行时一致、明确 Git ref 一致。使用有限结构和 AND 组合，不执行模型生成的代码或任意表达式。

文字限制随结论返回，不被解析成已满足条件。如果限制决定命题是否成立，而宿主不能判断它，则 `applicability = unknown`，不能进入默认有效结果。CLI 例外的 scene 来自当前获准任务上下文；只搜索“依赖规则”不能证明 scene 为 CLI。

适用性返回 `applicable / not_applicable / unknown`，并给出逐项结果和检查时间。已知场景或分支不匹配是 not_applicable；来源丢失、依赖不可读、预算不足、当前事实的依赖变化或必要条件无法判断是 unknown。它与持久 `status` 分离，切分支不永久撤销另一分支的记录。

### 5.4 观测与测试能证明什么

验证记录使用 `level = user_asserted / observed / tested`，同时保存结论范围、来源、时间、DependencyManifest、执行覆盖和校验器版本。来源有效不等于命题已证实；`isError=false`、退出码 0、Task completed、自报 passed 均不能单独授予 tested。

tested 至少需要真实执行事务，以及可解析的 runner 报告或可定位的实际测试断言/结果。`echo passed` 不构成测试证据。选定测试通过只证明这些测试的结果，不能推导“功能已完全正确”。用户表达规则属于 user_asserted；用户声称实现已完成也不能自动成为 tested。

执行稳定性单独保存：`endpoint_observed / controlled_snapshot / unknown`。普通可写工作区中，前后哈希相同只能是 endpoint_observed；不保证中间未修改再恢复。controlled_snapshot 仅在已有宿主执行设施能够证明声明依赖在执行中受控时使用，临时 worktree 本身不够。

前后依赖变化或缺失时，不晋升“此版本已通过验证”的命题。完整报告仍可支撑明确的历史观测，例如“该次命令报告所选 12 项通过”，必须保留时间与稳定性限制。不得自动改写一个被否定的成功候选以绕过验证；不同命题须作为独立候选校验。

程序负责引用、权限、哈希、版本、报告结构与状态条件；模型可辅助判断语义支持、过度概括和矛盾。accepted 仅表示“在声明范围和已检查材料内有依据、未发现未决反证”，不承诺通用逻辑证明，不使用模型自报 confidence 替代验证。

## 6. 分批处理与晋升提交条件

### 6.1 固定分页与检查点

证据按完整工具调用与结果分组；超大事务可分页，但保存父事务 ID、总范围和稳定片段 ID。每次模型输出须报告已检查与未检查的输入片段 ID；宿主验证二者互斥、无未知 ID、并覆盖本次实际发送集合。被截断或过滤掉的正文不得计入已检查。

`chunkId` 由 Manifest、来源范围和内容哈希确定。每个提炼工作单元保存输入清单、提炼器/提示/schema 版本、请求指纹、解析成功的候选、覆盖收据及输出哈希。候选达到数量上限视为可能未穷尽：该单元继续拆分或以已产出的候选 ID 分页，不能直接宣告提炼完成。重复输出且没有覆盖进展时进入 needs_review，不无限递归拆分。

输出 token 截断、非法 JSON、未知字段或不合法引用不生成成功检查点。合法空候选可生成 `processed_no_facts` 提炼收据。该收据只代表此工作单元的提炼已完成，不代表不存在其他候选，也不代替其他候选的反证检查。

### 6.2 提炼覆盖与反证覆盖分别计算

候选保存 `supportCheck = pending / passed / failed` 和 `counterevidenceCheck = pending / passed / contradicted / unknown`。后者绑定 `manifestId`、候选内容哈希、扫描覆盖、相关共享要求版本及校验器版本。

第一版反证检查扫描固定 Manifest 中全部允许的来源片段，包括前后窗口、失败、取消和后续修正。可以将多个候选放进同一调用检查同一片段，但不得用关键词 top-K、候选来源集合或提炼阶段的空候选收据代替全批扫描。新发现的候选必须补查它出现以前的片段。

每个已检查片段保存与候选关联的支持、反证或无关判定及来源定位；最终校验补读必要原文并综合这些结果。中间结果只作导航，不成为独立事实依据。未读材料存在时，普通实现事实和经验候选不得提前晋升；partial 批次只允许宿主能够确定与缺口独立的命题，例如已交付的明确用户要求。无法确定独立性就是 deferred。

例如第 1 批显示测试通过，第 3 批发现漏测并推翻修复：第 1 批可以落提炼检查点，但候选须等第 3 批检查后才能作最终判定，不能先写 active 再期待以后纠正。

严格的覆盖收据证明协议要求的材料已发送并获得完整处理响应，不证明模型认知上没有遗漏。语义遗漏和误判由第 13 节离线评估衡量。

### 6.3 逐条判定与不变量检查

候选仅在下列条件全部成立时 accepted：

1. 引用合法、来源可回读、权限与过滤通过，命题所需材料完整。
2. 支持检查通过，依赖与必要条件明确，验证表述不超出证据。
3. 当前 Manifest 的反证检查完成且无未决反证。
4. 第 7 节权威冲突上下文已扫描完成；相关未决共享要求已解决、将在本次原子事务中解决，或明确不影响此候选。
5. 提交时 Run 来源版本、相关要求版本、冲突读取修订、候选检查点版本和工作器租约仍匹配。

`rejected` 用于临时信息、明确错误、越权或敏感内容；`deferred` 用于缺证据、依赖变化、条件未知、冲突未决和尚未完成的检查。每项保存 reasonCode、证据和唤醒依赖。完成提炼不删除 deferred；新证据到达可以重开它，不能被 sourceReceipts 永久跳过。

## 7. 权威状态、冲突与共享项目要求

### 7.1 唯一权威状态

`projectMemoryDir(memoryRoot, cwd)/memory-state.v2.json` 保存 `schemaVersion`、`revision`、`records`、`jobs`、`runs`、`sourceReceipts`、`conflicts`、`projectDirectives` 与已知 Session 的持久定位。大原文和不可变证据附件放在独立文件，JSON 保存引用；Memory 修订、job 检查点和提交收据同属这个权威状态。

所有修改通过 Memory Module 的唯一提交接口，项目短锁内校验条件后原子替换。模型调用、文件批量读取、扫描和 embedding 在锁外执行。锁内对当前状态重放确定的变更，不用旧快照覆盖其他更新；仅无关 job 的进度改变时，无须重做语义校验。

Memory 修订至少包含 `memoryId`、`revision`、kind、subject、text、scope、machineConditions、limitations、SourceRef、`originRootPromptId`、verification、`status = active / needs_verification / superseded / revoked`、relations、reasonCode 和时间。旧修订不可原地修改。关系为 `supersedes / exception_of / conflicts_with`。

记录还包含由宿主决定的读取范围及允许展示的来源摘要。项目记忆的结论共享必须有项目级范围依据；它不授予其他 Session 读取原始私有对话的权限。不能共享结论的材料保持当前任务候选，不自动写成项目 active 记录。

宿主证据核对授权与调用者阅读原文授权分开保存。来源所属 Session 允许的宿主归档器可以在原授权范围内检查其持久化证据，向获准的项目读者返回验证元数据和共享结论；读者只凭 Memory 工具不能取得原文。若宿主本身也无权再核对、来源缺失或哈希变化，结果为 unknown，不能靠旧验证元数据无限延续有效性。

### 7.2 两种读取契约

| Interface | 返回集合与用途 |
| --- | --- |
| `getEffectiveMemoryView(queryContext)` | 获准项目中 active、适用、来源可用且无未决适用冲突的记录；用于默认 search/get、文档 embedding 及向量候选过滤 |
| `getMemoryConflictContext(candidateContext, cursor?)` | 相关权威记录及修订、needs_verification、未决冲突、替代/例外链和撤销身份；用于去重、授权与提交校验 |

两者共享底层权限、来源校验和权威修订读取，不共享“只取 active”的过滤。冲突上下文不是模型可任意读取历史正文的工具；不安全或不可见正文不送入模型，宿主保留相应阻塞信息。没有权限不能解释为没有冲突。

冲突检查先按 subject 和路径等宿主锚点定位，再展开范围重叠与关系闭包。项目级规则、相关待决要求和撤销身份必须参与；无法可靠限定候选范围时分页扫描获准项目的权威集合，不能用有效搜索 top-K 判定“无冲突”。subject 的语义匹配仍可能误判，不能单凭相似度执行替代。

扫描收据绑定所检查的记录修订、候选范围及相关集合版本。新增同范围记录也必须使扫描失效，不能只核对已读 ID 而漏掉并发插入。A、B 的未决冲突即使使它们退出默认召回，也必须阻止 C 绕过该冲突晋升。

### 7.3 冲突处理

| 情况 | 权威结果 |
| --- | --- |
| 同范围同义 | 合并来源或增加验证修订，不重复创建知识 |
| 用户明确整体替换规则 | 原记录 superseded，新记录 active，保留替换输入引用 |
| 用户明确局部例外 | 原规则保留，新增 exception_of，检索展开适用例外 |
| 实现违反用户要求 | 原规则有效；记录实现偏差，不把规则降为待核实 |
| 新版本修复旧缺陷 | 更新当前事实；历史 lesson 标明修复依据与状态 |
| 不同分支不同实现 | 保留各自条件，不互相全项目覆盖 |
| 有可信同范围反证但无法判定 | 保存未决 conflict；受影响事实停止无条件召回 |
| 同一来源试图重新生成已撤销结论 | 自动拒绝；文字改写、换 job 或重新 import 不解除撤销 |

撤销检查至少覆盖原支持来源、规范 subject、重叠范围及旧 ID 映射，不能只匹配新生成的文本哈希。新来源也不能自动解除已明确的用户撤销意图；重新确立规则需要新的明确用户授权。时间较新只表示顺序，不赋予修改权限。

### 7.4 本轮输入与项目要求分别登记

取消“每条用户输入都递增共享 userInputRevision”的设计。普通输入通过 Run 的 `sourceRevision` 使本轮检查失效；只有共享项目要求进入 `projectDirectives`。不同 Session 的普通提问、进度输入和 next_prompt 不使其他 job 重做全项目校验。

每条 ProjectDirective 包含稳定 `directiveId`、用户来源引用、宿主确认的项目范围、可共享的规则投影、目标 subject/范围或明确的 project-wide 标记、`state = pending / effective / dismissed / needs_review`、单调序号与修订。项目短锁提交是跨 Session 生效顺序的依据。

确定性 `/memory remember` 可直接登记 pending 要求。自然语言由输入所属 Session 的分类工作单元识别；它可以结合获准上下文判断长期意图，宿主须验证引用来自原始用户且项目范围有原文依据。识别成功后立即登记 pending，再进入同一校验链路，不等整轮结束。意图不清晰的输入保留本轮候选，不能仅因无法分类就建立项目全局阻塞。

此处明确一致性范围：自然语言在完成共享要求登记前，只对接收它的 Session 构成已交付输入；不宣称所有进程在原文到达瞬间已获知新规则。登记时必须同步使其目标范围中的旧验证凭据失效。登记前提交的结论在登记后也须受 pending 检查约束，不能继续作为已与新要求一致的知识返回。

登记有两条权限约束：项目级长期意图允许共享相应规则结论，不自动公开整段 Session；可共享投影不足以表达要求时，登记有范围的阻塞信息并标 needs_review。不能为了推进归档读取其他 Session 私有正文。

### 7.5 提交重校验与活性

校验器保存相关 ProjectDirective 修订和扫描游标。提交短锁内检查此后新增、更新和撤销的要求：明确不重叠的不使结果失效；重叠则补读获准规则投影并重校验；范围未知但已确认为项目级要求的记录按 project-wide 处理。

pending/needs_review 要求阻止的是与其重叠候选的提交及适用性判断，不暂停无关 Module 的归档。有关联但无可见投影时，候选进入 `waiting_dependency`，绑定 directiveId；等待其明确更新后唤醒，不反复调用模型，不因超时忽略要求，也不通过 dismissed 假装已解决。

ProjectDirective 的 effective/dismissed 转换及相应 Memory 修订在一次权威事务中完成。校验代表某条 directive 自身的候选时，必须将该 directive 纳入本次拟解决集合：检查原输入、所有相关旧规则及其他 pending 要求后，在同一事务内完成 pending → effective 与 Memory 提交，不能等待自己先 effective。相关 pending 要求形成互相依赖时，把同范围集合一起判定；矛盾且无替代授权则记录 conflict、转 needs_review，不让两个 job 相互等待。dismissed 仅用于有依据的误识别、重复登记或明确取消，并保存原因与来源，不能作为超时处理。

公平调度、有限输入、持久化可用且真实冲突已解决时，无关持续输入不影响已有 job 的完成；真实的未决同范围要求可以合法阻塞。状态页显示依赖及原因，而不是声称所有归档都必然完成。规则登记失败沿用第 3.2 节的可观测失败边界，不承诺故障区间内不存在跨进程竞态。

## 8. 持久化 job、检查点与预算

### 8.1 状态机与调度

| 状态 | 含义与后续转换 |
| --- | --- |
| `queued` | 有可运行工作；取得租约后 running |
| `running` | 一个有效工作器持有租约；可提交检查点、知识或让出 |
| `waiting_dependency` | 无可运行项且存在明确证据/要求依赖；依赖修订变化后 queued |
| `retryable_failed` | 技术失败，未达到失败上限；到 nextEligibleAt 后 queued |
| `needs_review` | 无进展、不可恢复状态或重试耗尽；保存原因，显式处理后才能重开 |
| `superseded` | 新来源清单已由 successorJobId 接管；保留原进度，不算原清单全量处理完成 |
| `completed` | 本批提炼、检查及处置已完成；结果可以包含 accepted、rejected、带依赖的 deferred |

预算耗尽而还有可运行单元时，保存检查点并回到 queued，记录 `yieldReason = budget` 和 `nextEligibleAt`；不进入失败状态。deferred 若已有确定等待原因可作为本批已处置结果，job completed 仍须在状态页计入未解决候选。没有完成反证扫描的工作不能仅标 deferred 就把全批覆盖报成 completed。

同项目第一版最多一个 running job。每次只领取一个有上限的调度切片，按就绪队列轮转，不能让大 job 或新到请求独占工作器。等待依赖不占租约；下一次依赖事件、明确手动操作或启动恢复才重查，不定时调用模型猜测到通过。

### 8.2 检查点先于最终知识提交

领取 job 时递增 `attemptToken` 并记录 workerId、leaseUntil。每次检查点写入、预算计数和最终提交都验证租约和令牌；接替工作器后，旧响应不能写入任何状态。租约续期也必须验证当前令牌，锁不能替代 fencing。

每个工作单元在发出模型调用前持久化 requestKey、调用序号和预算预留；响应通过结构检查后，立即在短锁内保存候选、覆盖收据、usage 和结果哈希。反证检查的分页结果同样逐单元落盘，不等待整个 job 完成。

检查点可复用条件包括请求指纹、证据内容、授权、模型/提示/schema/校验器版本一致。原始内容变化或权限丢失时不原样复用。共享规则变化可以复用仍合法的原文提炼结果，但必须重做受影响的反证或冲突检查。

最终提交将 Memory 修订、候选判定、关系变化、job 进度和知识提交收据原子写入权威状态。`commitKey` 来自 jobId、宿主候选身份和判定版本。宿主候选身份在提炼检查点落盘时稳定分配；跨 job 的重复来源通过权威去重/撤销检查处理，不依赖模型重复生成相同文本。

### 8.3 崩溃恢复的准确保证

| 中断位置 | 恢复行为 |
| --- | --- |
| Manifest 已保存，job 未创建 | 对账后按原 Manifest 身份补建 job |
| 调用已预留，未记录有效响应 | 标记该调用结果未知；提炼无副作用，可在预算允许时重做，不重放业务 Task |
| 模型返回，检查点未落盘 | 可能重复调用；不保证提炼 exactly-once |
| 检查点已落盘，知识未提交 | 重新验证检查点适用性，复用合格结果 |
| 知识与收据已提交，调用方未获知 | 读取原收据返回结果，不重复创建 Memory 修订 |
| 索引/Markdown 更新失败 | 权威提交仍有效；标记派生视图待重建 |
| lease 已接替，旧模型响应到达 | 旧 attemptToken 拒绝写检查点和提交 |

有效检查点不因重启被无条件清空。未知模型调用的实际付费可能无法恢复，报告 `usageUnknown`；已预留调用额度不因重启返还。不宣称恰好一次模型调用、断电持久性或 Session 与项目文件的跨文件原子事务。

### 8.4 技术失败、正常进度与成本

`failureCount` 针对同一个工作单元及输入版本累计；超时、provider 错误、非法输出等计入失败。成功检查点后后续工作单元独立计数。改变 lease、worker、调度切片或重启不创建新工作单元以逃避失败上限；未知的已预留调用在恢复确认失去原工作器后计一次失败。语义反证导致 rejected、等待真实证据、预算让出、版本失效和锁竞争不计入技术失败。

输出截断不提交成功收据；下一次必须缩小输入或候选分组，不能重复同一个必然截断的请求。达到不可再分且仍无法完成的状态则 needs_review。来源或版本持续变化可以持续等待，但不能持锁重试。

配置示例：

```json
{
  "memory": {
    "enabled": true,
    "archive": {
      "enabled": true,
      "maxConcurrencyPerProject": 1,
      "maxFailuresPerWorkItem": 3,
      "modelCallTimeoutMs": 60000,
      "maxInputTokensPerCall": 16000,
      "maxOutputTokensPerCall": 2000,
      "maxModelCallsPerSlice": 4,
      "maxCandidatesPerBatch": 12,
      "maxModelCallsPerProjectHour": 24
    }
  }
}
```

这些是待验收的初始成本配置，不是语义质量门槛。调用预算同时计入提炼、输入意图分类、反证和冲突复核；以项目锁保护的持久化一小时滚动调用预留限额控制持续续处理成本，重启不返还预留。额度恢复时间明确显示，正常额度等待不增加 failureCount。

实际输入还须满足模型窗口、输出预留和安全余量。所有调用都有 timeout；取消或停用会使令牌失效，不提交晚到响应。新的预算字段直接定义目标配置，不引入原草案 `maxAttempts` 或 `maxModelCallsPerJobAttempt` 的别名。

## 9. 有效读取与规则展开

`queryContext` 由宿主注入 projectKey、请求主体和权限、当前 Session 分支、工作区、当前场景、环境观测及本地检查预算。模型不能通过工具参数改变项目或授予自身历史读取权限。

默认 search/get 返回 memoryId、revision、kind、text、scope、status、applicability、verification、limitations 和获准来源摘要。`memory_get` 按 memoryId 读取，不保留路径参数绕过状态检查的入口。`includeUnverified` 和 `includeHistory` 只能扩大获准状态范围，不能跨项目或权限。

needs_verification、superseded、revoked、候选和 legacy_unverified 不进入默认有效结果。按当前条件计算出的 unknown 必须带原因，并从默认有效结果排除；持久 status 即使为 active，也不能覆盖这个判定。只读查询不自动修改其他分支的持久状态。

依赖检查在本地预算内执行，只验证候选真正声明的文件、配置及环境。预算耗尽时返回未完成检查和可继续状态，不把部分未命中当作不存在。记忆工具不得自动运行测试、联网核验或执行修复；这些由主任务按原权限完成并形成新证据。

关键词/向量/MMR 用于召回排序，不能裁掉同一命中规则的必要关系。命中基础规则或例外后，按权威关系展开规则与适用例外，再输出完整规则组。场景未知且存在可能适用的例外时，不返回“无例外”的基础规则作为无条件知识；明确列出条件，必要条件无法判断时为 unknown。

召回中的异步 embedding 返回后，最终输出前重新检查有关记录修订、规则关系、ProjectDirective 和适用性检查结果。更新/撤销后的向量缓存不赋予旧正文有效性。检查只能描述观测时刻，不能与外部编辑器修改形成原子事务。

`memory-active.md` 是带记录 ID、范围、条件、验证时间及导出版本的可重建展示，不作为有效性判断输入，也不是第二条工具读取通路。索引遗漏通过 authority/index revision 差异触发重建；索引更新失败不能将权威状态回滚或复活旧结论。

## 10. 模块 Interface 与运行接入

| Module / 位置（相对 `packages/coding-agent`） | 职责 |
| --- | --- |
| `src/core/agent-session.ts` | 传递 Run 生命周期、原始输入身份和宿主上下文；接入统一手动入口 |
| `src/core/session-manager.ts` | 类型化来源/Run/Manifest 事件、真实落盘与原文回读，不将归档事件作为模型可见用户消息 |
| `src/core/tasks/types.ts`、`task-manager.ts`、`tools/bash.ts` | 执行归属、archiveRole、输出持久化和终态证据通知 |
| `src/core/subagents/*` | taskId 传递、子证据移交及父工作区应用结果 |
| 新 `src/core/memory/archive-service.ts` | 资格、封存、调度、租约、检查点、预算和恢复；对宿主隐藏 job 状态推进细节 |
| 新 `src/core/memory/evidence.ts` | 证据登记、授权、固定分页与依赖观测解析 |
| `src/core/memory/extraction.ts`、`consolidation.ts`、新 `validation.ts` | 严格候选、覆盖收据、支持/反证/冲突判断；不拥有写权限 |
| `src/core/memory/memory-store.ts`、新 `types.ts` | 唯一权威事务、修订、两个读取契约与来源/要求版本 |
| `src/core/tools/memory-search.ts`、`memory-get.ts`、`src/core/memory/memory-index.ts` | 薄工具调用与派生索引；不另建有效性规则 |
| settings、trace、TUI/RPC/print | 配置、实际状态、失败分类和退出前持久化 |

宿主通过“登记事件、请求资格重查、提交显式记忆操作、读取状态”使用归档 Module；不得要求每个调用点自己安排锁、租约、重试和检查点顺序。有效检索和冲突上下文属于 Memory Module 的不同 Interface 用途，不能用一个 active-only 参数默认值掩盖差异。

归档工作器独立于业务 TaskManager，不出现在自己的 dependency 等待集合里，不调用 AgentSession.prompt。子代理不独立归档。模型提炼依赖以无执行工具的接口注入，可替换为确定性假提炼器；计时、存储故障和并发提交测试跨同一生产 Interface 进行。

`memory.enabled` 与 `memory.archive.enabled` 默认均 false；只有两者启用才自动归档。归档关闭仍允许已获准的手动记忆操作。启用 Memory 且宿主使用默认工具集合时，将 memory_search/memory_get 纳入候选默认工具，再执行 allowlist、deny 与能力过滤；用户显式工具集合不扩充。

主代理获得简短说明：依赖项目规则或历史经验前先检索，检查条件和来源；当前用户要求不能被旧记忆覆盖。子代理只获得父级已授权能力。

交互模式后台运行。print/RPC 退出前完成可封存 Manifest、job 和已知证据的持久化；不等待模型提炼完成，也不取消仍被业务运行时要求等待的 Task 来制造归档资格。未闭合 Run 保存真实 pending 状态。应用关闭期间不工作，下次项目启动从已知 Session 与 job 恢复；扫描失败报告范围和积压，不显示全部完成。

## 11. 手动入口、旧数据与可观测性

`/memory remember <规则>` 保存原始用户输入，并明确 scope 为当前项目；需要局部例外或替换时记录显式目标关系，歧义不静默整体覆盖。自然语言长期要求走同一 ProjectDirective 与提交链路。更新和撤销同样使用唯一权威事务。

`/memory flush` 返回 jobId、manifestId、queued/processed/deferred、实际写入数、剩余片段和原因。排队成功不得显示“记忆已写入”。重复 flush 不重复封存相同材料；立即 remember 与整轮归档看到同一来源时由权威去重处理。

`/memory status` 至少显示：待运行/运行/预算等待 job、未处理片段、未解决候选及依赖、技术失败与 needs_review、规则登记状态、证据缺失、legacy 数量、派生视图待重建、下次可调度时间。completed job 内的 deferred 仍计入待核实。trace 保存阶段、身份、版本、原因、耗时和 usage/usageUnknown，不回显被过滤的秘密。

旧 MEMORY.md、Session notes、撤销记录、`.dream-state.json` 和提交日志作为历史数据保留。新写入不依赖 compactionId、三 Session/24 小时 autoDream 门槛，不覆盖用户维护的旧 Markdown。旧条目默认为 legacy_unverified，通过显式调查读取，不自动进入有效知识。

显式 `/memory import` 在项目内选择旧记录、保留旧 ID 映射及撤销语义、找回原始来源并重新校验。缺少来源的条目不能自动获得用户规则身份；没有合法依据就 deferred。旧撤销状态损坏须明确报错，不能按无撤销处理。全局旧数据的读取和显式操作维持获准范围，自动归档始终只写项目。

实施时同步更新旧文档、SDK/RPC 类型、工具描述和调用方，不让它们继续声明“笔记默认等同有效知识”或使用旧路径接口。原数据保留不是旧算法兼容通路。

## 12. 实施批次与交付条件

| 批次 | 交付 | 完成条件 |
| --- | --- | --- |
| A：身份与证据 | Run、原始 origin、Task 归属、持久化事务、子证据移交 | 跨窗口/旧轮晚到归属正确；失败与清理前证据可回读；所有 pending 可恢复对账 |
| B：权威存储与读取 | v2 状态、修订/撤销、两个读取契约、依赖适用性、ProjectDirective | 手动小范围写入闭环；未决冲突不被 active 过滤；规则例外、项目权限与撤销生效 |
| C：归档调度 | 资格、Manifest、job、租约、工作单元检查点、预算、恢复 | 假提炼器验证中断窗口、幂等提交、正常续处理与失败计数、并发不丢更新 |
| D：真实提炼契约 | 分批候选、依赖、支持/反证覆盖、冲突、自然语言规则分类 | 严格输入输出和五项晋升条件闭合；用 faux provider 验证完整数据路径 |
| E：运行接入 | 开关、工具默认集合、TUI/RPC/print、状态/trace、legacy、文档 | 无压缩也归档；所有入口统一；针对性回归与根检查通过 |

A 批次同时建立第 3.2 节必需的 v2 状态文件、原子事务和 Run 登记最小实现，B 在同一存储上增加知识与读取契约；不得先造另一种临时权威格式再迁移。

这些是同一目标实现的依赖顺序，不授权多 Agent 并行，不形成长期保留的多套算法。新链路接管时同步替换旧写入/晋升调用、旧工具路径参数及专用无消费者代码；不删除仍服务于手动压缩、Task Note 或原始证据的能力。涉及看似有意保留的功能删除，遵守仓库确认规则。

## 13. 验收矩阵

下表是完整验收矩阵。已自动执行的覆盖项及尚未验证的条目记录在[实施报告](long-term-memory-archive-implementation-report.md)。测试放在 `test/suite/`，用现有 harness 与 faux provider；文件系统恢复使用真实临时文件，跨进程并发使用两个独立实例/进程，时间与竞态使用可控时钟/同步点。断言实际输入、输出、磁盘记录、版本和调用次数，不只 mock 最终判定。无真实 issue 编号时不创建虚构 issue regression 名称。

| ID | 场景 | 必须观察到的结果 | 建议文件 |
| --- | --- | --- | --- |
| A01 | 无压缩完成一轮 | 一个正常 Manifest/job；换窗不是触发前提 | `memory-archive-run.test.ts` |
| A02 | 同请求跨三窗及自动重试 | rootPromptId 不变；来源覆盖各窗；无窗口单独晋升 | 同上 |
| A03 | settled 后延期换窗/交互/续跑 | 等待真正静止后封存 | 同上 |
| A04 | 后台测试未结束、失败或 service 常驻 | dependency 等待；失败不称修复成功；service 不阻塞 | 同上 |
| A05 | 新轮开始后旧 Task 返回 | 更新旧 Run；新要求不被晚到结果覆盖 | 同上 |
| A06 | steering/follow_up/next_prompt、导航/fork | 按实际交付与祖先范围归属；无伪新用户来源 | 同上 |
| E01 | 内部 user 角色消息及扩展改写 | origin 检查拒绝授权升级；原用户输入可定位 | `memory-archive-evidence.test.ts` |
| E02 | 输出超缓冲/存储限额、Unicode 分页 | 丢弃前保存或明确缺口；区间可重建、哈希一致 | 同上 |
| E03 | 子代理 passed/失败/取消与 worktree 清理 | 全路径移交真实证据；自述不授予 tested；父应用不等于父验证 | 同上 |
| E04 | 来源登记各步骤 crash、JSONL 未刷盘 | pending 可对账；未落盘不封存；不重跑原工具 | 同上 |
| E05 | 来源缺失、改写、老化、权限丢失 | 缺口显式；不继续晋升；证据不被笔记老化改写 | 同上 |
| V01 | echo passed、零退出码、无报告 | 不单独授予 tested | `memory-archive-validation.test.ts` |
| V02 | 实现不变但配置/依赖/目录新文件改变 | 声明范围内变化使当前适用性 unknown；无“只查实现哈希”误判 | 同上 |
| V03 | 前后相同但执行中修改后恢复 | endpoint_observed 不升级 controlled_snapshot；不宣称执行中稳定 | 同上 |
| V04 | 依赖不完整、必要文字条件不可判定 | deferred/unknown，不省略条件后晋升 | 同上 |
| V05 | 第一批通过、第三批反证；预算停在中间 | 只存检查点，不提前 active；读完反证后拒绝对应成功命题 | 同上 |
| V06 | 后批新候选、前批存在反证 | 新候选补查前批；空提炼收据不代替反证覆盖 | 同上 |
| V07 | 空候选、达到候选上限、非法 JSON、截断 | 无事实收据与分页/失败区分；未处理范围不被吞掉 | 同上 |
| V08 | 中断 partial、活跃 flush、立即 remember | 仅闭合独立证据可晋升；整轮状态不被伪造 | 同上 |
| V09 | A/B 已是 needs_verification，再来 C | 冲突上下文仍看到 A/B，C 不能绕过未决冲突 | 同上 |
| V10 | 并发插入同范围记录、不同 subject 表述 | 冲突扫描集合版本变化被检测；不只检查已读 ID | 同上 |
| V11 | 有限 flush 已晋升，后续工具结果推翻 | 新来源登记即失效旧事实反证凭据，默认 unknown；重查后按反证处置 | 同上 |
| R01 | Manifest 落盘而 job 未落盘 | 恢复补建同身份 job | `memory-archive-recovery.test.ts` |
| R02 | 模型返回前/后、检查点落盘前 crash | 允许重做无副作用调用；预留额度不返还；无重复知识 | 同上 |
| R03 | 检查点后、最终提交前 crash | 合法检查点复用；变化部分重校验 | 同上 |
| R04 | 最终提交后、确认/展示/索引前 crash | 权威事务有效，原收据可读，派生视图可重建 | 同上 |
| R05 | lease 接替，旧响应晚到 | 旧令牌不能写进度、usage 或知识 | 同上 |
| R06 | 同工作单元连续失败与多片正常分页 | 技术失败达到上限停止；正常分页超过三片仍可完成 | 同上 |
| R07 | 每切片/每小时预算耗尽并重启 | 保存进度和预留；等待额度恢复；不计失败、不忙循环 | 同上 |
| R08 | 同项目两工作器、无关 job 进度变化 | 无丢更新/重复提交；无关 revision 不导致重新提炼 | 同上 |
| D01 | Session B 持续普通提问 | Session A 的不相关归档可完成，无全局 userInputRevision 重启 | `memory-project-directives.test.ts` |
| D02 | 提炼中登记同范围新要求 | 旧验证失效；提交补读投影，不覆盖新规则 | 同上 |
| D03 | 自然语言原文到达、分类前后提交 | 登记前不声称跨 Session 已同步；登记后旧记录也受新要求门禁 | 同上 |
| D04 | 私有来源明确共享规则、不可共享正文 | 只共享获准投影；原文不可跨读；需要正文者有依赖地等待 | 同上 |
| D05 | 范围未知的项目要求、明确不重叠要求 | 前者明确等待；后者不使候选失效；不靠超时忽略 | 同上 |
| D06 | pending 解决、登记失败、两个矛盾要求 | 依赖修订唤醒；失败如实显示；无替代授权则 conflict | 同上 |
| D07 | 首条 remember 或两个同范围 pending 要求 | 自身 pending 与 Memory 原子提交；相互依赖集合一起判定，无自等/互等死锁 | 同上 |
| Q01 | 基础规则加 CLI 例外、检索 top-K=1 | 规则关系完整展开；未知场景不伪报基础规则无例外 | `memory-effective-view.test.ts` |
| Q02 | 撤销/替代时异步向量查询晚到 | search/get/embedding/向量最终结果过滤旧修订 | 同上 |
| Q03 | Git 分支/未提交修改/预算不足 | applicability 与持久 status 分离；unknown 不默认有效 | 同上 |
| Q04 | 其他项目 memoryId、历史选项、路径绕过 | 权限和项目隔离一致，历史标志不扩大授权 | 同上 |
| Q05 | 旧无来源/撤销数据及重新 import/改写文本 | 不自动晋升、不复活撤销，旧 ID 映射保留 | 同上 |
| Q06 | 记录 active 但来源后来丢失 | 有效读取排除；显式调查返回原因 | 同上 |
| U01 | 配置默认/显式工具集合/deny/子代理 | 工具激活严格符合第 10 节 | `memory-archive-integration.test.ts` |
| U02 | TUI/RPC/print、排队成功、归档失败 | 业务与归档状态分离；退出持久化；不伪报已写入 | 同上 |
| U03 | completed job 留 deferred、扫描失败 | status 显示未解决候选和缺失范围，不显示全部完成 | 同上 |
| U04 | remember 后整轮再次归档、重复 flush | 同来源同结论幂等；新范围或明确新要求独立处理 | 同上 |

代码实现后运行每个新增/修改测试及相关定向回归，再按仓库规则执行 `npm run check` 并检查完整输出。不自动运行 `npm run build`、`npm test` 或完整 Vitest suite，不调用真实付费模型做回归。

自动晋升启用前，使用固定、去敏且逐条核对来源的人工标注样本评估晋升准确率、无依据晋升率、冲突处置正确率、过期事实误召回率、有用知识遗漏率、规则意图分类错误和登记延迟，以及每轮调用/token/等待成本。阈值由项目验收确定；尚未确定阈值或未完成评估时不得宣称语义质量验收通过。faux provider 只证明控制契约，不证明语义准确率。

## 14. 源码定位与最终交付标准

以下是基线的实现入口，描述当前代码，不代表本 Spec 已落地：

- [AgentSession](../../src/core/agent-session.ts)：`flushMemoryNow()`、settled、Task 接入和手动压缩后笔记。
- [SessionManager](../../src/core/session-manager.ts)：JSONL、工具来源、交付收据、分支与窗口坐标；新增事件须检查真实持久化行为。
- [MemoryStore](../../src/core/memory/memory-store.ts)：Markdown、compaction 快照、撤销、检索、autoDream 锁与幂等提交。
- [提炼 schema](../../src/core/memory/extraction.ts)与[提炼调用](../../src/core/memory/consolidation.ts)：当前 `text + sourceNoteIds` 契约。
- [TaskManager](../../src/core/tasks/task-manager.ts)、[Task 类型](../../src/core/tasks/types.ts)、[输出缓冲](../../src/core/tasks/task-output-buffer.ts)：内存状态、可选归属、输出保留上限。
- [子代理 Coordinator](../../src/core/subagents/subagent-coordinator.ts)、[子 Session runner](../../src/core/subagents/pi-child-runner.ts)、[结果协议](../../src/core/subagents/protocol.ts)：模型自述、内存 Session、应用补丁和清理顺序。
- [运行说明](../memory-context.md)：现有窗口、History、Note 和 Memory 入口；在 E 批次同步改为已实现的新行为。

交付完成必须同时满足：无压缩也可归档；有效知识有可回读依据和明确条件；分批反证未闭合不晋升；冲突不因过滤而消失；已落盘进度可恢复且知识不重复提交；无关输入和正常预算续处理不制造永久失败；默认读取不绕过状态与适用性；归档故障如实报告。实现报告须列出实际测试、未验证项和语义评估结果，不把本设计文档作为完成证据。
