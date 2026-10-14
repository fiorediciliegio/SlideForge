---
status: accepted
---

# 使用独立 HTML Page Source 和工作区视觉母版

> 2026-09-20：创作要求、文案自由度移除及修复/美化输入边界见 [ADR-0066](0066-outline-creation-requirements.md)。


> 2026-09-15：内容目标字段及 Visual Tone（视觉气质）的要求已由 [ADR-0058](0058-remove-requirement-content-goals.md) 替代。当前只确认生成规格与研究选择，模板快照机制保留。

HTML v1 将 Deck 创作权威从 TSX、Authoring Kit、Workspace Style Guide 和 Persistent Elements Reference 切换为完整 HTML Page Source 与一个 Workspace Visual Master（工作区视觉母版）。这一重构优先缩短生成链路并让 Agent 直接产出浏览器可运行的页面；项目仍处于本地开发阶段，因此不兼容、不迁移旧 Workspace，也不保留 TSX/HTML 双生成分支。

每个新 Workspace 在 `task.json.workspace_format` 中记录精确值 `html-authoring-v1`。这是工作区契约标识，不是目录名；工作区不创建 `html-authoring-v1/` 文件夹。页面权威源固定为 `slides/<page_id>.html`，每个文件都是一个完整、可独立运行的 HTML 文档，并包含唯一的固定 `1920 × 1080` `.slide` 根容器。Deck Manifest 继续只按 Confirmed Outline 顺序映射 `page_id` 到 `./slides/<page_id>.html`。Authoring Kit、Page Source Bootstrap、TSX 编译链、`style-guide.md`、`persistent-elements.tsx`、`visual-rhythm.md` 和 `page-visual-plans/*.md` 不参与这条主链路。

Workspace 根目录拥有唯一的 `visual-master.html`。它主要由 Outline 标题、已确认的演示用途/受众/预期效果/Visual Tone/语言/页数，以及选定的 Dominant Aesthetic Reference 共同生成；不再把原始 Brief 作为重复上下文传入。母版使用 `:root` 视觉变量并包含唯一的 `{{PAGE_CONTENT}}` 占位符，用来表达跨页共享的背景、装饰、页眉、标题区域、主内容安全区域、页脚和页码等视觉规则。母版最多使用四种字体、六种颜色和五级字号，最终 HTML 以八十行以内为简洁性目标；固定区域使用 `data-fixed="true"` 标记。普通内容页应物化适用的固定区域，封面、章节过渡页和收束页可以省略不适用区域。页面不会在运行时导入、组合或依赖母版，因此每个 Page Source 始终保持独立完整，母版只是一份 Deck 级创作权威。

Visual Style Preset（视觉风格预设）不再携带 `style_guide`。其 `preset.json` 保留 UI 使用的 `preview_images`，并新增有序 `reference_html_pages` 数组；每项包含预设目录内的 HTML 相对路径和一句基于该页实际截图撰写的内容结构与视觉外观描述。用户确认 Presentation Requirements 时，PPT App 将所选预设身份、参考页目录和全部参考 HTML 复制到 Workspace，形成不可变快照；后续生成、恢复和导出不实时依赖前端预设目录。

Visual Tone（视觉气质）仍是 Confirmed Presentation Requirements 的必填字段，并与 Visual Style Preset 同时存在。它可以由需求生成流程提出候选，也可以由用户填写；已选择预设时，候选生成可参考预设名称与描述，未选择预设时则先确定 Visual Tone，再用于自动选择预设。参考 HTML 只提供美学设计参考，不能提供页面文案、事实或论据，也不替代 Visual Tone。

生成 Workspace Visual Master 和每个 Page Source 前，PPT App 分别使用普通 LLM completion（模型补全）从 Workspace 预设快照中选择且只选择一个 Dominant Aesthetic Reference。选择输入包含当前目标需求和每个 Template Reference Page 的一句话描述；选出的路径必须属于该快照。每次选择使用普通 LLM 请求的统一默认次数，目前最多六次完整尝试（含首次请求），失败后不降级到默认页、多页混合或无参考生成。母版和各页面的选择结果持久化到固定 Workspace 工件 `aesthetic-reference-selections.json`，恢复时复用仍然有效的既有选择。

Workspace Visual Master 和 Page Source 的 HTML 内容生成都使用 Agent Session（Agent 会话），因为完整 HTML 属于长输出。Session 不写 Workspace 文件；PPT App 组装精简的演示描述、视觉母版、选定参考 HTML 和页面意图后，接收 Session 最终文本，提取一个完整 HTML 文档，再交给 `ppt-engine` 原子持久化。母版提示词要求输出带唯一 `{{PAGE_CONTENT}}` 的完整母版 HTML；页面提示词要求输出当前页的完整 HTML，并以自然语言传入“第几页、标题希望是、内容希望有、其中的重点是”，同时把母版与主导美学参考分别作为跨页约束和页面美学输入，优先保证信息传递效率、合理布局与不过空或过挤的内容密度。每页还会根据 Outline Entry 的 `copy_rewrite_freedom` 注入对应的文案改写限制；普通生成严格遵守该等级，精修时用户明确的本轮文案要求可以覆盖它。两类提示词都明确要求只返回 HTML，不返回分析、说明或 Markdown 代码块，也不让 Session 写磁盘文件。提示词中的演示描述全部来自当前 Workspace，不硬编码示例主题或固定页数。

HTML 接收采用宽松提取。PPT App 优先提取标记为 `html` 的 Markdown 代码块；没有代码块时，从首个 `<!doctype html>` 或 `<html` 截取到对应 `</html>`，并自动丢弃代码块标记及 HTML 前后的说明。内容验收只把两种结果视为失败：找不到完整 HTML，或找到多个完整 HTML；除此之外先接收并交给浏览器渲染。一次内容生成最多进行首次尝试加两次同 Session 修复，修复提示只说明本次提取失败的原因并要求重新返回唯一完整 HTML。Agent Session 和 Host 基础设施自己的传输或调用重试不消耗这三次内容尝试。

Page Source 可以包含需要浏览器执行的 HTML、脚本或动态布局。每页生成后在受管 Chrome 中只渲染一次，等待 Render Readiness（渲染就绪），随后生成该页的静态 HTML 快照和截图；静态快照删除运行时行为并成为最终组合输入，而 Page Source 继续是可恢复重建的创作权威。无法同时产出静态快照和截图时，该页标记为失败，不在旧 Session 中进行渲染修复；用户执行 Deck Generation Resume（继续生成）时，复用该页已持久化的有效主导美学参考，并通过新的页面 Session 重新执行完整 HTML 生成和渲染。

Final Deck Render 不再次执行各 Page Source，而是按 Manifest 顺序组合已接受的页面静态快照。组合阶段由引擎自动为每页 CSS 建立作用域，避免 `:root`、通用 class 和标签选择器污染其他页面，并生成包含全部 slide shell 的同一份 `deck.html`。`dom-to-pptx` 仍一次接收同一浏览器文档中的全部 slide 元素并输出一个 PPTX；它不直接读取多个 HTML 文件。标准画布固定为 `1920 × 1080`，导出仍映射为 `13.333333 × 7.5` 英寸的 16:9 PPTX。页码继续由渲染器填写 `data-presenton-page-number="current|total"` 标记，页面自身负责标记的位置与视觉样式。

HTML v1 的用户可达范围包含需求与研究选择、大纲确认、生成准备阶段中的 Web/图片研究、生成、预览、失败页面恢复、人工页面编辑和导出。人工页面编辑直接修改浏览器渲染后的静态 HTML 快照，保存为当前 Page Generation Unit 的 Manual Page Revision（人工页面修订），不回写 TSX，也不改变 HTML Page Source；后续 Page Refinement（单页优化）成功生成新的 HTML Page Source 后，才会替代该人工修订。研究按 ADR-0043 接入 HTML Page Source 契约：Web 研究和图片研究都在确认大纲后运行，可与 Workspace Visual Master 准备并行；Web 总结与正式图片目录只进入逐页 HTML 提示，Workspace Visual Master 不消费研究。其他后续能力不能回退到 TSX 或 Authoring Kit 路径。

本决策完整替代 ADR-0018 的 Authoring Kit Workspace 契约、ADR-0020 的 Workspace Style Guide 契约、ADR-0039 的 `style_guide` 型 Visual Style Preset 契约，以及 ADR-0047 的 Persistent Elements Reference 契约。它同时替代 ADR-0034 中固定 `1280 × 720` 画布和 Final Deck Render 再执行 Page Source 的部分；ADR-0034 关于单一静态 `deck.html`、同一浏览器文档中的 slide 集合和后端 `dom-to-pptx` 导出边界仍然有效。ADR-0043 的研究设计已按本契约重新启用；ADR-0040 的人工编辑设计现已按 HTML Page Source 契约恢复为用户可达能力。

## 封面页输入规则补充

封面页以 Confirmed Outline 的 `page_type=cover` 为准。大纲生成、改写和输出修复都要求封面 `content` 使用简约文案，不适用普通页的连续散文与 300 到 600 字要求。封面只保留必要的主题说明、副标题，以及资料中已有的身份、机构、日期等信息。

封面 HTML 生成与精修的视觉输入只包含选定的一份模板参考 HTML；单页执行跳过视觉母版读取，提示词不包含母版 HTML 或遵守母版的要求，并明确采用突出标题、清晰层级、允许充分留白的封面构图。精修继续保留原 HTML、截图和用户本轮修改意见。普通页仍读取并遵守母版，整套演示的母版准备流程保持不变。本补充替代上文中封面接收母版后自行省略固定区域的约定。

## 考虑过的方案

- 保留 `authoring-kit-v1` 并新增平行的 HTML 目录或兼容层。放弃，因为本地开发阶段没有旧 Workspace 迁移价值，双契约会延续本次重构要移除的复杂度。
- 让页面在运行时组合共享母版。放弃，因为 `dom-to-pptx` 需要一个稳定、可测量的最终 DOM，而独立完整页面更容易渲染、恢复、静态化和隔离。
- 将多个参考 HTML 一起交给页面 Session。放弃，因为参考之间可能产生竞争指令并扩大长上下文；每个生成目标先选择一个主导参考更明确。
- 让普通 LLM completion 直接生成母版和页面。放弃，因为完整 HTML 长输出在当前测试中稳定性不足；普通 completion 只保留给短小、结构化的参考选择。
- 对 HTML 结构执行严格静态校验或在渲染失败后继续旧 Session 修补。放弃，因为第一版优先跑通宽松 HTML 主链路，浏览器能否产出静态快照和截图才是页面是否可用的关键边界。

## 结果

- HTML Page Source、Workspace Visual Master 和模板参考快照成为新创作链路的核心权威，TSX 相关资源可以随实现迁移直接删除，不需要兼容读取。
- 页面生成、静态化、Deck 组合和 PPTX 转换形成单向链路：`slides/*.html -> 页面静态快照 -> deck.html -> deck.pptx`。
- 特殊页面保持视觉自由度，但普通内容页仍通过同一母版、Visual Tone 和单一主导参考获得跨页一致性。
- v1 保持独立 HTML 主路径，同时运行确认大纲后的 deck 级 Web 与图片研究；两类研究和视觉母版准备可以并行，研究不会生成共享运行时依赖，也不会改变母版权威。
