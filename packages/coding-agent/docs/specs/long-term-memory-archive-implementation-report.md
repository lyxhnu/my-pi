# 长期记忆归档实施报告

实施基于 [长期记忆归档 Spec](long-term-memory-archive.md)，范围为 `packages/coding-agent`。

## 已实现

- 项目级 `memory-state.v2.json` 权威存储、短锁原子事务、修订、撤销、替代、例外和冲突关系；`memory-active.md` 仅作为可重建展示。
- 稳定 `rootPromptId`、Run/continuation/outcome 状态、原始与转换输入 origin、log-only `memory_evidence`、两阶段 evidence 登记及启动对账。
- 工具完整结果、助手消息、Task 裁剪前输出和终态证据；Task 在创建时绑定 `ownerSessionId`、`rootPromptId` 与 dependency/service 角色。
- 固定 Manifest、幂等 job、项目并发限制、lease/attempt token、逐工作单元失败次数、提炼与候选验证检查点、持久化小时调用预算及 `retryAt` 唤醒。
- 严格 TypeBox 提炼/验证输出、来源覆盖收据、敏感内容过滤、支持/全批反证门禁、冲突和 ProjectDirective 版本提交前重校验。
- 默认有效视图统一服务 `memory_search` 和按 memoryId 的 `memory_get`；状态、来源、适用性和规则关系在最终返回前重新检查。
- `/memory remember|flush|status|undo` 及对应 RPC/SDK 类型。flush 不压缩上下文，compact/rollover 不触发知识晋升。
- 两级开关、默认工具集合与 allow/deny 过滤；归档模型调用没有业务工具，并有每次调用 timeout、输入/输出和成本预算。
- 真实模型契约包含完整 JSON Schema、来源覆盖语义和范围边界；助手自述不参与候选发现，但仍保留在固定 Manifest 并参与全量反证校验。
- 模型报告未检查的普通来源会按持久化检查点继续提炼；成功重试会清除当前失败状态，历史失败次数仍留在 job 审计数据中。
- 未建立宿主依赖清单的实现事实和经验只写为 `needs_verification`，不进入默认有效读取；明确用户规则和决策才能以 `user_asserted` 激活。

## 自动验证

定向回归覆盖无压缩归档、Task 依赖和旧轮归属、证据恢复、来源晚到失效、预算等待、并发 worker、lease 接替、检查点复用、未检查来源续页、候选上限、输入预算、冲突版本变化、关系展开、撤销、RPC 和压缩隔离。最终命令及结果：

```text
node node_modules/vitest/dist/cli.js --run <15 个 Memory/Task/RPC 定向文件>
16 files passed, 147 tests passed

npm run check
Biome、依赖锁、TypeScript 和 browser smoke 全部通过

git diff --check
通过
```

工程回归使用 faux provider 和临时真实文件系统。

## 真实 Agent 验证

使用隔离 Agent/Session/项目目录并复用现有登录态，通过 RPC 启动真实 `rrver/gpt-5.4` Agent。测试规则为一次性令牌，不读取或输出凭据：

1. 普通用户 prompt 写入明确项目规则，真实提炼与反证校验完成，`written=1`、`activeRecords=1`。
2. 关闭进程并创建新 Session；Agent 默认调用 `memory_search`，准确返回令牌。
3. RPC 撤销该 `memoryId`，再次关闭并新建 Session；Agent 调用 `memory_search` 后返回 `NOT_FOUND`，撤销记录未复活。
4. 提炼期间遇到一次真实供应商 `server_error`；同一 job 重试后只提交一次，最终状态不残留瞬时失败。
5. 真实 print Agent 完成 `history → context_note → new_context → next_action 保存 → rollover → recovery dispatch`。首个恢复请求超时后记录 `outcome_unknown` 且未自动重放；从同一持久化 Session 显式恢复后，Agent 通过 Note/History 找回要求并精确输出测试令牌。

该反馈环发现并修复了：真实模型使用错误候选结构、把无关助手回复误列为未检查、助手高熵误报导致规则整体延期、模型把命题对象误写成不可解析 scene、RPC 客户端 30 秒固定超时、成功 job 残留失败原因，以及 `context_note` 首次写入参数不清导致模型循环失败。

真实 Context 测试形成一个持久化 rollover，并覆盖了恢复 dispatch 未知结果时禁止自动重放、随后显式恢复完成的路径。连续供应商 overload/timeout 被保留为外部故障证据，没有当作实现成功或业务完成。

## 尚未完成或未验证

- 模型报告未检查的普通来源可以继续处理，但单个超过 `maxInputTokensPerCall` 的来源尚未实现 UTF-16/字节范围分页；当前明确进入 `needs_review`，不把截断输入算作已检查。候选恰好达到批次上限也进入 `needs_review`，尚未自动细分后续页。
- 尚未实现通用 `DependencyManifest` 采集器和 `tested` 自动晋升。当前明确用户规则/决策可授予 `user_asserted`；其余自动记录只写为 `needs_verification`，无法机器判断的条件从默认有效视图排除。
- 旧 `MEMORY.md`、Session notes、撤销 sidecar 和 dream 文件保留且不进入 v2 有效读取；显式 `/memory import` 尚未提供。
- v2 有效读取当前使用关键词排名及关系展开；旧 Markdown embedding 索引不作为 v2 authority 的索引。
- 已完成一条真实规则的写入、重启召回和撤销验证；尚未使用固定人工标注数据集统计无依据晋升率、冲突判断、遗漏率和成本，因此不能宣称大样本语义质量验收通过。
