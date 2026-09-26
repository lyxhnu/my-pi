 # Pi-Agent 改造技术文档

> 记录本项目相对上游 pi-agent 的全部改造：改了什么、怎么改的、解决了什么问题、验证到什么程度。

## 文档说明

| 项 | 内容 |
|---|---|
| 基线 | 上游 `pi-mono` / `pi-agent` |
| 覆盖范围 | `packages/agent`、`packages/coding-agent`、评测适配层 |
| 证据来源 | 当前源码逐符号核对 + 单元测试 + Terminal-Bench 2.0 全量评测 trace |
| 评测环境 | Harbor + Docker + dashscope/qwen3.7-plus，40/87 任务集 |

**阅读提示**：每节按「原来的问题 → 怎么改的 → 对 agent 的帮助」组织。所有常量、符号名均以当前源码为准，不依赖历史总结。

---

## 目录

1. [Length 截断恢复](#1-length-截断恢复)
2. [最终请求预算与自动触发](#2-最终请求预算与自动触发)
3. [Shake 机械式缩减](#3-shake-机械式缩减)
4. [完整工具结果与有界投影](#4-完整工具结果与有界投影)
5. [状态保存、换窗与恢复](#5-状态保存换窗与恢复)
6. [Append-Only Context 与 StablePrefix](#6-append-only-context-与-stableprefix)
7. [记忆系统](#7-记忆系统)
8. [安全执行](#8-安全执行)
9. [Subagent 多 Agent 编排](#9-subagent-多-agent-编排)
10. [其它稳定性与工具生态](#10-其它稳定性与工具生态)
11. [评测基础设施](#11-评测基础设施)
12. [量化结果](#12-量化结果)
13. [已知局限与后续方向](#13-已知局限与后续方向)
14. [附录：文件与测试索引](#14-附录文件与测试索引)

---

## 0. 总览

| # | 改造 | 性质 | 关键指标 |
|---|---|---|---|
| 1 | Length 截断恢复 + thinking 降档 | 缺陷修复 | 9/40 静默 0 分任务被救回 |
| 2 | 最终请求预算与自动触发 | 能力新增 | provider 调用前统一检查实际请求 |
| 3 | Shake 零模型缩减 | 能力新增 | 单次释放约 2 万 token，0 模型调用 |
| 4 | 完整工具结果与有界投影 | 可靠性修复 | 原文单次落盘，provider 批次共享空间 |
| 5 | 状态保存、换窗与恢复 | 能力新增 | 精确引用、恢复门禁与崩溃幂等 |
| 6 | Append-Only / StablePrefix | 能力新增 | 降低 prompt cache 失效 |
| 7 | 记忆向量检索 + 三层降级 | 能力新增 | 语义召回 + 长期膨胀控制 |
| 8 | 命令风险分析 + OS 沙箱 | 缺陷修复 + 能力新增 | 权限误拦截 491 → 0 |
| 9 | Subagent 编排 | 能力新增 | 含 2 个致命 Bug 修复 |
| 10 | LSP / Todo / Plan / print-mode | 缺陷修复 | 消除静默成功与进程崩溃 |
| 11 | 评测基础设施 | 环境修复 | verifier 崩溃 11/40 → 0 |

**总体成绩**：40 任务完成率 40% → 57.5%，McNemar `p=0.0391`（统计显著）。

---

## 1. Length 截断恢复

### 1.1 原来的问题

模型输出打到上限时返回 `stopReason: "length"`。上游只处理「截断消息里有 toolCall」的情况——通过 `failToolCallsFromTruncatedMessage` 把每个调用标记为失败，工具结果既携带了信号又让循环继续。

但对推理模型，最典型的截断发生在**还没产出任何 toolCall 就把预算烧完**。此时：

- `toolCalls.length === 0`
- `hasMoreToolCalls` 保持 `false`
- 循环判定「没有工具调用 = 没事可做」
- 正常发出 `agent_end`，退出码 0

评测 trace 里的典型形态：

```text
turn2  out=32770  stop=length  content=['thinking']
turn3  out=32770  stop=length  content=['thinking']
turn4  out=32770  stop=length  content=['thinking']
```

**9/40 任务死于此，全部 0 分**，且对外表现为「干净成功」——最难排查的失败形态。

此外 `isRetryableAssistantError()` 第一行就是 `stopReason !== "error" → false`，重试链路完全不介入；compaction 走 contextOverflow 分支，也不介入。整条链无兜底。

### 1.2 怎么改的

文件：[`packages/agent/src/agent-loop.ts`](packages/agent/src/agent-loop.ts)

| 符号 | 作用 |
|---|---|
| `createTruncationRecoveryMessage()` | 生成 user 消息：告知输出被截断、要求直接行动、勿复述推理 |
| `THINKING_LEVEL_LADDER` | `["max", "xhigh", "high", "medium", "low", "minimal"]` |
| `degradeThinkingLevel()` | 下降一档；`undefined → "low"`；未知档位直落 `minimal` |
| `thinkingRung()` | 返回档位序号，`undefined` 返回 `-1`（位于阶梯顶端之上） |
| `lowerThinkingLevel(a, b)` | 取更省思考的一个 |
| `truncationFloor` | 循环级变量，跨轮持久保存已付出代价的降档 |
| `MAX_CONSECUTIVE_TRUNCATION_RECOVERIES = 2` | 连续 length 封顶 3 轮（原始 1 次 + 重试 2 次） |

核心逻辑（第 362-375 行）：

```text
若 stopReason === "length" 且 toolCalls 为空：
    若 consecutiveTruncations < 2：
        consecutiveTruncations++
        pendingMessages.push(恢复提示)
        truncationFloor = degradeThinkingLevel(truncationFloor ?? config.reasoning)
        config.reasoning = truncationFloor
否则：
    consecutiveTruncations = 0
```

### 1.3 三个必须说清的设计细节

**（1）必须注入消息，不能只置 `hasMoreToolCalls = true`**

`agentLoopContinue` 里有明确不变量：

```ts
if (context.messages[context.messages.length - 1].role === "assistant")
    throw new Error("Cannot continue from message role: assistant");
```

截断消息已经 push 进 `context.messages`，且 `convertToLlm` 对 assistant 消息原样下发。若只续轮，上下文末尾是只含 thinking 的 assistant 消息，provider 会拒绝请求。注入 user 消息同时满足「携带反馈」和「修复上下文形状」两个需求。

**（2）降档必须放在 `prepareNextTurn` 之后**

`AgentSession._installAgentNextTurnRefresh` 每轮**无条件**返回 `thinkingLevel: state.thinkingLevel`，即 session 的持久值。执行时序是：

```text
LLM 调用 → prepareNextTurn（重置档位）→ 降档
```

如果降档基于被重置后的值，每轮都从起点降一级，永远停在第一档 `low`。评测中 `circuit-fibsqrt` 四轮输出完全相同（32770 × 4）就是这个原因。

修法：引入跨轮持久的 `truncationFloor`，并在 `prepareNextTurn` 应用之后强制压回（第 337-339 行）：

```ts
if (truncationFloor !== undefined) {
    config = { ...config, reasoning: lowerThinkingLevel(config.reasoning, truncationFloor) };
}
```

**（3）`undefined` 不是「关闭思考」，而是「用模型默认」**

初版设计假设 `undefined` 表示关闭，实测推翻了这个前提。对 dashscope/qwen3.7-plus 固定同一 prompt：

| 设置 | reasoning_tokens |
|---|---|
| 不传参数 | **1323** |
| `reasoning_effort=low` | 1114 |
| `reasoning_effort=minimal` | **无** |

所以「不传」反而是最费的。降级链必须从未设置**降入**一个显式档位，真正的地板是 `minimal` 而非 `undefined`。

### 1.4 对 agent 的帮助

模型撞上限不再假装完成，而是被拉回来、且用更小的思考预算重试。实测轨迹变化：

```text
修复前:  L L L                      三轮全截断，直接死，0 分
修复后:  T T T T T L N T T T T S    干活5轮 → 截断 → 注入 → 又干活4轮 → 正常收尾
                    ↑ 注入点
```

---

## 2. 最终请求预算与自动触发

### 2.1 原来的问题

只读取上一轮 usage 或在整个 prompt 结束后检查容量，无法覆盖 transform、工具 schema、队列交付、append-only 重建和本轮完整工具结果。守卫可能过早停止，也可能把实际超限请求交给 provider。

### 2.2 怎么改的

`packages/agent/src/agent-loop.ts` 的 `prepareAgentRequest()` 在所有上下文转换完成后计算同一份 `ContextBudget`。输入、当前请求输出预留和安全余量必须落在模型窗口内。`Agent.controlRequest` 在 provider 调用前消费该结果；`afterTurnControl` 只在完整 assistant/tool-result 批次结束后推进控制状态。

`packages/coding-agent/src/core/agent-session.ts` 将 `model_requested`、`work_budget_reached` 和 `provider_context_rejected` 收敛到同一条 save_state → rollover 链路。`compaction.enabled=false` 只关闭自动触发，不关闭硬容量检查。显式 `/compact` 继续是独立的手动摘要操作。

### 2.3 对 agent 的帮助

任何实际请求都在发送前得到结构化的 fits、work threshold 或 context_limit 结论。超限不再伪报完成；进入容量维护后也不会执行未获准的业务工具。

---
## 3. Shake 机械式缩减

### 3.1 原来的问题

腾空间只有 compaction 一条路：要调一次模型、有 300 秒墙钟预算、可能超时。而大多数阈值越线其实是被几个超大工具结果撑起来的，用一次模型调用去解决「删掉一坨日志」这种事并不划算。

### 3.2 怎么改的

文件：[`packages/agent/src/harness/compaction/shake.ts`](packages/agent/src/harness/compaction/shake.ts)

定位上下文中最重的区域（整个工具结果、大的 fenced / XML 块），替换为占位符，**零模型调用**。

导出：`collectShakeRegions` / `buildRedactions` / `applyRedactions` / `buildShakenIndex` / `resolveShakeConfig`。

三档预设：

| 预设 | protectTokens | minSavings | cacheWarmSuffix | 用途 |
|---|---|---|---|---|
| `DEFAULT_SHAKE_CONFIG` | 16000 | 4000 | 100000 | 阈值压缩前先试 |
| `AGGRESSIVE_SHAKE_CONFIG` | 4000 | 0 | 不设 | 手动 `/shake` |
| `RESCUE_SHAKE_CONFIG` | **0** | 0 | 不设 | 压缩预算耗尽后兜底 |

`fenceMinTokens: 400` 统一，`DEFAULT_PROTECTED_TOOLS = ["todo_write", "enter_plan_mode", "exit_plan_mode"]`。

### 3.3 三个设计要点

**保护近期尾部**：`protectTokens` 保证正在使用的结果不被抽走。

**保护缓存热区**：`cacheWarmSuffixTokens: 100000` 避免动到 provider 缓存前缀——省了 token 却触发全量 re-prefill 是负收益。

**保护状态类工具**：`todo_write` 回显的是活跃待办列表，plan-mode 结果承载着长期约束。抹掉任何一个都等于让 agent 失去正在依据的状态。

**`RESCUE` 的 `protectTokens: 0` 是刻意的**：堵住上下文的往往正是最新那个超大结果，一个不能删掉「堵塞物」本身的救援方案不是救援。

**持久化**：redaction 写成 `shake` session 条目，重载会话时重放，缩减不会失效——这比就地改写 append-only 日志更安全。

### 3.4 对 agent 的帮助

实测 `path-tracing`、`video-processing` 各释放 18270 / 20494 token，`reason=threshold`，零模型调用。修复判据统一前，整轮 87 个任务 shake 触发 0 次；修复后 4 个任务就触发 2 次。

---

## 4. 完整工具结果与有界投影

工具和 result hook 完成后，`tool_result_source` 先保存完整 terminal result，再生成发给模型的有界投影。一个 assistant 批次共享投影空间，每个 `toolCallId` 都保留 terminal result；被截出的文本带原始 entryId、范围和 `history.read_item` 分页提示。History 从权威 source 读取正文及 details，重启不会把完整大结果重新注入工作上下文。

保存和恢复阶段的 History/Note 查询也共享一个阶段额度。同批读取调用在执行前获得固定份额，结束后按实际占用结算，避免同步返回让每个并行查询重复取得整份预算。

---

## 5. 状态保存、换窗与恢复

达到工作预算或模型调用 `new_context` 后，当前工具批次先完整结束。一个 source window/promptGeneration 只建立一个持久化 save_state 操作；最多 3 次 sampling、2048 输出 token 和 3072 查询/结果 token，只开放 `history`、`context_note`、`get_context_remaining`、`new_context`。

完成条件是有效的 `next_action/current`。其 `resume` 明确列出相关 Note、History、用户要求来源和 Todo ID。保存完成后仍会核对新用户事实、Todo、权限、工具配置及来源 revision；变化时在同一操作的剩余额度内重新确认。

rollover 只保存引用、版本、窗口身份和请求指纹。提交前使用实际转换链预检必读正文、分页开销、完整业务工具定义、正常输出、安全余量和后续保存空间。无法容纳时以 `recovery_workset_too_large` 保留旧窗口。

新窗口先以固定 bootstrap 和恢复工具启动。只有当所需 Note、History 与匹配 revision 的 Todo 正文确实出现在最终 provider 请求里，下一请求才开放业务工具。同一批恢复读取后的业务调用仍被阻止；连续 3 次没有覆盖进展会返回 `recovery_no_progress`。

保存操作、rollover proposal、队列 reservation 和 dispatch 都写入 Session。已完成的本地保存结果在重启后直接校验；不完整工具事务不重放。prepared dispatch 必须复现相同请求，started 未 finished 保持 `outcome_unknown`。

---
## 6. Append-Only Context 与 StablePrefix

### 6.1 原来的问题

默认路径每轮重建并重新序列化整段 transcript。provider 按请求的**字节前缀**命中 KV 缓存，任何重建扰动了早期消息，后面全部失效并重新计费 prefill。

### 6.2 怎么改的

文件：[`packages/agent/src/append-only-context.ts`](packages/agent/src/append-only-context.ts)

**StablePrefix**：system prompt 与 tool specs 快照一次，只有指纹真变了才重建。指纹契约（L329-342）显式声明哪些输入会影响序列化字节：

```ts
{ s: systemPrompt, t: tools.map(...), i: intentTracing, pd: pruneToolDescriptions }
```

**AppendOnlyLog**：消息只增长。正常轮次只追加新尾部。

**messageDigest()**：对 role、content、toolCalls、toolCallId、toolName、isError、id 做哈希。就地改写某条消息时，`syncMessages()` 只从改动处之后重发，而不是整段重发。

开关：`AgentOptions.appendOnlyContext` / 配置项 `context.appendOnly`，默认 `false`。

### 6.3 已知的缓存稳定性风险（诚实记录）

| 风险 | 位置 | 说明 |
|---|---|---|
| 就地改写破坏 append-only 假设 | `pruning.ts` L297、`shake.ts` L424 | 都直接 `message.content = [...]` 并设 `prunedAt` |
| 工具数组顺序敏感 | `agent-loop.ts` `normalizeTools` L852-876 | 每轮 `.map()` 造新对象；MCP 工具异步到达导致顺序变化时，逻辑内容相同但字节不同 |

**教训**：不要从「逻辑内容等价」推断「字节稳定」。设计上不假设稳定，而是用 digest 比较把变化显式检测出来。

`bashExecutionToText`（`messages.ts` L63-79）是纯函数、无副作用、不含时间值，保证摘要确定性——这是缓存正确性的前提之一。

---

## 7. 记忆系统

记忆域从「纯关键词 Markdown 检索」升级为「语义融合检索 + 时效加权 + 年龄降级」。

### 7.1 模块结构

| 文件 | 职责 |
|---|---|
| `memory/memory-store.ts` | 核心存储、六步融合检索、autoDream、tombstone |
| `memory/embeddings.ts` | OpenAI 兼容 embedding 客户端 |
| `memory/memory-index.ts` | JSON 侧车向量索引 |
| `memory/degrade.ts` | 三层年龄降级 |
| `memory/mmr.ts` | 最大边际相关性重排 |
| `memory/secret-filter.ts` | 敏感信息拦截 |

存储布局：

```text
~/.pi/agent/MEMORY.md                                  全局记忆（人工确认）
~/.pi/agent/memory/<workspace_hash>/MEMORY.md          项目记忆
~/.pi/agent/memory/<workspace_hash>/sessions/*.md      会话笔记
~/.pi/agent/memory/<workspace_hash>/.memory-index.json 向量索引侧车
~/.pi/agent/memory/<workspace_hash>/.dream-state.json  consolidation 状态
~/.pi/agent/memory/<workspace_hash>/.dream.lock        并发锁
```

### 7.2 向量召回通道

| 常量 | 值 | 说明 |
|---|---|---|
| `EMBED_BATCH_SIZE` | 32 | 批量嵌入 |
| `EMBED_MAX_CHARS` | 4000 | 单条文本上限 |
| `EMBED_TIMEOUT_MS` | 10000 | 请求超时 |
| `MEMORY_INDEX_VERSION` | 1 | 索引版本，不匹配则重建 |
| `MAX_EMBED_BATCHES_PER_SEARCH` | 4 | 单次搜索最多补 4 批，避免首次搜索卡死 |
| `VECTOR_MIN_SIMILARITY` | 0.3 | 余弦相似度下限 |
| `VECTOR_WEIGHT` / `KEYWORD_WEIGHT` | 0.6 / 0.4 | 融合权重 |

向量做 L2 归一化后用点积等价计算余弦。索引增量更新：只对新增或变更的 block 补嵌入，`model` 变更则整体重建。

**关键设计——默认零影响**：

```text
resolveEmbeddingConfig() 要求 baseUrl + model + apiKeyEnv 全部配齐
且环境变量确有值，否则返回 undefined
```

`applyVectorChannel()` 是 best-effort：任何异常（网络、鉴权、超时）都静默降级到纯关键词，不抛出。**未配置 embedding 的用户行为与改造前完全一致。**

配置项：`memory.embedding.{baseUrl, model, apiKeyEnv, dimensions}`。

### 7.3 六步融合检索管道

```text
1. 候选扫描      global/project MEMORY.md + sessions 目录
2. 关键词打分    term scoring
3. 向量通道      嵌入 query → 加载/补全索引 → 余弦筛选
4. 分数融合      0.6 × cosine + 0.4 × keywordNorm（未配置时纯 keyword）
5. 衰减          × recencyFactor × tierWeight
6. MMR 重排      lambda=0.7，pool cap=50
```

时间衰减参数：

| 参数 | 值 |
|---|---|
| `RECENCY_FLOOR` | 0.7（旧记忆至少保留 70% 分数） |
| curated MEMORY.md 半衰期 | 2160 小时（90 天） |
| session note 半衰期 | 14 天 |

**为什么要 MMR**：纯相关性排序会让几条近重复的笔记挤满结果，把互补信息挤掉。MMR 在相关性和多样性之间取平衡（Jaccard 相似度衡量冗余）。

### 7.4 三层年龄降级

| 层 | 触发 | 处理 | 搜索权重 |
|---|---|---|---|
| 1 | 新 | 原文 | 1.0 |
| 2 | > 30 天 | 截断到 800 字符 | 0.85 |
| 3 | > 180 天 | 仅保留 heading 与 list 行（300 字符） | 0.7 |

- 标记方式：首行 HTML 注释 `<!-- memory-tier:N degraded:... -->`，`parseTierMarker()` 解析
- 幂等：目标层级不高于当前层级则不动
- `extractKeySignal()`：优先保留 `#` 标题与 `-`/`*`/`1.` 列表行，预算耗尽则回退前缀截断
- **curated `MEMORY.md` 永不降级**——那是人工确认过的内容
- 在 autoDream 期间 best-effort 执行，受 dream lock 保护

**降级前先剥离 tier marker**，避免 marker 污染 consolidation 生成的 MEMORY.md。

### 7.5 autoDream 自动整合

```text
每次 compaction（memory.enabled 为真时）：
    degradeSessionNotes()   → 三层降级
    writeSessionNote()      → 写入本次压缩摘要
    maybeConsolidate()      → 满足门控则合并到项目记忆
```

门控条件：

| 条件 | 默认值 |
|---|---|
| 距上次 consolidation 最小间隔 | 24 小时 |
| 新增 session note 数量 | ≥ 3 |
| 并发锁 | `.dream.lock`，10 分钟 stale 自动回收 |

**只写 project 记忆，永不自动写 global**——全局记忆必须人工确认。

与 Phase 1（`compaction.memoryFlushEnabled`，把压缩摘要直接写入项目记忆）是两个独立能力，默认均为关闭。

### 7.6 其它机制

- **tombstone**：`undo(scope, cwd, id)` 只往 `.tombstones.json` 追加标记，不物理删除；搜索时跳过
- **secret-filter**：`checkMemoryCandidate()` 检测 token / password / key / credential / auth header 模式，并做 Shannon 熵检验；所有写入路径统一经过
- **用户入口**：`memory_search` / `memory_get` 工具，`/memory flush`、`/memory undo` 命令，`flushMemoryNow()` API

### 7.7 对 agent 的帮助

记忆从「字面命中」升级为「语义命中 + 时效加权 + 多样性去重」，同时靠年龄降级控制长期膨胀。全链路 best-effort，任何环节失败都不阻塞 compaction 主流程。

---

## 8. 安全执行

### 8.1 背景：一次测错了对象的评测

引入 `PermissionService` 后，headless 模式（`pi -p`）没有审批通道，`ask` 档 fail-closed 变成 deny。后果：

| 指标 | 数值 |
|---|---|
| 权限拒绝次数 | **491** |
| 涉及任务 | **33 / 40** |
| 中位轮数 | 13 → **31** |

被拦命令 TOP：`1`（143 次）、`python3`（57）、`cd`（26）、`apt-get`（19）、`mkdir`（17）、`pytest`（14）。

trace 里能看到 agent 跑去读 pi 自己的 `policy.ts` 找出路、试图改 `settings.json` 自救。**那一轮测的是权限层，不是 agent。**

### 8.2 六个命令解析缺陷

文件：[`permissions/command-analyzer.ts`](packages/coding-agent/src/core/permissions/command-analyzer.ts)

| # | 缺陷 | 现象 | 修法 |
|---|---|---|---|
| 1 | 裸 `&` 无条件切段 | `ls -la 2>&1` 被切成两段，运行命令被识别为 `1`，**143 次拦截** | `isRedirectionAmpersand()` 检查 `&` 前后字符，识别 `2>&1`/`>&2`/`&>`/`\|&` |
| 2 | fd 复制被读成文件名 | `findOutputRedirectionTargets` 把 `2>&1` 的 `1` 当写入目标 | 遇 `&` 直接 `continue`，排除 `&1`/`&2`/`/dev/null` 等 |
| 3 | argv0 字符集缺 `+` | `g++` 被截成 `g`（白名单失效）；反向 `git+evil` 截成 `git` **误判 safe** | 字符集加入 `+` 和 `[` |
| 4 | 前置赋值被当命令名 | `DEBIAN_FRONTEND=x apt-get` 把赋值当 argv0，**掩盖了真正该审查的 `apt-get`** | `stripLeadingAssignments()` 循环剥离（上限 16 次防病态输入） |
| 5 | 版本化 / 交叉工具链不识别 | `python3.13`、`gcc-13`、`mipsel-linux-gnu-gcc` | `isSafeArgv0()` + `CROSS_TOOLCHAIN_RE` 提取末段工具名 |
| 6 | 白名单过窄 | 仅 28 项 | 扩至 **149 项**，覆盖常用开发工具链 |

**缺陷 3 同时是安全漏洞**：不只是漏拦（`g++` 被拦），更是误放（`git+evil` 被当成 `git` 放行）。这类前缀碰撞必须有反向断言测试。

**有意保留为受保护的命令**：`rm`、`sudo`、`apt`、`curl` 管道执行等，以及任务生成的二进制（无法静态验证）。

### 8.3 权限模式

`PermissionMode = "default" | "acceptEdits" | "auto" | "dontAsk" | "bypassPermissions" | "plan"`

- 支持 allow / deny 规则
- 决策写入 `~/.pi/agent/audit/permissions.jsonl`，便于事后审计「更严格模式会拦住什么」
- Plan 模式自动切换为只读工具集

### 8.4 OS 级沙箱

文件：`core/sandbox/`

| 维度 | 取值 |
|---|---|
| `profile` | `workspace` / `devbox` / `read-only` / `strict` / `off`，或 `{ custom }` |
| `childNetwork` | `unrestricted` / `blocked` / `websites` |
| `mode` | `best-effort`（不支持时降级）/ `required`（不支持时报错） |
| 后端 | macOS `sandbox-exec`，Linux `bubblewrap` |

- `devbox` 额外放开 `~/.npm`、`~/.cache` 写权限
- **Subagent 绑定**：`read-only` 能力模式继承 read-only profile，其余继承 workspace
- 已知限制：`websites` 的按域名过滤在 sandbox-exec 下无法实现；Windows 支持不完整

**另一个曾经的死代码问题**：`getSandboxSettings()` 一度从未被调用，用户为主会话配置的 `sandbox.profile` 完全不生效。补 `hasExplicitSandboxSettings()` 后，主会话 bash 在用户显式配置时才接入沙箱。

### 8.5 对 agent 的帮助

权限误拦截 **491 → 0**，中位轮数回落到 14；同时保留 OS 级真实隔离，而非仅有应用层检查。

---

## 9. Subagent 多 Agent 编排

### 9.1 架构

```text
SubagentCoordinator   编排：深度门控、隔离、resume、输出格式化
        ↓
    TaskManager       状态：统一管理 background bash / subagent / lsp
        ↓
   pi-child-runner    执行：构造嵌套 AgentSession
```

分层目的：coordinator 保持运行时无关，理论上可换成进程外 runner 而不动 TaskManager 接线。

### 9.2 能力矩阵

| 维度 | 内容 |
|---|---|
| 类型 | `general-purpose`（全权）/ `explore`（只读侦察）/ `plan`（只读规划） |
| 能力模式 | `read-only` / `read-write` / `execute` / `all` |
| 执行方式 | 默认后台返回 `task_id`；`run_in_background=false` 前台阻塞，`FOREGROUND_WAIT_MS = 600000` |
| 隔离 | `none` / `worktree`（best-effort git worktree，失败回落父 cwd） |
| 续跑 | `resume_from` 把上一个 subagent 的输出作为上下文前缀 |
| 深度 | `MAX_SUBAGENT_DEPTH = 1` |

**深度门控是物理移除而非停用**：达到上限时 `task` / `get_task_output` / `kill_task` 从工具注册表中删除，`getAllTools()` 里都查不到，杜绝孙子代理。

**输出协议**：

```text
<subagent_meta>
agent_type: explore
capability_mode: read-only
isolation: none
cwd: ...
status: completed
</subagent_meta>
<subagent_result>
...
</subagent_result>
```

子会话使用 `SessionManager.inMemory()`，transcript 不作为顶层会话持久化，结果通过 TaskManager output buffer 回传父代理。

### 9.3 两个致命 Bug

历史评测中 Subagent 触发 **0 次**。初步归因为「模型缺乏主动委派意识」，但实测推翻了这个单一解释——真实原因有两层。

#### Bug 1：Subagent 用完不放行（进程级资源泄漏）

**复现**：用真实 qwen3.7-plus 明确要求委派，JSONL 显示全链路正常：

```text
task 调用成功 → 子代理返回 SUBAGENT_OK → 父代理返回 PARENT_OK
→ agent_end → agent_settled → 进程挂满 600 秒被外层超时
```

对照组（禁止使用任何工具）立即退出，确认与 Subagent 强相关。

**根因**：`TaskManager.wait()` 里前台等待创建了一个 600 秒 `setTimeout`。`Promise.race` 因任务完成而提前 resolve 后，定时器**没有被 clearTimeout**，继续占住 Node 事件循环。

**修法**：

```ts
let timeout: ReturnType<typeof setTimeout> | undefined;
try {
    await Promise.race([
        Promise.all(pending.map((r) => r.settled)),
        new Promise<void>((resolve) => { timeout = setTimeout(resolve, timeoutMs); }),
    ]);
} finally {
    if (timeout) clearTimeout(timeout);
}
```

**危害**：若模型在评测中调用前台 Subagent，任务会白白多挂 10 分钟，直接造成超时失败。

#### Bug 2：CLI 里 Subagent 默认没激活

**根因**：`createAgentSession()` 用一个遗留的四工具列表覆盖了 AgentSession 的默认激活集：

```ts
const defaultActiveToolNames: ToolName[] = ["read", "bash", "edit", "write"];
```

`task` / `get_task_output` / `kill_task` 虽然注册了，但**默认不激活**，模型在工具列表里根本看不到它们。

**为什么单测没抓到**：现有 Subagent 测试全部绕过 SDK 直接构造 `AgentSession`，走的是 AgentSession 自己的完整默认列表。这是典型的「测试与真实入口走了不同路径」。

**修法**：不传工具策略时让 `initialActiveToolNames` 保持 `undefined`，由 AgentSession 拥有唯一的默认列表来源。

**验证**：修复后不指定 `--tools` 也能触发：

```text
父Agent调用 task → 子Agent返回 SUBAGENT_OK → 父Agent返回 PARENT_OK → 进程正常退出
```

新增回归：SDK 默认激活集包含三个 Subagent 工具；显式 allowlist 仍然严格生效；`TaskManager.wait` 提前完成后 `vi.getTimerCount() === 0`。

### 9.4 诚实结论

Subagent 属于「架构已落地、单测已覆盖、真实模型可触发」，但**不能把评测分数提升归因于它**。原因有二：一是历史评测被 Bug 2 屏蔽；二是即便修好，TB2 多为单工作区连续操作，模型在无强引导时仍倾向直接用 bash。要让它真正产生收益，需要显式编排策略或跨工作区任务设计。

---

## 10. 其它稳定性与工具生态

| 项 | 原问题 | 修法 | 帮助 |
|---|---|---|---|
| **Todo / Plan 持久化** | 只在内存，session 重启丢失 | `TodoStateStore.toJSON/fromJSON` + `todo_write` 的 `onChange` 回调写 session custom entry；构造时恢复。`PlanModeState` 同样持久化，`awaiting_approval` 恢复时收敛为 `planning`（PendingInteraction 无法跨进程存活，但其禁用变更的意图不应蒸发） | 长任务断点续跑不丢计划 |
| **LSP 韧性** | server 崩溃后所有语言服务请求失败 | 自动重启，`MAX_SERVER_RESTARTS = 2` 防崩溃循环；15 秒初始化超时；`instance.initialized.catch()` 防 unhandled rejection；`proc.stdin.on("error")` 防 EPIPE 崩掉整个进程 | 语言服务故障不再拖垮 agent |
| **print-mode 静默成功** | 末轮 `length` 落进 else 分支，只打印 text；而截断消息只有 thinking 没有 text，于是打印空、退出 0 | 检测末轮 `stopReason === "length"` → stderr 输出说明 + `exitCode = 1`。只看最后一条消息，中途被成功恢复的 length 不误报 | 失败对自动化框架可见 |
| **write 全文重写** | 单次 write 耗时 2.7~3.6 分钟；`adaptive-rejection-sampler` 重写同一文件两遍耗 6.7 分钟后超时 | 强化 `promptGuidelines`：讲清代价（逐行重现要花 output token、远慢于 edit、有损坏已正确部分的风险），而非单纯下禁令 | 降低超时率 |
| **MCP 工具膨胀** | 全量 tool schema 挤占上下文 | 两阶段发现：`search_tool` 找工具 → `use_tool` 调用 | 节省上下文预算 |
| **新增工具** | — | `memory_search`、`memory_get`、`lsp`、`web_fetch`、`web_search` | 扩展能力边界 |

**关于 print-mode 退出码的风险验证**：改为 `exitCode = 1` 前，需确认不会让本可通过的任务被判失败。查 Harbor 源码 `_exec` 在非零退出码时抛 `RuntimeError`，但历史数据里找到反例——`headless-terminal` 任务 agent 抛了 `AgentTimeoutError`，verifier 照样给了满分。证明 agent 阶段异常不阻断判卷。

---

## 11. 评测基础设施

这些不是 agent 能力问题，但直接决定结论是否可信。

### 11.1 verifier 缺少 Python

**根因**：`patch_tb2_tests.py` 向测试脚本注入：

```bash
HARNESS_PY=$(command -v python3 || command -v python)
$HARNESS_PY -m pytest
```

但 docker 实测确认 TB2 镜像里 `python3` 和 `python` **都不存在**，脚本直接死在 `-m: command not found`，**无条件 0 分**。

**为什么 harness 基线没踩坑**：harness agent 为自己安装 standalone CPython，顺手满足了 verifier 的隐藏依赖。pi 只装 node，所以中招。

**影响**：pi 11/40 崩溃，harness 0/40。

**决定性验证**：从 trace 取出 pi 写的正则，用任务官方测试单独跑 → **PASS**，却被判 0 分。证明是判卷环境问题，不是能力问题。

**修法**：镜像无 python 时解包离线 CPython 并 symlink 到 `/usr/local/bin`，**绝不覆盖镜像自带解释器**（任务可能依赖那个特定版本）。

### 11.2 headless 权限 fail-closed

评测容器本身就是隔离边界，故设 `permissions.mode = bypassPermissions`，同时保留 `audit: true` 写盘，事后仍可审计「更严格模式会拦住什么」。

### 11.3 maxTokens 与 thinking 配置

- 探测确认 provider 接受 `max_completion_tokens=65536`（含带/不带 `reasoning_effort` 两种情况），据此从 32768 上调
- 配合 `OUTPUT_HEADROOM_MAX_TOKENS` 封顶，避免守卫过早触发
- `thinkingLevelMap` 显式映射 `low`/`minimal`/`off`，避免回落到 provider 默认预算

**两次盲配教训**：

1. 数字型 `reasoning_effort`（如 `8192`）被 provider 拒绝，只接受枚举值 `low`/`minimal`
2. 自动兼容检测把 DashScope 识别为 Qwen 分支，只发 `enable_thinking`，导致 provider 用默认 thinking_budget 等于 `max_completion_tokens` 而报 400

**结论**：任何 provider 参数改动前必须做探针调用，不能靠推断。

### 11.4 硬门校验脚本

`.gate_check.py` 统计并断言：

| 指标 | 门槛 |
|---|---|
| 末轮 `toolUse` 且零缩减、非超时（守卫掐断） | 0 |
| 上下文峰值 > 95% 且零缩减 | 0 |
| 单 prompt 内 compaction > 3 次 | 0 |
| 末轮 `length` 且无 toolCall | 0 |
| 连续 length > 3 次 | 0 |
| 权限拦截 | 0 |
| verifier 崩溃 | 0 |

**统计口径易错点（已在脚本内注明）**：compaction / shake 是 session **entry** 类型，不是消息；truncation nudge 是 **user** 消息而非 assistant。早期两次手工统计都栽在这里。

---

## 12. 量化结果

### 12.1 演进轨迹

| 轮次 | 通过 | 权限拦截 | verifier 崩溃 | 中位轮数 |
|---|---|---|---|---|
| harness 基线 | 18/40 (45.0%) | 0 | 0 | — |
| pi 改动前 | 16/40 (40.0%) | 0 | 11 | 13 |
| 权限层裸奔 | 15/40 (37.5%) | **491** | 12 | **31** |
| 修权限层 | 16/40 (40.0%) | 0 | 11 | 14 |
| + 修 verifier | 19/40 (47.5%) | 0 | 0 | 14 |
| **+ 上下文与截断** | **23/40 (57.5%)** | 0 | 0 | 14 |

### 12.2 显著性

- 改动前 → 最终：赢 8 输 1，McNemar `p = 0.0391`（显著）
- 对 harness 基线：赢 8 输 3，`p = 0.227`（不显著，不做过度声明）

### 12.3 机制级证据

| 机制 | 证据 |
|---|---|
| 权限层 | 拦截 491 → 0，跑偏任务 33/40 → 0/40 |
| verifier | 崩溃 11/40 → 0，直接救回 3 个任务 |
| 命令解析 | 420 条真实被拦命令回放，**62% 转为放行** |
| length 恢复 | 11 次触发、覆盖 6 个任务，轨迹从 `L L L` 变为 `L N T...S` |
| 判据统一 | 掐断任务 13 → 0；shake 首次真实触发 |
| 单元测试 | agent 304+、coding-agent 1889，无新增失败 |

---

## 13. 已知局限与后续方向

### 13.1 尚未解决

| 项 | 说明 |
|---|---|
| 单轮工具结果超大 | `raman-fitting` 从 67846（52%，守卫判定宽裕）单轮跳到 137063，一步跨过窗口。守卫在轮次之间检查，无法预知下一个工具会返回多大。要修需在工具结果层面截断 |
| append-only 与就地改写冲突 | shake / pruning 都会 `message.content = [...]`，与 append-only 假设相悖；`normalizeTools` 顺序敏感 |
| host 刷新与用户主动切档不可区分 | `truncationFloor` 会同时压住两者。要精确区分需在 `AgentLoopTurnUpdate` 上增加「例行刷新 vs 显式意图」标记，属 API 变更 |
| DashScope `reasoning_effort` 兼容链 | 评测侧暂时关闭，靠 `maxTokens=65536` 止血；`thinkingFormat` 未完全打通 |
| Subagent 主动调用意愿 | 需要显式编排策略或跨工作区任务设计才能产生实际收益 |
| VerifierTimeout | 三个 PyTorch 任务 `timeout_sec = 900` 且 `MULTIPLIER` 只作用于 agent 阶段。需区分「基础设施超时」与「agent 产物死锁」，且 harness 与 pi 必须用同一预算 |

### 13.2 评测方法学注意事项

1. **噪声底噪 ±3~5**：n=40、0/1 评分、单轮，同一 agent 同任务轮间会翻面。87 任务扩样后落在 48.2%，真实水平线大致在此区间。
2. **网络污染会毁掉整轮**：曾有一轮 32/40 任务撞 `Connection error`，4/40 完全不可用。**跑前必须验证 DNS + provider 可达**。
3. **产物必须核验**：曾出现 tarball 过期 16 个源文件、shake 完全不在产物中的情况，直接跑等于测了旧代码。
4. **路径分叉率 87%**：同一模型同一题两次运行，头三步就分叉。分数结论需重复测量才成立。

### 13.3 待办

- [ ] 重建 runtime 并重跑评测（TaskManager 定时器与 SDK 默认工具修复尚未进入任何评测轮次）
- [ ] 补 print 模式调用 Subagent 后正常退出的**进程级**回归测试
- [ ] 补齐 CHANGELOG：上下文守卫、length 恢复、print-mode 退出码、两个 Subagent Bug 均未记录
- [ ] 工具结果层面的单轮超大输出截断
- [ ] VerifierTimeout 与 agent 失败分开统计

---

## 14. 附录：文件与测试索引

### 14.1 核心改动文件

| 文件 | 改动内容 |
|---|---|
| `packages/agent/src/agent-loop.ts` | 最终请求预算、完整工具批次控制、length 恢复 |
| `packages/agent/src/agent.ts` | PreparedContinuation、预算测量、结构化运行结果 |
| `packages/agent/src/append-only-context.ts` | StablePrefix / AppendOnlyLog / messageDigest |
| `packages/agent/src/harness/compaction/shake.ts` | shake 算法与三档预设 |
| `packages/coding-agent/src/core/agent-session.ts` | 保存/恢复控制、最终请求守卫、工具结果投影、记忆与 Todo 接线 |
| `packages/coding-agent/src/core/context-rollover.ts` | 保存契约校验、恢复工作集预检、CAS 提交与 dispatch |
| `packages/coding-agent/src/core/tasks/task-manager.ts` | 定时器泄漏修复 |
| `packages/coding-agent/src/core/sdk.ts` | 默认激活工具集修复 |
| `packages/coding-agent/src/core/memory/*` | 向量检索、三层降级、MMR、secret filter |
| `packages/coding-agent/src/core/permissions/command-analyzer.ts` | 六个解析缺陷 + 白名单扩充 |
| `packages/coding-agent/src/core/sandbox/*` | OS 级沙箱 |
| `packages/coding-agent/src/core/subagents/*` | Subagent 编排 |
| `packages/coding-agent/src/core/lsp/*` | 崩溃重启、EPIPE、rejection 处理 |
| `packages/coding-agent/src/core/tools/write.ts` | promptGuidelines |
| `packages/coding-agent/src/modes/print-mode.ts` | length 退出码 |
| `benchmarks/pi_agent.py` | bypassPermissions、CPython、maxTokens、thinkingLevelMap |

### 14.2 测试索引

| 测试文件 | 覆盖 |
|---|---|
| `packages/agent/test/agent-loop.test.ts` | 降档链、truncationFloor、host 每轮重置下仍能下探、上限封顶、计数重置 |
| `packages/agent/test/append-only-context.test.ts` | 指纹变化检测、消息重写后稳定前缀保留、模型切换 |
| `packages/agent/test/shake-regions.test.ts` | 区域收集与 redaction 构建 |
| `test/suite/context-window-memory.test.ts` | 三类触发、状态保存、恢复覆盖、并发、重启与 HTML 导出 |
| `test/suite/grok-alignment/subagent-task-tool.test.ts` | 注册、深度门控、前后台执行、resume 错误 |
| `test/suite/grok-alignment/subagent-depth.test.ts` | 深度不变量与物理移除 |
| `test/suite/grok-alignment/subagent-sandbox-binding.test.ts` | 子代理沙箱边界 |
| `test/suite/grok-alignment/task-output-kill-task.test.ts` | 任务轮询、取消、级联取消、**定时器清理** |
| `test/suite/grok-alignment/memory-autodream.test.ts` | 时间与计数双门控 |
| `test/memory-embeddings.test.ts` | 配置解析、向量通道构建/复用/模型升级、降级回退 |
| `test/memory-degrade.test.ts` | 三层降级、幂等、搜索侧权重 |
| `test/sdk-session-manager.test.ts` | **SDK 默认激活集**、显式 allowlist 仍严格 |
| `test/print-mode.test.ts` | error 与 length 的退出码 |
| `test/command-analyzer.test.ts` | fd 复制、版本化二进制、交叉工具链、前缀碰撞反向断言、前置赋值 |

### 14.3 回归基线（判断「无新增失败」的对照）

均为环境问题，非本项目引入：

- `packages/agent`：`test/harness/tools.test.ts` 的 bash 50ms 超时用例，计时敏感 flaky
- `packages/coding-agent`：5 个既有失败——Cloudflare 模型目录漂移 ×2、package-manager 网络/真实 home 污染 ×2、计时 flaky ×1
- `npm run check`：`packages/ai/test/*` 有若干模型目录漂移引起的类型错误，与本项目改动无关

---

## 核心结论

如果用一句话概括这些改造的共同点：

> **大部分提升不是让 agent 更聪明，而是把「它已经做对了却被系统丢掉」的成果捞回来。**

- length 截断把干到一半的活判成完成
- 守卫拉了刹车却没人修车
- shake 修好了车却不发车
- 判卷环境没装 Python 就直接给 0 分

这四件事没有一件跟模型能力有关，但合起来吃掉了十几个任务。真正的工程价值在于：**建立能把这类静默失败暴露出来的可观测指标**，而不只是修掉某一个 bug。
