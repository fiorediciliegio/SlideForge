import { slideFormatFromHtml } from "../../slideFormat";

/** 只规范化展示副本的文档边界，不修改页面源码或导出快照。 */
export function buildPagePreviewDocument(html: string) {
  const { width, height } = slideFormatFromHtml(html);
  const document = new window.DOMParser().parseFromString(html, "text/html");
  // 静态快照会把 body 样式限定到幻灯片容器；根文档需单独清除默认边距。
  const canvasStyle = {
    "box-sizing": "border-box",
    margin: "0px",
    padding: "0px",
    width: `${width}px`,
    height: `${height}px`,
    overflow: "hidden",
  };
  for (const element of [document.documentElement, document.body]) {
    for (const [property, value] of Object.entries(canvasStyle)) {
      element.style.setProperty(property, value, "important");
    }
  }
  return { width, height, html: `<!doctype html>\n${document.documentElement.outerHTML}` };
}
