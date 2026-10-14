# PPT App Glossary

This context defines the project language for the PPT authoring workflow and keeps the terms stable across UI, prompts, and artifacts.

## Language

**Workspace**:
The container for one PPT request and its artifacts.

**Brief**:
The user's initial input that describes what the deck should cover.
User-facing Chinese label: 需求描述

**Presentation Requirements**:
The Workspace-owned structured requirements for a Deck, derived from the Brief and resolved through user choices. They contain a positive page count, output language, a user-selected page aspect ratio, and independent Web and image research choices; the user's later explicit choices override the corresponding expression in the Brief, while Outline Review may synchronize the page count to the saved Outline without changing the other requirements.
User-facing Chinese label: 演示需求
_Avoid_: Context, Background

**Presentation Requirements Draft**:
A Workspace-owned set of ordered candidate Presentation Requirements and current selections that remains open to user review and editing across app sessions. The first candidate for each field is recommended and may be selected by default without making the requirements confirmed.
_Avoid_: Confirmed Presentation Requirements

**Presentation Requirements Candidate**:
A selectable proposed value within a Presentation Requirements Draft. Each field has one candidate when the Brief is explicit and two to four materially distinct candidates only when genuine ambiguity remains; page-count and output-language candidates are simple values. Audience, purpose, desired outcome, and visual tone are not structured fields or inferred candidates.

**Confirmed Presentation Requirements**:
The complete Presentation Requirements accepted by the user as the primary constraints for downstream creation; page count and output language are always concrete rather than automatically deferred. A draft may carry a replaceable Visual Style Preset identity, but only confirmation creates the Workspace's authoritative preset and Template Reference Page snapshot. Any later field change, including changing or clearing a Visual Style Preset, returns them to a draft until the whole set is confirmed again, except that saving a valid Outline synchronizes `slide_count` to the Outline entry count while the requirements remain confirmed; the Brief remains the original source record without overriding a conflicting confirmed field.

**Presentation Requirements Creation**:
The explicit user-requested process that derives a new Presentation Requirements Draft from the current Brief and current Visual Style Preset choice. It proposes page-count candidates, resolves output language separately, and recommends independent research choices, but never infers content goals or facts. When no preset is selected, the process extracts template recommendation intent from the original Brief and ranks built-in presets locally. Insufficient signals or an intent-analysis failure leave up to three persisted candidates for an explicit user choice, including when confirming a manual draft. Later review edits are persisted only when the user explicitly saves or confirms them.

**Presentation Requirements Review**:
The required user step where every Presentation Requirements field is resolved from generated candidates or manual entry and the whole set is explicitly confirmed by the user; it is never skipped automatically. Default selections remain a draft until this confirmation action occurs. Editing does not auto-save: Save persists a draft, while confirmation saves the complete set as confirmed before downstream work begins.
User-facing Chinese label: 确认演示需求

演示需求确认页只展示「生成规格」（页数、语言、页面尺寸）和「研究选择」（网页、图片）。受众、用途、预期效果和视觉气质不再生成、确认、保存或作为结构化约束注入提示词；原始需求描述中的明确表达继续有效。视觉方向由模板参考与工作区视觉母版承接。旧需求读取时只丢弃这四个历史字段，保留已有状态、规格、研究选择和模板，不自动重写已生成内容。详见 [ADR-0058](docs/adr/0058-remove-requirement-content-goals.md)。

**Visual Style Preset**:
A selectable, reusable visual-reference collection for a Deck. It has a user-facing name, concise description, UI-only preview images, and an ordered catalog of Template Reference Pages whose HTML may guide aesthetics but never supplies factual content; confirmation copies the preset catalog and reference HTML into an immutable Workspace snapshot so later catalog changes do not affect the Deck.
User-facing Chinese label: 模板
_Avoid_: Template Group, Executable Template, Template Catalog

**Template Recommendation（模板推荐）**：
从原始需求描述提取用途、行业、受众、内容形式及明确／推断／排除的视觉风格，仅用于内置模板匹配，不增加演示需求字段或事实。模型成功时由本地评分选取；信号不足或模型失败时保存最多三个候选，交互流程必须由用户选择后再确认。个人模板支持手动创建和选择，自动推荐仍不读取或纳入个人模板。内部批量测试允许直接采用首选候选并记录推荐详情；`template-recommendation-completed` 只运行推荐，`reuse_requirements` 只用于需求确认截止点的重复测试，后续重复复用规格与研究选择，但重新推荐模板。参见 [ADR-0073](docs/adr/0073-integrate-template-recommendation-and-color-variants.md)。

**Template Color Variant（模板配色）**：
同一内置模板可提供多套命名配色，通过八个语义颜色角色控制参考 HTML。选择身份使用基础模板 ID 与配色 ID 组合；确认时配色物化进不可变参考快照。列表默认显示静态 WebP，首次悬停／聚焦配色色块或选中非默认配色后才加载实时预览；弹窗按打开时加载，已准备的卡片预览保留以避免重复闪烁。

**Template Reference Page**:
One complete HTML example inside a Visual Style Preset, identified by a contained relative path and a one-sentence description of its content structure and appearance. A reference-selection decision may choose it as the dominant aesthetic reference for a Workspace Visual Master or one Page Source, but its text and claims are never grounding evidence.
User-facing Chinese label: 模板参考页
_Avoid_: Page Source, Preview Image, Factual Source, Executable Template

**Personal Template（个人模板）**:
用户从单个最大 20 MiB 的 PPTX 或图片（PNG/JPG）创建的应用级 Visual Style Preset，包含一份预生成 HTML 视觉母版、1 至 6 页模板参考 HTML、逐页描述、预览，以及一份结构化设计档案（design profile：Logo、配色、字体、背景、页眉页脚页码、页面类型）。创建过程通过 `doc_read` 选出原文稿页码，再由 `pptx-svg` 生成图片供独立会话创作；图片上传同样先选页/裁切再逐页创作。提取出的 design profile 在生成母版和参考页**之前**进入只读预览与编辑确认门，用户确认后才参与生成；profile 同时注入母版与参考页创作提示词。生成后对参考页做 canvas 取色漂移检测，实测色板与 profile 承诺色偏差超阈值时自动重写恰好一次并在 UI 标红。未完成模板以草稿保留并可继续，全部工件就绪后才进入可选模板目录。确认演示需求时，母版和参考页一起复制到作品；生成流程复用母版，每页仍单独选择主导美学参考。个人模板不是上传资料、事实依据或旧的 Style Profile。
User-facing Chinese label: 我的模板
User-facing English label: My templates

**Personal Template Creation Run（个人模板创建运行）**：
一次新建或继续创建操作。新建先分配 `ppt/user-templates/<id>/` 草稿目录，再上传原件；上传失败仍保留可排查的草稿，缺少原件时需重新选择同名 PPTX。继续操作沿用模板目录，每次分配独立 `creation_run_id`，已完成母版和页面可复用。

**Personal Template Diagnostic Bundle（个人模板问题排查包）**：
按明确选中的模板 ID 收集原件、生成文件及 `.log/`，不包含其他作品或整个模板库。设置页从“我的模板”进入时保持模板诊断上下文；没有明确选择时要求选择模板。生成期间可下载：日志在独立锁内复制，其他文件沿用逐项稳定性校验，不承诺原子快照。详细会话日志记录 App 实际观察到的全部原始帧并分批追加，超出队列容量或写入失败时明确记录缺口；不推断未观察到的宿主帧。开关仍为 `VITE_PPT_LOG_ENABLED`。见 [ADR-0074](docs/adr/0074-personal-template-diagnostics.md)。

**Dominant Aesthetic Reference**:
Exactly one Template Reference Page selected and persisted for the creation of one Workspace Visual Master or one Page Source because its described composition best matches that target's needs. Different targets may select different references, multiple reference HTML documents are never combined into one authoring prompt, and resumable generation reuses a valid prior selection.
User-facing Chinese label: 主导美学参考
_Avoid_: Template Assignment, Content Source, Reference Set, Layout Template

**Outline**:
A Workspace-owned presentation title, a string `global_creation_requirements` (empty when absent), and an ordered list of slide-level Outline Entries. It has an `empty`, `draft`, or `confirmed` lifecycle and does not own output language, template selection, or visual theme creation.

**Outline Entry**:
The content intent for one planned slide, consisting of a page type, title, and `content: string`. An optional `creation_requirements: string` contains only explicit page-specific user instructions; global instructions are not duplicated on each page. Content defaults to 300–600 characters of continuous prose, but explicit user wording, form, length, and visual requirements take precedence. Existing research and analysis metadata may remain for compatibility. Each entry may also own `selected_image_ids`, assigned after text creation and editable during Outline Review; missing or empty means no image. An Outline Draft entry has no page identity; Outline Confirmation assigns a stable opaque `page_id` for the lifetime of that Confirmed Outline and its Deck Generation.

大纲不再包含 `core_message`（核心信息）；生成、改写、保存、校验及后续提示词均使用标题和正文。读取历史大纲时丢弃旧字段，保留正文、页面标识和确认状态；不将旧字段拼入正文或自动重新生成已有页面。详见 [ADR-0067](docs/adr/0067-outline-inline-title-without-core-message.md)。

**Required Content**:
The compatibility Markdown projection of all segmented `content` items for downstream modules that have not yet migrated. Outline Review presents one Page Content section rather than a separate Required Content field.
_Avoid_: User-facing Outline field, Final Copy, Page Layout

**Creation Requirements（创作要求）**:
大纲持有用户明确提出的制作指令：顶层 `global_creation_requirements: string` 承接全局要求，无要求时为空字符串；逐页可选 `creation_requirements: string` 只承接该页专属要求，无要求时省略。多项指令用换行分隔，尽量保留用户原话、数字、否定词、范围和例外，不推断、扩写或泛化总结。它们不是展示文案，也不提供新的业务事实。

大纲审阅可编辑两级要求，沿用现有显式保存与确认。改写只返回预览，未涉及的要求原样保留，重排时单页要求随内容页移动。HTML 生成、精修、候选、美化与布局修复只接收全局及当前页要求，配图和参考选择也遵守适用要求；视觉母版只接收全局要求。用户要求优先于模板与默认美学建议，本轮明确修改只覆盖对应旧要求。旧 `copy_rewrite_freedom` 字段读取后丢弃，不再保存或进入模型。见 [ADR-0066](docs/adr/0066-outline-creation-requirements.md)。

**Outline Draft**:
A complete and deterministically valid Outline that is still open to user confirmation. Manual edits remain local until explicitly saved.

**Confirmed Outline**:
An Outline accepted by the user for downstream generation. Confirming it first saves and validates the current content, then automatically starts the downstream workflow; any later saved content change returns it to an Outline Draft.

**Outline Review**:
The required user step where the presentation title, each page title, Page Content, global and page Creation Requirements are directly reviewed and edited before explicit confirmation. It also exposes a natural-language AI Rewrite Request that may revise the current Outline Draft, including explicit structural changes, while the result remains subject to Outline Review and explicit confirmation. It is never skipped, and saving synchronizes the confirmed Presentation Requirements page count to the current Outline entry count.

**Outline Creation**:
The process that automatically starts after Presentation Requirements Confirmation and creates a new Outline Draft from the source Brief, readable Confirmed Presentation Requirements, and available uploaded-source analysis. Confirmed selections are authoritative over conflicting Brief wording, and Outline Creation does not perform template selection or visual theme creation.

大纲生成和改写的模型响应中，每页还须在正文前输出 `generation_notes`（生成依据与说明）字符串，记录来源、统计口径、派生指标输入与算式及结果、解释边界；无数据或派生计算时允许为空字符串。它只用于本轮生成约束，解析校验后丢弃，不属于持久化 Outline Entry，也不传给 HTML 页面生成。正文必须保留理解本页所必需的口径和限制。原始响应仍可随已有诊断日志保留；格式校验不代表数值已经过程序复算。

大纲生成和优化统一采用分段会话协议：第一轮只返回 `title` 与正整数 `total_pages`，之后由程序固定按最多 20 页请求 `items`（1～20、21～40，最后一段为剩余页数）。每页须包含临时全局页码 `page_number`，解析后与 `generation_notes` 一起丢弃。首次生成总页数必须等于已确认需求；优化输入包含完整现有大纲及页码，提示词要求未明确增删页时保持现有页数。每轮检查 JSON、字段、数量和连续页码范围，失败后同一会话最多追加 3 次纠正；耗尽或会话故障则丢弃整轮部分结果，新会话从原始请求和标题轮开始，最多追加 5 次整体重试。取消不重试。不再接受少页或截取超页结果，全部段通过后才配图并保存完整大纲。诊断记录区分会话轮次、标题阶段和分段页码范围。详见 [ADR-0063](docs/adr/0063-chunked-outline-sessions.md)。

**Rewrite Request**:
A natural-language instruction for revising the current Outline Draft. The request uses a dedicated Agent Session, includes the current draft and confirmed requirements, and returns a complete revision as a temporary preview. Only explicit Apply saves it as the new Outline Draft; dismissing the preview preserves the current draft. Outline Confirmation is still required before downstream generation.

大纲审阅使用展示标题、页码和封面标记的紧凑卡片，右侧按已选顺序最多展示三张配图缩略图，末尾始终保留加号；超过三张时叠加剩余数量，不限制实际选择。缩略图打开大图，加号直接进入共用配图窗口；确认配图只更新当前大纲草稿，仍需底部保存或确认，取消不应用选择。卡片支持拖动和键盘排序，窄屏图片区移到标题下方。点击标题区打开右侧详情；直接点击详情顶部标题编辑，页面类型选择紧接标题之后，正文区编辑页面内容、本页创作要求和配图，不重复展示标题字段。详情编辑在保存前独立暂存，取消或关闭不应用修改，保存失败保留编辑。AI 修改从右上角弹窗发起，先展示当前大纲与修改预览，再由用户确认应用。见 [ADR-0065](docs/adr/0065-outline-review-drawer-and-rewrite-preview.md)、[ADR-0067](docs/adr/0067-outline-inline-title-without-core-message.md) 和 [ADR-0079](docs/adr/0079-outline-card-image-entry.md)。

**Outline Image Assignment（大纲图片分配）**:
An independent metadata-only Agent Session after Outline Creation that chooses page images from usable uploaded and searched assets. Uploaded images take priority; each image must serve the page content, and automatic assignment avoids repeating image content across the Deck; manual selections may reuse it across pages, and rewrites may preserve existing reuse. Assignments persist on Outline Entries and remain editable before confirmation. Search-result titles are retained alongside descriptions.

本页已选配图在 HTML 创作提示词中属于用户明确的创作要求，必须全部清晰展示；模型不得自行筛选、遗漏、隐藏或替换，模板参考不能成为省略图片的理由。封面、普通页、精修和批量重新生成共用此规则；前 6 张原图附件预算不限制必须展示的图片数量。生成结果不增加漏图检查，仍由模型遵守要求。

新入库的搜索图片、按页补图、上传资料配图及手动配图统一使用 `image-<SHA-256 前 16 位>.<扩展名>` 文件名；完整哈希与素材标识继续用于去重及引用，来源目录保持原有归属。短文件名被不同内容占用时拒绝覆盖。历史素材保留旧路径，不自动迁移已有 HTML 的引用；手动配图目录通过可选 `file_name` 保存新文件名，旧条目仍按完整哈希解析。详见 ADR-0055、ADR-0068、ADR-0070。

**Page Image Search（按页补图）**:
用户通过大纲卡片加号、大纲详情或单页批量重新生成的“选择或搜索配图”入口打开共用配图窗口，详情按钮旁提示“已有图片 · 上传 · 搜索”，卡片加号通过悬停提示说明。主动输入关键词后，一次搜索最多获取 20 个结果，按内容哈希合并成功获取的候选及其 APS 引用，不改变首次研究进度或自动研究开关。窗口展示当前未保存的页码、标题、大纲及本页已选图片，下方“已有图片”“搜索图片”共用选择草稿；切换标签和新搜索不清空选择，窗口内可切回最近五轮结果，不读取或恢复旧搜索任务。搜索及取消收尾期间禁止关闭，取消保留已成功获取的候选，底层任务与诊断记录随作品保存。预览按需刷新 APS 地址，“确认配图”时才统一下载、校验并保存所选原图，不调用描述模型；部分失败保留选择且仅重试失败文件。保存成功的空描述图片立即可用，全部成功后只更新当前编辑输入；卡片入口仍需保存或确认大纲，详情仍需保存修改，单页生成仍需采用候选。详见 [ADR-0069](docs/adr/0069-page-image-search.md)、[ADR-0077](docs/adr/0077-image-candidates-and-deferred-descriptions.md)、[ADR-0078](docs/adr/0078-unified-page-image-manager.md) 和 [ADR-0079](docs/adr/0079-outline-card-image-entry.md)。

**Manual Page Image Upload（手动上传配图）**：
用户在大纲卡片、大纲详情或单页批量重新生成的共用图片选择器中主动上传配图。原图作为独立作品素材保存，不加入首页上传资料集合；添加阶段只校验、保存文件，不调用描述模型。成功图片以空描述进入共用素材库并默认勾选，仍需保存或确认大纲、保存详情或采用生成候选才应用页面修改。单张文件失败可重试，不影响其他成功图片；文件处理期间禁止关闭弹窗。关闭编辑不删除已入库素材，原图及元数据随作品快照保存，重复内容复用已有素材和描述。生成前只为实际选用且缺描述的图片补充客观描述，最终失败仍继续生成。详见 [ADR-0070](docs/adr/0070-manual-page-image-upload.md) 和 [ADR-0077](docs/adr/0077-image-candidates-and-deferred-descriptions.md)。

**Outline Confirmation**:
The explicit user action that first preserves the currently displayed content as the current Outline Draft, then validates every entry, assigns a new opaque `page_id` to every entry, marks the run's Outline confirmed, and automatically starts the downstream workflow. If that first Deck Generation is abandoned, the confirmation does not become current and the preserved Outline Draft remains; otherwise, when an existing Deck is present, successful Generation Commit replaces its current generation state and page identities rather than maintaining parallel Deck versions.

**Authoring Kit**:
The legacy TSX page-authoring foundation that provided a Page Source Bootstrap, reusable foundations, and reference guidance. HTML Page Authoring does not install or read it.
_Avoid_: Template, Template Catalog

**Presentation Principles**:
The Authoring Kit's shared normative guidance for page-role and information-hierarchy decisions, Chart Value Readability, and Formal Presentation Cover conventions. A Workspace receives the principles as part of its read-only Authoring Kit snapshot; they provide defaults beneath explicit user requests and confirmed Presentation Requirements or Outline decisions, while the Workspace Style Guide specializes visual expression. They do not prescribe executable layouts or replace Required Content or a Reference Implementation.
User-facing Chinese label: 演示文稿创作原则
_Avoid_: PPT Tips, PPT Skills, Slide Tips, Workspace Style Guide

**Chart Value Readability**:
The condition that a chart's decision-relevant numerical values and their meaning are directly readable rather than recoverable only by estimating marks, colors, or axes. Small-category exact-value charts should expose each relevant value, while dense charts may expose key values or an equivalent readable numerical expression; quantitative charts identify the necessary unit and statistical scope, and externally sourced data includes a concise traceable source when needed.
User-facing Chinese label: 图表数值可读性
_Avoid_: Data Labels, Chart Decoration, Axis Readability

**Formal Presentation Cover**:
A cover page convention for formal reporting contexts such as board meetings, operating reviews, project reports, policy briefings, and serious proposals. It normally identifies the presentation title, topic or period, presenter or organization, and presentation date when those facts are available; it is conditional on the Deck's purpose and is not synonymous with the first page or every opening page.
User-facing Chinese label: 正式汇报封面
_Avoid_: Generic Cover, First Page, Opening Page

封面以大纲中的 `page_type=cover` 识别，不以页序推断。大纲的 `content` 只提供简约封面文案及资料中已有的必要身份、日期等信息，不适用普通页的长段叙述和字数要求。封面 HTML 生成与精修明确使用封面构图并允许充分留白，视觉参考只传选定的一份模板参考 HTML，不读取或注入工作区视觉母版；精修仍接收原页面和用户本轮修改意见。

**Opening / Orientation Page**:
A page that orients the audience to the topic, context, central thesis, or reading path before or alongside the first substantive point. It may be combined with a Content / Analysis Page and does not automatically require a Formal Presentation Cover.
User-facing Chinese label: 开场/导览页
_Avoid_: Generic Cover, Agenda Page

**Content / Analysis Page**:
A page whose primary responsibility is to develop one substantive idea through evidence, comparison, metrics, a chart, a timeline, or another explanatory structure. Its visual composition serves the page's content intent rather than functioning as a deck identifier or a closing gesture.
User-facing Chinese label: 内容/分析页
_Avoid_: Detail Dump, Generic Content Page

**Closing / Next Action Page**:
A page that synthesizes the Deck's takeaway, recommendation, decision, or next action for the audience. It is not defined by a thank-you label alone and may be combined with the final substantive point when the page count is small.
User-facing Chinese label: 收束/下一步页
_Avoid_: Thank-you Page, Empty Closing

**Presentation Identity**:
The presenter or organization identity shown on a Formal Presentation Cover. User-provided identity takes precedence; when the user provides neither, the default Presentation Identity is ANNA AI.
User-facing Chinese label: 演示身份
_Avoid_: Author, Owner, Speaker Note

**Workspace Authoring Kit**:
A legacy Workspace-owned, read-only Authoring Kit snapshot used by TSX Page Authoring. An `html-authoring-v1` Workspace uses its Visual Style Preset snapshot and Workspace Visual Master instead.
_Avoid_: Live Authoring Kit Reference, Selected Template

**Foundation Module**:
A legacy reusable module that TSX Page Sources could import from the Workspace Authoring Kit. Complete HTML Page Sources do not depend on Foundation Modules.
_Avoid_: Reference Implementation, Template Component

**Reference Implementation**:
A legacy read-only TSX example in the Workspace Authoring Kit. HTML Page Authoring uses Template Reference Pages from the confirmed Visual Style Preset snapshot instead.
_Avoid_: Foundation Module, Blueprint, Importable Reference Component

**Reference Library**:
The legacy collection of Reference Implementations in the Workspace Authoring Kit. It is not part of the HTML Page Authoring path.
_Avoid_: Template Catalog, Blueprint Registry, Reference Registry

**Page Source Bootstrap**:
The legacy engine-owned minimal TSX resource used to initialize a TSX Page Source. HTML Page Authoring creates complete Page Sources from Session output and does not use a Bootstrap.
_Avoid_: Blueprint, Blank Template Layout, Example Slide

**Workspace Visual Master**:
The Workspace-owned, Deck-level HTML authoring reference that defines the shared visual variables, fixed regions, repeated elements, and Content Safe Area around one `{{PAGE_CONTENT}}` placeholder. Standard content Page Sources materialize its fixed regions, while section-transition and closing pages may omit inapplicable regions. Cover page generation and refinement do not receive the master and use only their selected Template Reference Page as the aesthetic reference; no Page Source imports or composes the master at runtime.
User-facing Chinese label: 工作区视觉母版
_Avoid_: Runtime Template, PowerPoint Slide Master, Workspace Style Guide, Persistent Elements Reference

**Workspace Style Guide**:
The legacy Workspace-owned Markdown visual-guidance artifact used by TSX Page Authoring. HTML Page Authoring uses one Workspace Visual Master instead of maintaining this artifact alongside a separate repeated-elements reference.
User-facing Chinese label: 艺术指导
_Avoid_: Workspace Theme Token, Runtime Theme, Preset Theme

**Persistent Elements Reference**:
The legacy Workspace-owned TSX reference for repeated elements and their Content Safe Area. HTML Page Authoring incorporates this responsibility into the Workspace Visual Master rather than keeping a second shared visual authority.
User-facing Chinese label: 跨页固定元素参考
_Avoid_: Template, Framework, Reference Implementation, Runtime Dependency

**Content Safe Area**:
The region of a page available to page-specific content after the Workspace Visual Master's fixed regions and repeated elements have reserved their required space. It constrains where content may appear without prescribing the page's composition.
User-facing Chinese label: 内容安全区域
_Avoid_: Page Layout, Content Template

**Workspace Style Guide Creation**:
The legacy automatic generation-time step that created a Markdown Workspace Style Guide for TSX Page Authoring. HTML Page Authoring creates a Workspace Visual Master instead.
_Avoid_: Workspace Theme Creation, Theme ID Selection, Preset Theme Selection

**PPTX Rasterization**:
The process that turns a user-provided PPTX into page-level images for visual inspection. It is a reusable preparation step and is not itself Style Profile Creation or Uploaded Source Analysis.
_Avoid_: PPT parsing, PPT import, PPT analysis

**Reference Slide Image**:
A PNG page image produced from reference material so an Agent can inspect visual style. Reference Slide Images may guide Style Profile Creation, but they are not factual grounding evidence for Page Authoring.
_Avoid_: Research Evidence, Visual Research Evidence

**Style Profile**:
A reusable textual visual style guide created from reference slide images or uploaded style-reference images. It can guide Workspace Style Guide Creation, but it does not preserve factual content from its references and is not Research Evidence, Uploaded Source Material, an Authoring Kit, a Workspace Style Guide, or an Agent Skill.
_Avoid_: Research Evidence, Uploaded Source Material, Authoring Kit, Template, Skill

**Style Profile Library**:
The app-level collection of reusable Style Profiles available across Workspaces. It is separate from Workspace-owned artifacts, Research Evidence, and the Authoring Kit.
_Avoid_: Workspace, Authoring Kit, Template Catalog

**Style Profile Creation Workspace**:
A temporary app-level work area used while creating one Style Profile from reference material. It is not a deck Workspace and does not participate in Outline Creation, Uploaded Source Analysis, Research Discovery, or Deck Generation.
_Avoid_: Workspace, Uploaded Source Material

**Selected Style Profile**:
A Workspace-owned copy of the Style Profile guidance chosen for that Workspace. It preserves the reusable guidance used by Workspace Style Guide Creation even if the original Style Profile later changes; changing or clearing it makes the current Workspace Style Guide and affected Page Sources stale.
_Avoid_: Live Style Profile Reference

**Style Profile Creation**:
The process that turns reference slide images or uploaded style-reference images into a reusable Style Profile. It is separate from Deck Generation and does not produce a Deck.
User-facing Chinese label: 创建风格画像
_Avoid_: Deck Generation, Uploaded Source Analysis

**Research Discovery**:
The deck-level process that follows the user's confirmed Web and image research choices. Web research runs after Presentation Requirements Confirmation and before Outline Creation; its final `web-summary.md` supports the outline. Image research runs concurrently with Web research after Presentation Requirements Confirmation and before Outline Creation. It uses the Brief and Confirmed Presentation Requirements without the Outline or Web summary. A separate image-assignment Session follows Outline Creation before user review. Visual material does not become factual evidence by itself.
User-facing Chinese label: 事实收集
_Avoid_: Research Planning

**Presentation Research Recommendation**:
An LLM-produced recommendation, with a concise reason, for whether one Presentation Requirements Draft would benefit from new Web Research and new Image Research. The two recommendations are independent defaults rather than final decisions.
User-facing Chinese label: 研究推荐

**Presentation Research Choice**:
The user's explicit boolean choice, confirmed as part of Presentation Requirements, for whether the current workflow may perform new Web Research and new Image Research. A later recommendation or execution-stage model cannot override it.
User-facing Chinese label: 研究选择

**Research Search Control**:
A Workspace-level or run-level user preference that disables new web or visual external search and fetch during Research Discovery. It does not disable reuse of existing Shared Research Evidence, Uploaded Source Material, or Uploaded Source Analysis.
_Avoid_: Disable evidence, disable uploaded sources

**Research Requirement**:
The decision that more external material is needed because the deck or a refinement target depends on material not already available in Shared Research Evidence. Web Research Requirement and Visual Research Requirement are evaluated independently.

**Web Research Requirement**:
The decision that source-backed web material is needed for real-world facts, current information, public data, citations, named cases, or conflict investigation.

**Web Research Session**:
One Agent Session that owns the decision history for a single Web Research attempt. It requests one Search, Fetch, or Finish action at a time; a Search action may contain 1–3 queries and a Fetch action may contain 1–5 URLs, while the App executes the corresponding Web operations and returns each batch's results together. A retry creates a new Web Research Session and reuses saved Raw Research Material from the interrupted attempt.
User-facing Chinese label: Web 研究会话
_Avoid_: Web Search API, Research Batch

**Visual Research Requirement**:
The decision that external visual assets are needed for the Deck or refinement target. It is independent of Web Research Requirement, although curated web material may inform later visual searches.

**Research Evidence Gap**:
A case where Research Discovery or Research Curation cannot produce enough Shared Research Evidence for a requested deck or page intent. The gap is recorded in the current Shared Research Evidence so Page Authoring knows which details cannot be asserted; it does not block Page Generation, and unsupported concrete details must be omitted, generalized, or marked as TBD / 待补充. Technical failure details belong in the Research Log. Generation Abandonment or interruption during research is unfinished work, not a Research Evidence Gap.

**Raw Research Material**:
External material collected by search, fetch, or image lookup before cleanup or selection. It is not grounding evidence until promoted into Research Evidence.
_Avoid_: Evidence, source of truth

**Uploaded Source Material**:
User-provided files uploaded into a Workspace as source material for the requested deck, such as documents, spreadsheets, images, or HTML. Uploaded Source Material is Workspace-owned from upload time; it is not a browser-temporary input that can silently move between Workspaces. Its identity is stable and not derived from the original filename, so files with the same display name can still be distinct uploaded materials. Uploaded Source Material is not Raw Research Material and is not Research Evidence by itself. It must be analyzed or curated before its facts or visual assets can be used as grounding evidence in deck generation.
User-facing Chinese label: 上传资料
User-facing English label: Source material

**Uploaded Source Analysis**:
A deck-level analysis result produced from Uploaded Source Material before Outline Creation or Deck Generation uses the uploaded material. It captures selected factual content, visual asset understanding, source-use constraints, gaps, and rejected or unusable material. Uploaded Source Analysis remains separate from Shared Research Evidence. It combines the continuation decisions from the factual and visual analysis drafts into the overall decision about whether Outline Creation may continue. When the Uploaded Source Material set or file content changes, existing Uploaded Source Analysis becomes stale, and any Outline Draft or Confirmed Outline that depended on it must be regenerated or reconfirmed before downstream generation uses the changed material.

**Attachment Preflight（附件预处理）**:
引擎对工作区上传资料执行格式解析，并持久化提取文本、警告和上下文策略。PDF 的 OCR（图片文字识别）可能需要多次显式续跑；`processing` 表示尚未完成，不能当作解析失败，也不能提前交给附件摘要。OCR 单页失败保留警告和已有可读文字，不保证扫描页全部识别成功。

**Attachment Brief（附件摘要记录）**:
单个附件的全文或结构化摘要。表格摘要记录可见工作表覆盖情况，PDF 摘录可定位物理页码。沿用附件格式处理模块的校验策略：文档和 PDF 检查摘录来源；表格允许重新组织行文本，通过工作表覆盖和证据引用关系校验，不额外要求逐字匹配原文。

**Attachment Context（附件上下文）**:
由用户需求描述和附件摘要记录组成的工作区资料输入。它与 Uploaded Source Analysis 并存，供需求生成和研究使用；大纲生成和改写将附件资料整理为纯文本，不重复追加旧分析 JSON；页面创作只接收当前页大纲与适用的创作要求，不注入附件上下文。附件始终是参考资料，不能覆盖用户需求或系统指令。批量测试沿用相同资料路径；`attachment-context-created` 仅表示准备附件上下文后停止，不限制其他目标阶段携带附件。

首页资料图片仍在附件分析阶段生成描述与用途判断，摘要随资料进入需求和大纲，只有 `use_in_ppt: true` 的有效资料图片自动进入素材目录。大纲生成后，独立图片分配会话只读取正式上传图片及搜索图片的元数据（不重复附图），不扫描未采用的完整候选池。人工选择器同时展示正式素材和所有成功获取的搜索候选，包含 AI 未推荐、未分析及超过研究附件预算的图片；按内容哈希去重并合并来源、搜索词和 APS 引用。卡片只展示图片来源，推荐与分析状态仍保留在元数据中。勾选只更新弹窗草稿，点击“确认配图”后统一下载、校验并保存所选候选，按钮显示加载状态；全部成功后应用到外层编辑，部分失败保留选择并仅重试未成功图片，直接关闭不应用草稿。原 AI 推荐判断保持不变，诊断文字不能充当画面描述。

按页关键词搜索一次最多获取 20 个结果，人工添加与手动上传都在文件校验、保存成功后即可使用，不调用描述模型；空描述是正常素材状态。两处入口共用图片库及大图预览，支持原图文件失败重试。大纲选图仍需显式保存；单页批量重新生成只修改本次候选输入，采用候选前不改正式大纲和页面。人工选择可跨页复用，自动分配默认避免跨页重复，历史同内容素材标识保持可解析。关闭图片研究不禁用这些人工入口。见 ADR-0055、ADR-0069、ADR-0070 和 [ADR-0077](docs/adr/0077-image-candidates-and-deferred-descriptions.md)。

HTML 生成前统一为本次目标页面实际选用且缺描述的图片补客观画面描述，按 SHA-256 去重，每批最多 6 张，14 张分为 6、6、2。沿用统一会话的有界重试；单图、整批及辅助保存最终失败仍继续生成，成功描述保留，取消必须停止。同次运行的页面重试和恢复复用已处理记录；单页多个候选共享一次准备，整份生成在影子工作区准备并随生成提交。美化、布局修复、精修及首页资料分析不增加此步骤。

首次 HTML 生成（含封面）和单页批量重新生成，额外附带按已选顺序排列的前 6 张原图。图片 JSON 清单保留全部已选素材，并用从 1 开始的 `attachment_index` 对应附件；未附原图为 `null`。附件通过后端按有效素材标识上传原始文件，HTML 仍引用工作区绝对路径。同批候选共享一次准备结果；美化、布局修复和精修仅附整页截图。超过 6 张不阻止选择，在共用配图界面提示可能影响生成效果。见 [ADR-0068](docs/adr/0068-page-authoring-image-attachments.md)。

**Uploaded Source Analysis Continuation Decision**:
A structured decision inside a valid Uploaded Source Analysis result that states whether downstream Outline Creation may continue when some Uploaded Source Material could not be fully parsed or understood. The decision is valid only after the analysis draft itself has been written and passed deterministic validation. Agent session failure, missing or invalid analysis drafts, or missing continuation decisions are analysis failures, not continuable uploaded-source gaps.

**Uploaded Source Factual Analysis Draft**:
An intermediate analysis result that selects factual claims, tables, metrics, source excerpts, gaps, and rejected material from Uploaded Source Material. It owns the continuation decision for factual uploaded-source analysis. It must not select visual assets for page use.

**Uploaded Source Visual Analysis Draft**:
An intermediate analysis result that interprets images, screenshots, charts, diagrams, and other visual material found in Uploaded Source Material, including suitability for PPT use and user-provided use constraints. It owns the continuation decision for visual uploaded-source analysis. Uploaded images and embedded visuals are not usable Visual Research Evidence until selected through Uploaded Source Visual Analysis and promoted into Shared Research Evidence. It must not promote visual text or chart content as factual evidence unless that content is separately captured by factual analysis.

**Research Curation**:
The step that turns Raw Research Material into Shared Research Evidence by selecting relevant facts, derived insights, visual assets, and gaps for the Deck.

**Research Log**:
A Workspace-owned diagnostic record of Research Discovery, Research Collection, and Research Curation activity, including external research API interactions and technical failures. It is separate from AI Interaction Logs, Workspace Storage Transfer Logs, and Page Generation Stage Records; their correlation identifiers connect related AI decisions, external collection, and asset transfers without merging their ownership boundaries.

**Research Evidence**:
Curated facts, derived insights, visual assets, and gaps selected from Raw Research Material for use in Page Generation. Shared Research Evidence is the deck-level authoritative grounding source for generated page content; raw material is never a substitute for it.
_Avoid_: Raw search results, raw crawl output

**Visual Research Evidence**:
A curated visual asset selected for the Deck because it is visually usable and has a documented source. Text, charts, or claims visible inside the asset are not grounded facts unless separately captured as Research Evidence.

**Visual Research Candidate**:
外部图片搜索成功获取、具有稳定 APS 引用及完整内容哈希的原图候选。AI 推荐判断与人工采用是独立状态：未推荐、未分析或因附件预算跳过的候选仍可供用户预览和采用。未采用候选只保留引用和元数据，不进入页面创作的正式素材清单；采用后校验原图并进入作品，不把候选诊断文字当作客观描述或事实证据。临时下载地址不属于持久化候选数据。

**Shared Research Evidence**:
Curated deck-level facts, derived insights, visual assets, and gaps that can support multiple Page Generation Units. It is composed of an ordered history of Research Batches and is the authoritative research grounding source available to page authoring, while external URLs and raw collection records remain diagnostic material rather than Page Authoring context.

**Research Batch**:
One ordered addition to Shared Research Evidence produced during initial Deck Generation or a later Deck or Page Refinement. A batch records curated evidence or an explicit skipped or gap outcome. Its heading may describe the generation or refinement that produced it for human readability, but it does not define page-level applicability and Page Authoring does not filter research by a structured target-page scope. Newer information takes precedence when it conflicts with older information, while older batches remain part of the evidence history.
User-facing Chinese label: 研究批次
_Avoid_: Research Update, Page Evidence Assignment

**Deck**:
The finished presentation content before export.

**Stale Deck**:
A deck that was generated from an earlier Confirmed Outline, Workspace Authoring Kit, Workspace Style Guide, style input, or setting and should not be presented as current until regenerated.

**Deck Generation**:
The process that turns a confirmed outline into presentation pages; it does not include outline creation from a brief.

**Deck Generation Public Facade**:
The stable app-facing entry boundary for Deck Generation, Deck Generation Resume, Generation Abandonment, and future refinement workflows. It exposes the workflow capabilities without owning their internal workflow decisions.
_Avoid_: Workflow implementation, orchestration module

**Active Deck Generation**:
A deck generation process that is currently running; the official Workspace's presentation content is frozen during this period and is replaced only by successful Generation Commit.

**Interrupted Deck Generation**:
A Deck Generation that is neither running nor finished, with the Workspace Style Guide, research, evidence assignment, or Page Source preparation not yet ready, one or more Page Generation Units not yet accepted, or final Deck artifacts not yet ready, and no page actively authoring. It can be resumed as the same run while keeping accepted pages, and the Workspace state that preceded the run remains current until Generation Commit succeeds.
_Avoid_: Abandoned Generation — Generation Abandonment permanently discards its run rather than creating resumable work.

**Unresumable Deck Generation**:
A Deck Generation that cannot be safely resumed because the authoritative pre-run Workspace artifacts are missing, stale, invalid, or inconsistent with the run state. The run ends without replacing the pre-run Workspace, and the user must correct or recreate its authoritative inputs before starting a new run.
_Avoid_: Failed Deck when the issue is an artifact or state blocker rather than a Page Generation failure.

**Generation Step**:
A visible part of deck generation, such as selecting an aesthetic reference, creating the Workspace Visual Master, preparing or authoring Page Sources, rendering a page, or producing the Final Deck Render.

**Final Deck Render**:
The deck-level Generation Step that turns the current accepted version of every Page Generation Unit into final previewable page artifacts and one ordered Deck-level Rendered HTML Snapshot. A current Manual Page Revision participates in place of that page's Page Source render; Final Deck Render is not owned by any single Page Generation Unit, and Deck Generation is not complete until it has succeeded.

**Page Generation Unit**:
One planned page being authored and rendered as an independent part of Deck Generation. It owns exactly one stable Page Source and that page's content and page-level assets; the Workspace Visual Master, Visual Style Preset snapshot, and Deck-level artifacts belong outside the unit.
Its stable identity is the Confirmed Outline entry's `page_id`; the identity is never reused, while page index is ordering rather than identity.

**Page Source**:
The Workspace-owned complete HTML document and authoritative authoring source for exactly one Page Generation Unit, stored as `slides/<page_id>.html` with one `.slide` root at the Workspace’s selected fixed canvas size. Its accepted render is the current page unless a Manual Page Revision supersedes it; the Confirmed Outline provides intent without acting as separate render data.
_Avoid_: Deck Source, Shared Page Entry, Template Layout, Page Data JSON

**Manual Page Revision**:
用户确认保存的单页内容和视觉修改。保存成功后直接替换 `slides/<page_id>.html`，与生成和候选采用共用唯一正式页面来源，不提供恢复编辑前版本。修订元数据仅用于保存版本及并发冲突检测，不再持有独立正文；旧 `manual-edits/<page_id>/current.html` 在首次读取时事务性迁入 slides，缺失或越界时不得静默回退旧源码。
页面预览、编辑上下文、优化、美化及导出读取同一正式内容。静态人工页面直接使用；可执行源码先静态化。预览缺失或旧指纹不同都允许按当前源码重建，只阻止重建期间发生变化的过时结果。创作完成状态独立于派生预览是否存在，后台重建不启动新创作。见 [ADR-0075](docs/adr/0075-single-authoritative-page-source.md)。
人工编辑的未保存草稿只在当前编辑会话内按页暂存，切页不触发持久化；显式保存处理当前页和其余草稿，逐页成功，失败保留剩余草稿，退出统一确认。它不提供整份保存回滚或跨会话草稿恢复。
User-facing Chinese label: 人工页面修订
_Avoid_: HTML Override, Edited Snapshot, Manual Draft

**Rendered HTML Snapshot**:
The Workspace-owned, engine-generated static DOM representation captured after Page Sources have completed browser rendering at the fixed slide viewport. A Page Generation Unit owns one page snapshot, while Final Deck Render produces a separate ordered Deck snapshot in which every accepted page is simultaneously available to whole-Deck consumers; both are rebuildable derived artifacts rather than authoritative Page Authoring sources, and neither carries interactive viewing behaviour.
User-facing Chinese label: 渲染后 HTML 快照
_Avoid_: Page Source, Executable React HTML, Runtime HTML

**Render Readiness**:
The condition in which all tracked dependencies affecting visible content have settled and the rendered DOM and layout are stable enough to capture. A Rendered HTML Snapshot may be published only after this condition is reached; timeout, interruption, or Generation Abandonment leaves rendering unfinished and produces no partial snapshot.
User-facing Chinese label: 渲染就绪
_Avoid_: Fixed Settle Time, Best-effort Ready

**Deck Manifest**:
The engine-owned, rebuildable rendering index that maps the current Confirmed Outline page sequence to Page Sources. It carries no page-planning, evidence-assignment, generation-state, or authoring decisions and is not edited by an Agent.
_Avoid_: Page Plan, Page Source of Truth, Agent-authored Manifest

**Active Page Generation**:
A Page Generation Unit that has started and has not yet reached an accepted, failed, or interrupted terminal state. Its live stream may be shown while it is active.

**Deck Generation Progress**:
The aggregate progress of an Active Deck Generation across all Page Generation Units. It describes counts and overall state rather than naming one current page.

**Page Progress**:
The Workspace-owned persisted execution state for Deck Generation, keyed by Outline Entry `page_id`. It owns deck/page recovery state and the latest successful rendered HTML reference, while page title and order remain projected from the Confirmed Outline. `snapshot_source_sha256` records the source version of that snapshot; legacy `screenshot_source_sha256` is accepted on read. Screenshots are transient session attachments, not persisted page artifacts.
_Avoid_: Pages Index, Deck Content Source

**Live Page Stream**:
The visible stream for an Active Page Generation. It shows the current page run while that page is still active.

**Page Generation Stage Record**:
单页创作、渲染、检查与修复的内部阶段记录，可包含实时或已完成的模型输出，用于已有进度投影。生成页只展示页码、标题、当前状态及最终失败摘要，不再提供逐页“查看生成过程”或嵌套阶段卡片；实时 HTML 继续用于视觉预览，诊断日志及其开关保持原有规则。见 [ADR-0076](docs/adr/0076-compact-page-generation-status.md)。

**Page Layout Check（页面布局检查）**:
HTML 主流程中，每页首次生成并成功渲染后、接受之前，由引擎对当前静态 HTML 快照执行现有 `layout-audit` 检查，画布使用作品已选页面尺寸。仅严重问题数大于 0 时触发一次 Page Layout Rewrite；警告和可疑项不影响接受。检测失败属于可重试的页面失败，不视为无问题。

**Page Layout Rewrite（页面布局修复）**:
由严重布局问题触发的新 HTML 会话，复用现有会话失败重试机制。提示词使用工作区 `slides/` 下的权威 HTML、该版本的截图附件及适用的全局/本页创作要求（精修时保留本轮修改意见），不附加大纲正文、视觉母版、模板参考或检测报告；要求保留原文，修复溢出、遮挡和大量空白。结果保存并重新渲染后直接接受，不再次检查；同一页面生成尝试最多重写一次。用户恢复失败页仍按现有规则重新完整生成该页。详见 [ADR-0059](docs/adr/0059-page-layout-audit-and-single-rewrite.md)。

**Page Visual Review**:
The optional, user-enabled Page Generation check that judges whether a rendered page screenshot is visually usable as a PPT page, including layout completeness, readability, overlap, cutoff, contrast, missing or broken visuals, unintended blank areas, and fit within the canvas. A valid review also includes a concise description of what the attached screenshot visibly contains, so diagnostics can distinguish an actual visual judgment from an unreadable image input. Failure to make the screenshot available or obtain a valid review is a Page Visual Review infrastructure failure rather than a page render or usability failure; after its own infrastructure retries are exhausted, the current rendered page is accepted without entering visual-review-fix. It does not read or judge the Workspace Style Guide or Visual Style Preset, and does not review factual grounding, output language, or content correctness; after bounded automatic fixes for a valid failed review are exhausted, the page is accepted with the unresolved review recorded so the user can inspect the completed Deck instead of being blocked.
_Avoid_: Self Review when referring to the visual-only screenshot check.

**Generation Session History**:
Deck Generation 的运行内历史记录，保留已有收集与进度投影行为，不再通过逐页详情展示。实时页面内容继续由预览呈现；已放弃运行只属于诊断信息，不作为可恢复或已完成的生成结果。它不替代持久化的 AI Interaction Log。
_Avoid_: User-facing labels such as "Session History" when the record is really page generation work.

**AI Interaction Log**:
A Workspace-owned diagnostic record of each LLM completion or Agent run used to produce, revise, inspect, or repair deck artifacts, including runs later abandoned by the user. It is for troubleshooting and auditability, separate from the in-memory Generation Session History.
Workspace diagnostic recording is opt-in through the App build setting `VITE_PPT_LOG_ENABLED=true`; disabling it preserves generation state and existing logs. See [ADR-0061](docs/adr/0061-control-diagnostic-logging-from-app-env.md).
_Avoid_: Session History, Live Page Stream

**Workspace Storage Transfer Log**:
A Workspace-owned diagnostic record of Host Upload and APS Files transfer activity associated with the Workspace, including transfer lifecycle phases, source operation associations, storage identifiers, and failure responses. It is separate from AI Interaction Logs and does not store file contents; it exists to trace transport and persistence boundaries for troubleshooting.
_Avoid_: Agent Session Log, Export History, Uploaded Source Material

**Performance Testing**:
An internal, explicitly enabled testing capability that measures user-perceived interactions and authoritative workflow stages before release using performance metadata rather than business content or raw diagnostic payloads. It is separate from Workspace diagnostics and does not collect ordinary users' production activity.
User-facing Chinese label: 性能测试
_Avoid_: Production Telemetry, Product Analytics, Workspace Diagnostics

**Performance Run**:
A bounded recording session within Performance Testing that captures the tester's actual product operations and may involve zero, one, or multiple Workspaces. It begins and ends explicitly, remains active across an app or engine interruption until a tester resolves it, is the source record for its performance report, and at most one may be active within a PPT global workspace root.
User-facing Chinese label: 性能测试运行
_Avoid_: Workspace, Generation Run, User Session

**Performance Run Finalization**:
The retryable process that stops a Performance Run from accepting new observations and derives its performance report from the captured source record. When explicitly forced, it marks unfinished Performance Operations as interrupted without stopping the measured product work; its own failure is a failure of the testing capability rather than a verdict on any measured product operation.
User-facing Chinese label: 结束并生成报告

**Abandoned Performance Run**:
A Performance Run explicitly ended by a tester without producing a valid performance report. Its captured observations remain diagnostic material rather than becoming a completed test result.
User-facing Chinese label: 已放弃的性能测试运行
_Avoid_: Deleted Performance Run, Failed Product Operation

**Button Interaction**:
A measured activation of a PPT App-owned button with a stable testing identity, from the tester's action through the browser's next presentation of that interaction. It describes interaction responsiveness rather than completion of asynchronous business work; key asynchronous buttons may additionally measure their explicit feedback state, and controls inside generated content or embedded page output are excluded.
User-facing Chinese label: 按钮交互
_Avoid_: Button Task, Business Operation, Click Handler Duration

**Performance Operation**:
A measured product operation with an explicit lifecycle and outcome, potentially spanning frontend, backend, and workflow stages. A key asynchronous Button Interaction may start one, while purely local controls do not require one.
User-facing Chinese label: 性能操作
_Avoid_: Button Interaction, Diagnostic Log Entry

**Performance Attempt**:
One actual automatic attempt within a parent Performance Operation, including its own lifecycle and outcome. Automatic retries create additional attempts under the same operation, while a tester's explicit retry begins a new Performance Trace.
User-facing Chinese label: 性能尝试
_Avoid_: Performance Operation, User Retry, Hidden Recovered Failure

**Performance Trace**:
The causally connected record of one tester intent or system-initiated flow within a Performance Run, composed of related Performance Operations across product boundaries. A Performance Run contains many Performance Traces, while existing diagnostic operation and interaction identifiers remain linked evidence rather than being redefined by the trace.
User-facing Chinese label: 性能链路
_Avoid_: Performance Run, AI Interaction Log, User Session

**Performance Report**:
A derived presentation of the performance measurements captured by one completed Performance Run, organized by stable interactions, operations, and workflow stages. It reports observed metrics without assigning a product score or turning measured business failures into a verdict on the report itself.
User-facing Chinese label: 性能报告
_Avoid_: Performance Score, Test Verdict, Diagnostic Bundle

**Performance Data Integrity**:
The completeness assessment of a Performance Run's captured measurements, based on known event loss, corruption, or producer sequence gaps. It is independent of the run's lifecycle, report generation outcome, and the success or failure of measured product operations.
User-facing Chinese label: 性能数据完整性
_Avoid_: Performance Run Status, Product Operation Status

**Performance Run History**:
The retained collection of terminal Performance Runs available for later inspection or report regeneration. It is not automatically expired; testers explicitly remove runs they no longer need.
User-facing Chinese label: 性能测试历史
_Avoid_: Workspace History, Generation Session History, Automatic Retention

**Failed Page Generation**:
A Page Generation Unit that reached a terminal state without becoming accepted after its automatic recovery attempts are exhausted or manual review is required. Its run and accepted pages remain available for retry while the pre-run Workspace stays current; only Generation Abandonment discards them, and Generation Commit cannot begin until every failed page is resolved.

**Interrupted Page Generation**:
A Page Generation Unit that was Active but whose run is no longer owned by any process because the app exited or lost the run before the unit reached an accepted or failed verdict, including interruption during Research Collection or Research Curation. It is unfinished in intent but terminal in fact: no run is advancing it, so it must be explicitly resumed or retried.
_Avoid_: Abandoned Page — Generation Abandonment discards the whole run rather than leaving resumable page state. Distinguish from Failed Page Generation, which exhausted recovery or needs review.

**Agent Session Cache Miss**:
A transient Agent Session infrastructure failure where the platform cannot continue an Agent run because the app session authorization is unavailable. It is treated as infrastructure failure, not as a Page Generation content or render failure.

**Deck Refinement**:
A user-requested revision of an accepted Deck as a whole after Deck Generation. It may update deck-level context, output language, Confirmed Outline, Shared Research Evidence, and selected Page Generation Units while preserving unaffected accepted pages when safe.
When the Confirmed Outline changes without changing output language, only Page Generation Units whose outline intent changed are affected unless the request explicitly asks for a global style, language, or narrative rewrite.
Deck Refinement preserves the Deck title unless the request explicitly changes it. A changed title updates the Workspace and active Confirmed Outline authorities but affects only the Page Generation Units that the reconciliation identifies as needing to express the new title.
An explicit output-language change updates the Confirmed Presentation Requirements, rewrites the active Confirmed Outline in the new language, and makes every retained Page Generation Unit a refinement target. Merely using foreign terms or examples does not change the Deck output language.
Deck Refinement keeps research choices and the confirmed template unchanged. Its final page count is synchronized from the reconciled Confirmed Outline rather than decided as a separate requirement update.
Deck Refinement preserves the current Workspace Style Guide unless the request changes the Deck's shared visual direction. In a Workspace with a confirmed Visual Style Preset, the preset's Style Guide is immutable: a shared visual request may override it for targeted Page Generation Units through the active Deck Refinement Request, but never replaces the Workspace Style Guide. Without a confirmed preset, replacing the Workspace Style Guide makes every retained Page Generation Unit a refinement target, while page-local visual changes leave the shared guide unchanged.
For retained Page Generation Units, Deck Refinement preserves the existing Page Source; requested layout changes are handled by Page Authoring against that source.
New Page Generation Units introduced during Deck Refinement are initialized from the engine's Page Source Bootstrap because they do not yet have a Page Source.
Deleted Page Generation Units are removed from the current Confirmed Outline, progress, manifest, and render artifacts, but their old workspace files may remain as unreferenced artifacts.
Deck Refinement uses the active request and existing Workspace material as its available grounding. It does not invent unsupported facts, numbers, dates, names, claims, or source-dependent visuals when that material is insufficient.
Target Page Generation Units in Deck Refinement receive both the deck-level request and a page-level refinement reason so page authoring can preserve useful existing work while applying the whole-deck change.
Deck Refinement outline reconciliation is operation-based so retained Page Generation Units keep their `page_id` identity across keep, update, add, and delete decisions.
The final operation order owns the resulting page order, so retained Page Generation Units may move without changing identity. Deck Refinement should add, delete, or reorder Page Generation Units only when the request explicitly asks to change page count, structure, sequence, section organization, or narrative flow; ordinary quality or whole-deck improvement requests preserve page count and order.
_Avoid_: Starting a new Deck Generation when accepted pages can be preserved.

**Deck Refinement Request**:
The user's active instruction for revising an accepted Deck as a whole. It may explicitly change the Deck title, output language, page structure, page intents, or shared visual direction, while requirement fields other than output language remain unchanged.

**Deck Refinement Planning**:
The pre-commit decision process that reconciles a Deck Refinement Request into the resulting Deck title, output-language decision, ordered page operations, complete changed or added Outline Entries, shared Style Guide decision when the Workspace has no Visual Style Preset, and page-level refinement reasons. With a confirmed preset, the planning result keeps the preset Style Guide and still identifies every Page Generation Unit affected by the active request. It does not author Page Sources and preserves page count and order unless the request explicitly authorizes structural change.

**Deck Refinement Resume**:
The user action that continues an unfinished Deck Refinement from persisted deck-level decisions and target pages. It does not reinterpret completed context, outline, Shared Research Evidence, or research-routing decisions as a new request.
The committed target Page Generation Units already own their refinement execution states, while the persisted Deck Refinement Request and page-level reasons preserve the authoring intent needed to continue without replanning.

**Deck Refinement Preparation**:
The visible pre-commit phase of Deck Refinement that derives the complete page reconciliation and, when allowed, a replacement Workspace Style Guide without changing the accepted Deck's authoritative artifacts. A confirmed Visual Style Preset never allows Style Guide replacement; a recoverable preparation failure keeps the same run available to retry the failed stage, while invalid authoritative inputs make the run unresumable.

**Deck Refinement Commit**:
The tool-call-level transition that accepts a prepared Deck Refinement decision as the Workspace's new active generation state, including its reconciled Confirmed Outline, any permitted Workspace Style Guide decision, target Page Generation Units, and recovery state. A confirmed Visual Style Preset keeps its Style Guide unchanged. Deck Refinement Resume applies only after this transition has succeeded.

**No-op Deck Refinement**:
A Deck Refinement whose review and reconciliation steps determine that no workspace artifacts or Page Generation Units need to change. It completes without rerunning page authoring or final deck render.

**Deck Refinement Context Review**:
The deck-level portion of Deck Refinement Planning that decides whether the request explicitly changes output language or the shared visual direction. An output-language change updates only that Confirmed Presentation Requirements field and the active Confirmed Outline. Without a confirmed Visual Style Preset, a shared visual-direction change may replace the Workspace Style Guide; with a confirmed preset, the request instead remains a page-authoring override and leaves the preset Style Guide unchanged. The original Brief and all other confirmed requirement fields remain unchanged.

**Page Refinement**:
A user-requested revision of one or more accepted Page Generation Units after Deck Generation that re-authors only the target Page Sources without modifying the Confirmed Outline or Workspace Style Guide. The current target Outline Entry and Workspace Style Guide remain the original creation baseline, while the active Page Refinement Request is authoritative wherever it conflicts with either baseline.
_Avoid_: Deck Generation Resume, Page Visual Review, Visual Review Fix

**Page Regeneration Alternatives（单页批量重新生成）**:
演示生成完成后，为同一页并发生成 1～10 个独立候选。用户可编辑该页标题、大纲、本页创作要求和配图；所有候选使用同一份编辑后的本页要求及图片选择，采用时同步回写。候选使用独立临时目录，正式内容在采用前保持有效。全部尝试结束后，用户从成功候选的 HTML 预览中选择并再次确认，才将选中 HTML、静态快照及对应大纲项一同发布，保留页面标识、顺序和大纲确认状态，更新整份静态演示并令旧导出失效。采用后清理其他候选，不提供停止、回退或影子工作区；普通大纲保存与 Page Refinement 的原有语义保持不变。详见 [ADR-0053](docs/adr/0053-single-page-regeneration-alternatives.md)。
User-facing Chinese label: 批量重新生成
User-facing English label: Regenerate alternatives

**Page Layout Repair Alternatives（单页布局修复候选）**:
用户通过“布局修复”为当前页并发生成 1～10 个独立方案，默认 2 个；单页批量重新生成仍默认 4 个。两种配置页的生成设置均说明 AI 输出可能不同，可生成多个方案供用户对比选择。布局修复配置页只允许选择方案数量，另以只读形式完整展示本页标题、大纲，以及已有的全局/本页创作要求。
所有会话使用同一份当前已保存的 `slides/<page_id>.html` 原文（包含人工修改）与对应版本的临时截图；截图在会话准备时生成并上传，随后删除本地文件，只额外接收适用的全局/本页创作要求，不附大纲正文、模板参考、视觉母版或检测报告，不调用工具。展示大纲不改变修复输入。提示词要求保留文字，识别并修复重叠、溢出和过多空白。沿用单页候选展示和发布机制，用户确认采用后才替换当前页，采用时不改大纲或模板参考选择。内部批次仍使用 `beautify` 模式。详见 [ADR-0060](docs/adr/0060-page-beautification-alternatives.md) 和 [ADR-0075](docs/adr/0075-single-authoritative-page-source.md)。
User-facing Chinese label: 布局修复
User-facing English label: Repair layout

**Page Refinement Request**:
The user's active instruction for a Page Refinement during the current run. It overrides conflicting target Outline Entry or Workspace Style Guide guidance for the target page without modifying those baseline artifacts; the request and existing Workspace material are the only factual grounding available to the refinement, and the resulting page must not invent unsupported facts, numbers, dates, names, claims, or source-dependent visuals.
_Avoid_: Visual Review Issue, Rewrite Request

**Page Refinement Resume**:
The user action that continues an unfinished Page Refinement using the same persisted Page Refinement Request and the same target pages. It preserves non-target accepted pages and does not reinterpret the refinement as a new request.

**Page Refinement Visual Context**:
A visual attachment captured on demand from the retained target page's latest successful HTML snapshot before refinement resets its execution state. The upload reference may be reused by the session, but its local screenshot file is deleted after upload. It is required visual input for initial Page Authoring, no-change/session retries, and render-fix attempts until a new successful render replaces it; once a new render exists, Page Visual Review and visual-review-fix use that latest rendered screenshot instead. Text, numbers, charts, and claims visible in any screenshot are not grounding evidence unless separately present in allowed sources. A newly added Page Generation Unit has no Page Refinement Visual Context, and a non-target page does not receive one.

**Deck Generation Resume**:
The user action that continues the same unfinished Deck Generation by completing a missing Workspace Visual Master or aesthetic-reference decision, regenerating any Page Generation Unit that is not accepted, or continuing Final Deck Render when all pages are accepted but final Deck artifacts are not ready. It keeps accepted pages from that run without replacing the pre-run current Workspace until Generation Commit succeeds; a page whose HTML could not be rendered is regenerated as a complete page rather than repaired through its old Session.
_Avoid_: Regenerate, Restart — those discard accepted pages and start the whole Deck over.

**Generation Abandonment**:
The explicit user-confirmed action available throughout an active Deck Generation, Page Refinement, or Deck Refinement before its final commit; it permanently discards that run and returns to the Workspace state that preceded it. An abandoned run cannot be resumed or prevent a new run from starting, and any work that finishes afterward cannot become current Workspace content or final Deck artifacts.
User-facing Chinese label: 停止
_Avoid_: Cancellation, Pause, Interrupted Generation

**Generation Commit**:
The final transition that makes a fully prepared Deck Generation, Page Refinement, or Deck Refinement result current in its Workspace. Generation Abandonment may win before this transition begins and is unavailable while the commit is running; if the commit fails, the result never becomes current and the Workspace returns to its pre-run state after the user acknowledges the failure.
_Avoid_: Page Acceptance, Final Deck Render

**Export Artifact**:
A final PPTX or PDF produced from a Workspace for the user to download. The Workspace-owned file remains authoritative even when a separate downloadable copy exists.

**Export Artifact Mirror**:
A PPT App-internal downloadable copy of an Export Artifact stored under an internal path in the user's APS Files namespace. A Workspace has at most one current mirror per export format; replacing it does not create Export History. Its `user` storage scope is a transport constraint and does not by itself make it a My Files Export or create a user-facing file record.
_Avoid_: User File, My Files Export

**Export Download Preparation**:
The process that makes an Export Artifact downloadable by creating its current Export Artifact Mirror. Its failure leaves the Export Artifact intact and may be retried without regenerating the export.
_Avoid_: Export Generation

**My Files Export**:
A user-owned copy of an Export Artifact explicitly saved for reuse outside the PPT App. It is distinct from the PPT App-internal Export Artifact Mirror and requires an explicit user action.
_Avoid_: Export Artifact Mirror

**Workspace Diagnostic Bundle**:
A temporary downloadable archive containing the contents observed while collecting one official Workspace for troubleshooting and, when present, its current foreground or interrupted generation transaction and complete shadow Workspace. It may be collected while generation is active, is not an atomic point-in-time snapshot, changes no Workspace, creates no Diagnostic Bundle History, and produces neither an authoritative Workspace artifact nor an Export Artifact or Export Artifact Mirror.
User-facing Chinese label: 问题排查包
_Avoid_: Log Bundle, Log Export, Export Artifact, Diagnostic Bundle History

**Task State Semantics**:
The authoritative state-meaning module for the Task State Machine. It derives effective deck/page state, allowed operations, blockers, recommendations, and page progress synchronization from Workspace artifacts such as the Confirmed Outline, manifest, and Page Progress.

## Example Dialogue

Dev: "The requirements page already selected the first candidate for every field. Can Outline Creation start now?"

Expert: "No. Those selections are still a Presentation Requirements Draft until the user explicitly confirms the whole set; the requirements gate must block Outline Creation before then."

Dev: "The user selected a template on the Brief page. Is that already the Workspace's visual authority?"

Expert: "No. It is a draft Visual Style Preset choice until Presentation Requirements Confirmation. Confirmation records the preset snapshot and its complete Style Guide; the preview images remain UI-only."

Dev: "The user changed the template after the requirements draft was generated. Can they keep reviewing the old draft?"

Expert: "No. The template change requires a new Presentation Requirements Creation. The old draft cannot be confirmed against a different Visual Style Preset."

Dev: "The user edited the Brief after confirming the requirements. Should we mark them stale immediately?"

Expert: "No. Editing the Brief does not change the current requirements. Only an explicit Presentation Requirements Creation action can replace the active draft, and the new draft retains the Brief used to generate it."

Dev: "The workspace has a draft outline, but not a confirmed outline yet."

Expert: "Good. Outline Review is required. Let the user edit the presentation title, each Page Title and Page Content, review global and page Creation Requirements, then explicitly confirm the valid Outline before the downstream workflow starts."

Dev: "If they edit the outline after confirmation, what happens?"

Expert: "It becomes a draft again until they confirm it one more time."

Dev: "The confirmed requirements requested eight pages, but the user saved a six-page Outline. Do the requirements become a draft again?"

Expert: "No. Outline Review is allowed to synchronize `slide_count` to six while the requirements remain confirmed; output language and every other requirement still belong to Presentation Requirements Review."

Dev: "Does a new page choose a Template or blueprint?"

Expert: "No. The engine assigns an opaque page identity, copies the stable Page Source Bootstrap, and Page Authoring creates that page's composition."

Dev: "Can the page Agent import a card from the Reference Library?"

Expert: "No. It may import a Foundation Module, but a Reference Implementation is only something to inspect, copy, or rewrite into the current Page Source."

Dev: "How do independently authored pages keep a consistent style without a Theme Token?"

Expert: "Every Page Authoring Agent reads the same Workspace Style Guide and applies its exact values, qualitative rules, and allowed variation in the Page Source."

Dev: "Is the generated Deck HTML another source that Page Authoring can edit?"

Expert: "No. It is a Rendered HTML Snapshot derived from Page Sources after browser rendering; Page Sources remain authoritative and the snapshot is rebuilt when needed."

Dev: "The PPTX was generated, but Export Download Preparation failed. Should we generate the PPTX again?"

Expert: "No. Keep the Export Artifact and retry only its Export Artifact Mirror."

Dev: "Does publishing that mirror also save the PPTX to My Files?"

Expert: "No. An Export Artifact Mirror is PPT App-internal transport under an internal path in the user's APS Files namespace. A My Files Export requires a separate explicit user action and product record."

Dev: "Can the support action be called Log Export if it includes the whole Workspace?"

Expert: "No. Call it a Workspace Diagnostic Bundle so users understand that uploaded sources, authoring files, logs, and generated artifacts may all be included."

Dev: "Anna image search returned a candidate, but the image never reached the Workspace. Is the Research Log enough to locate the failure?"

Expert: "No. The Research Log shows the external image-search interaction; use the shared operation identifier with the Workspace Storage Transfer Log to distinguish the later safe HTTPS download and Host Upload stages."

Dev: "Should creating a Workspace automatically create a Performance Run?"

Expert: "No. A Performance Run belongs to an explicitly started internal test recording, which may include creating, opening, or never using a Workspace at all."

Dev: "The tester confirmed an Outline and that started a full Deck Generation. Are those separate Performance Runs?"

Expert: "No. They belong to one Performance Run and one causal Performance Trace, with confirmation and downstream generation represented as related Performance Operations."

Dev: "One telemetry batch could not be delivered, but the PPT finished and the report was generated. Did the Performance Run fail?"

Expert: "No. The report may complete while Performance Data Integrity is degraded; the measured PPT result and the testing data's completeness are separate facts."

**HTML 主预览（Static HTML Preview）**：
从当前有效页面的静态快照或人工修订派生的浏览器展示内容。主预览和放映使用固定画布 iframe；内容传输统一交给普通 invoke 层，按完整消息的 3 MiB 预算依次选择原始 JSON、gzip + Base64 和 Host Upload；业务预览不再自行选择传输。图片及字体的本地引用只在展示派生内容中转换为 APS 临时下载地址，不改变权威页面或导出输入。候选使用 HTML，首次按需加载，最多四路准备并发；成功后的 iframe 和已打开的放大预览保留到退出候选页，不因离屏卸载。网格、缩略条及封面复用当前正式页面的 WebP。会话视觉附件仍按需截图，上传后删除。详见 ADR-0057 与 [ADR-0064](docs/adr/0064-webp-thumbnails-and-retained-candidate-previews.md)。

HTML 预览的“可见”与“资源加载完成”分开：当前页 HTML 挂载后立即展示，图片继续加载，不再由 iframe `load` 决定可见性。每个会话最多四个页面同时准备，后台最多三个；快速跳页时，尚未完成且不可见的后台 iframe 可暂停让位，已加载页面继续保留。完成事件仍负责释放准备名额，HTML 获取期间及加载失败时沿用加载、重试状态。详见 [ADR-0072](docs/adr/0072-progressive-html-preview.md)。

结果页缩略栏在页面目录就绪后主动后台预取全部当前版本 WebP，包含准备、获取、图片下载及解码；同时最多四张、纯后台最多三张，当前页及接近可视区域的页面优先。切页和滚动会重排未开始任务，同版本复用已显示图片，变化页单独刷新，单页失败不阻塞其他页。退出作品后停止调度；封面、网格及其他缩略图入口继续按可视区域加载。见 [ADR-0064](docs/adr/0064-webp-thumbnails-and-retained-candidate-previews.md)。

生成页的并发任务只更新其负责页面，流式展示读取共享最新进度，其他页的旧响应不能回退已完成状态。实时预览按固定间隔更新，正式 HTML 在后台准备、可见后再接替实时画面；同页更新期间保留已展示画面并标注更新中，切页不沿用上一页画面。缩略图加载新版本后替换。逐页列表只保留页码、标题、当前状态及最终失败摘要，移除详细生成过程；总体进度、实时预览、停止和恢复操作继续保留。见 [ADR-0072](docs/adr/0072-progressive-html-preview.md) 和 [ADR-0076](docs/adr/0076-compact-page-generation-status.md)。

**页面确认恢复（Confirmed Page Recovery）**：
最新版无法加载时，从当前 `slides/` 正式内容重建预览，包含已保存的人工修改，不再采用人工编辑前版本或历史快照。后台和按需重建共用当前页解析规则；显式重建仍校验等待期间的版本变化。轻量告警写入 `.log/preview-recovery.jsonl`。见 [ADR-0075](docs/adr/0075-single-authoritative-page-source.md)。

**预览资源映射（Preview Resource Mapping）**：
应用内部、按图片或字体内容指纹建立的本地文件与 APS 独立资源对应关系。稳定 APS 文件引用可以持久化；临时下载 URL 不持久化到作品或传输索引。映射是可重建的传输状态，不是图片内容权威，也不会将 URL 刷新视为作品修改。

**作品封面（Workspace Cover）**：
“我的作品”通过 `PptBackend` 读取第一页当前有效的 WebP 缩略图，与该页其他缩略展示共用一份图片。每页只保留当前 HTML 与素材版本的小图，长边不超过 640 像素；缺失时从静态 HTML 按需补齐，不保留整页 PNG。本地列表不等待封面或云端恢复，封面接近可视区域时加载。详见 [ADR-0064](docs/adr/0064-webp-thumbnails-and-retained-candidate-previews.md)。

**页面尺寸（Page Size）**：
用户在首页选定、整份作品统一使用的画布规格。支持 16:9（1920×1080）、4:3（1440×1080）、9:16（1080×1920）、3:4（1080×1440），缺失时默认 16:9。需求确认、HTML 创作、渲染、预览、人工编辑和 PPTX／PDF 导出使用同一规格；已有页面源码后不能改变比例。详见 [ADR-0062](docs/adr/0062-workspace-page-size.md)。

**普通调用传输（Ordinary Invoke Transport）**：
仅普通 `invoke` 使用的双向传输边界。按完整消息的 UTF-8 字节数使用 3 MiB（3,145,728 字节）预算，依次选择直接传递、一次 gzip + Base64 压缩、Host Upload；接收端自动恢复原始业务对象。跨域中转和存储重试属于这一层。后端普通业务（含任务状态机）仅由网关分发，对外工具清单只公开网关、通道和当前 PDF 导出／导出镜像发布两个异步入口；旧业务传输入口已删除。`invokeAsyncAwait`、异步恢复及结果读取保持原协议；APS 资源和会话附件上传仍按业务用途处理。详见 [ADR-0071](docs/adr/0071-unified-ordinary-invoke-transport.md)。
