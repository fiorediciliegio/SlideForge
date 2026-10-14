# Agent Session 完成识别与流诊断

共用 `runPromptOnce` 在收到 `choices[].delta.task_complete.status === "completed"`
时结束本次运行的文本收集。先处理同帧正文、用量和错误，错误优先；兼容原有顶层
`event: "complete"` 和迭代器自然结束。其他或缺失的 task_complete 状态只用于诊断，
不会触发提前成功，也不据此推断未定义的 Host 错误协议。单个 choice 的
`finish_reason` 不代表整个 Agent 运行结束。业务 JSON / HTML 校验和重试仍在上层执行。

提前退出会请求底层迭代器 `return()`，每个迭代器最多一次；自然结束不再请求。
清理采用非阻塞方式，避免 `return()` 排在永不完成的 `next()` 后面再次挂住收尾；
清理抛错或拒绝不覆盖业务结果。整体运行超时会同时停止本地流观察，沿用原有 Host
取消调用。空闲超时的 Host 取消策略、用户取消及 `drainOnCancel` 语义保持原有约定。

## 日志字段

遵循 ADR-0061：仅 `VITE_PPT_LOG_ENABLED=true` 且运行具有日志上下文时收集诊断。
每次运行尝试随现有 interaction finished 记录写入一次，不按 token 调用后端。
新字段及原有 `events` 加入 `payload_keys`，复用 Host Upload 和引擎 sidecar（附属文件）。

`stream_diagnostics.schema_version` 当前为 `1`：

| 字段 | 含义 |
| --- | --- |
| `observation_layer` | `session.run.payload`，SDK 交付给 App 的帧层级。 |
| `operation_id` / `interaction_id` | 与外层交互记录一致的关联标识。 |
| `attempt` | 普通执行器提供的尝试上下文。 |
| `held_session_attempt` | 复用会话的 `run_index`（从 1 开始的调用轮次）、`run_attempt`（本轮尝试次数）、`fresh_session_retry_count`（该持有会话累计新建重试数）。 |
| `identifiers` | 按来源分别记录 Session 属性、stream 对象属性、run_meta、最近帧及 task_info 标识；task_complete/task_id 在 markers 中，互不覆盖。 |
| `timing` | 开始等待、首末帧、首末正文、终止的 ISO 时间和单调时钟相对毫秒，以及配置超时、最大接收间隔、终止时距最后帧的时长。没有首帧时从开始等待计算。 |
| `counts` | 可见帧数、归一化正文片段数、正文 UTF-16 code unit 数；分别统计 `event` 和 `event_type`。 |
| `markers` | 实际观察到的 task_complete/status/task_id、stream_end/reason/task_id、raw `[DONE]`、顶层 complete 和 iterator done。 |
| `exit_reason` | `task_complete`、`top_level_complete`、`stream_exhausted`、`idle_timeout`、`run_timeout`、`cancelled` 或 `error`。 |
| `cleanup` | iterator return 和现有 Host cancel 的调用结果；`requested` 表示已请求但快照时尚未完成，不能解读为释放成功。 |
| `frames` / `frame_budget` | 有界帧摘要、预算、实际保留及丢弃数量。`receive_index` 是 App 接收序号，不是 RPC seq。 |
| `recording_errors` | 诊断字段提取失败的次数；不影响正文处理。 |

帧摘要保留前 8 帧、后 32 帧和最近 32 个关键生命周期帧的并集，最多 72 帧。
关键帧包括 started、run_meta、complete、error、end、task_complete、stream_end、raw DONE。
`frame_budget.lifecycle_dropped` 单独报告关键帧队列的淘汰数；不承诺全量帧记录。
摘要仅保留时间、顺序、事件标识、已知 delta 类型、正文长度及归一化事件类型。
未知事件名归为 `other`，缺失为 `unavailable`；不复制原始帧或工具输入输出。
标识字符串限制字符集和长度。未暴露的 RPC 外层信息与可靠构建版本记为 `unavailable`。

失败与取消另写 `partial_output`，明确 `kind: "partial"`，最多保留本次实际接收正文的
前 65,536 个 UTF-16 code unit，报告接收长度、保留长度、预算和截断状态。
保存前拼接片段并对 URL、Authorization、常见密钥字段及 Bearer / sk- 模式脱敏；
长度统计以脱敏前正文为准。部分正文仅用于诊断，不进入业务成功或历史回复恢复流程。
流终止时间在读取 history、写日志之前固定；快照脱离活动记录器，迟到帧和清理回调
不能篡改已写交互，也不能混入下一轮运行。诊断提取、序列化或写入失败不触发业务重试。

## 排查边界

- `counts.frames = 0`：App 没有观察到帧。
- 有帧但正文长度为 0：App 收到元数据或其他非正文事件。
- 有正文但因超时退出：可查看 `partial_output`、末帧及末正文时间；正文是否满足业务协议仍需校验。
- `exit_reason = task_complete`：App 观察到明确成功标记，随后停止观察。
  `subsequent_frames = not_observed` 不表示 Host 漏发 stream_end / DONE / 传输关闭。
- 只有 `markers.iterator_done = true` 才表示实际观察到 SDK 迭代结束；它不等同于
  App 直接看到了外层 RPC 的 `done: true`。

这些记录无法单独区分“宿主没有发送”和“中间传输没有投递”，也不会把某次空闲超时
预先归因于宿主漏发结束帧。`session.history()` 仍是独立、尽力读取的日志信息，
不能作为流已收到完整正文的证据或通用结果恢复机制。


## 个人模板的逐帧记录

个人模板另通过 `sessionTrace` 接入共用会话客户端，在归一化业务事件之前记录 SDK 交付的原始帧。
会话创建、每次运行请求、解析重试、取消和删除拥有独立生命周期记录；创建前即分配本地会话标识。
每次运行拥有独立交互标识，同会话修复不会覆盖前一轮；原始帧中的未知字段保留，鉴权信息和签名 URL 脱敏。

帧在 32 帧、约 64 KiB 或 250 毫秒时分批写入，成功、异常及取消均冲刷尾批。待写队列以 8 MiB
为保护上限；写入失败、序列化失败和超限都有缺失序号及计数，终态 `frame_integrity.complete` 说明完整性。
这项记录不改变现有成功判定、重试或提前结束行为，也不观察 SDK 以外的传输层。
目录和排查包语义见 [ADR-0074](adr/0074-personal-template-diagnostics.md)。
