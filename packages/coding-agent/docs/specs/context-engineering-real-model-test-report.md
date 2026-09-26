# 短期记忆真实模型验收

日期：2026-09-16。模型：`rrver/gpt-5.5`，现有服务商的 `openai-responses` 接口。

结论：3 个场景完整通过。第 4 个场景的跨窗恢复、文件结果、12 项 Todo 完成状态及原始输入不变均通过断言，但最后的模型回复超时，完整调用未通过。不能据此宣称全部端到端验收通过。

## 方法与边界

使用源码 SDK 的 `createAgentSession` 和 `session.prompt` 模拟用户提交任务。摘要、Note、换窗决策、恢复与业务回复均调用真实模型；文件读写、Todo、History 和 Note 均使用内置工具。请求与响应记录中的模型 ID 为 `gpt-5.5`。这验证配置接口返回的行为，不独立证明服务商底层模型身份。

每个场景在独立临时目录运行，保留用户提示、最终请求、事件、Session 日志和结果文件；凭证沿用本机配置，不写入测试记录。没有修改全局模型设置。长期记忆、提醒、扩展关闭，推理档位为 low，测试输出上限为 4096 token。

容量场景通过预置已持久化的合成历史、降低本地窗口预算触发维护，随后全部使用真实模型。48000 / 22000 / 32000 是测试预算，不是对 GPT-5.5 实际窗口大小的声明。主动换窗场景使用现有模型模板的本地 272000 预算。

## 验收结果

| 场景 | 本地预算 | 结果 | 证据 |
| --- | ---: | --- | --- |
| Shake 后继续 | 48000 | 通过 | 2 次真实请求；1 次 Shake，无摘要、无换窗；只写一次结果，税率 0.17、published=false |
| 同窗 Compaction 后继续 | 22000 | 通过 | 4 次真实请求，含 2 次摘要调用；1 次 Compaction，windowId 不变；只写一次正确结果 |
| 压缩后仍有压力，由模型决定换窗 | 32000 | 通过 | 11 次真实请求，含 2 次摘要调用；2 次整理回复完成模型显式换窗请求与 Note 保存；新窗恢复后只写一次正确结果，无工具错误 |
| Note 与 12 项 Todo 跨窗续跑 | 272000 | 业务断言通过；完整调用未通过 | 最后一轮 17 次真实请求；1 次换窗；恢复全部 12 项 Todo 后仅写入一次正确结果，12 项均 completed，原始输入逐字节不变；最终回复超时，runState=failed |

Shake 场景的完整请求输入估算从 57233 降为 26078 token；Compaction 场景从 17284 降为 5194 token。以上是发送前估算，不是服务商精确 tokenizer 计数。摘要实际保留了 `VAT_RATE=0.17` 与本地处理约束。

压力决策场景的 Session 顺序为 `shake` 尝试 → `compaction` 提交 → `decision` → 模型调用 `new_context` → `next_action/current` 持久化 → `context_rollover` → 恢复完成 → 业务写入。`windowId` 从 `65979f4e-78f6-42b7-bb72-60322e7fe1e2` 变为 `b895aeac-ac72-4aa3-a835-6d603baa4629`。该场景没有未完成 Todo，不为换窗强行创建任务。

12 项 Todo 场景中，模型只在 Note 的 `resume.todoIds` 中选择了 task-01 到 task-08，运行时恢复清单仍包含 task-01 到 task-12。恢复完成后才开放业务工具，结果为 count=12、sum=78 和全部 12 个固定 ID。模型曾将 Note 的 eventId 误用于 History，收到一次不可见引用错误，之后自行改用 `context_note` 成功读取。没有为此增加工具别名或绕过引用校验。

## 真实测试发现与修正

1. History 的整段文本引用使用 `blockIndex=-1`，Note 的旧 schema 却只接受非负数。已统一引用契约，并允许引用权威 Todo 快照；Todo 不因此成为业务成功的验证证据。新增用户整段文本、Todo 快照两项回归测试。
2. Note 的 `resume` 仅属于 `next_action/current`，提示没有明确说明。已明确身份、四个必需字段，以及最多 8 个直接依赖 Todo；运行时仍恢复全部未完成 Todo。
3. 恢复缺口提示基于上一条实际请求，可能诱导模型重复读取最新工具结果。现明确复用已可见正文，仅读取尚缺材料。恢复完成的实际请求校验保持不变。
4. 整理提示要求先查 History、再查 Note、同步 Todo、最后写 Note，却没有在首轮说明最多 3 次回复。真实模型逐轮执行，额度耗尽。现首轮说明总额度，要求把独立查询、必要的 Todo 同步和模型选择的换窗请求放在同批，再根据返回结果保存 Note；后续提醒复用首轮契约，减少重复文本占用。没有增加额度或放宽保存校验。

## 未通过的尝试

- 首次主动换窗测试超过测试器 15 分钟总时限；12 项 Todo 已恢复，但尚未写结果，不计通过。
- 后续主动换窗测试在第 11 次请求收到 `Request timed out.`，运行时记录 `dispatch_outcome_unknown`，没有报告成功或自动重放未知结果。测试器之后将单请求超时从 180 秒改为 300 秒；生产超时策略未修改。
- 再次主动换窗测试在建立 Todo 后收到服务商 `server_error: Our servers are currently overloaded. Please try again later.`；含一次应用层重试，共 4 次请求，仍未计为通过。
- 最后一轮主动换窗测试在旧窗出现两次 `server_error`，客户端重试后继续；完成恢复、文件写入和全部 Todo 后，第 17 次请求返回 `Request timed out.`。状态为 `dispatch_outcome_unknown`，没有自动重放或伪装 completed。原测试驱动的完成断言失败；另行对落盘结果和状态执行的业务断言通过，二者分开记录。
- 首次压力决策测试真实调用 5 次，整理阶段 3 次回复依次查询 History、查询 Note、创建 Todo，最终为 `continuation_state_missing`。该失败促成上面的提示修正。
- 压缩调试中一次摘要调用超时；另一次历史夹具的保留后缀过短，摘要没有净收益，被正确拒绝。调整测试夹具以形成可压缩旧前缀，没有放宽生产候选校验。

## 自动回归与记录

最终定向回归包含 `context-window-memory`、`progressive-context-memory`、`context-note-history-reference`、`task-note-projection` 四个文件，共 64 项通过。`npm run check` 与 `git diff --check` 通过；npm 仍提示仓库已有的 `min-release-age` 配置识别警告。真实 API 测试驱动在临时目录运行，现已清理，原始记录保留；未将真实 API 调用放入使用 faux provider 的 suite。

各验收场景的最终记录：

- [Shake report.json](C:/Users/16474/AppData/Local/Temp/pi-real-context-shake-J2fVKP/report.json)
- [Compaction report.json](C:/Users/16474/AppData/Local/Temp/pi-real-context-compaction-teUux3/report.json)
- [压缩后自主换窗 report.json](C:/Users/16474/AppData/Local/Temp/pi-real-context-decision-4TbtMl/report.json)
- [12 项 Todo 跨窗 report.json](C:/Users/16474/AppData/Local/Temp/pi-real-context-rollover-2Rzbm9/report.json)

每个目录包含 `report.json`、`user-prompt.txt`、`request-*.json`、`events.jsonl`、`sessions/*.jsonl` 和业务结果。记录中的价格元数据为零，不据此声称真实费用为零。

这是一组有界功能验收，不是大样本成功率或任意长任务语义无损的证明。
