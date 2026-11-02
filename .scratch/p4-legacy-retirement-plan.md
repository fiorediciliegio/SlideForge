# SlideForge PR-4 遗留代码退役审计与分批删除计划

- 日期：2026-11-01
- 状态：**已全部执行完成（PR-4A／PR-4B／PR-4C）**
- 审计数据：`.scratch/p4-reachability-audit.json`
- 可重复执行：`node scripts/architecture-reachability.mjs`

## 1. 审计方法

分别从以下入口计算相对 import 的可达依赖：

- 现役：HTTP Capability Server、MCP stdio、CLI、密钥工具、保真回归、MCP smoke、导出 spike。
- 核心测试：`tests/contracts`、`tests/capabilities`、`tests/server`。
- Legacy：`src/main.tsx`、旧 `run-ppt-pipeline` 管线以及全部 legacy 测试。

静态分析不能识别运行时文件路径、CSS、HTML、OpenAPI、Go 或插件公开入口，因此必须结合人工保护清单。未解析 import 不能简单等同于缺失文件。

## 2. 审计结果

| 指标 | 数量 | 含义 |
|---|---:|---|
| App 与测试模块 | 553 | `src/**` 与 `tests/**` 中的 TS／TSX／JS／MJS |
| 现役可达 | 45 | 包含跨目录与引擎依赖，不等于 App 文件数 |
| 核心测试可达 | 46 | 核心测试及其依赖 |
| Legacy 可达 | 512 | React／Host 及 legacy 测试依赖 |
| Legacy-only 候选 | 492 | 不被现役或核心测试引用的模块 |
| 未引用候选 | 24 | 三类入口均不可达，已排除运行时资产 |
| 核心测试专用保护项 | 12 | 当前核心测试文件，不参与删除 |
| 现役未解析 import | 0 | 审计通过 |
| 核心测试未解析 import | 0 | 审计通过 |
| Legacy 未解析 import | 4 | 全部为预期 CSS 引用 |

**492＋24＝516 只是候选数，不是已批准删除数。** 删除前仍须按本计划逐批确认。

## 3. 绝对保护清单

以下内容不得依据本次静态审计删除：

| 保护项 | 原因 |
|---|---|
| `src/features/templates/presets/**` | 现役模板目录、封面与参考 HTML；当前共 98 套预设 |
| `src/http/editor-dnd.js` | `capabilityServer.ts` 运行时通过 `new URL(..., import.meta.url)` 读取，静态 import 不可见 |
| `src/http/app.html`、`src/http/console.html` | 现役 Web 与控制台运行时资产 |
| `executas/**` | 引擎存在公开导出、插件、CLI 与二进制入口，不按单一 import 图删除 |
| `third_party/**` | Vendored 导出依赖 |
| `contracts/**` | 跨服务 OpenAPI 契约，Go／Node 服务边界 |
| `services/**` | 现役 Go 网关及其测试 |
| `src/contracts/**` | 现役纯契约层 |
| `src/capabilities/**`、`src/server/**`、`src/billing/**` | 现役能力与运行支撑 |
| `tests/contracts/**`、`tests/capabilities/**`、`tests/server/**` | 现役核心测试门禁 |
| 模板预览、保真、导出相关工具和评测 | 现役资产与验证链，不能随旧 React 一并清理 |

现役与 legacy 共享的引擎文件也必须保留；审计中识别的共享项包括 `pptx-export/google-static-fonts.ts` 和 `slide-format.ts`，但保护范围不限于这两个文件。

## 4. 第一批：24 个未引用候选（PR-4A）

这些文件不被现役、核心测试或 legacy 入口引用，适合优先人工复核。删除前必须再检查字符串引用、文档引用和运行时资产路径。

### 4.1 空桶或消息模块

- `src/features/export/index.ts`
- `src/features/pages/index.ts`
- `src/features/review/index.ts`
- `src/features/task/index.ts`
- `src/features/templates/index.ts`
- `src/features/outline/reviewMessages.ts`
- `src/features/page-regeneration/messages.ts`
- `src/features/process-progress/messages.ts`
- `src/features/user-templates/messages.ts`

### 4.2 未被入口使用的工作流与组件

- `src/agent/promptRules.ts`
- `src/ai/pageRefinementIntentReview.ts`
- `src/app/routes.ts`
- `src/features/deck-generation/deckRefinementArtifacts.ts`
- `src/features/deck-generation/deckRefinementWorkflow.ts`
- `src/features/deck-generation/pageRefinementArtifacts.ts`
- `src/features/deck-generation/pageRefinementWorkflow.ts`
- `src/features/deck-generation/prompts.ts`
- `src/features/deck-generation/visualPlanningWorkflow.ts`
- `src/features/deck-workspace/components/RenderedSlideImage.tsx`
- `src/features/deck-workspace/components/SlidePreview.tsx`
- `src/features/deck-workspace/components/StyleProfilePage.tsx`
- `src/features/deck-workspace/components/UploadedSourceAnalysisPage.tsx`
- `src/features/deck-workspace/components/WorkspaceDialog.tsx`
- `src/state/taskStore.ts`

第一批完成门禁：

- 对 24 个文件逐一完成字符串与文档引用复核。
- `npm run check` 通过。
- `npm run test:core` 通过。
- `npm run build:legacy` 仍通过，证明未误删 legacy 运行依赖。
- 重新运行审计，现役与核心测试未解析 import 继续为 0。

## 5. 第二批：React／Host 主体与 legacy 测试（PR-4B）

以下为 492 个 legacy-only 候选的分布。实际删除必须连同对应测试和调用方，保持每批是可编译、可回滚的闭包；不能先删被剩余模块继续引用的底层文件。

### 5.1 生产代码候选

| 分组 | 数量 | 处置 |
|---|---:|---|
| `src/agent` | 7 | 与 Host 会话链同批复核 |
| `src/ai` | 36 | 与旧 Prompt／会话工作流同批复核 |
| `src/api` | 14 | 区分 Host 专属与现役引用后删除 |
| `src/app` | 1 | 与 React 壳同批删除 |
| `src` 根模块 | 3 | `main.tsx` 等旧入口，最后与 Vite 配置处理 |
| `src/data` | 1 | 旧数据模型 |
| `src/features/batch-testing` | 12 | 与对应测试同批 |
| `src/features/deck-generation` | 37 | 与旧生成工作流同批 |
| `src/features/deck-workspace` | 87 | 与旧工作台组件同批 |
| `src/features/manual-page-editor` | 16 | 与手动编辑测试同批 |
| `src/features/outline` | 6 | 与大纲测试同批 |
| `src/features/page-image-search` | 3 | 与图片搜索测试同批 |
| `src/features/page-image-upload` | 2 | 与图片上传测试同批 |
| `src/features/page-regeneration` | 3 | 与页面重生成测试同批 |
| `src/features/performance` | 2 | 与性能页测试同批 |
| `src/features/process-progress` | 4 | 与进度组件测试同批 |
| `src/features/requirements` | 4 | 与需求页测试同批 |
| `src/features/templates` | 6 | 只删旧逻辑，**保留 presets 资产** |
| `src/features/user-templates` | 20 | 与个人模板旧实现同批 |
| `src/features/web-research-lab` | 3 | 与研究实验室测试同批 |
| `src/i18n` | 10 | 与旧四语注册表及测试同批 |
| `src/performance` | 2 | 与旧性能记录器同批 |
| `src/runtime` | 7 | 与 Host transport 同批 |

### 5.2 对应 legacy 测试候选

| 分组 | 数量 | 分组 | 数量 |
|---|---:|---|---:|
| `tests/agent` | 7 | `tests/ai` | 23 |
| `tests/api` | 6 | `tests/batch-testing` | 8 |
| `tests/deck-generation` | 22 | `tests/deck-workspace` | 80 |
| `tests/manual-page-editor` | 15 | `tests/outline` | 4 |
| `tests/page-image-search` | 2 | `tests/page-image-upload` | 3 |
| `tests/page-regeneration` | 2 | `tests/process-progress` | 2 |
| `tests/runtime` | 4 | `tests/templates` | 4 |
| `tests/user-templates` | 15 | `tests/web-research-lab` | 1 |
| `tests/i18n` | 1 | `tests/fixtures` | 1 |
| `tests/helpers` | 4 | `tests` 根测试 | 2 |

删除 legacy 测试的理由必须是其生产代码已退役，而不是为了隐藏当前 16 项失败。失败基线继续保留在交付记录中。

推荐按依赖闭包拆批：

1. Host transport、Agent、AI、Runtime 及其调用方和测试。
2. 旧生成与工作台功能及其调用方和测试。
3. 手动编辑、个人模板、图片与研究功能及其调用方和测试。
4. React 壳、旧入口和最后残留的引用。

若某批删除后仍有模块引用候选文件，必须扩大同批删除闭包或缩小本批范围，禁止留下无法编译的中间状态。

## 6. 第三批：入口、脚本与依赖（PR-4C）

只有在 legacy 生产代码和测试全部移除后执行：

- 删除 `index.html`、`src/main.tsx`、`src/styles/**`、`vite.config.ts` 中不再需要的 legacy 配置。
- 删除 `dev:legacy`、`build:legacy`、`test:legacy` 以及 `build` 的 legacy 别名；现役 `dev` / `serve` 保持不变。
- 删除 `scripts/run-tests.mjs` 的 legacy runner 和旧 `run-ppt-pipeline` 入口。
- 清理 `react`、`react-dom`、`react-moveable`、`lucide-react`、`@vitejs/plugin-react`、`vite` 及不再需要的 React 类型。
- 按剩余源码调整 `tsconfig.json` 的 JSX、Vite client 和 React 类型配置。
- 更新 lockfile，禁止手工编辑依赖版本或误删现役依赖。

最终验证：

- `npm install` 或等价干净安装验证通过。
- `npm run check` 通过。
- `npm run test:core` 通过。
- `npm run test:unit` 只包含现役测试并通过。
- `npm run test:gateway` 通过。
- MCP 工具注册与 smoke 通过。
- `npm run ci:fidelity` 通过。
- 模板列表、模板封面、Web 薄壳、控制台和手动编辑器运行时脚本可访问。
- 重新运行审计，无现役或核心测试依赖指向已删除文件。

## 7. 回滚策略

- PR-4A、PR-4B 各闭包、PR-4C 必须独立提交，禁止把全部删除压成一个超大提交。
- 每个提交只删除，不改变现役生成、计费、导出或 API 行为。
- 若核心测试、模板资产或导出回归失败，恢复对应删除提交，不在删除 PR 中顺带重写业务逻辑。
- 任何保护清单文件需要删除时，必须另开 ADR 和专门评审，不能沿用本计划的批量授权。

## 8. 执行确认与完成结果

- [x] 24 个未引用候选已完成人工复核并删除。
- [x] 492 个 legacy-only 候选按依赖闭包拆成可编译批次并删除。
- [x] 保护清单未被扩大解释为可删除项。
- [x] Go 网关、远程计费和契约改动已完整保留。
- [x] legacy 的 16 项既有失败已记录，未描述为修复。

执行结果：

- PR-4A 删除 24 个未引用文件，类型检查、核心测试与 legacy 构建通过。
- PR-4B 删除 206 个 legacy 测试文件和 286 个生产文件，legacy 候选归零。
- PR-4C 清理根级 Vite 配置、legacy 脚本和 React 依赖，lockfile 已同步。
- 全量现役测试 26 项通过、1 项环境跳过、0 项失败；MCP 全链路通过，保真回归 8／8 通过。
- 模板 98 套与 861 张 WebP 预览保持完整，主要文档本地链接无失效。
- Go 网关测试因本机未安装 Go 未执行；对应集成用例按环境跳过。
