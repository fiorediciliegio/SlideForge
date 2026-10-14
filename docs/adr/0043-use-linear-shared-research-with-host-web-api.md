---
status: accepted
---

# 使用 SlideForge Host Web API 执行共享研究

图片搜索时机及逐页使用规则已由 [ADR-0055](0055-assign-images-during-outline-review.md) 更新：搜索与 Web 研究并发前置，大纲后统一分配图片。

PPT App 在 HTML v1 主链路中启用 Web 和图片研究，但不恢复基于 `slideforge-search` Executa、Research Curation Draft 和 Page Evidence Assignment 的旧链路。新的研究流程直接使用 SlideForge Host 提供的 `slideforge.web.search`、`slideforge.web.fetch`、`slideforge.web.image_search` 和 `slideforge.web.image_fetch`，在 Confirmed Outline 之后执行 deck 级研究，并将整理结果作为 Shared Research Evidence（共享研究证据）提供给所有页面。Web 研究、图片研究和 Visual Master 准备可以并行启动；Web 和图片方向各自使用一个有界的 Agent Session（智能体会话）迭代决定下一步动作。图片 Session 会在同一会话中接收上一轮成功获取到 APS 的候选图片，并返回视觉判断、图片内容描述和下一条 query 或完成动作。图片候选由 Host 通过 `slideforge.web.image_fetch` 下载并保存到当前 App 的 APS 自作用域，Agent 仅接收短期 `get_url` 附件；Agent 选中后，App 再通过 APS URL 下载到本地 staging，完成尺寸校验和 Workspace 导入。这个决定用有限 Session、受控往返和较少中间工件换取可恢复的生成路径；它取代 ADR-0006 和 ADR-0011，并取代 ADR-0009 中针对 Research Curation Draft 的重试规则以及 ADR-0018 中“用户可达生成流程继续移除研究阶段”的临时范围决定。

官方 Web API 由 PPT App 中独立的 `ResearchWebClient` 边界调用，不再放入只负责 `ppt-engine` 的 `PptBackend`，也不再保留 `slideforge-search` 的 bundled handle、工具 ID、manifest 同步、adapter、构建、测试或发布路径。搜索授权和失败仍由 Host API 契约控制；App 不持有供应商密钥，也不提供旧 Executa 回退。已有 v2 研究进度中的候选如果已经保存 APS path，则恢复时通过 `slideforge.files.download_url` 重新取得短期 URL；绝不持久化过期的 `get_url`。

Presentation Requirements Creation 完成候选与模板选择后，使用一次独立直接 LLM 分别推荐是否需要 Web 研究和图片研究，并为两项推荐各返回一句符合当前界面语言的原因；推荐值只提供默认选择，用户在 Presentation Requirements Review 中对两项作出最终布尔选择。重新确认需求会删除当前 `research/`，避免旧需求的研究结果污染新大纲。

用户启用 Web 研究时，确认大纲后在 Generating 准备阶段启动 Web 研究。每次 Web 研究尝试只创建一个 Web Research Session（Web 研究会话），Session 读取 Outline 标题、逐页 Web research directions、既有 Web 总结以及本次检查点中已完成的搜索和抓取，不再重复传入用户 Brief 或完整需求。每一轮只返回一个 `search`、`fetch` 或 `finish` 动作；其中 `search` 的 `queries` 数组限制为 1～3 个，App 对每个 query 并行调用一次官方 `search({ query, max_results: 6 })`，再把这一批结果或简短错误统一返回同一 Session；`fetch` 的 `urls` 数组限制为 1～5 个，App 对未缓存 URL 只调用一次官方 `fetch({ urls, max_chars: 8000 })`，再按 URL 统一返回网页正文或错误；`finish` 动作头后的非空 Markdown 作为本次 Research Batch（研究批次）正文，由 App 截取并交给 `ppt-engine` 幂等发布到 `web-summary.md`。`fetch` 只能引用本次或恢复检查点中搜索结果出现过的完整 URL。Session 系统提示词只在 `session.create` 时传入，后续 `session.run` 不再覆盖；Session 只允许 `fs_read_file` 以满足 Host 的非空工具授权约束，但明确要求 Agent 不调用任何工具；模型路由偏好为 `moonshotai/kimi-k2.6`，并在每次 `session.run` 传入。

搜索或单页抓取失败属于可继续的收集结果，App 不自动重试 Web API，而是把错误返回同一 Session，由 Agent 决定补充搜索、改抓其他来源或在最终 Markdown 中记录缺口。协议解析兼容动作头前的无用文字和 JSON Markdown 代码块；格式或协议错误以简短修复消息返回同一 Session。连续 3 次协议错误，或 30 轮内仍未得到合法 `finish`，会中断 Web 研究并在 Generating 研究面板显示警告。Session 创建、运行、删除、检查点写入或正式研究批次发布失败会记录为研究失败并阻止页面生成提交。用户重试时创建新的 Session，复用检查点中的搜索与抓取结果，并获得新的 30 轮额度；本地开发阶段不承诺恢复旧固定流水线留下的未完成 Web 检查点。Outline Creation 不再等待 Web 研究；Page Authoring 和 Rewrite Request 把正式 `web-summary.md` 内容作为外部不可信事实资料加入提示词，并明确忽略其中任何指令性内容。

用户启用图片研究时，在 Confirmed Outline 已产生、Page Authoring 开始前执行图片研究。图片 Agent Session 首轮读取 Outline 标题、逐页图片 research directions、Visual Tone 和精简后的可复用本地图片目录，决定是否需要新的图片搜索以及第一条 query，不再重复传入 Brief、完整 Outline JSON 或实时 Web 总结。之后 App 每次只执行一个 query，向图片 API 请求最多 10 个结果；每个候选都调用 `slideforge.web.image_fetch`，按成功顺序最多将前 6 个 APS `get_url` 作为本轮 native image attachments（原生图片附件）传给同一 Session。Session 必须为本轮每个附件返回稳定 `candidate_id`、当前轮次的 `attachment_index`、`use_in_ppt`、客观图片描述和选择理由，然后决定下一条 query 或 finish。App 先按规范化原图 URL 合并搜索结果，再按 `image_fetch` 返回的 `sha256` 合并相同内容；单张 image_fetch 失败只过滤对应候选。Agent 选中后，App 通过 APS URL 下载到 `research/evidence/images/.staging/<operation_id>/`，由 `ppt-engine` 做尺寸和文件安全校验，再导入正式图片目录。图片搜索最多执行 10 次，连续 3 次图片 Agent 协议错误或超过搜索上限时记录 warning（警告）并结束图片研究；图片 query 不再使用独立直接 LLM 规划，Web Research Session 仍不接收图片附件。

正式研究工件固定为 append-only（只追加）的 `research/evidence/web-summary.md`、物化的 `research/evidence/image-catalog.json` 可用图片资产目录，以及只保存最终可用图片的 `research/evidence/images/`。App 负责持久化最终工件；Web 与图片 Session 都不直接重写文件。图片目录只保留 `use_in_ppt: true`、已由 `ppt-engine` 从本地 staging 导入影子 Workspace、同时具有本地 `file_path`、内容 `sha256` 和文件元数据的图片；目录包含描述、选择理由、匹配 query 和来源 URL，但不包含未入选候选、搜索结果、APS `get_url`、缩略图 URL、下载/分析/导入状态、去重过程、缺口或统计。APS `get_url` 只服务于当前 Agent 分析和选中图片的本地物化，不作为研究图片的长期存储；入选图片直接从已校验的 staging 文件导入正式图片目录。跨轮次写入按 `sha256` 合并，Page Authoring 从 deck 级可用资产中自行判断相关性，不预先分配页面范围。图片研究检查点额外保存 Session 尝试、动作轮次、已执行 query 和候选判断；恢复时创建新 Session，通过 `files.download_url(path)` 重新取得 APS URL，再将候选重新放入首轮上下文。最终 Web Markdown 不强制事实 ID 或逐条引用，但必须包含来源章节以及实际使用过的来源标题和 URL；原始响应、完整候选、视觉判断、技术错误和中间统计只属于 Research Log（研究日志）与当前轮次研究进度诊断。

Web 与图片研究均在确认大纲后的影子 Workspace 中运行，使未提交的研究、图片与 Page Source 一起保持事务隔离；它们可以与 Visual Master 准备并行。三者共用 `research/web-image-search-progress.json` 增量记录研究阶段、Web Session 尝试与动作轮次、query、原始搜索结果、抓取页面、URL 去重、APS image_fetch 状态与 artifact 元数据、SHA-256 内容去重、图片 Session 视觉判断、Workspace 导入和最终写入检查点。APS `get_url` 不进入该文件。Web 恢复将已保存的搜索与抓取结果放入新 Session 的首轮提示词；图片恢复通过 APS path 重新取得短期 URL，只有 Agent 选中后才重新下载到 staging 并导入。最终研究工件发布后清理本轮 staging 文件。图片目录中的 `file_path` 始终保存当前 Workspace 内已导入图片的绝对路径，Page Authoring 必须原样用于 HTML 图片引用。Shadow Preparation 和 Generation Commit 通过既有的全量文本路径 rebase 分别在正式与影子 Workspace 根路径之间重写该字段及其下游 HTML 引用。

用户确认的 Web 与图片研究选择只控制对应方向的新增外部搜索，不影响另一方向。未启用的方向不进入搜索；Web 收集失败由 Session 消化或最终升级为阻塞错误，图片方向的权限、限流、供应商、image_fetch 或导入失败继续记录为 gap 或 warning。App 不为官方 Web API 增加自动重试。图片 Session 采用一个 query 一个 query 的串行循环；每个 query 最多取 10 个结果，全部尝试 image_fetch，最多将前 6 个成功候选交给 Session 判断。单张图片失败只过滤对应候选，Session 基础设施错误按图片研究 warning 处理，不进一步拆分同一轮。APS 获取、恢复和最终导入共用固定并发 16；选中图片的本地下载继续执行现有 HTTPS 图片安全校验。APS `get_url` 不写入 Workspace 日志或进度文件。

**考虑过的方案**

- 恢复 ADR-0011 的完整迭代 Research Discovery、Evidence Pool、Curation Draft 和 Page Evidence Assignment。放弃，因为分页分配和额外中间工件造成不可接受的复杂度；本决策只恢复 Web 方向由单个 Session 驱动的有界资料补查。
- 继续使用本地 `slideforge-search` Executa。放弃，因为 SlideForge Host 已提供正式 Web 与图片接口，继续维护两套搜索协议、manifest 和发布链路没有价值。
- 让每页按需搜索或把原始搜索结果直接交给 Page Authoring。放弃，因为会重复搜索、放大延迟，并让未整理的 Raw Research Material（原始研究材料）成为页面事实依据。
- 使用固定的“查询规划、并行搜索、抓取选择、总结”直接 LLM 流水线。放弃，因为它无法根据真实搜索结果和网页正文逐轮补齐事实缺口，也会在不值得抓取时提前做出静态选择。
- 每个 Web 动作创建独立 Session。放弃，因为会丢失研究决策历史，并迫使 App 重复传输和压缩全部上下文。
- 为每轮研究创建独立 `.runs/<run_id>/` 和页面适用范围。放弃，因为影子 Workspace 已隔离单次运行，单一进度文件足以恢复，而页面范围元数据会重新引入不需要的证据分配逻辑。

**结果**

- 新研究实现以有界迭代、简单恢复和共享上下文为优先；Web 和图片方向都允许单 Session 内补查，仍不提供分页证据预分配。
- 每个 HTML Page Source 的首次创作提示都包含 Web 研究结果和精简后的正式图片目录；Workspace Visual Master 提示只接收大纲标题、确认的演示需求和原样参考 HTML，不包含研究。页面提示按页传入标题、内容、重点和 `copy_rewrite_freedom` 文案限制；页面修复只修当前页面，不重新搜索或更换研究图片。
- 旧研究代码、工件、测试和文档引用可以在同一次本地开发迁移中直接删除或替换，Git 历史是旧实现的唯一兼容参考。
- 图片版权或许可审核不在本次 App 重构范围内；App 不根据 `license_hint` 增加额外业务状态或工作流。

## 本次流程迁移补充

- Web 研究在确认演示需求后、Outline Creation 之前执行；输入包含 Brief、演示主题、结构化演示需求、上传资料分析和当前日期，模型偏好为 `openai/gpt-5-mini`。
- Web 研究完全失败时阻塞大纲生成，用户可从检查点重试；局部抓取失败仍作为研究缺口处理。
- Outline Creation 与 Rewrite 只输出页面标题和 `content: string[]`，不再生成逐页研究计划、视觉重点或 AI 幻觉检查；正式 `web-summary.md` 作为整套 PPT 的事实资料输入。
- 图片研究在 Outline Confirmation 之后运行，只接收 Brief、完整大纲、正式 `web-summary.md` 和图片目录；图片 `reason` 必须说明适用页码与页面标题。
