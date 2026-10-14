# 手动编辑器拖动手柄说明

## 功能

手动编辑器选中可编辑 HTML 元素后显示移动手柄。用户需要按住手柄并持续拖动，选中元素才会移动；松开鼠标后结束本次操作。

## 实现要点

- 手柄通过 portal 渲染到编辑器 iframe 文档中，并根据选中元素边界定位。
- 使用 pointerdown、pointermove、pointerup 生命周期处理拖动。
- 使用 setPointerCapture 保持按住状态下的连续事件。
- 监听 iframe 的 defaultView，避免 iframe 内事件无法传递到外层窗口。
- 位移按元素本地缩放比例换算，更新元素的 left/top。
- 有效拖动完成后写入编辑历史；未超过拖动阈值时不产生移动记录。

## 当前限制

- 手柄视觉样式仍可继续优化。
- 当前版本主要覆盖 HTML 文本框，SVG 文本仍由原有 SVG 编辑流程处理。
- 复杂嵌套布局的边界定位需要继续通过真实页面样本验证。

## 验证

- npm run check 已通过。
- 功能分支：feat/manual-editor-kimi-move-handle。
