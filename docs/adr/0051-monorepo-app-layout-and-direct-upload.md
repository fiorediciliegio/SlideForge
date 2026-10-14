# PPT App 收拢到 anna-apps 大仓并采用 Direct Upload 发布

## 背景

PPT App 原先在独立 `ppt-sdk` 仓库中维护。为了与其他 Anna App 统一开发和发布，前端、`ppt-engine`、`docs`、`evals`、`examples`、`third_party` 以及 Agent 运行资料需要整体收拢到 `apps/ppt-app/`，同时保留 Anna App 要求的 `app.json`、`manifest.json`、`bundle/` 和 `executas/ppt-engine/` 布局。

## 决策

- `apps/ppt-app/` 是独立 App 根目录；App 内的脚本、相对路径和文档不再假设外层存在 `ppt-app/` 子目录。
- `docs/`、`evals/`、`examples/`、`third_party/`、`agent-ppt-runs/` 和 `AGENTS.md` / `CONTEXT.md` / `README.md` 与 App 源码一起迁移，评估和开发资料不进入 `bundle/`。
- `third_party/dom-to-pptx` 仍是 `ppt-engine` 构建时的权威源码，位置固定为 `apps/ppt-app/third_party/dom-to-pptx`。
- `ppt-engine` 二进制由大仓 workflow 构建为四个平台 archive，暂存到 `apps/ppt-app/executas/ppt-engine/bundle/`，再由 `anna-app apps push` / `apps cut` 通过 Direct Upload（直接上传）写入 Anna 存储；不再使用独立仓库的 GitHub Release 镜像流程。
- App package 使用大仓约定的 `@anna-apps/anna-presenton` 名称，使根仓发布 workflow 可以按 App slug 过滤构建。

## 结果

本地开发仍从 `apps/ppt-app` 运行 App 命令；大仓根目录统一管理依赖安装和 GitHub Actions。`.anna/`、`node_modules/`、运行时 sidecar 与其他本地生成状态不随源码迁移，目标工作区已有状态保留并在需要时重新构建。
