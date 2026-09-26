# jev-codex-router 借鉴评估

研究日期：2026-09-26。固定版本：[`8701ef788aa8cb0948f299538747fb01029d32b8`](https://github.com/0xNatoshi/jev-codex-router/tree/8701ef788aa8cb0948f299538747fb01029d32b8)。本节完整阅读策略、策略测试、`/ask` 测试、路由样本与 README；仅静态研究，未运行下载的代码或调用 API。

## 总体建议

值得借鉴，优先采用四项：分类输入与执行上下文分离、边界明确的能力描述、线上与回放共用决策输入构建器、按实际请求记录完整用量及策略版本。阶段路由的有效期概念可作为后续参考，目前不需要引入它的整个代理服务和逐调用路由机制。

它选择的是“下一次模型调用”需要的资源；前一轮对 pi 的建议是“任务初始选择 + 执行中自主升级”。这两个调度范围不同，不能将整套实现直接套入。pi 已有请求准备、取消、上下文预算和 trace，应在这些机制中接入前置选择。

截至研究日，[GitHub 仓库主页](https://github.com/0xNatoshi/jev-codex-router)显示作者已于 2026-09-24 归档项目。本次把它当作固定版本的设计参考，不把维护状态或 README 的生产使用描述当作质量证明。

## 策略层结论

同意借鉴其**定义充分、边界明确的能力档位，以及把契约验证与任务效果分开的做法**。该仓库尚未证明四个独立 Choice 已完成结果校准；不能据此宣称等质量省钱，也不能把作者选定的模型梯度或强制 Astra 规则当成通用事实。README 明确称能力描述只是先验，并承认当前策略仍需真实任务结果校准；首页约 60% 的节省是旧策略的历史模拟。[README](https://github.com/0xNatoshi/jev-codex-router/blob/8701ef788aa8cb0948f299538747fb01029d32b8/README.md#routing-policy)

## 可借鉴的具体设计

1. **描述任务边界，而非让 Jev 凭模型名猜能力。** Luna 限于目标及完成方式已确定的机械操作；Terra 对应明确需求和已知模式下的局部实现；Sol 覆盖意图推断、调查和跨文件推理。特别强调短消息不代表任务简单，优化目标计入返工、澄清和上下文重处理成本。描述本身仍需实测，但作为可审查、可调整的路由先验，比模糊的“简单/复杂”更有用。[能力描述与问题定义](https://github.com/0xNatoshi/jev-codex-router/blob/8701ef788aa8cb0948f299538747fb01029d32b8/server/routing_policy.py#L25-L109)
2. **按剩余工作重新判断阶段。** 已完成的最终审查不应让后续确认操作持续使用同一高档位；常规质量检查和独立最终审查有明确边界。强制策略与成本选择分开，便于看见最终模型为何不同于基础模型；但强制采用 Astra 的类别属于作者的业务选择。[策略及合并逻辑](https://github.com/0xNatoshi/jev-codex-router/blob/8701ef788aa8cb0948f299538747fb01029d32b8/server/routing_policy.py#L9-L24)；[保留 base_model](https://github.com/0xNatoshi/jev-codex-router/blob/8701ef788aa8cb0948f299538747fb01029d32b8/server/routing_policy.py#L165-L213)
3. **验证返回契约。** 已返回的概率分布必须包含完整候选、值有限且在合法范围、概率和接近 1、所选项符合最大概率。测试检查非法分布和未知选项。`confidence` 仅作诊断，缺失或较低都不会悄悄替换有效选择。[验证逻辑](https://github.com/0xNatoshi/jev-codex-router/blob/8701ef788aa8cb0948f299538747fb01029d32b8/server/routing_policy.py#L131-L162)；[测试](https://github.com/0xNatoshi/jev-codex-router/blob/8701ef788aa8cb0948f299538747fb01029d32b8/server/test_route_policy.py#L112-L163)

## 四个独立 Choice 与联合组合 Choice

实现一次并行询问强制策略、模型、effort、lease，再由代码合并；强制策略为 Astra 时覆盖模型，但保留独立选出的 effort。普通路径接受四个模型与五个 effort 的全部组合。这个结构是明确的策略假设，并非遗漏了组合步骤。[策略源码](https://github.com/0xNatoshi/jev-codex-router/blob/8701ef788aa8cb0948f299538747fb01029d32b8/server/routing_policy.py#L67-L109)；[合并与覆盖测试](https://github.com/0xNatoshi/jev-codex-router/blob/8701ef788aa8cb0948f299538747fb01029d32b8/server/test_route_policy.py#L90-L110)

此前“模型和思考强度必须用联合 Choice”的说法应收窄：**联合 Choice 是可选建模方式，不是 API 强制要求；独立选择并非必然错误，联合选择也不自动更准。**

- 独立选择适用于把能力需求、思考深度定义为可分别判断的任务属性；候选组合均有效，档位语义经过对应模型验证，而且代码有明确的组合规则。这时小问题更容易维护，不必枚举完整笛卡尔积。
- 若问题是“这个具体模型达到质量目标至少需要哪个 effort”，effort 就以模型为条件。同批独立问题看不到另一个问题的结果，不能完成这一条件判断。若可用 effort、上下文或能力约束随模型变化，从事先筛选的有效组合中做联合选择可直接表达这种约束。这里是逻辑适用边界，不是该仓库已验证的性能结论。
- lease 的问题使用“this model and effort”，但输入只有共同 state，没有同批最终选出的组合，且强制策略可能随后覆盖模型。因此它至多在预测当前阶段是否稳定，不能据此声称已验证某个所选组合能持续胜任到何时。[lease 定义](https://github.com/0xNatoshi/jev-codex-router/blob/8701ef788aa8cb0948f299538747fb01029d32b8/server/routing_policy.py#L53-L65)；[lease 提问](https://github.com/0xNatoshi/jev-codex-router/blob/8701ef788aa8cb0948f299538747fb01029d32b8/server/routing_policy.py#L99-L107)

## 尚未校准，以及不能直接照搬的部分

- 策略测试的概率分布是手工构造的，主要证明全部合法组合被原样应用、强制策略覆盖生效以及坏数据被拒绝；不是 Jev 的真实任务准确率测试。[test_route_policy.py](https://github.com/0xNatoshi/jev-codex-router/blob/8701ef788aa8cb0948f299538747fb01029d32b8/server/test_route_policy.py)
- 10 条人工法语样本规定允许的模型集合，部分规定强制策略；没有 effort 或 lease 期望值，更没有各模型实际完成任务的结果标签。能覆盖“短确认承接不同任务”“审查已完成”“并行工具其中一个失败”等边界，但不足以校准模型×effort 的收益。[routing_cases.json](https://github.com/0xNatoshi/jev-codex-router/blob/8701ef788aa8cb0948f299538747fb01029d32b8/poc/routing_cases.json)
- `/ask` 测试将 Jev 调用替换成假响应，验证输入、鉴权、转发和错误状态；它能说明接口测试方法，不能说明路由质量。[test_ask.py](https://github.com/0xNatoshi/jev-codex-router/blob/8701ef788aa8cb0948f299538747fb01029d32b8/server/test_ask.py)
- 汇总 `confidence` 与所选概率都取各题最小值，这只是诊断聚合，**不是联合决策正确率或成功率下界**。批内独立执行不意味着四个判断误差统计独立；即使每题概率都已校准，取最小值也不能推出组合成功概率。[聚合代码](https://github.com/0xNatoshi/jev-codex-router/blob/8701ef788aa8cb0948f299538747fb01029d32b8/server/routing_policy.py#L179-L212)
- 强制类别是否命中仍由 Jev 分类。代码只保证“分类结果为 Astra 时覆盖”，不保证真实高风险工作必然被识别。固定模型 ID、固定价格顺序、五档 effort 通用假设以及技术错误时的 Astra/medium 路由，均不能直接变成本项目需求。[策略定义](https://github.com/0xNatoshi/jev-codex-router/blob/8701ef788aa8cb0948f299538747fb01029d32b8/server/routing_policy.py#L4-L24)；[README](https://github.com/0xNatoshi/jev-codex-router/blob/8701ef788aa8cb0948f299538747fb01029d32b8/README.md#routing-policy)

## 上下文与决策有效期

已完整静态阅读 `server/jev_server.py`、`test_per_call_routing.py` 与 `test_replay_policy.py`。

### 最值得采用：两种上下文各司其职

`decision_dossier()` 给 Jev 的输入是有长度上限的任务、步骤和必要证据。短确认补充前序有效任务/助手建议；工具续接保留整批结果数量、错误数和至多三段摘要，优先错误。执行模型则收到调用方完整的 canonical request。测试断言 instructions、历史、工具结果及 cache key 没有因为分类摘要而丢失。[输入构建](https://github.com/0xNatoshi/jev-codex-router/blob/8701ef788aa8cb0948f299538747fb01029d32b8/server/jev_server.py#L636-L850)、[完整执行请求测试](https://github.com/0xNatoshi/jev-codex-router/blob/8701ef788aa8cb0948f299538747fb01029d32b8/server/test_per_call_routing.py#L436-L483)

pi 应保留自己经过上下文管理后形成的完整 prepared Context，Jev 摘要只供选择使用。不要把“保留执行上下文”误解为恢复所有原始历史或绕过 pi 的预算/换窗机制。该项目的字符阈值、XML 清理及错误关键词是代理层经验规则；pi 可使用已有结构化任务信息和工具 `isError`。

线上请求、历史回放和测试使用同一个决策输入构建器，也是重要约束：否则离线测到的分类能力与线上行为不可比。[回放一致性测试](https://github.com/0xNatoshi/jev-codex-router/blob/8701ef788aa8cb0948f299538747fb01029d32b8/server/test_replay_policy.py#L89-L110)

### Lease：借鉴有效期和失效条件，不复制阶段推断

实现允许决定只使用一次、在同工具连续调用期间复用，或在当前用户轮次的正常工具续接中复用。复用完整 decision，因此模型和 effort 一起保持。新用户轮次、错误、执行契约变化及空闲 TTL 超时会使结果失效；只有完整成功响应才续存。[实现](https://github.com/0xNatoshi/jev-codex-router/blob/8701ef788aa8cb0948f299538747fb01029d32b8/server/jev_server.py#L1022-L1174)、[成功判定](https://github.com/0xNatoshi/jev-codex-router/blob/8701ef788aa8cb0948f299538747fb01029d32b8/server/jev_server.py#L2027-L2047)

其真实边界有三点：`user_turn` 允许换工具，只有 `tool_chain` 要求同名工具；缓存 miss 不会使 lease 失效；每次复用刷新 TTL，所以不是绝对有效时长上限。它根据请求形状、工具名和错误文本推断稳定性，不识别真实业务阶段。[测试](https://github.com/0xNatoshi/jev-codex-router/blob/8701ef788aa8cb0948f299538747fb01029d32b8/server/test_per_call_routing.py#L258-L274)

如果 pi 后续确实需要阶段路由，应利用任务、会话、上下文修订、结构化错误和 AbortSignal 定义失效。首版任务初选无须额外建设 lease 缓存。

### 不必移植的代理层处理

该项目需要 Codex Router、LiteLLM、转发服务和本地执行入口，并带有请求头、流事件及显示标签的处理。这些是在外部代理位置接入产生的工作；pi 控制自己的执行循环，无须复制该链路。README 的“SSE 原样转发”也不是严格字节不变：代码会附加路由标签、可选回答标签并处理终止 response id。pi 可以把选档信息放入已有 trace/UI 元数据。[架构](https://github.com/0xNatoshi/jev-codex-router/blob/8701ef788aa8cb0948f299538747fb01029d32b8/README.md#how-it-works)、[流标记](https://github.com/0xNatoshi/jev-codex-router/blob/8701ef788aa8cb0948f299538747fb01029d32b8/server/jev_server.py#L1343-L1361)、[本地 trace](../../src/core/trace.ts)

## 计量方式值得借鉴，节省结论尚不成立

已完整阅读 `BACKTEST.md`、`report_routing.py`、`test_routing_usage.py` 与 `backtest_savings.py`。

### 历史样例实际说明了什么

公开样例是单人一周的 237 个用户轮次，按历史 token 用量重新套价格。旧策略的结果为：

| 情景 | 模拟成本 |
| --- | ---: |
| 全部 Astra | $871.48 |
| Jev 路由 | $349.29 |
| 全部 Sol | $348.59 |

因此“相对全 Astra 节省 59.9%”成立于其模拟口径，但 Jev 相对固定 Sol 贵约 0.20%。这不证明路由没有价值，也不证明固定 Sol 质量相当；它说明现有样例不能证明动态选择比固定中档更划算。[公开聚合样例](https://github.com/0xNatoshi/jev-codex-router/blob/8701ef788aa8cb0948f299538747fb01029d32b8/poc/backtest-sample-results.json#L11-L18)

模拟固定 token 数量、没有模拟换模型产生的缓存损失，也没有完成质量对照。它属于旧策略，当前脚本不能复现旧表，不能用于宣称当前策略真实额度节省。[限制和复现说明](https://github.com/0xNatoshi/jev-codex-router/blob/8701ef788aa8cb0948f299538747fb01029d32b8/BACKTEST.md#L72-L96)

### 应采用的记录原则

- 按每次实际请求记录选中及实际模型、effort、结果、usage；一次逻辑调用内发生的重试也保留。另记策略版本、Jev 用量、耗时和决策来源。[请求记录](https://github.com/0xNatoshi/jev-codex-router/blob/8701ef788aa8cb0948f299538747fb01029d32b8/server/jev_server.py#L2048-L2086)
- 缺失 usage 或未知价格保持 unknown；不能记为零。失败请求已知用量要计入；reasoning 已包含在 output 时不重复收费。[费用处理](https://github.com/0xNatoshi/jev-codex-router/blob/8701ef788aa8cb0948f299538747fb01029d32b8/server/report_routing.py#L113-L153)
- 按会话和模型观察真实缓存 token，分别统计换模型及回到原模型的缓存读取；区分“有缓存的请求占比”和“缓存 token 占输入比例”。缓存状态可作为费用参考，不能压过能力要求。[缓存统计](https://github.com/0xNatoshi/jev-codex-router/blob/8701ef788aa8cb0948f299538747fb01029d32b8/server/report_routing.py#L156-L324)

即使使用真实 usage，给相同 token 数量套上另一模型价格仍只是成本估计，不是另一模型真实运行的对照结果。pi 最终应按根任务汇总主代理、子代理、Jev 和全部失败/重试，比较成功率约束下的总费用与端到端耗时。

## 对前一轮建议的补充

保留“任务初始选择 + 现有执行中自主升级”的最短实现范围；优先补入独立决策输入、明确的候选能力边界、统一回放输入和真实请求计量。联合 Choice 保留为表达异构模型合法组合的一种方式，不再把它表述为必然优于独立 Choice。

本次只新增评估文档，并补充前一份评估的引用。未安装该项目、运行下载代码、调用付费 API 或修改 pi 的运行代码。源码测试仅做静态阅读，不声称已经运行通过。
