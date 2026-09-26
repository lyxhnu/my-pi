# Jev 用于模型与思考强度选择：接入评估

研究日期：2026-09-25。对象：TypeSafe AI 的 Jev。本次核查公开一手资料及本地调用链，未调用模型、安装依赖或验证实际准确率与网络时延。

2026-09-26 补充：已完成 [jev-codex-router 借鉴评估](jev-codex-router-review.md)。联合 Choice 是表达合法组合的一种选择，并非 API 要求或必然更准确；模型与 effort 的维度可分离、组合均有效时，独立 Choice 也成立。该项目还提供了决策/执行上下文分离、回放一致性和实际用量记录的实现参考，但未证明当前策略等质量省钱。

## 判断边界

Jev 的接口适合输出有限集合中的路由选择，但这只能证明接口匹配，不能证明它能正确判断编码任务需要哪个模型、哪个思考档位。官方明确将 Jev 定位为 agent 内部的结构化决策组件；它不生成代码、文本或工具调用，不能替代执行任务的聊天模型。[官方 Coding Agents 说明](https://docs.typesafe.ai/introduction/coding-agents)

## API 和输出语义

- HTTP 接口为 `POST https://api.typesafe.ai/v1/systemone`，使用 Bearer API key；输入包含 `model`、`state`、`questions`，返回 `model`、`answers`、`usage`。Choice 在显式候选中返回最高概率选项及完整分布，每题最多 255 个选项；Score 返回有序等级的概率加权值，可以落在两级之间，支持 2–10 个等级。[API reference](https://docs.typesafe.ai/api)
- Choice/Score 的 `confidence` 是由本题概率分布计算出的统计量。**不能直接解释为所选编码模型完成任务的成功率**，也不能把文档示例阈值当成本项目经过验证的阈值。[Confidence](https://docs.typesafe.ai/confidence)
- 同一请求内的问题共享 `state`，并行且独立评估；因此某个问题不能读取同批另一个问题的答案。官方建议把复杂判断拆成窄问题，再由代码组合。[Introduction](https://docs.typesafe.ai/introduction)
- 官方提供 `@typesafe-ai/sdk`，要求 Node.js 20+；`TypeSafeClient.systemOne()` 支持由问题定义推导答案类型，包含 ESM、CommonJS 和 TypeScript 声明。也可以直接使用 HTTP 接口。[JavaScript SDK](https://docs.typesafe.ai/sdk/javascript)

## 费用、时延与限制

截至研究日，官方模型表列出以下值，均属于供应商公布值：[Models](https://docs.typesafe.ai/models)

| 项目 | 公布值 |
| --- | --- |
| 当前版本 | `jev-1.13.0`；`jev-latest`、`jev-preview` 均指向该版本 |
| 价格 | 每百万输入 token 0.042 美元；输出免费 |
| 请求上下文 | 全请求 64k token；`state` 加最长单题至多 32k token |
| 输入 | 纯文本，可包装为字符串、JSON 对象或数组；不接受图片、音频、视频 |
| 限流 | 250,000 tokens/s、1,200 requests/min；官方说明可能无通知调整 |
| 版本与语言 | 别名会移动；英语表现最好，中文等非英语需自行测试 |

按上述单价计算，2,000 输入 token 约 0.000084 美元，10,000 输入 token 约 0.00042 美元；这是输入规模假设下的算术估计，不是实际账单测量。

发布博文宣称端到端响应为 70–500ms，并说明公开评测通常在美国西海岸、靠近服务所在地运行。首页的大倍率提速来自特定工作流，官方承认处于实际收益的较高端。**这些数字不能作为中国网络环境或本项目的时延承诺**；本次未测量。[发布博文](https://typesafe.ai/blog/introducing-system-one-models-and-jev)

## 有什么效果证据

官方公开工作流评测涵盖安全事件、客服 agent 轨迹、发票、客服处理；标签由两个强模型的回答形成共识，比较时其他模型使用默认思考设置。这不是编码任务实际完成率评测，也未比较同一模型不同思考强度的选档收益。[Workflow evals](https://evals.typesafe.ai/)

官方有 intent routing 示例，但它示范客服意图分派，不提供编码任务路由精度。[Intent routing](https://docs.typesafe.ai/patterns/intent-routing)

较接近模型选择的官方例子是 SDE cascade：先由小模型做结构化抽取，再用 Jev 验证字段，触发条件后升级到大推理模型；示例覆盖 100 个抽取任务。这支持“验证输出后决定是否升级”的实验路线，不能证明“只看编码需求即可选对模型与思考强度”。[SDE cascade](https://docs.typesafe.ai/cookbooks/sde_cascade)

本次检查的公开资料中，**未找到 Jev 对编码任务的 `(模型, 思考强度)` 事前路由准确率、节省比例或最终任务成功率的直接证据**。这是本次检索结果，不是断言该证据绝不存在。

## 与该用途直接相关的成熟度限制

官方列出的 Jev 1.13 已知弱点包括：多跳间接推理、数值精度、大量无关上下文、对抗性输入；无关内容增加时准确率下降，输入中试图影响分类的文字可能改变答案。不同题目的概率也不保证满足预期的数学关系。因此应避免把完整冗长会话无筛选地当作路由输入，也不能让它凭模型名猜测各档位的真实能力。[Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13)

接入价值仍需用本项目任务验证：预先定义质量目标，测量各候选模型与档位的真实结果、总费用和耗时，再评估 Jev 的选择是否保持该质量目标。这个结论是对以上证据的工程推论，不是供应商已验证的收益。

## 本项目的接入判断

以下是基于当前工作区代码的设计判断，未实现、未运行端到端实验。暂以“保持任务质量，减少不必要的模型和思考开销”为评估目标；候选模型、允许的质量差值以及延迟目标尚未指定。

结论：技术可行，适合承担任务开始前的初始档位评估；工程难度中等，主要不在 API 调用，而在任务边界、取消、配置生效和真实能力校准。尚无证据支持直接宣称自动选择能节省多少费用或提升多少成功率。

### 现有能力与不可直接复用之处

- 当前 `executionUpgrade` 只允许执行中上调：同模型提高有效思考强度，跨模型沿显式 `modelOrder` 前进。因此前置初选是独立的选择语义，不能冒充已有升级事件。[execution-upgrade.ts](../../src/core/execution-upgrade.ts:69)、[现有功能说明](../execution-upgrades.md:3)
- 升级链路已经验证完整下一请求的可用模型、认证、支持档位、输入模态和上下文预算，并把模型与思考强度一起提交。可以复用这些校验及原子提交机制；具体抽取边界应在实施时确定。[agent-session.ts](../../src/core/agent-session.ts:2605)、[session-manager.ts](../../src/core/session-manager.ts:1728)
- 扩展暴露的 `setModel()`、`setThinkingLevel()` 最终调用手工选择接口，会更新全局默认配置；后者还会调整不支持的档位。直接在前置扩展里调用它们，不满足任务局部选择及准确记录推荐值的要求。[agent-session.ts](../../src/core/agent-session.ts:4443)、[思考强度设置](../../src/core/agent-session.ts:4546)
- 子代理当前继承派发时父代理的模型、思考强度和升级策略，之后有独立会话，但共享设置管理器。子任务选档必须针对自己的交付物，且不能写共享默认值。[pi-child-runner.ts](../../src/core/subagents/pi-child-runner.ts:55)

### 最短接入链路

1. 在 `coding-agent` 的任务生命周期构建评估输入：任务目标、验收要求、与任务相关的会话/代码事实和允许的执行档位。不能只看最新一句话，也不应将任意完整会话塞给纯文本分类器。主任务与子任务各自评估；“继续”、恢复和内部维护请求不应默认被视为新任务。任务开始边界仍需明确。
2. 使用独立 Jev 客户端，从本地允许的 `(provider/model, thinkingLevel)` 联合档位中做 Choice。档位说明来自配置及实测能力，不能只凭模型名称、价格排序推断。这样避免两个独立问题选出不匹配的模型和思考级别；它仍只是待验证的选档策略，并不保证最优。
3. 每个明确的新任务只做一次前置评估。在首个普通请求的准备阶段，使用运行中的取消信号，验证最终实际请求并原子提交会话局部档位；取消或用户手工改档使未提交的结果失效。不能在测量预算、保存状态、恢复上下文和每轮工具执行后重复评估。已有请求准备接口提供 `signal` 和 `dispatch/measure` 模式。[agent-loop.ts](../../../agent/src/agent-loop.ts:674)
4. 之后继续使用现有 `upgrade_execution` 做执行中升级。记录 Jev 版本、候选档位、分类分布、推荐档位、实际生效档位及评估耗时。支持级别映射和输出截断恢复可能使实际 reasoning 与名义值不同，应通过真实请求确认。[models.ts](../../../ai/src/models.ts:663)、[请求准备](../../../agent/src/agent-loop.ts:704)

这条链路属于任务配置选择，不需要把 Jev 注册成生成代码或工具调用的聊天 provider。现有请求校验、取消和会话记录应成为同一条执行链的一部分；不能只让界面显示选档成功。

### 如何判断是否值得接入

当前评测适配器仅注册单个 DashScope 模型，关闭 `supportsReasoningEffort`，只显式映射 `low/minimal/off`，启动命令未传 `--thinking`。现有结果不能直接证明多模型与思考档位选择的收益。实验前必须确认各候选组合实际发出不同且有效的 provider 参数。[pi_agent.py](../../../../eval/benchmarks/pi_agent.py:91)、[请求启动](../../../../eval/benchmarks/pi_agent.py:249)

最小可信验证方式：

- 冻结候选档位，在开发任务集上制定档位说明和选择规则，在独立留出任务集上验收，不能用验收结果反复调规则。
- 在相同任务、运行版本、工具、权限和超时下，对比固定档位、现有执行中升级策略，以及 Jev 初选加同样的升级策略。需要与最佳固定配置比较，不能只和始终最高配比较；重复运行，报告配对差异及不确定性。
- 以根任务真实通过率为质量门槛，同时比较全部尝试总费用/成功任务数和端到端耗时。费用包括 Jev、主代理、所有子代理、重试、升级与失败；模型切换的缓存影响也必须计入。主任务与子任务路由分别观察，最后以整项任务结果验收。
- Jev 的分类置信度、工具成功次数和自报 Todo 完成都不能代替真实验收。当前监控实现也明确将这些量视为观测而非成功证明。[execution-monitor.ts](../../src/core/execution-monitor.ts:20)

本次只新增该评估文档；未修改运行代码，未调用 Jev 或真实任务模型，也未运行构建、测试或付费评测。
