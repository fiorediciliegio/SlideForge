# SlideForge P0 架构收敛重构计划

- 日期：2026-11-01
- 范围：统一现役主链路、API 契约、`deck_id` 与工作区标识；冻结并分阶段退役 React／Host 旧体系
- 不在本阶段：数据库／Redis 迁移、Go 网关、微服务拆分、模板资产大规模搬迁、引擎目录删除
- 前置说明：当前工作区正在推进队列、浏览器生命周期和导出幂等改造。P0 不得回退或重写这些改动；冲突时以其最新实现为准

## 1. 背景与核心判断

当前存在两套应用体系：

1. 现役交付服务：`src/http/app.html` / CLI / MCP → `src/http/capabilityServer.ts` / `src/mcp/tools.ts` → `src/capabilities/deck.ts` → `scripts/m0` 与 `ppt-engine`。
2. 抽离前 React 体系：`src/main.tsx` → `src/app/App.tsx` → `src/features/**` → `src/api/pptBackend.ts` / `src/runtime/**` → Host／Executa → 同一个引擎。

主要问题不是目录大，而是：

- 默认 `dev` / `build` 仍指向 React，现役服务使用另一套 `serve` 入口；
- HTTP、MCP、CLI 各自维护输入、输出和错误形态，缺少单一契约；
- 接入层 `jobId` 与能力层 `deckId` 分别生成，任务 ID 不必然等于工作区目录名；
- 旧功能与现役共享资产混在 `src/features`，不能按目录直接删除；
- 根测试主要服务旧 React 体系，现役核心链路需要独立、稳定的测试门禁。

## 2. 目标与非目标

### 2.1 完成后的目标状态

```text
Web / CLI / MCP
      ↓
薄适配层（HTTP / MCP / CLI）
      ↓
纯契约层（Zod + DTO + Error + DeckId）
      ↓
Capability API
      ↓
生成、校验、工作区与 ppt-engine
```

- `deck_id` 在创建入口生成一次，任务、计费、工作区和 API 响应始终使用同一个值。
- HTTP 与 MCP 复用相同字段约束和语义，协议序列化差异只留在适配层。
- 现役核心测试可以独立运行，不被旧 React 测试失败阻塞。
- React／Host 先冻结，满足删除门禁后再单独删除；不在行为改造 PR 中大规模删文件。

### 2.2 明确不做

- 不重写生成算法、Prompt、HTML 方言、PPTX 导出和计费规则。
- 不把所有 `src/features` 或引擎“旧目录”一刀切删除。
- 不为了统一字段而强行让 REST 与 MCP 使用完全相同的序列化名称。
- 不引入新的运行时依赖；现有 `zod` 足够支撑 P0。

## 3. 模块处置清单

| 分类 | 路径 | P0 处置 |
|---|---|---|
| 现役主入口 | `src/http/app.html`、`src/http/capabilityServer.ts`、`src/mcp/**`、`scripts/m0-generate.ts` | 保留，改为复用统一契约 |
| 核心能力 | `src/capabilities/**`、`scripts/m0/**` | 保留，统一类型与标识，不改生成行为 |
| 运行支撑 | `src/server/**`、`src/billing/**` | 保留并兼容当前未提交改造 |
| 业务支撑 | `src/brand/**`、`src/documents/**`、`src/research/**`、`src/templates/**` | 保留 |
| 共享模板资产 | `src/features/templates/presets/**` | **必须保留**；封面和参考 HTML 仍被现役服务使用 |
| React 旧入口 | `index.html`、`src/main.tsx`、`src/app/**`、`src/styles/**` | 冻结新功能，重命名为 legacy 入口后待删 |
| React 旧业务 | `src/features/**`（共享模板资产除外） | 冻结；按引用审计分批删除 |
| Host 旧接入 | `src/api/hostPptBackend.ts`、`src/api/pptBackend.ts`、`src/runtime/**`、`src/agent/**`、`src/ai/**` | 冻结；不得与现役适配层合并成巨型接口 |
| 引擎 | `executas/ppt-engine/**`、`third_party/dom-to-pptx/**` | 全部暂保留，只按导出入口做可达性审计 |
| 旧管线与评测 | `scripts/run-ppt-pipeline.mjs`、部分 `evals/**` | 标记 legacy；保真与导出评测继续保留 |

### 删除禁区

- 不因目录名叫 `app-workspace`、`authoring-kit-workspace` 或 `task-state-machine` 就认定引擎模块可删；PDF 导出等现役路径可能仍有依赖。
- 不删除 `src/features/templates/presets`，直到模板资产另迁且现役引用全部改写。
- 不在 P0 删除 React 依赖；只有旧入口与旧测试全部移除后才清理 `react`、`react-dom`、`react-moveable`、`lucide-react`、Vite 相关依赖。

## 4. 统一契约设计

### 4.1 新增文件

```text
src/contracts/
├── deck.ts       # DeckId、CreateDeck、DeckJob、DeckEvent、Export 等 schema 与类型
├── errors.ts     # 标准错误码、错误结构与 HTTP 映射
└── ids.ts        # newDeckId()、assertDeckId()，不依赖 HTTP 或文件系统
```

契约层只依赖 `zod` 和 Node 标准库；不得 import Capability、HTTP、MCP 或 React，避免反向依赖。

### 4.2 核心约束

- `DeckId`：以 `deck-` 开头，仅允许字母、数字和连字符；禁止路径分隔符、`.` 和空白。
- `CreateDeckInput`：`brief` 非空，`pageCount` 为 2–20 的整数；其他可选字段沿用当前语义。
- `DeckStatus`：P0 保持 `creating | ready | error`，不在本阶段改变任务状态机。
- `DeckEvent`：从 `src/capabilities/deck.ts` 移到契约层；Capability 与 `src/server/jobs.ts` 均从契约层导入。
- `DeckJob`：外部 DTO 与内部持久化记录分型，不直接把含 `ownerKeyHash` 的存储对象暴露给客户端。
- 错误：统一为 `{ error: string, error_code: string, retryable: boolean, details? }`。保留现有字符串 `error`，新增机器可读的 `error_code` 等字段，避免同一 JSON 键同时承担字符串和对象两种类型。

### 4.3 协议边界

内部 TypeScript 继续使用 camelCase。外部协议允许保留各自既有命名，但语义必须来自同一契约：

- REST 保持现有 URL 和状态码。
- MCP 工具继续使用 `deck_id`、`page_count`、`pptx_path` 等既有工具字段。
- REST 导出响应以 `out_path` 为规范字段，暂时保留 `outPath` 别名；`app.html` 切换后再删除别名。
- 不在 P0 修改 MCP 工具名和工具数量。

### 4.4 统一 `deck_id` 的规则

`CreateDeckInput` 增加可选 `deckId`：

```ts
const deckId = input.deckId ?? newDeckId();
const runDir = resolveDeckRunDir(decksRoot, deckId);
```

- HTTP／MCP：先用 `newDeckId()` 创建任务，再把同一个值传入 `createDeck`。
- CLI：可让 Capability 生成一次 ID，不再生成第二套外部 ID。
- 默认工作区：`artifacts/decks/<deck_id>`。
- 创建目录时先确保 `decksRoot` 存在，再以 `recursive: false` 创建具体 Deck 目录；若已存在则返回冲突，禁止复用并覆盖。
- `resolveDeckRunDir` 必须为纯函数，负责 ID 校验和路径包含关系检查。

### 4.5 历史数据兼容

- 旧 `deck-jobs.json` 中已有 `runDir` 时，恢复逻辑必须优先使用持久化值，**不得根据 ID 重算**。
- 不批量重命名历史 `artifacts/decks/*`。
- 新任务全部满足 `job.id === deck.deckId === path.basename(job.runDir)`；旧任务只保证原路径继续可用。
- 本地开发的磁盘兜底恢复只作为兼容路径，不能替代任务快照。

## 5. 分阶段 PR 计划

### PR-0：恢复可依赖的验证基线

**目标**：先让核心测试可运行、结果可解释，再开始重构。

改动：

- 新增 `test:core`，先运行现有的 `tests/server`；PR-1 加入 `tests/contracts`，PR-2 再加入 `tests/capabilities`，避免引用尚不存在的测试目录。
- 保留 `test:unit` 全量跑批，不通过删除或 skip 隐藏旧测试失败。
- 核查当前大纲提示词断言失败：确认产品约束后修代码或更新测试，禁止只为变绿而删断言。
- 记录需要真实 LLM／Chrome 的测试与纯单元测试边界。

验收：

- `npm run check`
- `npm run test:core`
- `npm run test:unit` 结果明确，无未解释失败

### PR-1：建立纯契约层，不改变业务行为

**目标**：HTTP、MCP、Capability 共享类型和输入约束。

主要文件：

- 新增 `src/contracts/{deck,errors,ids}.ts`
- 新增 `tests/contracts/deck.test.ts`
- 修改 `src/capabilities/deck.ts`
- 修改 `src/http/capabilityServer.ts`
- 修改 `src/mcp/tools.ts`
- 修改 `src/server/jobs.ts`

步骤：

1. 先移动类型并保留原文件的兼容 re-export。
2. MCP 复用契约中的 Zod 字段 shape；HTTP 在边界解析并映射到内部 camelCase。
3. 统一错误映射，保留现有 `error` 字符串，并新增 `error_code`、`retryable` 等机器可读字段。
4. 删除各适配器中的重复约束，不改变生成、导出和计费流程。

验收：

- 契约单测覆盖合法值、边界值、非法 ID、错误序列化。
- 现有 HTTP smoke、MCP smoke 无行为回归。
- `src/contracts` 不出现对上层业务模块的 import。

### PR-2：统一 `deck_id` 与工作区目录

**目标**：消除 `Date.now()` 内部 ID 与随机外部 ID 双轨。

主要文件：

- `src/contracts/ids.ts`
- 新增 `src/capabilities/workspace.ts`（纯路径解析）
- `src/capabilities/deck.ts`
- `src/http/capabilityServer.ts`
- `src/mcp/tools.ts`
- `scripts/m0-generate.ts`
- `src/server/jobs.ts`
- `tests/capabilities/workspace.test.ts`
- `tests/server/httpSmoke.test.ts`

步骤：

1. HTTP／MCP 将既有 `jobId` 传入 `createDeck({ deckId: jobId, ... })`。
2. Capability 只在未传 ID 时生成一次，移除 `Date.now()`。
3. 新工作区目录拒绝冲突复用。
4. 快照恢复优先使用旧 `runDir`，增加历史双 ID 数据回归用例。
5. API 返回、计费上下文、事件记录全部使用同一个外部 ID。

验收：

- 新任务满足 ID 与目录名一致。
- 旧快照中 `id` 与 `runDir` 不一致时仍能恢复。
- 非法 ID 无法逃逸 `decksRoot`，重复 ID 不覆盖已有工作区。
- CLI／HTTP／MCP 创建结果返回的 ID 与后续预览、导出使用一致。

### PR-3：冻结 React／Host，区分现役与 legacy 入口

**目标**：停止双栈继续扩张，但不立即删除旧功能。

主要文件：

- `package.json`
- `README.md`、`AGENTS.md`、`docs/current-state.md`、`docs/deployment.md`
- 必要时更新 `CONTEXT.md` 和 `docs/architecture-10k.md`；与现有改动合并，不覆盖

入口调整：

1. 增加 `dev:legacy = vite`、`build:legacy = vite build --outDir bundle`。
2. 过渡期保留原 `dev` / `build` 别名，并在文档标明 legacy。
3. 文档和验证稳定后，将默认 `dev` 指向现役服务；不为静态薄壳制造虚假的 production build。
4. 增加 `test:legacy`，与 `test:core` 分开运行。

冻结规则：

- 新功能只能进入现役 Capability 路径。
- 旧 React 只接受阻断性缺陷修复。
- `src/features/templates/presets` 明确标记为共享资产，不随旧功能冻结删除。

验收：

- 新贡献者根据 README 能唯一确定现役启动入口。
- `npm run dev:legacy` 仍可打开旧 React，证明冻结未误删依赖。
- `test:core` 不依赖 React／Host 测试。

### PR-4：满足门禁后删除遗留代码

**目标**：把删除作为独立、可审查、可回滚的变更。

删除前必须全部满足：

- 现役入口不引用 legacy 业务模块。
- 共享模板资产已列入保留白名单。
- 引擎从 `runExportOnly` 出发的可达依赖未被列入删除集。
- `test:core`、HTTP／MCP smoke、保真回归通过。
- 部署文档不再引用 `dev:legacy` / `build:legacy`。

建议删除顺序：

1. `src/main.tsx`、`src/app` 与 Vite 入口。
2. Host 专属 `src/api`、`src/runtime`、`src/agent`、`src/ai`。
3. 旧 `src/features`，但排除共享模板资产。
4. 旧测试与 legacy 脚本。
5. 最后清理 React／Vite 依赖和 `tsconfig` 中不再需要的类型。

每一步单独提交，删除后运行类型检查，避免出现一次性数万行不可审查变更。

## 6. 回归测试矩阵

| 层级 | 必测场景 | 是否需要外部服务 |
|---|---|---|
| 契约单测 | 字段边界、非法 ID、错误结构、DTO 不泄露 owner hash | 否 |
| 工作区单测 | 路径包含关系、重复目录、历史双 ID、Windows 路径 | 否 |
| HTTP 集成 | 创建、查询、恢复、权限、请求上限、导出字段兼容 | 否，使用预置快照 |
| MCP 集成 | 工具 schema、同一 ID 查询与导出、权限隔离 | 可选 mock |
| CLI 冒烟 | 创建结果 ID 与工作区一致 | 是 |
| 引擎回归 | PPTX／PDF 导出、保真夹具 | Chrome |
| 全量回归 | 现役核心无回归，旧测试无新增失败 | 视用例 |

P0 完成门槛：

- `npm run check` 通过。
- `npm run test:core` 通过。
- `npm run test:unit` 无新增失败，已知失败有明确处置。
- `npm run mcp:smoke` 通过。
- `npm run ci:fidelity` 通过。
- 重启后新旧任务均可查询，历史 `runDir` 不被改写。

## 7. 风险与回滚

| 风险 | 控制方式 | 回滚点 |
|---|---|---|
| 契约改造破坏现有客户端 | 保留旧字段别名，先改 Web 再删别名 | 回滚 PR-1，不影响生成数据 |
| ID 改造导致旧作品丢失 | 快照优先使用旧 `runDir`，不迁移旧目录 | 回滚 PR-2，旧目录保持原样 |
| 删除共享模板或引擎依赖 | 白名单与可达性审计，删除独立 PR | 恢复对应删除提交 |
| 当前队列／导出改动被覆盖 | P0 只复用其接口，不重写实现；逐文件合并 | 保留当前工作区实现，契约适配后移 |
| 旧测试长期阻塞核心交付 | `test:core` 独立，但不隐藏全量失败 | 核心与 legacy 结果分别报告 |

## 8. 推荐执行顺序

```text
PR-0 基线
  → PR-1 契约
  → PR-2 标识
  → PR-3 冻结入口与文档
  → 完整验收
  → PR-4 分批删除
```

每个 PR 只承担一种风险：类型契约、目录标识、入口说明、代码删除不得混成一个大重构提交。
