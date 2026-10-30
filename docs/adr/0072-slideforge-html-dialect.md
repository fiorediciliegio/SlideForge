# ADR-0072: SlideForge-HTML 方言契约与静态校验

- 状态: accepted
- 日期: 2026-10-30
- 决策人: 产品与架构讨论定稿（总纲 D2 的落地）

## 背景

导出保真的根本矛盾是 HTML 表达力 ⊃ OOXML。M0 的溢出事故与历次走样都源于"模型可以自由生成任意 HTML/CSS"。方向不应是追着转换器补洞，而是收窄生成语言：让允许集合与可映射集合相等。

## 决策

生成页面必须遵守 SlideForge-HTML 方言，由**生成后静态校验器**强制执行（`scripts/m0/dialect.ts`），违规即拒收并带具体违规项定向重生成（最多 2 次，仍违规则接受并记录）。

### 结构锚点（必须）

- 完整 HTML 文档，body 内有且仅有一个 `<main class="slide">` 根容器；
- 画布固定 1920×1080，overflow:hidden；
- 全部 CSS 内联 `<style>`；deck 组装时每页样式经 `scopeCss` 作用域隔离。

### 外部资源禁令（自包含）

禁止：`<script>`、外链样式表、`@import`、远程图片（img/src 与 CSS url() 的 http(s) 资源）、`<iframe>`。

### 不可映射 CSS 禁令（OOXML 无对应物）

`position:fixed`、`backdrop-filter`、`mix-blend-mode`、`filter`、`animation` / `transition`。

### 允许（明确在白名单内）

block/flex/grid 基础布局、文本、内联图片（base64/相对路径）、基础形状（圆角/边框/阴影）、表格、基础 SVG、absolute 定位（装饰/页码/logo）、CSS 变量（作用域内）。

## 与既有闸门的分工

- **方言校验（本 ADR）**：静态结构检查，不渲染，抓"根本不该出现的写法"；
- **渲染闸门（M1-1）**：无头 Chrome 测量溢出，抓"写法合法但排版超界"；
- **CI 保真回归（D6）**：夹具级导出+结构校验，防回归。

## 影响

- 生成提示词同步声明禁令（重生成反馈文案含契约摘要）；
- 新增 CSS 特性时，先确认 OOXML 可映射再进白名单，禁止"先生成再修导出"。
