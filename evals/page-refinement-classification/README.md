# 单页修改请求分类评估

此评估只测试第一步 LLM 分类，不进入“优化本页”、不读写业务 Workspace、不生成页面。每个 case 会自动创建独立 Performance Run；最终 Batch bundle 的 `case.json` 中包含分类结果，`performance/report.html` 包含端到端耗时与聚合 Token 用量。

使用 `config/smoke-v1-batch-input.json` 作为最小冒烟数据。它可以通过已有 Batch Testing 后端接口创建和执行，目标阶段固定为 `page-refinement-classification-completed`。该接口仍由 Anna Runtime 代理 LLM，因此不需要启动 Vite 前端，但执行进程必须具备 Anna Runtime LLM 权限；`ppt-engine` 不保存、也不直接读取 LLM 凭据。

输入契约：

- `briefs[].brief` 是用户的单页修改要求；
- `page_refinement_classification.prompts` 支持一到十个候选 Prompt 版本；
- `expected_by_brief_id` 是人工标注，供后续准确率评分；
- 每次执行保留 `actual_model`、原始 `token_usage`、`latency_ms` 和重试信息。

批量运行的执行接口是现有 `runBatchTestWorkflow` / `PptBackend.createBatchTestRun`、`updateBatchTestCase`，而不是实际单页优化 Agent 调用。因此将来接入真实流程时可独立决定是否采用该分类，不会改变当前“优化本页”行为。
