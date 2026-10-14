# Research Routing Eval

This directory is the evaluation layer for `recommendResearch`. It lives under `apps/ppt-app/` for repository co-location, but remains outside the `bundle/` output, so its fixtures, candidate prompts, raw results, and reports are not shipped in the PPT App bundle.

## Phase 1

Phase 1 compares the 10 prompt versions from `cases/research-routing-v1.xlsx` against 50 labelled briefs:

```text
10 prompt versions × 50 cases × 1 fixed runtime route × 1 repeat
```

另有从 v7 派生的 v11 评估版本：系统消息只有 `Return exactly one JSON object:{"web":{"recommended":false,"reason":"..."},"images":{"recommended":false,"reason":"..."}}`；用户消息保留 v7 的其余正文，并在运行时追加当前日期和可选附件上下文。v1～v10 保持原有单条用户消息，主流程提示词不变。

从 `apps/ppt-app` 目录运行 `node evals/research-routing/scripts/build-stage1-batch-input.mjs --prompt v11`，即可生成只含 v11 的 50 条任务文件 `config/stage1-smoke-v11-batch-input.json`。不指定 `--prompt` 时，会生成包含 v1～v11 的 550 条任务，批量测试支持导入全部 11 个版本。

The execution owner is Batch Testing. Before a routing run, Batch Testing generates one Requirements draft per brief, freezes it, and reuses that same draft for every prompt version of that brief. The routing run invokes only `recommendResearch`; it must not perform web or image search.

The Eval layer owns fixture synchronization, experiment metadata, scoring, stability analysis, and reports. It consumes the normalized raw result JSON written by Batch Testing.

## Commands

Run these from the repository root after the implementation is built:

```powershell
node evals/research-routing/scripts/sync-fixtures.mjs
node evals/research-routing/scripts/build-stage1-batch-input.mjs
node evals/research-routing/scripts/build-stage1-batch-input.mjs --prompt v1
node --test evals/research-routing/tests
node evals/research-routing/scripts/extract-batch-results.mjs --batch-dir <unzipped-batch-directory>
node evals/research-routing/scripts/score-stage1.mjs --results <batch-testing-results.json>
```

`sync-fixtures.mjs` imports the manually maintained source workbook at `../eval/search测试数据.xlsx` (or the path passed through `--source`) into this directory. Do not edit generated JSON or `prompts/router-v*.txt` by hand; update the workbook and synchronize again.

同步时会从工作簿的 v7 自动派生 v11 并更新清单及哈希，因此重复同步不会丢失该版本。若使用仓库内工作簿，在 `apps/ppt-app` 目录执行 `node evals/research-routing/scripts/sync-fixtures.mjs --source evals/research-routing/cases/research-routing-v1.xlsx`。

Commit the implementation before running `build-stage1-batch-input.mjs`. That script records `git rev-parse HEAD` in every Batch Testing case, so the report can be traced to the exact code revision.

`score-stage1.mjs` only scores existing result data. It never calls Anna or any LLM.

To execute Phase 1, import the generated `config/stage1-batch-input.json` in Batch Testing and select its already-defined `research-routing-completed` target. Download and unzip the resulting Batch Testing bundle, extract its normalized results, then score them. The 500 actual model calls are initiated only by pressing Start in Batch Testing.

For a 50-case smoke run, use `build-stage1-batch-input.mjs --prompt v1`. It writes `config/stage1-smoke-v1-batch-input.json`; import that file instead. Repeat `--prompt` to smoke-test a small set of versions.

## Phase 2

Stage 2 is deliberately one Batch Testing run per model selected in the Local Agent UI. Select the model there, create a matching input with its human-readable label, then import and run it:

```powershell
node evals/research-routing/scripts/build-stage2-batch-input.mjs --prompt v7 --requested-model "Local Agent model label" --repeat 1
```

After downloading and extracting each model's Batch ZIP, normalize each export and score them together:

```powershell
node evals/research-routing/scripts/extract-batch-results.mjs --batch-dir <model-a-batch-dir> --output stage2-model-a.json
node evals/research-routing/scripts/extract-batch-results.mjs --batch-dir <model-b-batch-dir> --output stage2-model-b.json
node evals/research-routing/scripts/score-stage2.mjs --results stage2-model-a.json --results stage2-model-b.json
```

`requested_model` is the label entered in the generated input. `actual_model` comes from Anna's completion response and is the model comparison key.

## Phase 3

Stage 3 compares production `v1` and the final candidate on about 10 manually selected high-risk cases. It uses frozen Requirements per case and runs through image research and confirmed Outline, but does not generate a PPT.

```powershell
node evals/research-routing/scripts/build-stage3-batch-input.mjs --prompt v1 --prompt v3 --requested-model "Local Agent model label" --case case-003 --case case-008 --case case-019
```

Download and unzip the Stage 3 Batch ZIP, then compare it:

```powershell
node evals/research-routing/scripts/score-stage3.mjs --batch-dir <stage3-batch-dir>
```

The report records repaired cases, new regressions, sustained failures, Requirements invariant violations, Outline regressions, and total token/latency growth.

## Result contract

The scorer accepts a JSON object with `schema_version: 1` and a `results` array. Every successful item records:

- `case_id`, `prompt_version`, `prompt_hash`;
- expected and actual Web/Image recommendations;
- `requested_model` and `actual_model`;
- `token_usage`, `latency_ms`, and `json_repair_count`.

The concrete writer lives in Batch Testing, because it owns execution and persistence. The schema is defined in `src/contracts.mjs` so the two sides have one stable interchange format.

Failed calls have a separate `failure_kind`. Quota, timeout, or transport failures are never counted as JSON format errors.

研究路由评估使用 `src/ai/llmRequestExecutor.ts` 中的统一默认次数，目前为最多 6 次尝试（首次调用加最多 5 次重试）。JSON 格式错误、推荐结果结构校验失败（包括非布尔值的 `recommended`）和调用失败共用这份重试额度。成功记录保留 `json_repair_count`、`retry_count` 和 `retry_reasons`，便于追踪经过重试才成功的结果。
