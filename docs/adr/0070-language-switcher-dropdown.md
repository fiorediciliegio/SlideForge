# ADR-0070：语言切换器改为地球仪下拉

状态：已采纳

## 背景

原语言切换器是四个短标签按钮（EN / 中 / 日 / DE）横排的胶囊控件，挤占顶栏与侧栏头部空间，短标签对德语等语言不直观。Leader 于 2026-09-23 提供目标设计（`docs/language-switcher.html`）：地球仪图标 + 当前语言全名 + 箭头的下拉触发器，菜单内列出全部注册语言，当前项带 ✓。

## 决策

- `LocaleSwitch` 重写为原生 `<details>/<summary>` 下拉，不引入新组件库依赖。触发器显示 `locales` 注册表中当前语言的 `label`；菜单用 `localeIds.map` 渲染全部注册语言，保持"语言清单唯一来源是 `src/i18n/locales.ts`"的既定约束，组件内不硬编码任何语言。
- 选中项以 `aria-selected` 高亮并显示 ✓；菜单按钮保留既有性能埋点 `data-performance-id="locale.select-<id>"`。
- 菜单按钮带 `lang` 属性，取注册表的 BCP-47 `intl` 值（如 `zh-CN`），保证屏幕阅读器以正确语言发音。
- 补 `<details>` 缺失的交互：点击菜单外部关闭、Esc 关闭并回焦触发器，document 监听在 effect 清理函数中移除。
- 样式迁入 `deck-workspace.css`，颜色对齐工作区设计令牌（`--accent`、`--text-main`、`--text-muted`），不用 demo 的裸色值；类名前缀沿用 `.lang-switch`，根节点类名不变以兼容既有断言。
- 菜单绝对定位在触发器下方（`z-index: 60`），对齐右侧；若未来宿主管栏出现裁切，再按具体容器补 `overflow` 处理，本次不改布局结构。

## 验证

- `tests/deck-workspace/entrySidebar.test.ts` 与 `tests/i18n/i18n.test.ts` 通过（25/25），含 LocaleSwitch 源码契约（注册表渲染、无硬编码 `setLocale("en")` 等）。
- `tsc --noEmit` 无错误。
- 四个挂载点（EntryTopControls、PanelHeader、WebResearchLab、BatchTesting）共用同一组件，行为一致；真机交互（打开/外部点击/Esc/切换持久化）待 staging 目验。
