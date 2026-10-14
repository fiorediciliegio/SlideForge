# Visual Style Preset Preview Renderer

这是 PPT App 的独立 Visual Style Preset（视觉风格预设）预览图生成与校验工具。
它不会进入前端 UI Bundle（界面构建包）、`ppt-engine` Executa（执行工具）或最终 App 发布包。

本工具处理的是：

```text
src/features/templates/presets/<preset-id>/
├── preset.json
├── html/*.html
└── images/*.webp
```

`executas/ppt-engine` 的旧 Template Group（模板组）PNG 预览链路已经移除；
这里是生成和校验 Visual Style Preset WebP 的独立入口。

## 运行约束

- 需要 Node.js 22+。
- 所有路径均通过命令行传入，代码不包含个人电脑的绝对路径。
- `render` 与 `convert-images` 会遍历源根目录下的全部预设目录，并在输出根目录创建同名目录。
- 源根目录和输出根目录必须存在、彼此分离且互不包含。
- `preset.json` 必须提供非空 `preview_images`，每项必须有非空 `alt`。
- Template Reference Page（模板参考页）HTML 必须自包含；不允许引用本地图片、字体或样式文件。
- 输出只包含 `preset.json`、`html/` 与 `images/*.webp`，不会复制源 PNG/JPG/JPEG 或 `assets/`。
- 所有输出先写入临时目录；只有整批预设校验通过后，才原子替换输出目录中的对应预设。

安装依赖：

```bash
npm ci
```

## 从 HTML 渲染预览图

适用于已经准备好完整 `preset.json` 和自包含参考 HTML 的新预设：

```bash
npm run render -- \
  --source-root <完整预设源目录> \
  --output-root <PPT App presets目录> \
  --browser-executable <Chromium可执行文件> \
  --quality 90 \
  --report <报告文件.json>
```

工具以 `reference_html_pages` 为依据，在 Chromium 中渲染 HTML，并输出
`1280x720` WebP。`preview_images` 与 `reference_html_pages` 必须顺序一致，文件名主体必须相同。

## 转换旧预览图片

适用于 `preview_images` 仍指向 PNG/JPG/JPEG 的旧预设：

```bash
npm run convert-images -- \
  --source-root <完整旧预设源目录> \
  --output-root <PPT App presets目录> \
  --quality 90 \
  --report <报告文件.json>
```

此命令不依赖 Chromium，但仍会校验输出 HTML 是自包含的，避免发布后留下失效的本地资源引用。

## 严格校验

```bash
npm run check -- \
  --presets-root <包含HTML和WebP的完整预设目录> \
  --browser-executable <Chromium可执行文件> \
  --report <报告文件.json>
```

`check` 不修改预设。它验证 WebP 可完整解码、尺寸为 `1280x720`、不超过 300KB，
并逐页检查 HTML、字体、样式、请求和控制台错误。

该命令面向新增或变更的预设目录。当前 PPT App 中仍有部分历史参考 HTML 保留缺失本地资源的
warning（警告），在这些历史资源清理前，不要把全量浏览器 `check` 接入普通 `prebuild`。

发布或更新 App 内预设后，还必须在 `apps/ppt-app` 运行：

```bash
npm run validate:visual-style-presets
```

新增预设或预览页时，要同步更新 App 校验脚本中的预设数量和预览图数量基线。

## 测试

```bash
npm test
```
