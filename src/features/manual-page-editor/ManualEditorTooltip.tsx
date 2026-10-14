import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

export function ManualEditorTooltip({ containerRef, iframeDocument }: { containerRef: RefObject<HTMLElement>; iframeDocument?: Document | null }) {
  const id = useId();
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [trigger, setTrigger] = useState<HTMLElement | null>(null);
  const [text, setText] = useState("");
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let pending: number | undefined;
    let current: HTMLElement | null = null;
    const close = () => { window.clearTimeout(pending); pending = undefined; current = null; setTrigger(null); };
    const find = (target: EventTarget | null) => target && typeof (target as Element).closest === "function" ? (target as Element).closest<HTMLElement>("[data-editor-tooltip]") : null;
    const show = (target: EventTarget | null, delay: number) => {
      const next = find(target);
      if (!next || (!container.contains(next) && next.ownerDocument !== iframeDocument) || next.getAttribute("aria-expanded") === "true") { close(); return; }
      if (current === next) return;
      close();
      current = next;
      pending = window.setTimeout(() => {
        if (!next.isConnected || next.getAttribute("aria-expanded") === "true") return;
        setText(next.dataset.editorTooltip ?? "");
        setTrigger(next);
      }, delay);
    };
    const over = (event: PointerEvent) => { if (event.pointerType !== "touch") show(event.target, 80); };
    const out = (event: PointerEvent) => { if (find(event.relatedTarget) !== current) close(); };
    const focus = (event: FocusEvent) => show(event.target, 0);
    const blur = (event: FocusEvent) => { if (find(event.relatedTarget) !== current) close(); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    const roots: (HTMLElement | Document)[] = iframeDocument ? [container, iframeDocument] : [container];
    for (const root of roots) {
      root.addEventListener("pointerover", over as EventListener);
      root.addEventListener("pointerout", out as EventListener);
      root.addEventListener("focusin", focus as EventListener);
      root.addEventListener("focusout", blur as EventListener);
      root.addEventListener("pointerdown", close, true);
      root.addEventListener("keydown", key as EventListener, true);
    }
    window.addEventListener("keydown", key, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.clearTimeout(pending);
      for (const root of roots) {
        root.removeEventListener("pointerover", over as EventListener);
        root.removeEventListener("pointerout", out as EventListener);
        root.removeEventListener("focusin", focus as EventListener);
        root.removeEventListener("focusout", blur as EventListener);
        root.removeEventListener("pointerdown", close, true);
        root.removeEventListener("keydown", key as EventListener, true);
      }
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [containerRef, iframeDocument]);

  useLayoutEffect(() => {
    const tooltip = tooltipRef.current;
    if (!trigger || !tooltip) return;
    const sourceRect = trigger.getBoundingClientRect();
    const frame = trigger.ownerDocument !== containerRef.current?.ownerDocument ? trigger.ownerDocument.defaultView?.frameElement : null;
    const frameRect = frame?.getBoundingClientRect();
    const scaleX = frameRect && frame ? frameRect.width / frame.clientWidth : 1;
    const scaleY = frameRect && frame ? frameRect.height / frame.clientHeight : 1;
    const rect = frameRect ? { left: frameRect.left + sourceRect.left * scaleX, top: frameRect.top + sourceRect.top * scaleY, bottom: frameRect.top + sourceRect.bottom * scaleY, width: sourceRect.width * scaleX } : sourceRect;
    const bounds = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.max(8, Math.min(rect.left + rect.width / 2 - bounds.width / 2, window.innerWidth - bounds.width - 8))}px`;
    const top = rect.bottom + 8 + bounds.height <= window.innerHeight - 8 ? rect.bottom + 8 : rect.top - bounds.height - 8;
    tooltip.style.top = `${Math.max(8, top)}px`;
    const describedBy = trigger.getAttribute("aria-describedby");
    trigger.setAttribute("aria-describedby", [describedBy, id].filter(Boolean).join(" "));
    return () => { if (describedBy === null) trigger.removeAttribute("aria-describedby"); else trigger.setAttribute("aria-describedby", describedBy); };
  }, [containerRef, id, text, trigger]);
  return trigger && text && containerRef.current ? createPortal(<div ref={tooltipRef} id={id} role="tooltip" className="manual-editor-tooltip">{text}</div>, containerRef.current) : null;
}
