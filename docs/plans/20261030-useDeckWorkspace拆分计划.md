# useDeckWorkspace 拆分计划（2026-10-30）

- 状态: active · 第一步已完成

## 问题

`src/features/deck-workspace/hooks/useDeckWorkspace.ts` 为 7111 行、101 个 import 的巨型 hook，
被 `App.tsx` 单点引用。所有状态与工作流纠缠在一个函数体内，是原平台遗留的最大单文件技术债。

## 处置原则

新架构的能力层（`src/capabilities/deck.ts`）已接管生成/导出/指改主流程，
该 hook 的大量工作流代码**应当删除而非搬走**。拆分分两类：

- **可复用纯逻辑** → 抽为独立模块（进行中）
- **被能力层替代的工作流** → 客户端 A 重建时直接退役

## 第一步（已完成）

抽出零状态依赖的纯函数到 `hooks/utils.ts`（formatWorkspaceDate/clampSlideIndex/appendBounded/appendStreamText），
hook 接口与行为不变，tsc 干净。

## 后续步骤（客户端 A 重建时执行）

1. 抽离风格档案状态机（createIdle/updateStage/applyEvent 等）→ `styleProfileStages.ts`；
2. 抽离上传附件依赖判断 → `uploadedSourceDeps.ts`；
3. 生成工作流整段删除，改调能力层（Web 壳与 MCP/HTTP 共用）；
4. 按域拆分剩余 hook：requirements / outline / export / templates / my-work。

每一步的验收：`npm run check` + `npm run test:unit`。
