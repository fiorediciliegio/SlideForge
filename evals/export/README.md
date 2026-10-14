# Export-only evals

该目录保存固定、脱敏的 Final Deck HTML 案例，并通过真实
`ppt-engine.app_run_export_only` 验证 PPTX/PDF 导出。运行过程不调用 LLM，
也不执行需求分析或内容生成。

## 首批案例

当前先落地 8 个单页高级 HTML 案例：

1. 英文商业摘要；
2. 中文数据看板；
3. 中英双语路线图；
4. 长文本、多级列表与特殊字符；
5. 多字体、多字重与重复 `@font-face`；
6. 复杂表格；
7. SVG 图表、图标、渐变和透明；
8. Flex/Grid/绝对定位、重叠、阴影和裁切综合布局。

案例是评测输入，不应被 UI 引用。输出统一写入
`ppt-app/.eval-results/export/<run-id>/`，该目录已被 Git 忽略。

## 运行

在 `ppt-app` 目录执行：

```powershell
python evals\export\run_export_batch.py
```

如果 `ppt-engine/dist` 已经是最新版本：

```powershell
python evals\export\run_export_batch.py --skip-build
```

可以只运行部分格式或案例：

```powershell
python evals\export\run_export_batch.py --skip-build --formats pptx
python evals\export\run_export_batch.py --skip-build --cases 02-chinese-dashboard,06-complex-table
```

每次运行会生成 `report.json`、`report.csv`、`report.html`、逐次 JSON
结果和导出文件。HTML 报告中的 Deck HTML 与 PDF 链接用于人工视觉检查；
PPTX 的可编辑性及视觉一致性仍需用 PowerPoint/WPS 人工复核。

## 61 个 Visual Style Preset

仓库当前有 88 个 Visual Style Preset、811 个参考 HTML 页面。其中 27 个
存在缺失本地资源，默认严格排除；其余 61 个可以通过生产 Deck 构建后分别
测试 PPTX/PDF。

先确认 61/27 分类，不启动浏览器：

```powershell
python evals\export\run_visual_style_preset_batch.py --dry-run
```

完整运行 61 × 2：

```powershell
python evals\export\run_visual_style_preset_batch.py --skip-build
```

建议先用一个模板冒烟测试：

```powershell
python evals\export\run_visual_style_preset_batch.py --skip-build --limit 1
```

默认执行 PPTX OOXML 深度校验、PDF 解析与 PDF 首图生成。若还要将每个
PPTX 的所有页面重新打开并栅格化，追加 `--rasterize-pptx`；这会显著增加
811 页全量测试的耗时和磁盘占用。

## Legacy 截图语料定向批跑

`run_legacy_preset_export.py` 复用上述批次管线，但读取
`legacy-large-screenshot-templates/`（语料 HTML 与 src presets 逐字节一致），
按 ppt_number 定向导出并同时产出 PPTX+PDF 便于对照：

```powershell
python evals\export\run_legacy_preset_export.py --skip-build
# 默认 --numbers 18,25,33,80,111,125；输出 .eval-results/export/legacy-presets-<ts>/
```

## 研究结论：PPTX 可变字体字重拍平（勿重复排查）

2026-09-07 在 legacy 批次（preset-125 第 4 页"PPTX 与 PDF 字体明显不一致"）
定位的问题。结论：

- **不是模板问题，是导出管线对可变字体的系统性缺陷**：Google css2 对可变字体
  按多个 weight 声明 @font-face 但 src 指向同一 woff2；转换器把 400/700/900 分进
  regular/bold 槽（两槽同字节），woff2→EOT 又丢弃 fvar/gvar 拍平为默认实例。
  PowerPoint 里所有字重渲染成同一实例；PDF(Chromium) 按声明字重取实例，故不一致。
  且 **900≠"400 加粗"**：可变字体的各字重是独立设计的轮廓，还有 opsz 光学尺寸轴。
- **来源盘点**：静态字体（每字重独立文件）与系统字体栈（子集嵌入功能）今天即正确；
  Google 可变字体与其他来源可变字体当前嵌入字重必错，静态字源无需任何修复。
- **PPTX 格式天花板**：run 只有"字体名+b/i"、无数值字重属性；每字体名仅 4 个嵌入槽。
  多档字重只能假名家族逐档实例化的 hack 模拟，代价是编辑语义/跨机命名断裂。
  "与浏览器逐像素一致"在格式层面不可达，与工程量无关。
- **方案论证与落地风险**：修复只能落在"嵌入期换对字重文件"。透明化（撞槽/拍平升级
  为正式警告）保证不再静默；Google 来源可在嵌入期用老浏览器 UA 重查 css2 取每字重
  静态分片，但依赖 Google 未承诺的 UA 降级行为，可能失效，须回退+警告兜底；通用根治
  是对任意 fvar/gvar 字体做实例化，但 JS 生态无现成库、需手写增量应用与 checksum
  重建，风险最高。任何方案都受上述格式天花板约束，不存在"完全保真"路线。

完整根因链、SHA1/表级实证、各方案实现链路（含代码行号）见
`requirement_docs/PPTX导出-可变字体字重拍平-原因与应对实现链路.md`；
系统字体嵌入功能记录见 `requirement_docs/PPTX导出问题记录.md`（2026-09-07 节）。
本批次产物：`.eval-results/export/legacy-presets-20260907-155009/`（12/12 PASS）。
