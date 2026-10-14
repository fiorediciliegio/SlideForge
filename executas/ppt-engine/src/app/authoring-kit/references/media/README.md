# Media（媒体参考）

- `foundations/SafeMediaFrame.tsx` 是页面可直接 import 的稳定媒体容器；有图片时优先使用它，并由外层布局先给出受约束的槽位尺寸。
- `ImageShowcase.tsx`：页面需要一张主图，并保留标题、说明、来源或加载失败占位时参考。

照片型素材通常使用 `cover`，截图、图表、地图或文档页面通常使用 `contain`。图片中的文字和数字不能自动作为事实依据。
