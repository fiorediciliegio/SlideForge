# Use Host Upload as PPT App transport only

> 普通 `invoke` 的固定上传及旧传输预算已由 [ADR-0071](0071-unified-ordinary-invoke-transport.md) 替代；本篇的业务语义、资源存储及异步协议约定仍有效。

The Export Artifact Mirror decisions in this ADR are superseded by ADR-0025; its other Host Upload transport decisions remain active.

PPT App uses Host Upload only as the transport for browser-selected files and `ppt-engine` generated artifacts; the local Workspace remains the authoritative store for deck inputs, generated pages, previews, and export artifacts. Host Upload references are short-lived transport objects, so app-facing APIs use structured `*_upload` `HostUploadRef` values and do not preserve legacy `*_url` string fields as a parallel contract.

We intentionally require `negotiate + PUT + confirm` for both frontend browser uploads and backend artifact uploads, even though Host Upload has an inline mode, because this keeps file bytes out of JSON-RPC/stdout and avoids runtime exits from oversized RPC payloads. If Host Upload is unavailable, tools fail with explicit diagnostics instead of falling back to JSON-RPC base64 payloads, `__file_transport`, or local loopback HTTP.

作品封面是上述文件固定上传规则的一个有界例外：`app_get_workspace_cover` 继续使用第一页截图派生的 640 像素宽 WebP，将 Base64 数据 URL、元数据和含请求标识的完整 JSON-RPC 响应一起序列化，UTF-8 字节数不超过 48 KiB 时返回 `cover_data_url`；超限时使用原有上传与有效期缓存，返回 `cover_upload`。预算不能按原始图片大小判断，上传引用响应也必须满足预算。`PptBackend` 统一转换为供界面展示的 `cover_url`，此例外不改变 AI 会话截图附件协议。

“我的作品”刷新先独立读取本地列表，列表就绪即显示卡片并启动封面队列。封面队列在刷新和首页预取之间共享，最多四个请求同时执行，第一张不会阻塞其余首屏卡片。云端列表、首次缺失作品恢复与逐作品同步状态独立补齐；恢复完成后由仍有效的最新刷新重新读取本地列表，过时请求不能回写新列表。

Transient backend Host Upload failures use at most one initial attempt plus two automatic retries, with short backoff between attempts. Every retry reuses the existing local file but starts a new complete `negotiate + PUT + confirm` transaction with a new `r2_key`; a failed confirm never reuses its prior key. The former platform concurrency error `r2_key does not belong to this invoke` was fixed in Local Agent `1.1.0-beta.26` and platform `1.1.0-beta.103`. PPT App follows the corrected reverse-RPC correlation contract instead of serializing uploads or reducing page-generation concurrency: the Executa binds each forward `invoke` through its `params.context.invoke_id`, and every reverse-RPC client automatically stamps that id onto outgoing `params.context.invoke_id`. Retries remain a transient-failure safeguard, not a substitute for invoke correlation.

Existing `ppt-engine` generated page-preview and page-edit-context screenshots retain their established `purpose: "user_artifact"` Host Upload behavior when their returned HTTPS URLs are reused as native Agent Session image inputs. Native image attachment adoption does not relabel these uploads as `image_input` or otherwise change their existing storage classification.

Page preview rendering and native Session image transport are separate app-facing operations. Rendering writes the local HTML and PNG without performing Host Upload; only a workflow that needs the screenshot as a Session image input calls the narrow upload operation, which resolves the current `last_screenshot_path` from Workspace Page Progress by `workspace_dir` and `page_id`, validates that current page-owned screenshot, and starts a new complete Host Upload transaction. The same operation refreshes a URL that is approaching expiry without accepting an arbitrary frontend-supplied local path, reusing the prior `r2_key`, or rebuilding the page render.

PPT App decides whether to refresh a screenshot upload only from its returned expiry metadata: `expires_at` is authoritative, or when it is absent an absolute expiry is calculated once from the receipt time plus `expires_in`. Before starting a Session run, a URL with less than two minutes remaining is refreshed through that operation. If both expiry fields are absent, the current URL is used without proactive refresh. The App does not probe the URL, parse Session error messages or provider-specific attachment errors to infer readability, or reactively refresh after a run has failed; a Session attachment failure after submission follows the already-defined infrastructure behavior for that Page Authoring or Page Visual Review stage.

Screenshot `HostUploadRef` values are active-run transport state only. PPT App may reuse one in memory for Sessions that consume the same visual version, but it does not persist the URL or `r2_key` in Page Progress, Workspace manifests, Outline artifacts, or other authoritative Workspace state. Page Progress continues to preserve the local `last_screenshot_path`; reload and resume obtain a new upload from that local screenshot, and expiry refresh replaces only the in-memory reference.

Small, bounded control-plane results may return inline through JSON-RPC. In particular, `CreateWorkspaceResult` is a versioned creation receipt rather than a Workspace artifact or full Workspace snapshot, so `app_create_workspace` returns it inline and does not use Host Upload. Full Workspace snapshots and results whose size grows with Workspace content continue to use Host Upload.

`app_stdio.js` may remain temporarily as a compatibility wrapper while app-facing file transport is removed, but it must transparently pass Executa v2 reverse-RPC traffic; the target state is for `ppt-engine` to run without the wrapper once SlideForge App no longer depends on `__file_transport`.

当已确认的 `application/json` Host Upload 引用因 CORS（跨域限制）无法被浏览器直接下载时，SlideForge adapter（适配层）通过 `app_resolve_host_upload_json_reference` 回退读取。Executa 校验 MIME 类型和声明的字节数；小 JSON 的序列化响应最多 48 KiB，大 JSON 通过 `byte_offset` 分块返回 UTF-8 文本，每块包含当前位置、下一位置和总字节数，单块序列化后也不超过 48 KiB。前端验证位置连续性和字节数，重组后解析 JSON，禁止将完整大 JSON 再塞回 RPC。

分块回退最多读取 16 MiB 的 JSON。后端只在进程内短暂缓存已下载内容，最多保留 32 MiB、五分钟，最后一块返回后移除该缓存；缓存丢失时可重新下载原引用。缓存不改变 Workspace 文件的权威性，也不持久化短期下载地址。非 JSON 文件不使用此回退，平台仍应优先提供允许跨域或同源的下载地址。

批量测试的创建、列表、单条状态更新和批次状态更新统一采用 48 KiB 内联阈值，超限结果通过现有 `result_upload` 返回。完整用例和性能明细继续保存在本地文件中。状态写入和响应传输分开处理：响应失败时先查询已保存状态，已提交的成功用例不能被错误处理覆盖成失败；循环停止时尽力保存批次最终状态，连接完全不可用时明确报告状态未能确认。
