import { useCallback, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";
import { manualToolbarOverflow } from "./manualToolbarLayout";

export interface ManualEditorToolbarItem {
  id: string;
  priority: number;
  pinned?: boolean;
  label?: string;
  content: ReactNode;
}

export function ManualToolbarPopover({
  open,
  label,
  trigger,
  children,
  className = "",
  alignRight = false,
}: {
  open: boolean;
  label: string;
  trigger: ReactNode;
  children: ReactNode;
  className?: string;
  alignRight?: boolean;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  return (
    <>
      <span ref={anchorRef} className="manual-toolbar-popover-anchor">{trigger}</span>
      {open ? <ManualToolbarPanel anchorRef={anchorRef} label={label} className={className} alignRight={alignRight}>{children}</ManualToolbarPanel> : null}
    </>
  );
}

function ManualToolbarPanel({ anchorRef, label, children, className, alignRight }: {
  anchorRef: RefObject<HTMLSpanElement>;
  label: string;
  children: ReactNode;
  className: string;
  alignRight: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [root, setRoot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => { setRoot(anchorRef.current?.closest<HTMLElement>(".manual-page-editor") ?? document.body); }, [anchorRef]);
  useLayoutEffect(() => {
    if (!root) return;
    const update = () => {
      const anchor = anchorRef.current;
      const panel = panelRef.current;
      if (!anchor || !panel) return;
      const rect = anchor.getBoundingClientRect();
      const height = panel.getBoundingClientRect().height;
      const width = panel.getBoundingClientRect().width;
      const below = window.innerHeight - rect.bottom - 8;
      const top = below < height && rect.top > below ? rect.top - height - 6 : rect.bottom + 6;
      const left = alignRight ? rect.right - width : rect.left;
      panel.style.top = `${Math.max(8, Math.min(top, window.innerHeight - height - 8))}px`;
      panel.style.left = `${Math.max(8, Math.min(left, window.innerWidth - width - 8))}px`;
    };
    update();
    const observer = new ResizeObserver(update);
    if (panelRef.current) observer.observe(panelRef.current);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); };
  }, [alignRight, anchorRef, root]);
  return root ? createPortal(
    <div ref={panelRef} className={`manual-toolbar-panel ${className}`} data-manual-toolbar-popup role="dialog" aria-label={label}>{children}</div>,
    root,
  ) : null;
}

export function ManualEditorToolbar({ toolbarRef, label, items, measurementKey, moreLabel, moreOpen, moreDisabled, onToggleMore, moreContent }: {
  toolbarRef: RefObject<HTMLDivElement>;
  label: string;
  items: ManualEditorToolbarItem[];
  measurementKey: string;
  moreLabel: string;
  moreOpen: boolean;
  moreDisabled: boolean;
  onToggleMore: () => void;
  moreContent: ReactNode;
}) {
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const sizesRef = useRef(new Map<string, number>());
  const moreRef = useRef<HTMLDivElement>(null);
  const moreWidthRef = useRef(30);
  const [overflow, setOverflow] = useState<string[]>([]);
  const [measuring, setMeasuring] = useState(true);
  const hasMoreContent = Boolean(moreContent);
  const signature = `${measurementKey}:${items.map((item) => item.id).join(",")}`;
  const update = useCallback(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    for (const element of toolbar.querySelectorAll<HTMLElement>("[data-toolbar-item]")) {
      sizesRef.current.set(element.dataset.toolbarItem!, element.getBoundingClientRect().width);
    }
    const dock = toolbar.parentElement;
    if (!dock) return;
    const style = window.getComputedStyle(toolbar);
    const dockStyle = window.getComputedStyle(dock);
    const gap = Number.parseFloat(style.columnGap) || 0;
    if (moreRef.current) moreWidthRef.current = moreRef.current.getBoundingClientRect().width;
    const available = dock.clientWidth - (Number.parseFloat(dockStyle.paddingLeft) || 0) - (Number.parseFloat(dockStyle.paddingRight) || 0)
      - (Number.parseFloat(style.paddingLeft) || 0) - (Number.parseFloat(style.paddingRight) || 0)
      - (Number.parseFloat(style.borderLeftWidth) || 0) - (Number.parseFloat(style.borderRightWidth) || 0);
    const measuredItems = itemsRef.current.map((item) => ({ ...item, width: sizesRef.current.get(item.id) ?? 0 }));
    const needsMore = hasMoreContent || manualToolbarOverflow(measuredItems, available, gap).length > 0;
    const next = manualToolbarOverflow(measuredItems, available - (needsMore ? moreWidthRef.current + gap : 0), gap);
    setOverflow((current) => current.join(",") === next.join(",") ? current : next);
  }, [hasMoreContent, toolbarRef]);

  useLayoutEffect(() => { sizesRef.current.clear(); setOverflow([]); setMeasuring(true); }, [signature]);
  useLayoutEffect(() => { if (measuring) { update(); setMeasuring(false); } }, [measuring, signature, update]);
  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    const observer = new ResizeObserver(update);
    observer.observe(toolbar);
    if (toolbar.parentElement) observer.observe(toolbar.parentElement);
    return () => observer.disconnect();
  }, [toolbarRef, update]);

  const canOpenMore = !moreDisabled && (overflow.length > 0 || Boolean(moreContent));
  return (
    <div className="manual-editor-toolbar-dock">
      <div ref={toolbarRef} className="manual-editor-toolbar" role="toolbar" aria-label={label}>
        <div className="manual-toolbar-primary">
          {items.filter((item) => measuring || !overflow.includes(item.id)).map((item) => <div key={item.id} className="manual-toolbar-item" data-toolbar-item={item.id}>{item.content}</div>)}
        </div>
      {measuring || canOpenMore ? <div ref={moreRef} className="manual-toolbar-more">
        <ManualToolbarPopover open={moreOpen && canOpenMore} label={moreLabel} alignRight className="manual-toolbar-overflow-menu" trigger={
          <button type="button" data-performance-id="manual-editor.more.toggle" className={`manual-editor-btn icon ${moreOpen && canOpenMore ? "active" : ""}`} data-editor-tooltip={moreLabel} aria-label={moreLabel} aria-haspopup="dialog" aria-expanded={moreOpen && canOpenMore} disabled={!canOpenMore} onClick={onToggleMore}><MoreHorizontal size={16} /></button>
        }>
          {items.filter((item) => overflow.includes(item.id)).map((item) => <div key={item.id} className="manual-toolbar-overflow-item">{item.label ? <span>{item.label}</span> : null}<div className="manual-toolbar-overflow-control">{item.content}</div></div>)}
          {moreContent}
        </ManualToolbarPopover>
      </div> : null}
      </div>
    </div>
  );
}
