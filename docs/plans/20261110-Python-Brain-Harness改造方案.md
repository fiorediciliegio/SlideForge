# Python Brain Agent Harness 代码修改方案

> **For agentic workers:** 按任务逐项使用 superpowers:executing-plans；如用户另行选择，可使用 superpowers:subagent-driven-development。用户已于2026-11-10确认本方案并授权修改业务代码，完成勾选以实际验证为准。

状态: implemented（本机Web验收完成；PostgreSQL实机集成待环境） · 最后验证日期: 2026-11-11

**Goal:** 在现有四进程开发架构中实现单总控、可恢复且受预算约束的 Python Brain Agent Harness，并首先交付 Web。

**Architecture:** Python 负责决策闭环与工具协议，Node Capability 负责页面生成工具、资料/版本 artifact 和引擎调用，Go 独占任务状态、执行权、预算与已提交修订引用。沿用当前 HTML/PPTX 引擎，不同时迁移整个生成/渲染栈。先写不可变 artifact，再由 Go 原子提交修订引用与工具回执，避免要求跨服务分布式事务。

**Tech Stack:** 现有 Python 标准库 ThreadingHTTPServer、queue.Queue 与工作线程；TypeScript/Zod；Go 现有 JSON 单实例与 PostgreSQL 后端；Chat Completions 原生 tools 与 image_url；现有 Chrome 渲染和导出。首版不新增 Agent 框架、任务中间件或前端框架。

**Spec:** [产品设计 PRD](../../.scratch/python-brain-harness/PRD.md)。产品与工程方案均已整体确认。实施记录在 `.scratch/python-brain-harness/实施记录.md`，验收结果另记。

## Global Constraints

- 生成方式默认“直接生成”，另有“先确认大纲”；明确的先规划要求停在可编辑大纲。
- 固定/范围/自动三种页数策略，全部页面合计 2–20 页，已确认结构不能由 Agent 自行改动。
- 单总控，首版不增加独立评审 Agent；模型工具调用、图片输入必须实测。
- 每次执行默认 600 秒有效时间、模型费用估算 2 元；等待用户、排队、停机不计时；恢复不重置累计。
- 先 Web；当前 WPS/MCP/CLI 契约不被本期交互变更强制升级。
- 所有业务操作经 src/contracts 与 Capability；模型不接收文件系统路径、内部 token 或用户 API Key。
- Go 管任务/预算，Node 管 artifact；Python 不直连它们的数据库或工作区文件。
- 默认仅用户资料，联网/导出授权由服务端确定；预算耗尽停止新调用，未知模型结果不自动重发。
- 修改前保留工作区已有用户改动；新功能完成后更新 CHANGELOG.md，不能把规划当作已实现。
- 若修改 executas/ppt-engine/src，先重建 engine，再运行受影响核心验证。本计划优先复用引擎，不预设重写。
- 本期开始实施前追加一份 accepted ADR 并登记 docs/README.md；不改写历史 ADR 或未经评审修改总纲。

## Review Focus

1. 大纲自动保存与确认竞态：确认的必须是最新已保存修订；409 刷新后由用户重试。（任务 2、6）
2. 服务重启恰在模型响应/工具落盘边界：有回执复用，模型结果未知不自动重发。（任务 1、3、5）
3. 并行生成遇到预算边界或取消：预算共享、迟到结果不能覆盖当前修订/取消状态。（任务 1、4）
4. 旧作品缺失原件与历史：基线诚实标记缺口，续改不回到初稿、不丢当前约束。（任务 2、6）
5. 页面重排/回退后导出：稳定 page_id、正确当前顺序、检查对应同一修订，导出计费幂等。（任务 2、4、7）

## 1. 现状与必要变化

| 位置 | 已核实的现状 | 本期变化 |
|---|---|---|
| src/capabilities/deck.ts | createDeck 包办大纲、页面并发和组装；generatePage 内部最多两次尝试。 | 提取一次页面候选生成供 Harness 调用，语义返工由总控决定；保留旧创建入口行为。 |
| 同文件 regeneratePage/updatePageHtml/applyTheme/reimportDeck | 修改覆盖当前 HTML，完整品牌/模板与历史未统一恢复。 | 项目一旦迁移，全部写入经当前修订读写，不绕过版本提交。 |
| src/http/capabilityServer.ts、src/server/jobQueue.ts | 外层任务持有 Node 队列槽位直到整个 createDeck 完成。 | Harness 长任务由 Python worker 执行，Node 槽位只用于实际工具工作，不能等待 Python 再回调同一队列。 |
| services/brain/brain/app.py、models.py | 标准库 HTTP，已有 prompt/文档/图像/evals，无工具决策循环。 | 增加短请求派发、工具消息、检查点恢复与有界 worker。 |
| services/gateway/internal/jobs | Go 支持 JSON/PostgreSQL；重启将 creating 改 error；现有 save 缺少完整 CAS。 | 增加执行阶段、修订、执行权/心跳、检查点、原子条件更新，保留原 DTO 粗状态。 |
| src/billing/index.ts | Node 请求内 token 聚合，缺少跨进程逐调用预算。 | Harness 预算另记 Go 调用账；新路径不调用旧生成扣点结算，复用导出扣点。 |
| src/http/app.html | 已有作品列表、预览、单页修改与导出，没有大纲编辑/约束/版本恢复。 | 沿用现有结构增加相应区域，不复活已退役 React 入口。 |

文档中的旧三服务说明与实际四进程启动有出入；本期以 scripts/dev-services.mjs 与代码为准，不借此重写无关文档。3211 引擎 HTTP 进程已存在，现有 deck.ts 仍包含进程内引擎调用；本期不声称已经完成独立服务拆分。

需要新 ADR 明确两项历史调整：Q17 的页面历史回退调整 ADR-0075“不再需要回滚”的产品范围；新 Harness 不提交非法候选，调整 ADR-0072 方言契约“重试后仍违规则接受并记录”的条款。新 ADR 标明 Supersedes 的具体条款和新路径适用范围，保持旧入口行为与历史文档原文。

## 2. 文件责任图（新增名为工程建议）

| 文件 | 责任 |
|---|---|
| contracts/openapi/agent.yaml（新）、jobs.yaml、gateway.yaml、brain.yaml | 公开交互、内部工具、状态/预算契约。 |
| src/contracts/agent.ts（新）、deck.ts | Zod/DTO，统一阶段、页数策略、草稿、版本、观察结果。 |
| services/gateway/internal/jobs/agent.go（新）、store.go、postgres.go、http.go | 任务执行 CAS、检查点、操作回执与当前项目修订引用。 |
| services/gateway/internal/jobs/budget.go（新）、store.go、postgres.go、http.go | 同一执行记录内的模型调用预留/结算/未知状态；不另建产品扣点账。 |
| src/capabilities/project.ts（新）、workspace.ts | 不可变修订工作区、资料保存、旧作品基线、版本回退、统一写入。 |
| src/capabilities/agent.ts（新）、deck.ts | Harness 生命周期与工具业务入口；复用旧功能的一次生成/检查/导出。 |
| src/server/agentClient.ts（新）、jobs.ts、brainClient.ts | 内部 HTTP 客户端，传递执行身份、修订与操作 ID。 |
| scripts/m0/llmClient.ts、src/billing/index.ts | Node 嵌套模型调用接入同一预算，限制 Harness 请求重试与最大输出。 |
| services/brain/brain/harness.py（新） | 单总控循环、工具分发、结束条件与暂停。 |
| services/brain/brain/agent_state.py（新） | Go 状态/预算客户端，检查点序列化。 |
| services/brain/brain/agent_tools.py（新） | 工具定义与 Node Capability 调用，不写本地工作区。 |
| services/brain/brain/models.py、prompts.py、config.py、app.py | 原生工具/图片消息、场景与判断提示、短派发接口和运行器生命周期。 |
| src/http/capabilityServer.ts、src/http/app.html | 薄 HTTP 路由、Web 大纲/进度/预算/版本界面。 |
| services/gateway/internal/httpapi/server.go、config/config.go、scripts/dev-services.mjs | 转发新路由、内部地址与配置注入；保持一条 npm run dev 启动链。 |

只在真实任务实施时创建上述模块，不先搭空目录/占位实现。单测沿用 tests/**/*.test.ts、services/brain/tests/test_*.py、Go *_test.go。

## 3. 契约与执行身份

新增 Web 请求使用 agent_options.version=1，明确选择新路径；没有该字段的旧调用继续现有路径。新路径要求 Go 与 Brain 可用，缺失即报配置错误，不静默回落旧生成。Web 完整验收后才默认发送该字段。

核心类型在 agent.yaml 定义，并同步 Zod/Python/Go；不要维护三套含义不同的状态：

```text
PagePolicy = {mode:"fixed", count:2..20}
           | {mode:"range", min:2..20, max:2..20}
           | {mode:"auto"}
AgentOptions = {version:1, generation_mode:"direct"|"outline_first",
                page_policy:PagePolicy, research_allowed:boolean,
                budget:{active_seconds:600, estimated_cost_cny:2}}
ExecutionKey = {deck_id, run_seq, runner_epoch}
OperationKey = {deck_id, run_seq, operation_id, input_hash}
ProjectRef = {revision_id, artifact_ref, outline_revision, constraints_revision}
OutlineDraft = {draft_revision, title, pages:[{page_id,title,bullets}]}
CheckResult = {check_id, revision_id, kind:"layout"|"content"|"visual",
               page_ids, issues:[{severity:"blocker"|"improvement",code,detail,page_ids,evidence_refs}]}
CheckCoverage = {target_revision_id, check_id, source_revision_id,
                 page_revisions, constraints_hash, template_hash}
```

600 与 2 是默认值，不是将可调预算锁成常量的 schema。页数策略内部另检查 min<=max。operation_id 来自已保存的模型 turn/tool_call_id；嵌套单页调用再加 page_id/attempt，不让模型自行指定可绕过预算的身份。

每个 deck_id 仍是唯一作品/工作区标识，在同一任务记录下用 run_seq 区分后续执行。恢复继续同一 run_seq，新的交付后修改递增 run_seq；runner_epoch 每次取得执行权递增。当前仅允许一份作品同时有一个运行中的写执行，多次提交返回冲突而非新开平行写者。

详细 phase：queued、planning、waiting_outline、generating、checking、revising、waiting_user、paused_budget、interrupted、completed、failed、cancelled。公共 status 仍为 creating/ready/error，新增 phase、preview_revision 与 quality_state：

- queued 至 revising 及 waiting_* / paused_budget / interrupted 映射 creating；completed 映射 ready；failed/cancelled 映射 error。
- phase 决定可执行动作，preview_revision 决定是否能展示已有页面，不能仅靠粗 status 触发预览。
- 追加预算/回答问题/确认大纲后 queued；failed 不自动重试；cancelled 终止该 run，保留此前提交内容。

公开 API 均走 Gateway → Capability，内部 API 走 X-Internal-Token，且每个作品操作绑定已验证 owner。模型工具参数不含 owner/内部令牌：

| 接口 | 请求与语义 |
|---|---|
| POST /decks（扩展） | 原字段 + agent_options，创建后立即返回 deck_id，后台派发。 |
| GET /decks/:id/project | 返回上下文摘要、当前版本、缺失资料和历史；原件走已有鉴权文件边界。 |
| PUT /decks/:id/outline-draft | {expected_draft_revision,title,pages}；成功返回新草稿修订，过期409。 |
| POST /decks/:id/outline-confirm | {draft_revision}；冻结确切修订并排队，重复确认同修订返回原回执。 |
| POST /decks/:id/respond | {request_id,response,expected_checkpoint}；只回答当前暂停请求，不自动授予无关权限。 |
| POST /decks/:id/continue | {expected_checkpoint,budget_addition?,retry_unknown_call_ids?}；未知调用需显式列出同意重试的 ID。 |
| GET /decks/:id/pages/:page_id/history | 返回版本/时间/指令/检查状态。 |
| POST /decks/:id/pages/:page_id/rollback | {target_page_revision,expected_project_revision}；形成新项目修订。 |
| POST /decks/:id/agent-revise | {page_ids,instruction,expected_project_revision,budget}；从现有编辑框提交新执行。 |
| GET /decks/:id、/decks/:id/events（扩展） | 沿用现有查询/SSE，返回阶段、有效时间、预算、待确认问题、当前可预览修订。 |

现有取消、预览、导出/下载接口复用；新增导出参数 revision_id 固定导出快照，服务端核对归属。无显式 revision 的旧客户端导出调用时固定当前版本。旧修改入口遇到已迁移作品，仍走 project.ts 读当前快照并提交版本，不启动需要其不支持的新交互界面。

新增内部接口：POST /internal/jobs/agent（Go，action 为 claim/transition/begin_tool/complete_tool/reserve_call/settle_call/mark_unknown/heartbeat）；POST /internal/agent/tools（Node，执行受控工具）；POST /internal/agent/model-results（Node，保存不可变供应商响应并返回 response_ref）；POST /internal/brain/agent-runs/enqueue（Python，短派发）。内部读状态复用 Go job get；模型响应 artifact 的读取由 read_project 的运行时客户端通道提供，不作为任意路径工具暴露给模型。

## 4. 持久化、提交与恢复

### 4.1 权威归属

Go 保存任务阶段、run_seq/runner_epoch、checkpoint_seq、ProjectRef、草稿引用、操作/模型调用账和预算。预算与调用账属于同一 jobs 存储事务，JSON 放在同一任务快照，PostgreSQL 用同一事务；不分散到独立 billing JSON 再假定跨文件原子。JSON 单实例存储与 PostgreSQL 都实现相同的条件更新。PostgreSQL outbox 仍用于既有事件交付，不能当作已经存在的执行队列。

Node 保存不可变资料与项目修订，每个修订是引擎可读取的独立工作区：

```text
artifacts/decks/<deck_id>/
  brief.txt / outline.json / page-N.html / deck.html  # 旧作品原文件保留
  project/sources/<source_id>/original + extracted.json
  project/drafts/<draft_revision>.json
  project/revisions/<revision_id>/
    project.json                 # 场景、资料引用、约束/确认信息、品牌/模板快照
    history.json                 # 父修订、变更指令、页面版本引用、检查引用
    outline.json / manifest.json
    slides/<page_id>.html         # 该工作区权威页面源，稳定 ID 与顺序分离
    deck.html                    # 当前修订的可重建聚合产物
  project/checks/<check_id>.json
  project/candidates/<candidate_id>/...  # 尚未通过校验的页面候选与问题
  project/observations/<observation_id>/...
```

资料/品牌/模板保存为快照或不可变引用，避免用户后来删除模板影响旧作品。每次修订仅 2–20 页，先简单复制所需页面构造完整快照，不新增内容寻址系统。page-N.html 仅保留旧工作区输入；新工具通过 page_id 与 manifest 顺序组装，不能同时写两套权威页面。

### 4.2 提交协议

1. Go 以 expected checkpoint/epoch/current revision 校验并登记操作 pending，相同 operation_id+input_hash 返回原状态，hash 不同409。
2. Node 在暂存目录完成页面、manifest、上下文与回执结果；验证后同盘 rename 成新的不可变修订目录，尚不改变当前引用。
3. Go complete_tool 在一次 JSON 原子保存或 PostgreSQL 事务内，校验执行身份、预期父修订、取消状态，将工具回执与 ProjectRef/检查点共同提交。
4. Python 把已提交工具结果追加为 role=tool，保存消息检查点后再向模型提问。Node 读取 Go 当前引用后提供新预览/导出。

Node 完成第2步而Go未提交时，恢复通过同操作的完成 artifact 与输入 hash 校验后补交；不重生成。已发布但无 Go 引用的 artifact 不作为当前版本。模型调用也先登记、保存完整响应，再消费结果；模型响应可由执行它的 Python/Node 服务经同一内部结果保存接口形成不可变 artifact，Go 只保存引用和结算状态。已发请求但找不到完整响应则标记 unknown，不推断成成功/未执行。

Go JSON 保存当前有“rename 失败后删除旧文件”的路径，无法支持上述恢复承诺。任务1将其改为同目录临时文件+flush+平台原子替换：Unix rename，Windows ReplaceFileW/MoveFileExW；失败保留旧快照并向调用方抛错。只修本期状态/预算保存涉及的持久化边界；不顺手重构其他存储。

心跳工程初值：10秒一次，租约30秒；Go 重启将 queued 及执行中的 run 置 interrupted，等待用户/大纲/预算的阶段原样保留。Python 调度实例也登记 instance_id 与心跳，排队记录绑定该实例，实例过期或换代将其尚未运行的排队任务标记 interrupted；执行中的 run 另有执行租约。这样只重启 Python 也不会留下永久 queued/生成中。首版按单 Brain 调度实例实现，不扩展为多实例自动抢占恢复。恢复须用户点击，不由启动扫描重新付费执行。派发失败只重试派发/查收，不重发模型调用。Go 是可恢复队列目录；Python 内存 queue.Queue 只作本次进程调度。

排队时不持有执行 lease；worker 真正开始时原子 claim。waiting_*、paused_budget、中断释放 worker，分别保存阶段和有效时间。Node 重工具使用现有队列，外层 Python 任务不得占其槽位。并行页面最多复用现有配置的并发上限；Go 统一预留避免并发超支。

### 4.3 预算协议

reserve_call(ExecutionKey, call_id, input_hash, max_cost_cny, pricing_version) 返回 reservation 或 budget_exhausted；settle_call(call_id, usage, response_ref) 幂等；mark_call_unknown(call_id) 保留预留。JSON 状态使用同一串行锁/快照事务，PostgreSQL 锁执行预算行并用 call_id 唯一约束。

每次发送前持久化 sent 状态；超时/崩溃后不能证明未发送的调用均视为 unknown。供应商明确拒绝且无执行结果的错误如实保存；Harness 不继承 Node 默认三次传输尝试或跨 provider 回落。决定重试时需要新的 call_id、独立预留和明确上下文；unknown 仅用户可批准重试。

价格配置快照包含 provider/model、输入/输出/图像计费规则、币种/汇率、最大输出与估算方法。预算为费用估算上限，保守预留需覆盖输入计数误差；模型实际 usage 超过估算要显式记录超额并停止后续调用，不能承诺供应商账单绝对不超。无价格配置或无法为当前输入建立上界，报告配置/预算错误。不得在方案中硬编码未经核实的 DeepSeek 单价。

active_seconds 由有效运行时间段累计，多个页面并行不重复计算墙钟时长。每次检查点、心跳持久化时间；崩溃到最近心跳间最多30秒的不确定区间按租约区间保守计入，重启不重置。截止时停止派发、取消可取消请求，迟到输出可归档但须通过 epoch/phase 校验才能提交。

取消或执行权换代不删除已发调用账，迟到 usage 仍可按原 call_id 幂等结算，但不能据此推进旧执行/提交页面。unknown 调用经用户批准重试时创建新的调用记录，旧预留直到有可靠结算依据前继续保留；如剩余预算不足，先由用户追加，不能把未知费用当作零。

## 5. 工具与控制循环

工具参数在 agent.yaml/Zod 定义，再映射为 JSON Schema 给模型；工具返回统一 {operation_id,project_ref,observations,issues,error?}。schema/权限/状态错误在工具边界就地报错，不静默降级。一个决策回合最多一个有副作用工具；generate_pages 内部可并行，不让多个修改工具争抢同一父版本。

| 工具 | 模型可见参数 | 行为 |
|---|---|---|
| read_project | section、source_ids?、page_ids? | 分块读取资料、当前内容、相关历史，不给任意路径。 |
| save_plan | scenario、outline、constraint_proposals | 保存分类与大纲；需要确认则进入 waiting_outline，模型建议不写成用户确认约束。 |
| research_sources | query、purpose | 仅联网授权下开放；返回可追溯来源，沿用 src/research/web.ts 能力。 |
| generate_pages | page_ids | 按有效大纲生成这些页，工具内部一次模型生成/页；所有候选先校验。 |
| revise_page | page_id、instruction、issue_ids、candidate_id? | 默认注入当前 HTML、约束、相关历史；也可修复该页尚未通过的候选，产生新候选版本。 |
| inspect_deck | kinds、page_ids? | 程序版面检查、文本/来源索引与截图，返回版本化证据；不暗中启动独立评审 Agent。 |
| record_assessment | kind、page_ids、evidence_ids、issues | kind 仅 content/visual；保存总控对当前证据的结构化评估，核对版本与覆盖。 |
| request_user | reason_code、question、proposal? | 暂停并保存请求 ID；问题不能自行增加预算或授权。 |
| finish_deck | assessment、check_ids、remaining_issues | 校验当前修订检查覆盖、硬约束、阶段后交付预览；不能以自然语言“完成了”跳过。 |
| export_deck | format、revision_id | 仅已记录相应授权，复用现有导出幂等协调器及收费。 |

版面检查由工具执行；内容与视觉评估分别由总控决策回合产出结构化 CheckResult，提交时服务端核对引用和覆盖修订，不能用模型一个 true 代替程序证据。视觉证据按小批截图提供，覆盖全稿；源码/版面硬失败由程序判定。页面检查缓存键使用 page_revision/内容hash/相关约束hash/模板hash/检查种类，整稿内容检查键另含当前全稿修订。

CheckResult 保留原始 revision_id 和证据，不改写历史。单页修改后，服务端对未改页核对上述指纹，生成指向新 target_revision_id 的 CheckCoverage，将兼容检查重新绑定到当前覆盖范围；不伪造新截图。改动页重查，全局主题/约束变化使对应全部绑定失效；跨页内容摘要检查始终针对本次全稿修订重新执行。finish gate 检查的是有效 Coverage 与最新全稿检查，不能只要求历史 CheckResult.revision_id 等于当前整稿，否则会误使单页改动触发全稿重查。

未通过的页面候选持久化并返回 candidate_id、问题与有关源码上下文，使首次生成失败也可定向修复；它不替换有效当前页，也不作为可交付预览。含非法方言的候选不送 Chrome 执行。重试同一页候选计入该页本次执行的返工上限。

初始需求明确授权导出的执行，在检查满足导出条件后调用 export_deck，再由 finish_deck 结束并附导出回执；默认未授权时只 finish_deck 交付预览。交付后用户点击导出直接走既有接口，无需重新启动 Agent。导出未完成/失败不伪报文件成功，已完成预览保留。

循环顺序：载入检查点 → 准备当前上下文/可用工具 → 预留模型调用 → 请求模型并持久化完整 assistant 消息 → 保存所选工具 pending → 执行并提交 → 保存完整 tool_call_id 结果 → 下一回合。预算或权限判断始终在业务边界复核。若模型只给自然语言但未调用 finish/request_user，写入观察并在回合限额内继续，不直接把文本当交付。

保留 assistant tool_calls、role=tool、tool_call_id 及模型协议要求的延续字段；若启用 DeepSeek 思考模式，按其官方协议处理 reasoning_content，仅供协议延续，不在界面展示隐式推理。每轮上下文用持久事实、当前页、有关修改记录、最近工具结果和完整未完成工具往返组装；不在 Chat Completions 历史中伪造/插入不存在的模型工具调用。

## 6. 实施任务

### 任务 1：Go 执行状态、调用账与恢复

**Files:** 新增 agent.yaml、src/contracts/agent.ts、jobs/agent.go、jobs/budget.go；修改 jobs/store.go/postgres.go/http.go 和相关 OpenAPI。测试放 tests/contracts/agent.test.ts、jobs/agent_test.go、jobs/budget_test.go、jobs/postgres_test.go。产品点数账结构保持现有实现。

**Interfaces:** claim_run(deck_id,run_seq,expected_checkpoint) → ExecutionKey；transition_run(key,expected_checkpoint,transition) → snapshot；begin_tool/complete_tool(OperationKey,expected_project_revision,result) → receipt；reserve_call/settle_call/mark_call_unknown 使用第4节协议。所有修改接口先验证 owner 或可信内部上下文。

- [x] 在执行前记录当前相关定向测试基线，追加 ADR（使用实施时下一个可用编号），登记索引与已批准规则。
- [x] 增加窄测试：同一 checkpoint 两次 claim 只成功一次；取消后旧 epoch 无法完成；同 call_id 结算不重复；并发 reserve 总预留不超2元；重启变 interrupted 且保留累计/回执。
- [ ] 增加保存失败测试：Windows 替换失败旧 JSON 仍在；PostgreSQL 事务冲突不丢原记录。实现原子存储与条件更新，不接受旧 save 对 agent run 直接覆盖。
- [x] 实现 phase/粗status映射和预算记录；Go 心跳/租约过期只中断，不自动恢复执行。
- [x] 运行 npm.cmd run check、npm.cmd run test:gateway、定向 agent 契约测试；预期通过上述可观察行为，再运行 npm.cmd run test:core。

**交付边界:** 可以通过内部测试完整创建、暂停、抢占、结算和恢复一个空执行；尚不默认切换 Web。

### 任务 2：项目快照、版本与旧作品基线

**Files:** 新增 src/capabilities/project.ts、tests/capabilities/project.test.ts；修改 workspace.ts、deck.ts、documents 资料落盘调用点。

**Interfaces:** readProject(deckId,owner) → ProjectSnapshot；prepareRevision(input:{baseRef,operationKey,changes}) → PreparedRevision；importLegacyProject(deckId,owner) → PreparedRevision；saveOutlineDraft(expectedDraftRevision,draft) → DraftRef；rollbackPage(pageId,targetRevision,expectedRef) → PreparedRevision。当前引用统一由任务1 complete_tool 提交，project.ts 不维护另一份可分叉的 HEAD。

- [x] 用现有最小工作区 fixture 增加测试：旧当前页面与初始大纲不一致时以当前页面建立基线；缺原件标 missing，不补造用户确认/历史。
- [x] 实现资料/品牌/模板快照保存和稳定 page_id，旧 page-N.html 建立一次映射；每次写入构造完整不可变工作区并保留修改指令、父修订。
- [x] 修改 regeneratePage/updatePageHtml/applyTheme/reimportDeck 的已迁移作品分支，共用当前上下文读写；不迁移旧作品的只读预览/导出。
- [x] 增加重排+回退用例：page_id 不变、manifest 顺序正确，回退产生新修订且保留当前 constraints/source refs；过期父修订409。
- [x] 增加草稿 CAS/确认竞态、同一旧作品重复迁移不重复建基线测试。用 node --import tsx/esm --test tests/capabilities/project.test.ts 定向验证，再运行 npm.cmd run check 和 npm.cmd run test:core。

**交付边界:** 当前已有编辑入口对已迁移作品均能保留版本；不依赖 Agent 才能读取历史。

### 任务 3：模型协议与共享预算接入

**Files:** 修改 services/brain/brain/models.py/config.py、scripts/m0/llmClient.ts、src/billing/index.ts；新增 Python agent_state.py、TS agentClient.ts。测试扩展 test_models_documents.py，并新增 test_agent_models.py、tests/server/agentBudget.test.ts。

**Interfaces:** Python agent_complete(messages,tools,call_context) → 完整 assistant/usage/response_ref；Node llmComplete 的可选 agentCallContext 包含 ExecutionKey、call_id、input_hash、reservation。两者使用任务1同一调用账；普通旧调用无此上下文时保持现有行为。

- [x] 用假供应商固定响应验证工具往返、图片内容块、tool_call_id 与必要延续字段未丢失；先预留再发送，usage 幂等结算。
- [x] 实现输出上限/价格快照与完整响应持久化；Harness 明确关闭旧默认传输重试和 provider 回落。测试送出后连接断开标 unknown，恢复不自动重新请求；响应已存但检查点未推进则复用。
- [x] Python/Node 模型调用均贯穿预算，禁止只统计总控而漏掉 generate_pages 内部调用；测试并行子调用共享同一上限。
- [x] 实施时用当前用户配置进行最小工具往返+截图识别能力验证，明确限额并记费用；失败如实报告模型/协议原因，不换模型凑通过。此次设计不执行真实模型调用。
- [x] 运行 npm.cmd run test:brain、node --import tsx/esm --test tests/capabilities/agentRecoveryBoundaries.test.ts（预算并发另在Go jobs/agent_test.go验证）、npm.cmd run check；核对新路径没有旧生成扣点，导出计费仍独立。

**交付边界:** Python 与 Node 的受控模型调用可恢复、可计量，不需要完整 UI。

### 任务 4：可观察且可重放的业务工具

**Files:** 新增 src/capabilities/agent.ts、tests/capabilities/agentTools.test.ts；修改 deck.ts、capabilityServer.ts、exportCoordinator.ts、brainClient.ts，复用 research/web.ts 与 scripts/m0/validatePage.ts/thumbnails.ts。

**Interfaces:** executeAgentTool(executionKey,operationKey,toolName,args) → ToolResult；页面工具复用 generatePageCandidate(ctx,pageId,instruction?) → Candidate，单次生成且不自行语义重试；inspectDeck(ref,kinds,pageIds?) → EvidenceBundle。接收 operation hash 相同的重放时查询/提交已有准备产物。

- [x] 提取一次生成候选所需最小代码，旧 createDeck 仍拥有它已有的本地尝试逻辑，新路径由总控决定返工。候选必须过方言与溢出校验再提交；错误带具体页面与问题返回。
- [x] 实现第5节工具；资料读取按 source_id 分块，保留覆盖索引；场景/大纲保存同时判断是否等待用户。
- [x] 实现内容/视觉证据、修订化检查记录与完成 gate；测试改动页旧检查不可用于 finish、未改页指纹相同可重绑复用、全局约束变更全部相关绑定失效，未授权研究/导出被拒绝。
- [x] 生成一批页时以父操作+page_id/attempt 建子操作账，候选模型可并行；提交器串行读取最新已提交修订，确认该页基版本/大纲/约束未变，再把候选合入最新全稿并构造修订，Go CAS 提交。不能用两个相同旧父版本的完整快照覆盖兄弟页结果。逐页成功即留回执，其它页失败不丢已完成页；父操作恢复只补未完成子操作。Node 队列只包实际生成/渲染，不能包跨 Brain 等待；测试容量1也能完成回调链，并发两页反序完成不丢页，取消/预算耗尽后迟到结果不能提交。
- [x] 导出固定 revision；在 fingerprint/幂等键中包含该修订与格式，复用鉴权文件交付及 chargeFixed operation_id，禁止新增另一套导出扣点路径。
- [x] 用假模型/检查器运行 node --import tsx/esm --test tests/capabilities/agentTools.test.ts、npm.cmd run check、npm.cmd run test:core；真实 Chrome 相关验收安排在任务7，遵守本机授权边界。

**交付边界:** 每个工具可独立执行/重放并返回可信证据，未接入总控仍可定向验证。

### 任务 5：Python 单总控循环与可恢复调度

**Files:** 新增 harness.py、agent_tools.py、services/brain/tests/test_harness.py；修改 app.py、agent_state.py、prompts.py/config.py，更新 brain.yaml。

**Interfaces:** enqueue_run(deck_id,run_seq) → accepted；run_harness(execution_key) → 暂停或终结快照；内部 POST /internal/brain/agent-runs/enqueue 仅短请求入队，不等待整次生成。模型工具经 Node 内部 Capability 工具端点执行。

- [x] 用脚本化模型增加闭环测试：读取→保存大纲→生成→检查发现问题→修页→重查→交付；断言只改问题页，同页最多两次返工，所有页均有初始检查覆盖。
- [x] 实现场景/约束规划、模式意图同步、页数校验、request_user、finish gate；测试文字“先规划一下”与默认 direct、固定页数冲突、模型未调用 finish 仅宣称完成等路径。
- [x] 实现 queue.Queue 有界调度与 Go claim/心跳；默认1个长任务 worker，waiting_* 释放槽位。启动/重连只发现可恢复执行并显示中断，不自动重新发送模型；仅用户新提交/确认/继续产生排队动作。
- [x] 实现每轮完整消息/工具回执检查点、上下文按资料索引与当前状态重建；不要把模型隐式思维转成面向用户的修改记录。
- [x] 测试暂停等待一小时不扣执行时间、队列等待不扣时间、恢复保留预算、达到决策/时间/费用边界停止、结果未知须用户同意；精确复现停在工具已落盘/Go提交前后的恢复行为。
- [x] 运行 npm.cmd run test:brain、npm.cmd run check、npm.cmd run test:core，确认旧 outline/page prompt 接口仍通过现有测试。

**交付边界:** 假供应商可跑完整自主闭环、用户暂停和恢复，无需浏览器交互。

### 任务 6：Web 交互与网关接线

**Files:** 修改 app.html、capabilityServer.ts、gateway httpapi/server.go/config.go、dev-services.mjs、gateway.yaml；新增 tests/server/agentApi.test.ts、tests/server/agentApp.test.ts，扩展 Go 路由/归属测试。

**Interfaces:** 落实第3节公开 API，Node lifecycle Capability 调用 Go状态和Brain短派发；SSE返回新增快照字段。Web 只渲染服务端状态，不自行判定授权/版本。

- [x] 在现有表单增加生成方式、三种页数策略、联网许可与预算，展示有效模式/场景纠正入口；继续使用业务 Key 鉴权，密钥不出现在日志和模型上下文。
- [x] 实现大纲编辑、稳定 ID 排序/增删、自动保存指示；确认发送最新保存修订。测试 autosave 乱序/失败与双标签确认，409 后保留本地未保存编辑并提示刷新比较，不默默覆盖。
- [x] 按 phase 展示进度、问题请求、预算追加、未知调用处理、继续/取消。移除旧90次×4秒的固定轮询终止条件；用带 X-API-Key 的 fetch 读取 SSE（不将 Key 放到URL），断线重连先拉当前快照，waiting_* 等待多久都可恢复界面，不据此重启后端任务。终态或用户离开当前作品停止该界面订阅。预览只拉取 preview_revision 对应已提交页面；保留当前 appPolling/appDownload 修复。验证等待超过原6分钟上限仍能显示确认/完成状态。
- [x] 在我的作品恢复上下文摘要、当前约束、页面修改历史/回退，现有单页修改框发送 agent-revise；旧作品首次续改走迁移与缺失提示。
- [x] 接入网关转发与内部地址配置，新 Harness 必需服务未配置时给明确错误；dev 启动仍四进程。测试跨用户读草稿/历史/继续/导出均不可达，模型无法传入任意路径。
- [x] 运行 npm.cmd run check、npm.cmd run test:core、npm.cmd run test:gateway；浏览器手工验收两种模式与离开/重开的状态恢复，不为样式细节编写自我验证测试。

**交付边界:** Web 具备完整操作流程；WPS/MCP 仍使用原交互，已迁移作品的旧写入口保留版本记录。

### 任务 7：端到端验收、评测与文档交付

**Files:** 新增 tests/server/agentRecovery.test.ts、.scratch/python-brain-harness/验收记录.md；按实际结果更新 CHANGELOG.md、docs/current-state.md、docs/deployment.md、docs/README.md 与本计划状态。

- [x] 完成五项 Review Focus 的跨服务验证：保存/确认竞态、模型未知状态、并行预算/取消、旧作缺资料、重排/回退后导出。检查各任务已有窄测试，避免重复构造只覆盖实现细节的测试。
- [ ] 假供应商端到端测试注入 Python/Node/Go 分别停止、响应丢失、重复 continue，核对 operation/call 数量、版本和累计消耗；PostgreSQL 模式复测相同状态语义。
- [x] 在授权的真实 Chrome/模型环境运行 PRD 样本集，检查全稿覆盖、定向返工和人工质量；记录模型/价格版本、并发、耗时、调用数、费用估算、阻断项和人工可用性，不能用历史速度代替结果。
- [x] 真实导出 PPTX/PDF，验证当前修订顺序、下载鉴权和导出幂等扣点；预览交付未触发导出时不扣导出点数。
- [x] 运行 npm.cmd run check、npm.cmd run test:core、npm.cmd run test:brain、npm.cmd run test:gateway，按受影响面运行 npm.cmd run test:unit。若动 engine/src，先在 executas/ppt-engine 执行 npm.cmd run build 与相应检查。
- [x] 将实际通过/未通过项、模型能力限制和未交付内容写入验收记录；实际功能写入 CHANGELOG 的“未发布”，按新增功能/体验优化/问题修复分组。检查失败先报告事实、根因与一个最小修复动作，同一问题两次未过即停止补丁。

**交付边界:** 形成可复现实测结果与启动说明；只有全部本期门槛通过，才把 Web 默认入口切换到 agent_options.version=1，并将本计划状态改 done。

## 7. 实施前审阅说明

已确认的产品取舍见 PRD。实施前建议为：复用 Node 页面生成、标准库 Python worker、Go CAS/预算账、不可变完整页面快照、版本化新请求、心跳10秒/租约30秒、每页最多两次返工与按页数计算的决策上限。现已完成本机四进程与真实模型能力/样本验证；实际结果及PG环境限制见[验收记录](../../.scratch/python-brain-harness/验收记录.md)。

这是一项跨语言主链路改造。本轮已按任务1–7实施并完成一次独立审查及修复；保留两个包含PostgreSQL实机/故障注入要求的复合清单项未勾选，不能据本机JSON验收宣称PG生产验收完成。测试文件按实际职责合并，未创建仅为对应计划文件名的重复测试。详细命令、回归与验证边界见验收记录。
