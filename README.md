# SlideForge

AI 驱动的演示文稿工作台：HTML 原生的幻灯片、可审计的 AI 设计改动、可编辑的 PPTX 导出。

> 本项目为独立抽离的新仓库，前身为内部 monorepo 中的 `ppt-app`（2026-10-14 抽离）。

## 设计主张

**可确定性不赌模型。** 坐标定位、图像保真、资产去重与回补、变量级联全部在引擎与确定性代码中完成；模型只做语义判断。由此带来三个竞品给不了的承诺：

1. **AI 改动可审计** —— 母版优化采用前输出确定性偏离度报告（颜色/字号/logo 位移/占位符/骨架五色判读）；
2. **品牌资产零失真** —— 固定资产（logo）九宫格槽位 + 引擎合成 + 丢失确定性回补；
3. **调整粒度可控** —— 调整范围（整体/板块锁）× 强度（微调/平衡/重构）双维度控制。

## 仓库结构

```text
slideforge/
├── src/                ← 前端 SPA（React 18 + Vite + TS）
│   ├── features/       ← 业务功能（deck 生成/工作区/用户模板/导出…）
│   ├── ai/             ← 提示词体系与结构化解析
│   ├── i18n/           ← 四语注册表（en/zh/ja/de，编译期强制齐全）
│   ├── api/            ← PptBackend 接口与实现
│   └── agent/          ← 生成会话客户端（接口 + 重试编排）
├── executas/ppt-engine/← 引擎：HTML 工作区、栅格化、PPTX 导出、字体库
├── tests/              ← 前端单测（node --test）
├── evals/              ← 评测夹具（导出/版面审计/附件）
├── third_party/        ← dom-to-pptx（内嵌维护）
└── tools/              ← 预设预览渲染等内部工具
```

## 开发

```bash
npm install
npm run check        # tsc --noEmit
npm run test:unit    # 前端单测
npm run build        # vite build → bundle/
```

引擎：

```bash
cd executas/ppt-engine
npm install
npm run check        # tsc --noEmit
npm run test:unit    # 引擎单测
```

## 路线图

- [x] 从内部平台抽离（类型解耦、痕迹清扫）
- [ ] 自有 LLM 网关（SSE 会话流，替换宿主代理会话）
- [ ] 引擎 HTTP 服务化（替换进程桥，根治 90s 桥超时）
- [ ] 标准上传/下载与检索服务
- [ ] 模板资产外置按需加载

## License

待定。若含上游开源项目衍生代码，发布前需保留对应 NOTICE。
