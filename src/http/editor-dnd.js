// F2 布局级拖拽编辑：Ctrl/Cmd 点选元素，拖动移动、右下角手柄缩放。
(function () {
  const doc = document;
  const SCALE = doc.body.getBoundingClientRect().width / 1920 || 1;
  let selected = null, outline = null, handle = null, drag = null;

  function removeUI() {
    if (outline) outline.remove();
    if (handle) handle.remove();
    outline = handle = null;
  }

  function select(el) {
    removeUI();
    selected = el;
    const rect = el.getBoundingClientRect();
    outline = doc.createElement("div");
    outline.id = "__dnd-outline";
    outline.style.cssText = "position:absolute;pointer-events:none;border:2px solid #1e40af;z-index:9999;" +
      "left:" + (rect.left - 2) + "px;top:" + (rect.top - 2) + "px;width:" + (rect.width + 4) + "px;height:" + (rect.height + 4) + "px;";
    doc.body.appendChild(outline);
    handle = doc.createElement("div");
    handle.id = "__dnd-handle";
    handle.style.cssText = "position:absolute;width:18px;height:18px;background:#1e40af;border-radius:50%;cursor:nwse-resize;z-index:10000;" +
      "left:" + (rect.right - 9) + "px;top:" + (rect.bottom - 9) + "px;";
    handle.title = "拖动缩放";
    doc.body.appendChild(handle);
    handle.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const style = getComputedStyle(selected);
      drag = { mode: "resize", x: event.clientX, y: event.clientY, w: parseFloat(style.width), h: parseFloat(style.height) };
    });
    // 通知父页面：选中元素的属性面板可用（postMessage + iframe 全局引用）
    const style = getComputedStyle(el);
    window.__dndSelectedElement = el;
    window.parent.postMessage({
      type: "dnd-select",
      background: style.backgroundColor,
      color: style.color,
      fontSize: style.fontSize,
      tag: el.tagName,
    }, "*");
  }

  doc.addEventListener("mousedown", (event) => {
    if (event.target === handle) return;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      event.stopPropagation();
      const el = event.target.closest("main.slide *");
      if (!el) return;
      select(el);
      const style = getComputedStyle(el);
      if (style.position !== "absolute") {
        alert("该元素为流式布局，仅支持 absolute 定位元素拖拽");
        return;
      }
      drag = { mode: "move", x: event.clientX, y: event.clientY, left: parseFloat(style.left) || 0, top: parseFloat(style.top) || 0 };
    } else if (selected && !selected.contains(event.target) && event.target !== handle) {
      // 点击已选元素内部（含拖拽起点）不取消选择；仅点外部才取消
      removeUI();
      selected = null;
      drag = null;
    }
  }, true);

  doc.addEventListener("mousemove", (event) => {
    if (!drag || !selected) return;
    const dx = (event.clientX - drag.x) / SCALE, dy = (event.clientY - drag.y) / SCALE;
    if (drag.mode === "move") {
      selected.style.left = (drag.left + dx) + "px";
      selected.style.top = (drag.top + dy) + "px";
    } else {
      selected.style.width = Math.max(20, drag.w + dx) + "px";
      selected.style.height = Math.max(20, drag.h + dy) + "px";
    }
    const rect = selected.getBoundingClientRect();
    outline.style.left = (rect.left - 2) + "px";
    outline.style.top = (rect.top - 2) + "px";
    outline.style.width = (rect.width + 4) + "px";
    outline.style.height = (rect.height + 4) + "px";
    handle.style.left = (rect.right - 9) + "px";
    handle.style.top = (rect.bottom - 9) + "px";
  });
  // 注意：不要在 mouseup 清空 drag——Ctrl 点选后的 mouseup 也会触发，
  // 否则选中状态在拖拽开始前就被抹掉。drag 会在下次拖拽/取消选择时重置。
})();
