import { isInvokeTimeout } from "../deck-workspace/userFacingError";
import { ErrorNotice } from "../deck-workspace/components/ErrorNotice";
import { SlideThumbnail } from "../deck-workspace/components/SlideThumbnail";
import { slideFormatFromHtml } from "../../slideFormat";
import { persistManualPageDraft, saveManualPageDrafts, type ManualPageDraft } from "./manualPageSave";
import { bindEditorResources, displayEditorHtml, EditorResources } from "./manualPageEditorResources";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import Moveable from "react-moveable";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  AlignVerticalSpaceAround,
  AlertTriangle,
  ArrowLeft,
  Bold,
  ChevronDown,
  Crop,
  Download,
  ImagePlus,
  Italic,
  Layers,
  LoaderCircle,
  Move,
  PaintBucket,
  Plus,
  PanelLeftClose,
  PanelLeftOpen,
  Redo2,
  RotateCcw,
  Save,
  Shapes,
  Square,
  Strikethrough,
  Trash2,
  Type,
  Underline,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { createPptBackend, type PptBackend } from "../../api/pptBackend";
import type {
  GetPageEditContextResult,
  ManagedFontFamilySummary,
  ManagedFontRuntimeFamily,
  RestorePageSourceVersionResult,
  SaveManualPageRevisionResult,
} from "../../api/types";
import { createAppHostUploadClient, type AppHostUploadClient } from "../../runtime/appHostUploadClient";
import { connectAnnaRuntime } from "../../runtime/annaRuntime";
import { formatMessage, type Messages } from "../../i18n/messages";
import {
  DRAG_THRESHOLD_PX,
  MOVEABLE_EDITOR_CLASS,
  exceedsDragThreshold,
  isDoubleClickGesture,
  isMoveableEditorTarget,
  isSelectableBox,
  isSvgElement,
} from "./manualPageEditorInteractions";
import {
  ManualImageCropOverlay,
  type ImageCropSession,
} from "./ManualImageCropOverlay";
import {
  clampSourcePosition,
  cropForBoxes,
  imageDisplaySize,
  imageSourceElement,
  isCroppedImage,
  isEditableImage,
  readImageCrop,
  resetImageCrop,
  sourceBoxForCrop,
  updateImageCrop,
  wrapImageWithCrop,
  type ImageBox,
} from "./manualPageEditorImages";
import { measureLocalScale, promoteToAbsolute } from "./manualPageEditorPromotion";
import { applyInheritedLineHeight, applyProportionalFontSize, applySpaceAfter, currentSpaceAfter } from "./manualPageEditorText";
import {
  FONT_UPLOAD_VALUE,
  MANAGED_FONT_FAMILY_ATTRIBUTE,
  installRuntimeManagedFonts,
  managedFontFileMimeType,
  mergeRuntimeFontFamily,
  refreshRuntimeFontResources,
  verifyRuntimeManagedFonts,
} from "./manualPageEditorFonts";
import "./manual-page-editor.css";
import { beginTextSession, endTextSession, serializeDocument } from "./manualPageEditorSnapshot";
import { beginPerformanceSpan } from "../../performance/performanceRecorder";
import { ManualEditorToolbar, ManualToolbarPopover, type ManualEditorToolbarItem } from "./ManualEditorToolbar";
import { ManualEditorTooltip } from "./ManualEditorTooltip";
import { ManualEditorColorPicker } from "./ManualEditorColorPicker";
import { ManualEditorNumericControl } from "./ManualEditorNumericControl";

const FONT_SIZES = [10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 56, 64, 72, 88];
const MAX_HISTORY = 50;
/** Smallest box edge the manual editor lets a resize produce. */
const RESIZE_MIN_SIZE_PX = 16;
// Allow time for resource URL preparation and bounded HTML transport on slow links.
const PAGE_LOAD_TIMEOUT_MS = 60_000;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

export interface ManualPageEditorPage {
  pageId: string;
  title: string;
  previewVersion?: string;
}

interface Props {
  t: Messages;
  workspaceDir: string;
  pages: ManualPageEditorPage[];
  initialPageIndex: number;
  onPageUpdated: (result: SaveManualPageRevisionResult | RestorePageSourceVersionResult) => void;
  onExit: (workspaceDir: string, pageId: string | undefined, requiresDeckRender: boolean) => Promise<void> | void;
}

type SaveStatus = "saved" | "unsaved" | "saving" | "conflict" | "error";
type SaveSource = "explicit" | "switch-confirm" | "exit-confirm" | "shortcut";
type ToolbarPopover = "insert" | "spacing" | "text-color" | "fill" | "border" | null;
type SvgTextElement = SVGTextElement;

interface ManualToolbarSelectOption {
  value: string;
  label: string;
  tone?: "current" | "available";
  trailing?: React.ReactNode;
}

function ManualToolbarSelect({
  value,
  options,
  ariaLabel,
  className = "",
  prefix,
  menuMinWidth,
  disabled = false,
  onChange,
}: {
  value: string;
  options: ManualToolbarSelectOption[];
  ariaLabel: string;
  className?: string;
  prefix?: React.ReactNode;
  menuMinWidth?: number;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, options.findIndex((option) => option.value === value)));
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number; width: number; maxHeight: number; placement: "up" | "down" } | null>(null);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const selectedOption = options[selectedIndex] ?? options[0];

  useEffect(() => {
    const owner = triggerRef.current?.closest<HTMLElement>(".manual-page-editor");
    if (owner) setPortalRoot(owner);
  }, []);

  useEffect(() => {
    if (!open) return;
    setActiveIndex(selectedIndex);
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const maxHeight = Math.max(120, Math.min(300, window.innerHeight - 16));
      const menuHeight = Math.min(maxHeight, options.length * 36 + 12);
      const opensUp = rect.bottom + menuHeight + 8 > window.innerHeight && rect.top > menuHeight + 8;
      const width = Math.min(Math.max(rect.width, menuMinWidth ?? 0), window.innerWidth - 16);
      setMenuPosition({
        top: opensUp ? Math.max(8, rect.top - menuHeight - 6) : Math.max(8, Math.min(window.innerHeight - menuHeight - 8, rect.bottom + 6)),
        left: Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8)),
        width,
        maxHeight,
        placement: opensUp ? "up" : "down",
      });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [menuMinWidth, open, options.length, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && (triggerRef.current?.contains(event.target) || menuRef.current?.contains(event.target))) return;
      setOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutside);
    return () => window.removeEventListener("pointerdown", closeOnOutside);
  }, [open]);

  const choose = (option: ManualToolbarSelectOption) => {
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      if (!open) {
        setOpen(true);
        return;
      }
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((index) => (index + direction + options.length) % options.length);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      if (!open) {
        setOpen(true);
      } else {
        const option = options[activeIndex];
        if (option) choose(option);
      }
    }
  };

  return (
    <div className="manual-toolbar-select-wrap">
      <button
        ref={triggerRef}
        type="button"
        className={`manual-toolbar-select manual-toolbar-select-trigger ${className} ${selectedOption?.tone ? `tone-${selectedOption.tone}` : ""}`}
        aria-label={ariaLabel}
        data-editor-tooltip={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleKeyDown}
      >
        {prefix}
        <span>{selectedOption?.label ?? value}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open && menuPosition ? createPortal(
        <div
          ref={menuRef}
          className={`manual-toolbar-select-menu ${menuPosition.placement}`}
          role="listbox"
          data-manual-toolbar-popup
          aria-label={ariaLabel}
          style={{ top: menuPosition.top, left: menuPosition.left, width: menuPosition.width, maxHeight: menuPosition.maxHeight }}
        >
          {options.map((option, index) => (
            <button
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={`${index === activeIndex ? "active" : option.value === value ? "selected" : ""} ${option.tone ? `tone-${option.tone}` : ""}`}
              key={option.value}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(option)}
            >
              <span>{option.label}</span>
              {option.trailing ? <span className="manual-toolbar-select-option-icon">{option.trailing}</span> : null}
            </button>
          ))}
        </div>,
        portalRoot ?? document.body,
      ) : null}
    </div>
  );
}

function editableTarget(target: EventTarget | null): target is HTMLElement {
  const element = target && typeof (target as HTMLElement).closest === "function" ? target as HTMLElement : null;
  return Boolean(element?.closest("input,textarea,select,[contenteditable='true']"));
}

function selectionTarget(target: EventTarget | null, shell: HTMLElement): HTMLElement | null {
  let element = target && typeof (target as HTMLElement).closest === "function" ? target as HTMLElement : null;
  while (element && element !== shell) {
    // Static HTML promotion writes CSS positioning and an HTML placeholder.
    // SVG text uses x/y/transform instead, so never select an SVG descendant
    // for generic Moveable operations. Its HTML chart wrapper is safe instead.
    if (isSvgElement(element)) {
      const svg = element.closest("svg");
      element = svg?.parentElement ?? null;
      continue;
    }
    if (element.dataset.pptEditorImageSource && isCroppedImage(element.parentElement)) {
      return element.parentElement;
    }
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (isSelectableBox({
      tagName: element.tagName,
      display: style?.display ?? "block",
      visibility: style?.visibility ?? "visible",
      width: rect.width,
      height: rect.height,
      isEditorArtifact: Boolean(element.dataset.pptEditorPlaceholder || element.dataset.pptEditorDeleted),
    })) return element;
    element = element.parentElement;
  }
  return null;
}

function isPromotableHtmlElement(element: HTMLElement): boolean {
  return !isSvgElement(element);
}

function capturePromotionRollback(element: HTMLElement): () => void {
  const view = element.ownerDocument.defaultView;
  const parent = element.parentElement;
  if (!view || !parent || view.getComputedStyle(element).position === "absolute") return () => undefined;
  const cssText = element.style.cssText;
  const parentPosition = parent.style.position;
  promoteToAbsolute(element);
  const placeholder = element.previousElementSibling as HTMLElement | null;
  return () => {
    if (placeholder?.dataset.pptEditorPlaceholder === "true") placeholder.remove();
    element.style.cssText = cssText;
    parent.style.position = parentPosition;
  };
}

function svgTextTarget(target: EventTarget | null): SvgTextElement | null {
  const element = target && typeof (target as Element).closest === "function" ? target as Element : null;
  if (!isSvgElement(element)) return null;
  const text = element?.closest("text");
  return text && isSvgElement(text) && text.tagName.toLowerCase() === "text"
    ? text as SvgTextElement
    : null;
}

function textHitAtPoint(element: HTMLElement, clientX: number, clientY: number): boolean {
  const doc = element.ownerDocument;
  const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (node.textContent?.trim()) {
      const range = doc.createRange();
      range.selectNodeContents(node);
      for (const rect of Array.from(range.getClientRects())) {
        if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) return true;
      }
    }
    node = walker.nextNode();
  }
  return false;
}

interface OutlineBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface CaretBox {
  left: number;
  top: number;
  height: number;
}

function outlineBox(element: HTMLElement): OutlineBox {
  const rect = element.getBoundingClientRect();
  const view = element.ownerDocument.defaultView;
  return {
    left: rect.left + (view?.scrollX ?? 0),
    top: rect.top + (view?.scrollY ?? 0),
    width: rect.width,
    height: rect.height,
  };
}

function makeId(): string {
  return `ppt-editor-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

function primaryFontFamily(value: string | undefined): string {
  return value?.split(",")[0]?.trim().replace(/^['"]|['"]$/g, "") ?? "";
}

function colorInputValue(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const trimmed = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed;
  const rgb = trimmed.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (!rgb) return fallback;
  return `#${rgb.slice(1, 4).map((part) => Math.max(0, Math.min(255, Number(part))).toString(16).padStart(2, "0")).join("")}`;
}

function isTextBoxElement(element: HTMLElement): boolean {
  return Boolean(
    element.textContent?.trim() &&
    !isEditableImage(element) &&
    !/^(SVG|CANVAS)$/.test(element.tagName),
  );
}

/**
 * Typography changes must not reflow siblings in a template's flex/grid
 * layout. Promotion keeps a hidden placeholder in the original flow and
 * gives the edited text box a fixed canvas-space rectangle.
 */
function isolateTextBox(element: HTMLElement): void {
  if (!isTextBoxElement(element)) return;
  const position = element.ownerDocument.defaultView?.getComputedStyle(element).position;
  if (position !== "absolute" && position !== "fixed") promoteToAbsolute(element);
}

const PARAGRAPH_SELECTOR = "p,li,blockquote,pre";


function imageBoxesEqual(left: ImageBox, right: ImageBox): boolean {
  return (
    Math.abs(left.left - right.left) < 0.01 &&
    Math.abs(left.top - right.top) < 0.01 &&
    Math.abs(left.width - right.width) < 0.01 &&
    Math.abs(left.height - right.height) < 0.01
  );
}

export function ManualPageEditorShell(props: Props) {
  const t = props.t.manualEditor;
  const controls = props.t.controls;
  const [backend, setBackend] = useState<PptBackend | null>(null);
  const [uploadClient, setUploadClient] = useState<AppHostUploadClient | null>(null);
  const [pageIndex, setPageIndex] = useState(Math.min(props.initialPageIndex, Math.max(0, props.pages.length - 1)));
  const [context, setContext] = useState<GetPageEditContextResult | null>(null);
  const [html, setHtml] = useState("");
  const { width: SLIDE_WIDTH, height: SLIDE_HEIGHT } = slideFormatFromHtml(html);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [conflictPageId, setConflictPageId] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [selected, setSelected] = useState<HTMLElement | null>(null);
  const [textEditingTarget, setTextEditingTarget] = useState<HTMLElement | null>(null);
  const [svgTextEditingTarget, setSvgTextEditingTarget] = useState<SvgTextElement | null>(null);
  const [svgTextEditingValue, setSvgTextEditingValue] = useState("");
  const [hoverBox, setHoverBox] = useState<OutlineBox | null>(null);
  const [caretBox, setCaretBox] = useState<CaretBox | null>(null);
  const [iframeDocument, setIframeDocument] = useState<Document | null>(null);
  // Bumped on every snapshot application (undo/redo) so the iframe remounts
  // even when the restored srcdoc is byte-identical to the current one —
  // without a remount, setting the same srcdoc fires no load event and the
  // editor stays dead (iframeDocument null → no selection, no editing).
  const [iframeReloadEpoch, setIframeReloadEpoch] = useState(0);
  const [zoom, setZoom] = useState<"fit" | number>("fit");
  const [fitScale, setFitScale] = useState(0.75);
  const [history, setHistory] = useState<string[]>([]);
  const [future, setFuture] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<null | { kind: "exit" | "switch"; target?: number }>(null);
  const [imageMode, setImageMode] = useState<"add" | "replace">("add");
  const [cropSession, setCropSession] = useState<ImageCropSession | null>(null);
  const [managedFontLibrary, setManagedFontLibrary] = useState<ManagedFontFamilySummary[]>([]);
  const [workspaceFontLibrary, setWorkspaceFontLibrary] = useState<ManagedFontFamilySummary[]>([]);
  const [runtimeFonts, setRuntimeFonts] = useState<ManagedFontRuntimeFamily[]>([]);
  const [pendingFontFamily, setPendingFontFamily] = useState<string | null>(null);
  const [fontNotice, setFontNotice] = useState<null | { kind: "downloading" | "ready" | "error"; message: string }>(null);
  const [filmstripCollapsed, setFilmstripCollapsed] = useState(false);
  const [toolbarPopover, setToolbarPopover] = useState<ToolbarPopover>(null);
  const [toolbarOverflowOpen, setToolbarOverflowOpen] = useState(false);
  const [frameTick, setFrameTick] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const moveableRef = useRef<InstanceType<typeof Moveable> | null>(null);
  const canvasScrollRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fontInputRef = useRef<HTMLInputElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const textEditBeforeRef = useRef<string | null>(null);
  const svgTextEditBeforeRef = useRef<string | null>(null);
  const selectionRangeRef = useRef<Range | null>(null);
  const hoveredRef = useRef<HTMLElement | null>(null);
  const selectedRef = useRef<HTMLElement | null>(null);
  const cropSessionRef = useRef<ImageCropSession | null>(null);
  const finishCropRef = useRef<() => boolean>(() => false);
  const cancelCropRef = useRef<() => void>(() => undefined);
  const startCropRef = useRef<(target?: HTMLElement | null) => void>(() => undefined);
  const nudgeCropRef = useRef<(key: string, step: number) => void>(() => undefined);
  const editorKeydownRef = useRef<(event: KeyboardEvent) => void>(() => undefined);
  const iframeCleanupRef = useRef<(() => void) | null>(null);
  // Synchronous reentrancy guard for undo/redo. The `loading` state is set
  // asynchronously, so two Cmd+Z presses in the same tick both pass the
  // `loading` check, double-pop history, and apply the same snapshot twice —
  // the second application finds an unchanged srcdoc, fires no load event,
  // and leaves the editor permanently non-editable.
  const snapshotTransitionRef = useRef(false);
  const pageCacheRef = useRef(new Map<string, { context: GetPageEditContextResult; html: string }>());
  const pageFetchRequestsRef = useRef(new Map<string, Promise<{ context: GetPageEditContextResult; html: string }>>());
  const pageLoadRequestRef = useRef(0);
  const deckRenderRequiredRef = useRef(false);
  const resourceRegistriesRef = useRef(new Map<string, EditorResources>());
  const resourcesRef = useRef(new EditorResources());
  const savedSnapshotRef = useRef<string | null>(null);
  const saveRequestRef = useRef<Promise<boolean> | null>(null);
  const [savingAll, setSavingAll] = useState(false);
  const navigatingRef = useRef(false);
  // Unsaved per-page edits stashed in memory so switching pages never forces a
  // save/discard prompt; everything persists together via the Save button or
  // the exit confirmation (deck-level save).
  const dirtyPagesRef = useRef(new Map<string, ManualPageDraft>());
  const [dirtyStashCount, setDirtyStashCount] = useState(0);
  // Baseline override for the next iframe install when a stashed draft is shown.
  const pendingBaselineRef = useRef<string | null>(null);
  const pendingDraftRef = useRef<{ pageId: string; draft: ManualPageDraft } | null>(null);
  const pendingPageIndexRef = useRef<number | null>(null);
  const requestSwitchRef = useRef<(index: number) => void>(() => undefined);
  const finishSvgTextRef = useRef<() => void>(() => undefined);
  const loadSpanRef = useRef<ReturnType<typeof beginPerformanceSpan>>(null);
  const dragGestureRef = useRef<{
    before: string;
    startLeft: number;
    startTop: number;
    localScale: { x: number; y: number };
    moved: boolean;
  } | null>(null);
  const resizeGestureRef = useRef<{
    before: string;
    startLeft: number;
    startTop: number;
    startWidth: number;
    startHeight: number;
    localScale: { x: number; y: number };
    moved: boolean;
  } | null>(null);

  /** Drops the cached hover so the next pointer move measures the new layout. */
  const forgetHover = useCallback(() => {
    hoveredRef.current = null;
    setHoverBox(null);
  }, []);

  const recordDeckRenderRequirement = useCallback((required: boolean) => {
    if (!required) return;
    deckRenderRequiredRef.current = true;
  }, []);

  const page = props.pages[pageIndex];

  useEffect(() => {
    let cancelled = false;
    void Promise.all([createPptBackend(), connectAnnaRuntime()]).then(([nextBackend, runtime]) => {
      if (cancelled) return;
      setBackend(nextBackend);
      setUploadClient(createAppHostUploadClient(runtime));
    }).catch((value) => setError(formatMessage(t.loadFailed, { message: value instanceof Error ? value.message : String(value) })));
    return () => { cancelled = true; };
  }, []);

  const fetchPageIntoCache = useCallback(async (pageId: string, options?: { force?: boolean }) => {
    if (options?.force) {
      pageCacheRef.current.delete(pageId);
      pageFetchRequestsRef.current.delete(pageId);
    }
    const cached = pageCacheRef.current.get(pageId);
    if (cached && !resourceRegistriesRef.current.get(pageId)?.needsRefresh) return cached;
    const existing = pageFetchRequestsRef.current.get(pageId);
    if (existing) return existing;
    if (!backend) throw new Error("PPT backend is unavailable.");
    const request = withTimeout((async () => {
      const context = await backend.getPageEditContext({ workspace_dir: props.workspaceDir, page_id: pageId });
      const resources = resourceRegistriesRef.current.get(pageId) ?? new EditorResources();
      resources.merge(context.resources);
      resources.merge(context.workspace_fonts.flatMap((font) => Object.values(font.variants).flatMap((variant) => variant?.sources ?? []).map((source) => ({ local_url: source.local_url, url: source.source_url, expires_at: source.expires_at }))));
      resourceRegistriesRef.current.set(pageId, resources);
      const document = new DOMParser().parseFromString(context.html, "text/html");
      bindEditorResources(document, resources);
      const value = { context, html: serializeDocument(document) };
      pageCacheRef.current.set(pageId, value);
      return value;
    })(), PAGE_LOAD_TIMEOUT_MS, t.loadTimeout);
    pageFetchRequestsRef.current.set(pageId, request);
    try {
      return await request;
    } finally {
      if (pageFetchRequestsRef.current.get(pageId) === request) pageFetchRequestsRef.current.delete(pageId);
    }
  }, [backend, props.workspaceDir, t]);

  const loadPage = useCallback(async (index: number) => {
    const target = props.pages[index];
    if (!backend || !target) return;
    const request = pageLoadRequestRef.current + 1;
    pageLoadRequestRef.current = request;
    loadSpanRef.current?.finish("interrupted");
    loadSpanRef.current = beginPerformanceSpan({ operationName: "manual-editor.page-ready" });
    setLoading(true);
    setError("");
    setConflictPageId(null);
    setSelected(null);
    setTextEditingTarget(null);
    setSvgTextEditingTarget(null);
    cropSessionRef.current = null;
    setCropSession(null);
    iframeCleanupRef.current?.();
    iframeCleanupRef.current = null;
    try {
      const { context: nextContext, html: fetchedHtml } = await fetchPageIntoCache(target.pageId);
      const resources = resourceRegistriesRef.current.get(target.pageId)!;
      // Unsaved inserted resources are absent from the persisted page context.
      // Refresh the whole session registry before restoring its local snapshot.
      if (resources.needsRefresh) {
        resources.merge(await backend.refreshManualPageResources({ workspace_dir: props.workspaceDir, page_id: target.pageId, local_urls: resources.localUrls }));
      }
      if (pageLoadRequestRef.current !== request) return;
      // Keep the draft until its iframe is ready: a queued jump may skip this
      // page before installation, in which case it must remain in the stash.
      const stashed = dirtyPagesRef.current.get(target.pageId);
      pendingDraftRef.current = stashed ? { pageId: target.pageId, draft: stashed } : null;
      pendingBaselineRef.current = stashed ? stashed.baseline : null;
      setContext(stashed ? { ...nextContext, revision: stashed.baseRevision } : nextContext);
      setManagedFontLibrary(nextContext.font_library ?? []);
      setWorkspaceFontLibrary(nextContext.workspace_font_library ?? []);
      setRuntimeFonts(refreshRuntimeFontResources(nextContext.workspace_fonts ?? [], resources));
      resourcesRef.current = resources;
      setHtml(displayEditorHtml(stashed ? stashed.html : fetchedHtml, resources));
      savedSnapshotRef.current = null;
      setPageIndex(index);
      setSaveStatus(stashed ? "unsaved" : "saved");
      setHistory([]);
      setFuture([]);
    } catch (value) {
      if (pageLoadRequestRef.current !== request) return;
      loadSpanRef.current?.finish("error");
      setError(formatMessage(t.loadFailed, { message: value instanceof Error ? value.message : String(value) }));
    } finally {
      if (pageLoadRequestRef.current === request) setLoading(false);
    }
  }, [backend, fetchPageIntoCache, props.pages]);

  useEffect(() => { if (backend) void loadPage(pageIndex); }, [backend]); // eslint-disable-line react-hooks/exhaustive-deps

  // Start adjacent-page prefetch only after the current iframe is ready.
  // One worker avoids competing with initial load and bulk-warming a whole deck.
  useEffect(() => {
    if (!backend || loading || !iframeDocument || props.pages.length <= 1) return;
    let cancelled = false;
    const pending = props.pages
      .filter((item, index) => Math.abs(index - pageIndex) === 1 && !pageCacheRef.current.has(item.pageId))
      .map((item) => item.pageId);
    let cursor = 0;

    const prefetch = async (pageId: string) => {
      if (cancelled) return;
      // Give an explicit user navigation priority over opportunistic warming.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 1000));
      if (cancelled || navigatingRef.current || saveRequestRef.current) return;
      await fetchPageIntoCache(pageId);
    };

    const worker = async () => {
      while (!cancelled) {
        const pageId = pending[cursor++];
        if (!pageId) return;
        try {
          await prefetch(pageId);
        } catch {
          // Prefetch is opportunistic; a later explicit page switch retries it.
        }
      }
    };

    void worker();
    return () => { cancelled = true; };
  }, [backend, fetchPageIntoCache, props.pages, pageIndex, loading, iframeDocument]);

  useEffect(() => () => {
    iframeCleanupRef.current?.();
    loadSpanRef.current?.finish("interrupted");
  }, []);

  // The iframe listeners are registered once per page load, so they read the
  // current selection through a ref instead of a stale closure.
  useEffect(() => {
    selectedRef.current = selected;
    // Moveable already frames the selection; two outlines on one element read as
    // a rendering glitch.
    if (hoveredRef.current === selected) setHoverBox(null);
  }, [selected]);

  useEffect(() => {
    cropSessionRef.current = cropSession;
  }, [cropSession]);

  useEffect(() => {
    if (!textEditingTarget) setCaretBox(null);
  }, [textEditingTarget]);

  useEffect(() => {
    if (!iframeDocument) return;
    let cancelled = false;
    resourcesRef.current.merge(runtimeFonts.flatMap((font) => Object.values(font.variants).flatMap((variant) => variant?.sources ?? []).map((source) => ({ local_url: source.local_url, url: source.source_url, expires_at: source.expires_at }))));
    installRuntimeManagedFonts(iframeDocument, runtimeFonts);
    void verifyRuntimeManagedFonts(iframeDocument, runtimeFonts).catch((value) => {
      if (!cancelled) {
        setError(formatMessage(t.fontLoadFailed, {
          message: value instanceof Error ? value.message : String(value),
        }));
      }
    });
    return () => { cancelled = true; };
  }, [iframeDocument, runtimeFonts]);

  useEffect(() => {
    if (!toolbarPopover && !toolbarOverflowOpen) return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && toolbarRef.current?.contains(event.target)) return;
      if (event.target instanceof Element && editorRef.current?.contains(event.target.closest("[data-manual-toolbar-popup]"))) return;
      setToolbarPopover(null);
      setToolbarOverflowOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [toolbarOverflowOpen, toolbarPopover]);

  useEffect(() => { setToolbarPopover(null); setToolbarOverflowOpen(false); }, [pageIndex, selected]);

  useEffect(() => {
    const area = canvasScrollRef.current;
    if (!area) return;
    const update = () => {
      const style = window.getComputedStyle(area);
      const width = area.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
      const height = area.clientHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom);
      setFitScale(Math.max(0.1, Math.min(width / SLIDE_WIDTH, height / SLIDE_HEIGHT)));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(area);
    return () => observer.disconnect();
  }, [SLIDE_WIDTH, SLIDE_HEIGHT]);

  const currentHtml = useCallback(() => {
    const doc = iframeRef.current?.contentDocument;
    return doc?.querySelector('[data-presenton-slide-shell="true"]') ? serializeDocument(doc) : html;
  }, [html]);

  // The status label is intentionally sticky after a failed request so the
  // user can see that the last save did not complete. Prompt decisions must
  // use the document content instead: a transient editing interaction (or a
  // failed save followed by an undo) must not create a false unsaved prompt.
  const hasUnsavedChanges = useCallback(() => {
    const baseline = savedSnapshotRef.current;
    return baseline !== null && currentHtml() !== baseline;
  }, [currentHtml]);

  const markMutation = useCallback((before: string) => {
    const next = currentHtml();
    if (before === next) return;
    setHistory((items) => [...items, before].slice(-MAX_HISTORY));
    setFuture([]);
    setSaveStatus(next === savedSnapshotRef.current ? "saved" : "unsaved");
  }, [currentHtml]);

  const applySnapshot = useCallback(async (snapshot: string) => {
    if (!backend || !page) return;
    const request = ++pageLoadRequestRef.current;
    setLoading(true);
    try {
      const resources = resourcesRef.current;
      if (resources.needsRefresh) {
        resources.merge(await backend.refreshManualPageResources({ workspace_dir: props.workspaceDir, page_id: page.pageId, local_urls: resources.localUrls }));
        if (pageLoadRequestRef.current !== request) return;
        setRuntimeFonts((fonts) => refreshRuntimeFontResources(fonts, resources));
      }
      setSelected(null);
      cropSessionRef.current = null;
      setCropSession(null);
      setIframeDocument(null);
      setHtml(displayEditorHtml(snapshot, resources));
      setIframeReloadEpoch((epoch) => epoch + 1);
      setSaveStatus(snapshot === savedSnapshotRef.current ? "saved" : "unsaved");
      return true;
    } catch (value) {
      setError(formatMessage(t.resourceRefreshFailed, { message: value instanceof Error ? value.message : String(value) }));
      return false;
    } finally { if (pageLoadRequestRef.current === request) setLoading(false); }
  }, [backend, page, props.workspaceDir, t]);

  const undo = useCallback(async () => {
    if (snapshotTransitionRef.current) return;
    const previous = history.at(-1);
    if (loading || !previous) return;
    snapshotTransitionRef.current = true;
    try {
      const current = currentHtml();
      if (!await applySnapshot(previous)) return;
      setFuture((items) => [current, ...items].slice(0, MAX_HISTORY));
      setHistory((items) => items.slice(0, -1));
    } finally {
      snapshotTransitionRef.current = false;
    }
  }, [applySnapshot, currentHtml, history, loading]);

  const redo = useCallback(async () => {
    if (snapshotTransitionRef.current) return;
    const next = future[0];
    if (loading || !next) return;
    snapshotTransitionRef.current = true;
    try {
      const current = currentHtml();
      if (!await applySnapshot(next)) return;
      setHistory((items) => [...items, current].slice(-MAX_HISTORY));
      setFuture((items) => items.slice(1));
    } finally {
      snapshotTransitionRef.current = false;
    }
  }, [applySnapshot, currentHtml, future, loading]);

  const finishCrop = useCallback((): boolean => {
    const session = cropSessionRef.current;
    if (!session) return false;
    session.target.style.visibility = session.previousVisibility;
    cropSessionRef.current = null;
    setCropSession(null);

    if (
      imageBoxesEqual(session.frame, session.initialFrame) &&
      imageBoxesEqual(session.source, sourceBoxForCrop(session.initialFrame, readImageCrop(session.target)))
    ) {
      return false;
    }

    const crop = cropForBoxes(session.frame, session.source);
    let target = session.target;
    promoteToAbsolute(target);
    const localScale = measureLocalScale(target);
    target.style.left = `${target.offsetLeft + (session.frame.left - session.initialFrame.left) / localScale.x}px`;
    target.style.top = `${target.offsetTop + (session.frame.top - session.initialFrame.top) / localScale.y}px`;
    target.style.width = `${Math.max(16, target.offsetWidth + (session.frame.width - session.initialFrame.width) / localScale.x)}px`;
    target.style.height = `${Math.max(16, target.offsetHeight + (session.frame.height - session.initialFrame.height) / localScale.y)}px`;

    if (target.tagName === "IMG") {
      const image = target as HTMLImageElement;
      image.style.objectFit = "fill";
      image.style.objectPosition = "50% 50%";
      target = wrapImageWithCrop(image, crop);
    } else {
      updateImageCrop(target, crop);
    }

    const changed = serializeDocument(target.ownerDocument) !== session.before;
    if (changed) markMutation(session.before);
    setSelected(target);
    return changed;
  }, [markMutation]);

  const cancelCrop = useCallback(() => {
    const session = cropSessionRef.current;
    if (!session) return;
    session.target.style.visibility = session.previousVisibility;
    cropSessionRef.current = null;
    setCropSession(null);
  }, []);

  const startCrop = useCallback((requested?: HTMLElement | null) => {
    if (cropSessionRef.current) {
      finishCropRef.current();
      return;
    }
    const target = requested ?? selectedRef.current;
    if (!target || !isEditableImage(target)) return;
    const source = imageSourceElement(target);
    if (!source) return;
    const frame = outlineBox(target);
    const sourceBox = sourceBoxForCrop(frame, readImageCrop(target));
    const session: ImageCropSession = {
      target,
      sourceUrl: source.currentSrc || source.src,
      before: serializeDocument(target.ownerDocument),
      previousVisibility: target.style.visibility,
      initialFrame: frame,
      frame,
      source: sourceBox,
      sourceAspectRatio: sourceBox.width / sourceBox.height,
    };
    target.style.visibility = "hidden";
    forgetHover();
    cropSessionRef.current = session;
    setCropSession(session);
    setSelected(target);
  }, [forgetHover]);

  const nudgeCrop = useCallback((key: string, step: number) => {
    const session = cropSessionRef.current;
    if (!session) return;
    const source = clampSourcePosition({
      ...session.source,
      left: session.source.left + (key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0),
      top: session.source.top + (key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0),
    }, session.frame);
    const next = { ...session, source };
    cropSessionRef.current = next;
    setCropSession(next);
  }, []);

  finishCropRef.current = finishCrop;
  cancelCropRef.current = cancelCrop;
  startCropRef.current = startCrop;
  nudgeCropRef.current = nudgeCrop;

  const performSave = useCallback(async (source: SaveSource = "explicit") => {
    if (!backend || loading || !context || !page || savedSnapshotRef.current === null) return false;
    const activeElement = iframeRef.current?.contentDocument?.activeElement as HTMLElement | null;
    if (activeElement?.isContentEditable) activeElement.blur();
    finishSvgTextRef.current();
    finishCropRef.current();
    const value = currentHtml();
    const baseline = savedSnapshotRef.current;
    // A failed navigation may have left a stash for the still-live page.
    dirtyPagesRef.current.delete(page.pageId);
    setDirtyStashCount(dirtyPagesRef.current.size);
    if (value === baseline) {
      setSaveStatus("saved");
      return true;
    }
    const file = new File([value], `${page.pageId}.html`, { type: "text/plain" });
    if (file.size > 64 * 1024 * 1024) {
      setError(t.tooLarge);
      setSaveStatus("error");
      return false;
    }
    setSaveStatus("saving");
    setError("");
    const saveSpan = beginPerformanceSpan({ operationName: "manual-editor.persist", attributes: { size_bytes: file.size, save_source: source, base_revision: context.revision } });
    console.info(`[manual-editor] save-request page_id=${page.pageId} base_revision=${context.revision} source=${source} bytes=${file.size}`);
    let saveStage = "upload";
    try {
      saveStage = "revision";
      const result = await persistManualPageDraft(backend, {
        workspace_dir: props.workspaceDir,
        page_id: page.pageId,
        base_revision: context.revision,
        html: value,
        save_source: source,
      }, baseline, async () => {
        const latest = await fetchPageIntoCache(page.pageId, { force: true });
        return { html: latest.html, revision: latest.context.revision };
      });
      setContext({
        ...context,
        revision: result.manifest.revision,
        manually_edited: true,
        manifest: result.manifest,
        screenshot_path: result.manifest.screenshot_path,
      });
      // Keep the live iframe and newer edits intact while the request completes.
      savedSnapshotRef.current = value;
      pageCacheRef.current.set(page.pageId, {
        context: {
          ...context,
          revision: result.manifest.revision,
          manually_edited: true,
          manifest: result.manifest,
          screenshot_path: result.manifest.screenshot_path,
        },
        html: value,
      });
      setSaveStatus(currentHtml() === value ? "saved" : "unsaved");
      recordDeckRenderRequirement(result.final_deck_render_requires_rebuild);
      props.onPageUpdated(result);
      saveSpan?.finish("ok");
      return true;
    } catch (value) {
      const message = value instanceof Error ? value.message : String(value);
      console.error(`[manual-editor] save-error page_id=${page.pageId} source=${source} stage=${saveStage} message=${message}`);
      setConflictPageId(/revision conflict/i.test(message) ? page.pageId : null);
      setError(/revision conflict/i.test(message) ? t.saveStatus.conflict : formatMessage(t.saveFailed, { message }));
      setSaveStatus(/revision conflict/i.test(message) ? "conflict" : "error");
      saveSpan?.finish("error");
      return false;
    }
  }, [backend, context, currentHtml, fetchPageIntoCache, loading, page, props.onPageUpdated, props.workspaceDir, recordDeckRenderRequirement, t]);

  const saveStashedPages = useCallback(async (source: SaveSource): Promise<boolean> => {
    if (!backend) return false;
    let savingPageId: string | null = null;
    try {
      await saveManualPageDrafts(dirtyPagesRef.current, async (pageId, entry) => {
        savingPageId = pageId;
        const result = await persistManualPageDraft(backend, {
          workspace_dir: props.workspaceDir,
          page_id: pageId,
          base_revision: entry.baseRevision,
          html: entry.html,
          save_source: source,
        }, entry.baseline, async () => {
          const latest = await fetchPageIntoCache(pageId, { force: true });
          return { html: latest.html, revision: latest.context.revision };
        });
        const cached = pageCacheRef.current.get(pageId);
        if (cached) {
          pageCacheRef.current.set(pageId, {
            context: {
              ...cached.context,
              revision: result.manifest.revision,
              manually_edited: true,
              manifest: result.manifest,
              screenshot_path: result.manifest.screenshot_path,
            },
            html: entry.html,
          });
        }
        recordDeckRenderRequirement(result.final_deck_render_requires_rebuild);
        props.onPageUpdated(result);
      }, () => setDirtyStashCount(dirtyPagesRef.current.size));
      return true;
    } catch (value) {
      const message = value instanceof Error ? value.message : String(value);
      setConflictPageId(/revision conflict/i.test(message) ? savingPageId : null);
      setError(formatMessage(t.pageSaveFailed, {
        page: props.pages.findIndex((item) => item.pageId === savingPageId) + 1,
        message: /revision conflict/i.test(message) ? t.saveStatus.conflict : message,
      }));
      setSaveStatus(/revision conflict/i.test(message) ? "conflict" : "error");
      return false;
    }
  }, [backend, fetchPageIntoCache, props.onPageUpdated, props.pages, props.workspaceDir, recordDeckRenderRequirement, t]);

  const saveAll = useCallback((source: SaveSource = "explicit"): Promise<boolean> => {
    if (saveRequestRef.current) return saveRequestRef.current;
    if (navigatingRef.current || loading || savedSnapshotRef.current === null) return Promise.resolve(false);
    setSavingAll(true);
    setError("");
    setConflictPageId(null);
    // Install the shared promise before beginning any asynchronous page work.
    const request = Promise.resolve().then(async () => {
      if (!await performSave(source) || !await saveStashedPages(source)) return false;
      setSaveStatus(currentHtml() === savedSnapshotRef.current ? "saved" : "unsaved");
      return true;
    }).finally(() => {
      if (saveRequestRef.current === request) {
        saveRequestRef.current = null;
        setSavingAll(false);
      }
    });
    saveRequestRef.current = request;
    return request;
  }, [currentHtml, loading, performSave, saveStashedPages]);

  const requestSwitch = async (index: number) => {
    if (index === pageIndex) return;
    // Keep the latest user choice while the current page is still loading.
    // The snapshot is intentionally cleared during load, so checking it
    // before queueing would silently drop clicks made during that window.
    if (saveRequestRef.current || loading || savedSnapshotRef.current === null) {
      pendingPageIndexRef.current = index;
      return;
    }
    const activeElement = iframeRef.current?.contentDocument?.activeElement as HTMLElement | null;
    if (activeElement?.isContentEditable) activeElement.blur();
    finishSvgTextRef.current();
    const cropChanged = finishCropRef.current();
    if ((hasUnsavedChanges() || cropChanged) && page) {
      // Stash the draft and switch immediately instead of prompting a
      // save/discard decision per page. The draft is restored when the user
      // returns, and persists on the next deck-level save.
      dirtyPagesRef.current.set(page.pageId, {
        html: currentHtml(),
        baseline: savedSnapshotRef.current!,
        baseRevision: context?.revision ?? 0,
      });
      setDirtyStashCount(dirtyPagesRef.current.size);
    } else if (page) {
      dirtyPagesRef.current.delete(page.pageId);
      setDirtyStashCount(dirtyPagesRef.current.size);
    }
    if (loading) {
      pendingPageIndexRef.current = index;
      return;
    }
    // Preserve the user's latest click while a save or page fetch is in flight.
    // Previously navigatingRef caused subsequent clicks to be silently dropped.
    if (navigatingRef.current) {
      pendingPageIndexRef.current = index;
      return;
    }
    navigatingRef.current = true;
    try {
      let target = pendingPageIndexRef.current ?? index;
      pendingPageIndexRef.current = null;
      // While the target context is loading, pointer events can queue newer
      // page selections. Drain that queue after each load so the final click
      // wins instead of leaving the editor on the original page.
      while (true) {
        await loadPage(target);
        const next = pendingPageIndexRef.current;
        if (next === null || next === target) break;
        target = next;
        pendingPageIndexRef.current = null;
      }
    } finally {
      navigatingRef.current = false;
      pendingPageIndexRef.current = null;
    }
  };

  requestSwitchRef.current = requestSwitch;

  const reloadLatest = async () => {
    if (saveRequestRef.current || navigatingRef.current || loading) return;
    const targetId = conflictPageId ?? page?.pageId;
    const targetIndex = props.pages.findIndex((item) => item.pageId === targetId);
    if (!targetId || targetIndex < 0) return;
    // Explicitly reload only the conflicting page. Switching stashes any live
    // edits on the currently displayed page, so other drafts remain intact.
    dirtyPagesRef.current.delete(targetId);
    setDirtyStashCount(dirtyPagesRef.current.size);
    pageCacheRef.current.delete(targetId);
    if (targetIndex === pageIndex) await loadPage(targetIndex);
    else await requestSwitch(targetIndex);
  };

  // A click can arrive after loadPage has finished its request but before the
  // iframe has installed its document snapshot. Drain it once the page is
  // genuinely ready, keeping only the latest requested page.
  useEffect(() => {
    if (saveRequestRef.current || loading || navigatingRef.current || savedSnapshotRef.current === null) return;
    const target = pendingPageIndexRef.current;
    if (target === null) return;
    pendingPageIndexRef.current = null;
    if (target !== pageIndex) void requestSwitchRef.current(target);
  }, [iframeDocument, loading, pageIndex, savingAll]);

  const requestExit = () => {
    if (saveRequestRef.current || navigatingRef.current || loading) return;
    const activeElement = iframeRef.current?.contentDocument?.activeElement as HTMLElement | null;
    if (activeElement?.isContentEditable) activeElement.blur();
    finishSvgTextRef.current();
    const cropChanged = finishCropRef.current();
    if (currentHtml() !== savedSnapshotRef.current || cropChanged || dirtyPagesRef.current.size > 0) setConfirm({ kind: "exit" });
    else void props.onExit(props.workspaceDir, page?.pageId, deckRenderRequiredRef.current);
  };

  const resolveConfirm = async (action: "save" | "discard" | "cancel") => {
    if (saveRequestRef.current || loading) return;
    const request = confirm;
    if (!request || action === "cancel") { setConfirm(null); return; }
    if (action === "save" && !(await saveAll("exit-confirm"))) return;
    if (action === "save" && (currentHtml() !== savedSnapshotRef.current || dirtyPagesRef.current.size > 0)) return;
    if (action === "discard") {
      // Drop every stashed draft; the on-disk deck stays untouched.
      dirtyPagesRef.current.clear();
      setDirtyStashCount(0);
    }
    setConfirm(null);
    if (request.kind === "switch" && request.target !== undefined) await loadPage(request.target);
    if (request.kind === "exit") await props.onExit(props.workspaceDir, page?.pageId, deckRenderRequiredRef.current);
  };

  const selectParent = () => {
    const shell = iframeDocument?.querySelector<HTMLElement>('[data-presenton-slide-shell="true"]');
    const parent = selected?.parentElement;
    if (parent && shell && parent !== shell && shell.contains(parent)) {
      setSelected(parent);
      setToolbarPopover(null);
    }
  };

  const patchSelected = (patch: (element: HTMLElement) => void) => {
    if (!selected) return;
    const before = currentHtml();
    patch(selected);
    markMutation(before);
    setSelected(selected);
  };

  const patchSelectedText = (patch: (element: HTMLElement) => void) => {
    if (!selected || !isTextBoxElement(selected)) return;
    const before = currentHtml();
    isolateTextBox(selected);
    patch(selected);
    markMutation(before);
    setSelected(selected);
  };

  const applyFontSize = (size: number) => patchSelectedText((element) =>
    applyProportionalFontSize(element, element.ownerDocument.defaultView!, size));

  const startHandleMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!selected || !iframeDocument || isSvgElement(selected)) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const target = selected;
    const before = serializeDocument(iframeDocument);
    promoteToAbsolute(target);
    const startX = event.clientX;
    const startY = event.clientY;
    const handleLeft = Number.parseFloat(handle.style.left || "0") || 0;
    const handleTop = Number.parseFloat(handle.style.top || "0") || 0;
    const left = Number.parseFloat(target.style.left || "0") || 0;
    const top = Number.parseFloat(target.style.top || "0") || 0;
    const scale = measureLocalScale(target);
    const view = iframeDocument.defaultView ?? window;
    let moved = false;
    const onMove = (moveEvent: PointerEvent) => {
      if ((moveEvent.buttons & 1) === 0) return;
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      moved = true;
      target.style.left = `${left + dx / scale.x}px`;
      target.style.top = `${top + dy / scale.y}px`;
      handle.style.left = `${handleLeft + dx}px`;
      handle.style.top = `${handleTop + dy}px`;
      moveableRef.current?.updateRect();
    };
    const onUp = () => {
      view.removeEventListener("pointermove", onMove);
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      if (moved) markMutation(before);
      else capturePromotionRollback(target)();
      setFrameTick((tick) => tick + 1);
    };
    view.addEventListener("pointermove", onMove);
    view.addEventListener("pointerup", onUp, { once: true });
  };

  const applyTextStyle = (property: keyof CSSStyleDeclaration, value: string) => {
    if (!selected) return;
    const target = selected;
    const range = selectionRangeRef.current;
    if (range && !range.collapsed && target.contains(range.commonAncestorContainer)) {
      const before = currentHtml();
      isolateTextBox(target);
      const span = target.ownerDocument.createElement("span");
      (span.style as unknown as Record<string, string>)[property as string] = value;
      span.append(range.extractContents());
      range.insertNode(span);
      markMutation(before);
      selectionRangeRef.current = null;
      return;
    }
    const computedStyle = target.ownerDocument.defaultView?.getComputedStyle(target);
    const currentValue = String(
      computedStyle ? (computedStyle as unknown as Record<string, string>)[property as string] ?? "" : "",
    ).trim();
    // Avoid promoting/serializing a text box when the chosen value is already
    // active. This keeps a click on the current value from creating a dirty
    // revision or an undo entry.
    const inlineValue = String((target.style as unknown as Record<string, string>)[property as string] ?? "").trim();
    if (currentValue === value || inlineValue === value) return;
    patchSelectedText((element) => {
      (element.style as unknown as Record<string, string>)[property as string] = value;
    });
  };

  const applyFontFamily = (family: string, managed: boolean) => {
    if (!selected) return;
    const value = `"${family.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    const range = selectionRangeRef.current;
    if (range && !range.collapsed && selected.contains(range.commonAncestorContainer)) {
      const before = currentHtml();
      isolateTextBox(selected);
      const span = selected.ownerDocument.createElement("span");
      span.style.fontFamily = value;
      if (managed) span.setAttribute(MANAGED_FONT_FAMILY_ATTRIBUTE, family);
      span.append(range.extractContents());
      range.insertNode(span);
      markMutation(before);
      selectionRangeRef.current = null;
      return;
    }
    const currentValue = primaryFontFamily(selected.ownerDocument.defaultView?.getComputedStyle(selected).fontFamily);
    if (currentValue.toLowerCase() === family.toLowerCase()) return;
    patchSelectedText((element) => {
      element.style.fontFamily = value;
      if (managed) element.setAttribute(MANAGED_FONT_FAMILY_ATTRIBUTE, family);
      else element.removeAttribute(MANAGED_FONT_FAMILY_ATTRIBUTE);
    });
  };

  const ensureRuntimeManagedFont = async (
    font: ManagedFontRuntimeFamily,
    document: Document,
  ): Promise<boolean> => {
    const nextRuntimeFonts = mergeRuntimeFontFamily(runtimeFonts, font);
    resourcesRef.current.merge(
      Object.values(font.variants)
        .flatMap((variant) => variant?.sources ?? [])
        .map((source) => ({ local_url: source.local_url, url: source.source_url, expires_at: source.expires_at })),
    );
    // Do not write font-family until this exact @font-face has loaded in the
    // editing iframe. Browser fallback must never become a successful choice.
    installRuntimeManagedFonts(document, nextRuntimeFonts);
    await verifyRuntimeManagedFonts(document, [font]);
    if (iframeRef.current?.contentDocument !== document) return false;
    setRuntimeFonts((current) => mergeRuntimeFontFamily(current, font));
    return true;
  };

  const chooseFontFamily = async (family: string) => {
    if (family === FONT_UPLOAD_VALUE) {
      fontInputRef.current?.click();
      return;
    }
    if (!managedFontLibrary.some((font) => font.family === family) || !backend || pendingFontFamily) {
      return;
    }
    const target = selectedRef.current;
    const document = iframeRef.current?.contentDocument;
    if (!target || !document) return;
    setError("");
    setFontNotice(null);
    setPendingFontFamily(family);
    const isPinnedToWorkspace = workspaceFontLibrary.some((font) => font.family === family);
    const isCachedInSharedLibrary = managedFontLibrary.some((font) => font.family === family && font.cached);
    if (!isPinnedToWorkspace && !isCachedInSharedLibrary) {
      setFontNotice({ kind: "downloading", message: formatMessage(t.fontDownloading, { font: family }) });
    }
    try {
      const font = runtimeFonts.find((entry) => entry.family === family)
        ?? await backend.pinManagedFont({ workspace_dir: props.workspaceDir, family });
      if (selectedRef.current !== target || iframeRef.current?.contentDocument !== document) return;
      if (!await ensureRuntimeManagedFont(font, document)) return;
      if (selectedRef.current !== target || iframeRef.current?.contentDocument !== document) return;
      applyFontFamily(family, true);
      // A successful pin proves the global copy exists, including the case
      // where this action had to download it just now.
      setManagedFontLibrary((current) => current.map((entry) => entry.family === family
        ? { ...entry, cached: true }
        : entry));
      setWorkspaceFontLibrary((current) => current.some((entry) => entry.family === family)
        ? current
        : [...current, managedFontLibrary.find((entry) => entry.family === family) ?? {
          family,
          variants: ["regular"],
          source: "cloud" as const,
          cached: true,
        }].sort((left, right) => left.family.localeCompare(right.family)));
      // A cached shared face still needs iframe verification, but it was
      // not downloaded in this action. Only report a completed download for
      // a family that was absent from the Workspace before the selection.
      if (!isPinnedToWorkspace && !isCachedInSharedLibrary) {
        const notice = { kind: "ready" as const, message: formatMessage(t.fontDownloadCompleted, { font: family }) };
        setFontNotice(notice);
        window.setTimeout(() => setFontNotice((current) => current === notice ? null : current), 2_500);
      }
    } catch (value) {
      // The existing font-family is deliberately left untouched on any pin or
      // iframe load failure.
      const message = formatMessage(t.fontLoadFailed, {
        message: value instanceof Error ? value.message : String(value),
      });
      const notice = { kind: "error" as const, message };
      setFontNotice(notice);
      window.setTimeout(() => setFontNotice((current) => current === notice ? null : current), 5_000);
    } finally {
      setPendingFontFamily((current) => current === family ? null : current);
      setFontNotice((current) => current?.kind === "downloading" ? null : current);
    }
  };

  const handleFontUpload = async (file: File) => {
    const mimeType = managedFontFileMimeType(file.name);
    if (!mimeType || file.size <= 0 || file.size > 20 * 1024 * 1024) {
      setError(t.fontRejected);
      return;
    }
    if (!backend || !uploadClient) return;
    setError("");
    try {
      const hostUpload = await uploadClient.uploadFile(file, {
        purpose: "user_artifact",
        filename: file.name,
        mimeType,
        metadata: {
          workspace_dir: props.workspaceDir,
          source: "manual-page-editor-font",
        },
      });
      const result = await backend.commitManagedFontUpload({
        workspace_dir: props.workspaceDir,
        filename: file.name,
        size_bytes: file.size,
        host_upload: hostUpload,
      });
      setManagedFontLibrary(result.library.families);
      setWorkspaceFontLibrary((current) => current.some((entry) => entry.family === result.font.family)
        ? current
        : [...current, result.library.families.find((entry) => entry.family === result.font.family) ?? {
          family: result.font.family,
          variants: ["regular"],
          source: "uploaded" as const,
          cached: true,
        }].sort((left, right) => left.family.localeCompare(right.family)));
      const target = selectedRef.current;
      const document = iframeRef.current?.contentDocument;
      if (!target || !document) return;
      setPendingFontFamily(result.font.family);
      try {
        if (!await ensureRuntimeManagedFont(result.font, document)) return;
        if (selectedRef.current !== target || iframeRef.current?.contentDocument !== document) return;
        applyFontFamily(result.font.family, true);
      } finally {
        setPendingFontFamily((current) => current === result.font.family ? null : current);
      }
    } catch (value) {
      setError(formatMessage(t.fontLoadFailed, {
        message: value instanceof Error ? value.message : String(value),
      }));
    }
  };

  const addElement = (kind: "text" | "shape") => {
    finishCropRef.current();
    const shell = iframeDocument?.querySelector<HTMLElement>('[data-presenton-slide-shell="true"]');
    if (!shell) return;
    const before = currentHtml();
    const element = iframeDocument!.createElement("div");
    element.dataset.pptEditorCreated = "true";
    element.dataset.pptEditorId = makeId();
    element.style.position = "absolute";
    element.style.zIndex = "999";
    if (kind === "text") {
      Object.assign(element.style, { left: "430px", top: "328px", width: "420px", height: "64px", fontSize: "24px", fontFamily: "Arial", color: "#111827", overflow: "hidden" });
      element.textContent = t.newTextPlaceholder;
    } else {
      Object.assign(element.style, { left: "500px", top: "290px", width: "280px", height: "140px", background: "#ddd6fe", borderRadius: "16px" });
    }
    shell.append(element);
    markMutation(before);
    setSelected(element);
  };

  const resetSelectedCrop = () => {
    if (!selected || !isCroppedImage(selected)) return;
    const before = currentHtml();
    const image = resetImageCrop(selected);
    if (!image) return;
    markMutation(before);
    setSelected(image);
  };

  const handleImage = async (file: File) => {
    if (!/image\/(png|jpeg|webp)/.test(file.type) || file.size > 20 * 1024 * 1024) {
      setError(t.imageRejected);
      return;
    }
    if (!backend || !uploadClient || !page || !iframeDocument) return;
    const originalDocument = iframeDocument;
    const originalRequest = pageLoadRequestRef.current;
    let data: Awaited<ReturnType<PptBackend["commitManualPageImage"]>>;
    try {
      const hostUpload = await uploadClient.uploadFile(file, { purpose: "user_artifact", filename: file.name, mimeType: file.type,
        metadata: { workspace_dir: props.workspaceDir, source: "manual-page-image" } });
      data = await backend.commitManualPageImage({ workspace_dir: props.workspaceDir, page_id: page.pageId, size_bytes: file.size, host_upload: hostUpload });
      if (originalRequest !== pageLoadRequestRef.current || iframeRef.current?.contentDocument !== originalDocument) return;
      if (imageMode === "replace" && selected !== selectedRef.current) return;
      resourcesRef.current.merge([data]);
    } catch (value) {
      if (originalRequest === pageLoadRequestRef.current) setError(formatMessage(t.imageUploadFailed, { message: value instanceof Error ? value.message : String(value) }));
      return;
    }
    const size = imageDisplaySize(data.width, data.height);
    if (imageMode === "replace" && selected && isEditableImage(selected)) {
      const before = currentHtml();
      let image = isCroppedImage(selected) ? resetImageCrop(selected) : selected as HTMLImageElement;
      if (!image) return;
      promoteToAbsolute(image);
      const previousRect = image.getBoundingClientRect();
      const previousCenterX = previousRect.left + previousRect.width / 2;
      const previousCenterY = previousRect.top + previousRect.height / 2;
      Object.assign(image.style, {
        width: `${size.width}px`,
        height: `${size.height}px`,
        objectFit: "fill",
        objectPosition: "50% 50%",
      });
      const nextRect = image.getBoundingClientRect();
      const localScale = measureLocalScale(image);
      image.style.left = `${image.offsetLeft + (previousCenterX - nextRect.left - nextRect.width / 2) / localScale.x}px`;
      image.style.top = `${image.offsetTop + (previousCenterY - nextRect.top - nextRect.height / 2) / localScale.y}px`;
      image.src = data.url;
      markMutation(before);
      setSelected(image);
      return;
    }
    const shell = iframeDocument?.querySelector<HTMLElement>('[data-presenton-slide-shell="true"]');
    if (!shell) return;
    const before = currentHtml();
    const image = iframeDocument!.createElement("img");
    image.src = data.url;
    image.dataset.pptEditorCreated = "true";
    image.dataset.pptEditorId = makeId();
    Object.assign(image.style, {
      position: "absolute",
      left: `${(SLIDE_WIDTH - size.width) / 2}px`,
      top: `${(SLIDE_HEIGHT - size.height) / 2}px`,
      width: `${size.width}px`,
      height: `${size.height}px`,
      objectFit: "fill",
      objectPosition: "50% 50%",
      zIndex: "999",
    });
    shell.append(image);
    markMutation(before);
    setSelected(image);
  };

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (confirm) {
        if (saveRequestRef.current || loading) return;
        if (event.key === "Escape") {
          event.preventDefault();
          setConfirm(null);
        }
        return;
      }
      const meta = event.ctrlKey || event.metaKey;
      if (meta && event.key.toLowerCase() === "s") { event.preventDefault(); void saveAll("shortcut"); return; }
      // Escape should dismiss an open toolbar popover even when focus is inside
      // one of its colour/select controls (editableTarget would otherwise stop
      // the event before it reaches this handler).
      if (event.key === "Escape" && (toolbarPopover || toolbarOverflowOpen)) {
        event.preventDefault();
        setToolbarPopover(null);
        setToolbarOverflowOpen(false);
        return;
      }
      if (editableTarget(event.target)) return;
      if (cropSessionRef.current) {
        if (event.key === "Escape") {
          event.preventDefault();
          cancelCropRef.current();
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          finishCropRef.current();
          return;
        }
        if (event.key.startsWith("Arrow")) {
          event.preventDefault();
          nudgeCropRef.current(event.key, event.shiftKey ? 10 : 1);
          return;
        }
        if (meta && ["z", "y"].includes(event.key.toLowerCase())) {
          event.preventDefault();
          cancelCropRef.current();
          return;
        }
        return;
      }
      if (meta && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); return; }
      if (meta && event.key.toLowerCase() === "y") { event.preventDefault(); redo(); return; }
      if ((event.key === "Delete" || event.key === "Backspace") && selected) {
        event.preventDefault();
        patchSelected((element) => { element.style.visibility = "hidden"; element.dataset.pptEditorDeleted = "true"; });
        setSelected(null);
        return;
      }
      if (event.key === "Escape") {
        selected?.blur();
        setSelected(null);
        return;
      }
      if (event.key === "Enter" && selected && /^(DIV|P|H[1-6])$/.test(selected.tagName)) {
        event.preventDefault();
        textEditBeforeRef.current = serializeDocument(selected.ownerDocument);
        beginTextSession(selected);
        selected.focus();
        setTextEditingTarget(selected);
        return;
      }
      if (event.key.startsWith("Arrow") && selected) {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        const before = currentHtml();
        promoteToAbsolute(selected);
        const left = Number.parseFloat(selected.style.left || "0");
        const top = Number.parseFloat(selected.style.top || "0");
        if (event.key === "ArrowLeft") selected.style.left = `${left - step}px`;
        if (event.key === "ArrowRight") selected.style.left = `${left + step}px`;
        if (event.key === "ArrowUp") selected.style.top = `${top - step}px`;
        if (event.key === "ArrowDown") selected.style.top = `${top + step}px`;
        markMutation(before);
      }
    };
    editorKeydownRef.current = keydown;
    window.addEventListener("keydown", keydown);
    return () => {
      window.removeEventListener("keydown", keydown);
      if (editorKeydownRef.current === keydown) editorKeydownRef.current = () => undefined;
    };
  }, [confirm, currentHtml, loading, markMutation, redo, saveAll, selected, toolbarOverflowOpen, toolbarPopover, undo]);

  const onIframeLoad = () => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    iframeCleanupRef.current?.();
    setIframeDocument(doc);
    const shell = doc.querySelector<HTMLElement>('[data-presenton-slide-shell="true"]');
    if (!shell) { loadSpanRef.current?.finish("error"); setError(t.missingShell); return; }
    bindEditorResources(doc, resourcesRef.current);
    installRuntimeManagedFonts(doc, runtimeFonts);
    if (savedSnapshotRef.current === null) {
      // When a stashed draft is displayed, the baseline is the last saved
      // version (captured at stash time), not the draft being installed.
      savedSnapshotRef.current = pendingBaselineRef.current ?? serializeDocument(doc);
      pendingBaselineRef.current = null;
      const pending = pendingDraftRef.current;
      if (pending && pending.pageId === page?.pageId && dirtyPagesRef.current.get(pending.pageId) === pending.draft) {
        dirtyPagesRef.current.delete(pending.pageId);
        setDirtyStashCount(dirtyPagesRef.current.size);
      }
      pendingDraftRef.current = null;
    }
    let pointerStart: { x: number; y: number } | null = null;
    let suppressNextClick = false;
    const pointerDown = (event: PointerEvent) => {
      if (editableTarget(event.target)) return;
      if (isMoveableEditorTarget(event.target)) return;
      pointerStart = { x: event.clientX, y: event.clientY };
      suppressNextClick = false;
      if (cropSessionRef.current) {
        finishCropRef.current();
        return;
      }
      const target = selectionTarget(event.target, shell);
      setSelected(target);
    };
    const pointerUp = (event: PointerEvent) => {
      if (!pointerStart) return;
      suppressNextClick = Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) >= DRAG_THRESHOLD_PX;
      pointerStart = null;
    };
    const click = (event: MouseEvent) => {
      if (editableTarget(event.target) || isMoveableEditorTarget(event.target)) return;
      if (suppressNextClick) {
        suppressNextClick = false;
        return;
      }
      const target = selectionTarget(event.target, shell);
      if (!target || isEditableImage(target) || /^(IMG|SVG|CANVAS|TABLE)$/.test(target.tagName)) return;
      if (!target.textContent?.trim() || !textHitAtPoint(target, event.clientX, event.clientY)) return;
      const caretRangeFromPoint = (doc as Document & {
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
        caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
      }).caretRangeFromPoint;
      const caretPositionFromPoint = (doc as Document & {
        caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
      }).caretPositionFromPoint;
      const caretRange = caretRangeFromPoint?.call(doc, event.clientX, event.clientY)
        ?? (() => {
          const position = caretPositionFromPoint?.call(doc, event.clientX, event.clientY);
          if (!position) return null;
          const range = doc.createRange();
          range.setStart(position.offsetNode, position.offset);
          range.collapse(true);
          return range;
        })();
      textEditBeforeRef.current = serializeDocument(doc);
      beginTextSession(target);
      target.focus();
      if (caretRange && target.contains(caretRange.commonAncestorContainer)) {
        const selection = doc.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(caretRange);
      }
      setSelected(target);
      setTextEditingTarget(target);
    };
    const doubleClick = (event: MouseEvent) => {
      if (isMoveableEditorTarget(event.target)) return;
      const svgText = svgTextTarget(event.target);
      if (svgText) {
        event.preventDefault();
        textEditBeforeRef.current = null;
        svgTextEditBeforeRef.current = serializeDocument(doc);
        setSvgTextEditingTarget(svgText);
        setSvgTextEditingValue(svgText.textContent ?? "");
        return;
      }
      const target = selectionTarget(event.target, shell);
      if (target && isEditableImage(target)) {
        startCropRef.current(target);
        return;
      }
      if (!target || !isEditableImage(target)) return;
    };
    const focusOut = (event: FocusEvent) => {
      const target = event.target && typeof (event.target as HTMLElement).isContentEditable === "boolean" ? event.target as HTMLElement : null;
      if (!target?.isContentEditable) return;
      endTextSession(target);
      setCaretBox(null);
      setTextEditingTarget((current) => current === target ? null : current);
      if (textEditBeforeRef.current && textEditBeforeRef.current !== serializeDocument(doc)) markMutation(textEditBeforeRef.current);
      textEditBeforeRef.current = null;
    };
    const paste = (event: ClipboardEvent) => {
      const target = event.target && typeof (event.target as HTMLElement).isContentEditable === "boolean" ? event.target as HTMLElement : null;
      if (!target?.isContentEditable) return;
      event.preventDefault();
      doc.execCommand("insertText", false, event.clipboardData?.getData("text/plain") ?? "");
    };
    const selectionChange = () => {
      const range = doc.getSelection()?.rangeCount ? doc.getSelection()!.getRangeAt(0) : null;
      selectionRangeRef.current = range && shell.contains(range.commonAncestorContainer) ? range.cloneRange() : null;
      const target = selectedRef.current;
      if (!target?.isContentEditable || !range || !target.contains(range.commonAncestorContainer)) {
        setCaretBox(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      const lineHeight = Number.parseFloat(doc.defaultView?.getComputedStyle(target).lineHeight || "0") || 18;
      setCaretBox({
        left: rect.left + (doc.defaultView?.scrollX ?? 0),
        top: rect.top + (doc.defaultView?.scrollY ?? 0),
        height: rect.height || lineHeight,
      });
    };
    // A click lands on a leaf over text and on a container over padding, so the
    // pointer previews what it is about to grab.
    const pointerMove = (event: PointerEvent) => {
      if (cropSessionRef.current) return;
      if (dragGestureRef.current || resizeGestureRef.current) return;
      if (isMoveableEditorTarget(event.target)) return;
      const target = selectionTarget(event.target, shell);
      if (target === hoveredRef.current) return;
      hoveredRef.current = target;
      setHoverBox(target && target !== selectedRef.current ? outlineBox(target) : null);
    };
    const pointerLeave = () => forgetHover();
    const keydown = (event: KeyboardEvent) => editorKeydownRef.current(event);
    doc.addEventListener("pointerdown", pointerDown);
    doc.addEventListener("pointerup", pointerUp);
    doc.addEventListener("click", click);
    doc.addEventListener("pointermove", pointerMove);
    doc.addEventListener("pointerleave", pointerLeave);
    doc.addEventListener("dblclick", doubleClick);
    doc.addEventListener("focusout", focusOut);
    doc.addEventListener("paste", paste);
    doc.addEventListener("selectionchange", selectionChange);
    doc.addEventListener("keydown", keydown);
    iframeCleanupRef.current = () => {
      doc.removeEventListener("pointerdown", pointerDown);
      doc.removeEventListener("pointerup", pointerUp);
      doc.removeEventListener("click", click);
      doc.removeEventListener("pointermove", pointerMove);
      doc.removeEventListener("pointerleave", pointerLeave);
      doc.removeEventListener("dblclick", doubleClick);
      doc.removeEventListener("focusout", focusOut);
      doc.removeEventListener("paste", paste);
      doc.removeEventListener("selectionchange", selectionChange);
      doc.removeEventListener("keydown", keydown);
      forgetHover();
      selectionRangeRef.current = null;
    };
    loadSpanRef.current?.finish("ok");
  };

  const finishSvgTextEdit = (commit: boolean) => {
    const target = svgTextEditingTarget;
    if (commit && target) {
      // Recharts commonly wraps the label in a single tspan. Preserve its SVG
      // attributes instead of introducing invalid HTML inside the SVG tree.
      const run = target.querySelector("tspan");
      if (run) run.textContent = svgTextEditingValue;
      else target.textContent = svgTextEditingValue;
      if (svgTextEditBeforeRef.current && svgTextEditBeforeRef.current !== serializeDocument(target.ownerDocument)) {
        markMutation(svgTextEditBeforeRef.current);
      }
    }
    svgTextEditBeforeRef.current = null;
    setSvgTextEditingTarget(null);
  };
  finishSvgTextRef.current = () => finishSvgTextEdit(true);

  const scale = zoom === "fit" ? fitScale : zoom;
  const selectedStyle = selected && iframeDocument?.defaultView?.getComputedStyle(selected);
  const shell = iframeDocument?.querySelector<HTMLElement>('[data-presenton-slide-shell="true"]');
  const selectedFont = primaryFontFamily(selectedStyle?.fontFamily);
  // A family is selectable only when the managed library supplies a regular
  // face. Names inherited from page CSS and local/system fallbacks deliberately
  // remain out of this menu: their presence does not prove that they can load.
  const selectableManagedFonts = managedFontLibrary.filter((font) => font.variants.includes("regular"));
  const workspaceFontNames = new Set(workspaceFontLibrary.map((font) => font.family));
  // A page may name a cloud font before it has ever been pinned. Keep that
  // name in the current group, but leave the select value empty so the same
  // family stays available to click and download below.
  const selectedFontIsManaged = selectableManagedFonts.some((font) => font.family === selectedFont)
    && workspaceFontNames.has(selectedFont);
  const fontSelectValue = selectedFontIsManaged ? selectedFont : "";
  const currentFontOption = selectedFont
    ? { family: selectedFont, variants: ["regular" as const], source: "uploaded" as const }
    : null;
  const downloadedCloudFonts = selectableManagedFonts.filter((font) =>
    font.source === "cloud" && font.cached && (!selectedFontIsManaged || font.family !== selectedFont),
  );
  const availableCloudFonts = selectableManagedFonts.filter((font) =>
    font.source === "cloud" && !font.cached,
  );
  const uploadedFonts = selectableManagedFonts.filter((font) =>
    font.source === "uploaded" && (!selectedFontIsManaged || font.family !== selectedFont),
  );
  const fontFamilyOptions: ManualToolbarSelectOption[] = [
    {
      value: fontSelectValue,
      label: currentFontOption?.family ?? t.noManagedFonts,
      tone: "current",
    },
    ...downloadedCloudFonts.map((font) => ({ value: font.family, label: font.family })),
    ...availableCloudFonts.map((font) => ({
      value: font.family,
      label: font.family,
      tone: "available" as const,
      trailing: <Download size={14} aria-hidden="true" />,
    })),
    ...uploadedFonts.map((font) => ({ value: font.family, label: font.family })),
    { value: FONT_UPLOAD_VALUE, label: t.uploadFont },
  ];
  const selectedIsImage = isEditableImage(selected);
  const selectedHasText = Boolean(
    selected && !selectedIsImage && !/^(IMG|SVG|CANVAS)$/.test(selected.tagName) && selected.textContent?.trim(),
  );
  const selectedParent = selected?.parentElement;
  const canSelectParent = Boolean(selectedParent && shell && selectedParent !== shell && shell.contains(selectedParent));
  const textToolsDisabled = !selectedHasText;
  const currentFontSize = Math.round(Number.parseFloat(selectedStyle?.fontSize ?? "20"));
  const fontSizeOptions = FONT_SIZES.includes(currentFontSize)
    ? FONT_SIZES
    : [currentFontSize, ...FONT_SIZES].sort((left, right) => left - right);
  const computedLineHeight = Number.parseFloat(selectedStyle?.lineHeight ?? "");
  const computedFontSize = Number.parseFloat(selectedStyle?.fontSize ?? "");
  const currentLineHeight = Number.isFinite(computedLineHeight) && computedFontSize > 0
    ? Math.round(computedLineHeight / computedFontSize * 100) / 100
    : 1.2;
  const currentParagraphSpacing = selectedHasText && selected && iframeDocument?.defaultView
    ? currentSpaceAfter(selected, iframeDocument.defaultView)
    : 0;
  const textColor = colorInputValue(selectedStyle?.color, "#111827");
  const fillColor = colorInputValue(selectedStyle?.backgroundColor, "#ffffff");
  const borderColor = colorInputValue(selectedStyle?.borderColor, "#111827");
  const borderWidth = Math.round(Number.parseFloat(selectedStyle?.borderWidth ?? "0"));
  const fillIsClear = !selectedStyle || selectedStyle.backgroundColor === "rgba(0, 0, 0, 0)" || selectedStyle.backgroundColor === "transparent";
  const alignmentIndex = selectedStyle?.textAlign === "center" ? 1 : selectedStyle?.textAlign === "right" || selectedStyle?.textAlign === "end" ? 2 : 0;
  const alignmentValues = ["left", "center", "right"] as const;
  const AlignmentIcon = [AlignLeft, AlignCenter, AlignRight][alignmentIndex];
  const alignmentLabel = [t.alignLeft, t.alignCenter, t.alignRight][alignmentIndex];
  // Stashed drafts on other pages count as unsaved even when the current page
  // itself is clean.
  const effectiveSaveStatus = savingAll ? "saving" : saveStatus === "saved" && dirtyStashCount > 0 ? "unsaved" : saveStatus;
  const saveStatusLabel = effectiveSaveStatus === "saved"
    ? t.saveStatus.saved
    : effectiveSaveStatus === "saving"
      ? t.saveStatus.saving
      : effectiveSaveStatus === "conflict"
        ? t.saveStatus.conflict
        : effectiveSaveStatus === "error"
          ? t.saveStatus.failed
          : t.saveStatus.unsaved;
  const togglePopover = (popover: Exclude<ToolbarPopover, null>) => {
    setToolbarPopover((current) => current === popover ? null : popover);
  };
  const toolbarItems: ManualEditorToolbarItem[] = [
    {
      id: "insert", priority: 0,
      content: <ManualToolbarPopover open={toolbarPopover === "insert"} label={t.insert} className="manual-toolbar-insert-menu" trigger={
        <button type="button" data-performance-id="manual-editor.insert.toggle" className={`manual-editor-btn text ${toolbarPopover === "insert" ? "active" : ""}`} data-editor-tooltip={t.insert} aria-label={t.insert} aria-haspopup="dialog" aria-expanded={toolbarPopover === "insert"} onClick={() => togglePopover("insert")}><Plus size={16} />{t.insert}<ChevronDown size={12} /></button>
      }>
        <button type="button" data-performance-id="manual-editor.element.add-text" className="manual-popover-action" onClick={() => { setToolbarPopover(null); addElement("text"); }}><Type size={16} />{t.addText}</button>
        <button type="button" data-performance-id="manual-editor.element.add-shape" className="manual-popover-action" onClick={() => { setToolbarPopover(null); addElement("shape"); }}><Shapes size={16} />{t.addShape}</button>
        <button type="button" data-performance-id="manual-editor.element.add-image" className="manual-popover-action" onClick={() => { finishCropRef.current(); setToolbarPopover(null); setImageMode("add"); fileInputRef.current?.click(); }}><ImagePlus size={16} />{t.addImage}</button>
      </ManualToolbarPopover>,
    },
    {
      id: "history", priority: 1, label: `${t.undoLabel} / ${t.redoLabel}`,
      content: <div className="manual-toolbar-group manual-toolbar-history">
        <button type="button" data-performance-id="manual-editor.undo" className="manual-editor-btn icon" onClick={undo} disabled={Boolean(cropSession) || !history.length} data-editor-tooltip={t.undoLabel} aria-label={t.undo}><Undo2 size={16} /></button>
        <button type="button" data-performance-id="manual-editor.redo" className="manual-editor-btn icon" onClick={redo} disabled={Boolean(cropSession) || !future.length} data-editor-tooltip={t.redoLabel} aria-label={t.redo}><Redo2 size={16} /></button>
      </div>,
    },
  ];
  if (selectedHasText) {
    toolbarItems.push(
      {
        id: "font", priority: 6, label: t.fontFamily,
        content: <ManualToolbarSelect value={fontSelectValue} options={fontFamilyOptions} className="font-family" ariaLabel={t.fontFamily} menuMinWidth={260} disabled={textToolsDisabled || Boolean(pendingFontFamily)} onChange={(family) => void chooseFontFamily(family)} />,
      },
      {
        id: "font-size", priority: 2, label: t.fontSize,
        content: <ManualToolbarSelect value={String(currentFontSize)} options={fontSizeOptions.map((size) => ({ value: String(size), label: String(size) }))} className="font-size" ariaLabel={t.fontSize} disabled={textToolsDisabled} onChange={(value) => applyFontSize(Number(value))} />,
      },
      {
        id: "text-style", priority: 0, pinned: true,
        content: <div className="manual-toolbar-group">
          <button type="button" data-performance-id="manual-editor.text.bold" disabled={textToolsDisabled} className={`manual-editor-btn icon ${Number.parseInt(selectedStyle?.fontWeight ?? "400", 10) >= 600 ? "active" : ""}`} data-editor-tooltip={t.bold} aria-label={t.bold} aria-pressed={Number.parseInt(selectedStyle?.fontWeight ?? "400", 10) >= 600} onClick={() => applyTextStyle("fontWeight", Number.parseInt(selectedStyle?.fontWeight ?? "400", 10) >= 600 ? "400" : "700")}><Bold size={15} /></button>
          <button type="button" data-performance-id="manual-editor.text.italic" disabled={textToolsDisabled} className={`manual-editor-btn icon ${selectedStyle?.fontStyle === "italic" ? "active" : ""}`} data-editor-tooltip={t.italic} aria-label={t.italic} aria-pressed={selectedStyle?.fontStyle === "italic"} onClick={() => applyTextStyle("fontStyle", selectedStyle?.fontStyle === "italic" ? "normal" : "italic")}><Italic size={15} /></button>
          <button type="button" data-performance-id="manual-editor.text.underline" disabled={textToolsDisabled} className={`manual-editor-btn icon ${selectedStyle?.textDecorationLine.includes("underline") ? "active" : ""}`} data-editor-tooltip={t.underline} aria-label={t.underline} aria-pressed={Boolean(selectedStyle?.textDecorationLine.includes("underline"))} onClick={() => applyTextStyle("textDecoration", selectedStyle?.textDecorationLine.includes("underline") ? "none" : "underline")}><Underline size={15} /></button>
          <button type="button" data-performance-id="manual-editor.text.strikethrough" disabled={textToolsDisabled} className={`manual-editor-btn icon ${selectedStyle?.textDecorationLine.includes("line-through") ? "active" : ""}`} data-editor-tooltip={t.strikethrough} aria-label={t.strikethrough} aria-pressed={Boolean(selectedStyle?.textDecorationLine.includes("line-through"))} onClick={() => applyTextStyle("textDecoration", selectedStyle?.textDecorationLine.includes("line-through") ? "none" : "line-through")}><Strikethrough size={15} /></button>
        </div>,
      },
      {
        id: "alignment", priority: 2, label: t.alignment,
        content: <button type="button" data-performance-id="manual-editor.text.alignment-cycle" className="manual-editor-btn icon" data-editor-tooltip={alignmentLabel} aria-label={`${t.alignment}: ${alignmentLabel}`} onClick={() => patchSelected((element) => { element.style.textAlign = alignmentValues[(alignmentIndex + 1) % 3]; })}><AlignmentIcon size={15} /></button>,
      },
      {
        id: "spacing", priority: 3, label: t.spacing,
        content: <ManualToolbarPopover open={toolbarPopover === "spacing"} label={t.spacing} className="manual-toolbar-spacing-panel" trigger={
          <button type="button" data-performance-id="manual-editor.text.spacing" className={`manual-editor-btn icon ${toolbarPopover === "spacing" ? "active" : ""}`} data-editor-tooltip={t.spacing} aria-label={t.spacing} aria-haspopup="dialog" aria-expanded={toolbarPopover === "spacing"} onClick={() => togglePopover("spacing")}><AlignVerticalSpaceAround size={16} /></button>
        }>
          <ManualEditorNumericControl label={t.lineHeight} value={currentLineHeight} max={3} step={0.01} onChange={(value) => patchSelectedText((element) => applyInheritedLineHeight(element, String(value)))} />
          <ManualEditorNumericControl label={t.spaceAfter} value={currentParagraphSpacing} max={64} step={1} unit="px" onChange={(value) => patchSelectedText((element) => applySpaceAfter(element, element.ownerDocument.defaultView!, value))} />
        </ManualToolbarPopover>,
      },
      {
        id: "text-color", priority: 2, label: t.textColor,
        content: <ManualToolbarPopover open={toolbarPopover === "text-color"} label={t.textColor} className="manual-toolbar-color-panel" trigger={
          <button type="button" data-performance-id="manual-editor.text.color" className={`manual-editor-btn icon ${toolbarPopover === "text-color" ? "active" : ""}`} data-editor-tooltip={t.textColor} aria-label={t.textColor} aria-haspopup="dialog" aria-expanded={toolbarPopover === "text-color"} onClick={() => togglePopover("text-color")}><span className="manual-text-color-sample" style={{ borderBottomColor: textColor }}>A</span></button>
        }><ManualEditorColorPicker value={textColor} label={t.textColor} t={t} onChange={(color) => applyTextStyle("color", color)} /></ManualToolbarPopover>,
      },
    );
  }
  if (selectedIsImage) {
    toolbarItems.push(
      { id: "replace-image", priority: 2, content: <button type="button" data-performance-id="manual-editor.image.replace" className="manual-editor-btn text" data-editor-tooltip={t.replaceImage} disabled={Boolean(cropSession)} onClick={() => { setImageMode("replace"); fileInputRef.current?.click(); }}><ImagePlus size={15} />{t.replaceImage}</button> },
      { id: "crop-image", priority: 2, content: <button type="button" data-performance-id="manual-editor.image.crop" className={`manual-editor-btn text ${cropSession ? "active" : ""}`} data-editor-tooltip={t.cropImage} onClick={() => cropSession ? finishCropRef.current() : startCropRef.current()}><Crop size={15} />{t.cropImage}</button> },
    );
    if (isCroppedImage(selected) && !cropSession) toolbarItems.push({ id: "reset-crop", priority: 3, content: <button type="button" data-performance-id="manual-editor.image.reset-crop" className="manual-editor-btn text" data-editor-tooltip={t.resetCrop} onClick={resetSelectedCrop}><RotateCcw size={15} />{t.resetCrop}</button> });
  }
  if (selected && !selectedIsImage) {
    toolbarItems.push(
      {
        id: "fill", priority: 3,
        content: <ManualToolbarPopover open={toolbarPopover === "fill"} label={t.fill} className="manual-toolbar-color-panel" trigger={
          <button type="button" data-performance-id="manual-editor.fill.toggle" className={`manual-editor-btn icon ${toolbarPopover === "fill" ? "active" : ""}`} data-editor-tooltip={t.fill} aria-label={t.fill} aria-haspopup="dialog" aria-expanded={toolbarPopover === "fill"} onClick={() => togglePopover("fill")}><span className="manual-color-swatch" style={{ borderBottomColor: fillIsClear ? "transparent" : fillColor }}><PaintBucket size={15} /></span></button>
        }>
          <ManualEditorColorPicker value={fillColor} label={t.fillColor} t={t} isClear={fillIsClear} clearLabel={t.noFill} onChange={(color) => patchSelected((element) => { element.style.backgroundColor = color; })} onClear={() => { patchSelected((element) => { element.style.background = "transparent"; }); setToolbarPopover(null); }} />
        </ManualToolbarPopover>,
      },
      {
        id: "border", priority: 4,
        content: <ManualToolbarPopover open={toolbarPopover === "border"} label={t.border} className="manual-toolbar-color-panel" trigger={
          <button type="button" data-performance-id="manual-editor.border.toggle" className={`manual-editor-btn icon ${toolbarPopover === "border" ? "active" : ""}`} data-editor-tooltip={t.border} aria-label={t.border} aria-haspopup="dialog" aria-expanded={toolbarPopover === "border"} onClick={() => togglePopover("border")}><span className="manual-color-swatch" style={{ borderBottomColor: borderWidth > 0 ? borderColor : "transparent" }}><Square size={15} /></span></button>
        }>
          <ManualEditorColorPicker value={borderColor} label={t.borderColor} t={t} isClear={borderWidth === 0} clearLabel={t.noBorder}
            onChange={(color) => patchSelected((element) => { element.style.borderColor = color; element.style.borderStyle = "solid"; if (borderWidth === 0) element.style.borderWidth = "1px"; })}
            onClear={() => patchSelected((element) => { element.style.borderWidth = "0px"; element.style.borderStyle = "none"; })}
          ><ManualEditorNumericControl label={t.borderWidth} value={borderWidth} max={12} step={1} unit="px" onChange={(value) => patchSelected((element) => { element.style.borderWidth = `${value}px`; element.style.borderStyle = value > 0 ? "solid" : "none"; })} /></ManualEditorColorPicker>
        </ManualToolbarPopover>,
      },
    );
  }
  if (selected && !cropSession) toolbarItems.push({ id: "delete", priority: 2, label: t.deleteLabel, content: <button type="button" data-performance-id="manual-editor.element.delete" className="manual-editor-btn icon danger" data-editor-tooltip={t.deleteLabel} aria-label={t.deleteElement} onClick={() => { patchSelected((element) => { element.style.visibility = "hidden"; element.dataset.pptEditorDeleted = "true"; }); setSelected(null); }}><Trash2 size={15} /></button> });
  const toolbar = <ManualEditorToolbar toolbarRef={toolbarRef} label={t.title} items={toolbarItems} measurementKey={t.title} moreLabel={t.more} moreOpen={toolbarOverflowOpen} moreDisabled={false} onToggleMore={() => { setToolbarPopover(null); setToolbarOverflowOpen((open) => !open); }} moreContent={
    selected ? <button type="button" data-performance-id="manual-editor.selection.select-parent" className="manual-popover-action" disabled={Boolean(cropSession) || !canSelectParent} data-editor-tooltip={t.selectParent} onClick={selectParent}><Layers size={14} />{t.selectParent}</button> : null
  } />;

  return (
    <section ref={editorRef} className="manual-page-editor">
      <aside className={`manual-editor-filmstrip ${filmstripCollapsed ? "collapsed" : ""}`}>
        <div className="manual-filmstrip-header">
          <button data-performance-id="manual-editor.exit.request" className="manual-editor-btn icon" onClick={requestExit} data-editor-tooltip={controls.back} aria-label={controls.back}><ArrowLeft size={17} /></button>
          {!filmstripCollapsed ? <strong>{t.title}</strong> : null}
          <button data-performance-id="manual-editor.filmstrip.toggle" className="manual-editor-btn icon" onClick={() => setFilmstripCollapsed((value) => !value)} data-editor-tooltip={filmstripCollapsed ? t.expandPages : t.collapsePages} aria-label={filmstripCollapsed ? t.expandPages : t.collapsePages}>{filmstripCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</button>
        </div>
        {!filmstripCollapsed ? (
          <div className="manual-filmstrip-scroll">
            {props.pages.map((item, index) => (
              <button data-performance-id="manual-editor.page.select" key={item.pageId} className={`manual-filmstrip-item ${index === pageIndex ? "active" : ""}`} onClick={() => requestSwitch(index)}>
                <span className="manual-filmstrip-index">{index + 1}</span>
                <div className="manual-thumb-placeholder"><SlideThumbnail t={props.t} workspaceDir={props.workspaceDir} pageId={item.pageId} title={item.title} version={item.previewVersion ?? item.pageId} /></div>
                <small>{item.title}</small>
              </button>
            ))}
          </div>
        ) : null}
      </aside>
      <main className="manual-editor-canvas-area">
          {toolbar}
        <div ref={canvasScrollRef} className="manual-editor-canvas-scroll">
          {loading ? (
            <div className="manual-editor-loading" role="status" aria-live="polite">
              <LoaderCircle size={30} aria-hidden="true" />
              <span>{t.loading}</span>
            </div>
          ) : null}
          {error ? <div className="manual-editor-error">{isInvokeTimeout(error) ? <ErrorNotice t={props.t} summary={props.t.errors.summaryInvokeTimeout} detail={error} /> : error}{saveStatus === "conflict" ? <button data-performance-id="manual-editor.conflict.reload" disabled={savingAll || loading} onClick={() => void reloadLatest()}>{t.reloadLatest}</button> : null}</div> : null}
          {fontNotice ? <div className={`manual-font-toast ${fontNotice.kind}`} role="status" aria-live="polite">
            {fontNotice.kind === "downloading" ? <LoaderCircle size={15} aria-hidden="true" /> : null}
            {fontNotice.message}
          </div> : null}
          {html ? (
            <div className="manual-editor-stage" style={{ width: SLIDE_WIDTH * scale, height: SLIDE_HEIGHT * scale }}>
              <iframe
                key={`${page?.pageId ?? "page"}:${iframeReloadEpoch}`}
                ref={iframeRef}
                title={page?.title ?? t.title}
                sandbox="allow-same-origin"
                srcDoc={html}
                onLoad={onIframeLoad}
                style={{ width: SLIDE_WIDTH, height: SLIDE_HEIGHT, transform: `scale(${scale})`, transformOrigin: "top left" }}
              />
              {hoverBox ? (
                <div
                  className="manual-editor-hover-outline"
                  style={{
                    left: hoverBox.left * scale,
                    top: hoverBox.top * scale,
                    width: hoverBox.width * scale,
                    height: hoverBox.height * scale,
                  }}
                />
              ) : null}
              {caretBox && textEditingTarget ? (
                <div
                  className="manual-editor-caret"
                  style={{
                    left: caretBox.left * scale,
                    top: caretBox.top * scale,
                    height: caretBox.height * scale,
                  }}
                />
              ) : null}
            </div>
          ) : null}
          {iframeDocument && svgTextEditingTarget ? createPortal(
            <input
              className="manual-editor-svg-text-input"
              autoFocus
              value={svgTextEditingValue}
              aria-label={t.editChartText}
              style={{
                position: "fixed",
                left: `${svgTextEditingTarget.getBoundingClientRect().left}px`,
                top: `${svgTextEditingTarget.getBoundingClientRect().top - 2}px`,
                width: `${Math.max(100, svgTextEditingTarget.getBoundingClientRect().width + 56)}px`,
                zIndex: 2147483647,
                minHeight: "28px",
                padding: "3px 6px",
                border: "1px solid #6366f1",
                borderRadius: "4px",
                outline: "2px solid rgba(99, 102, 241, 0.22)",
                background: "#fff",
                color: "#111827",
              }}
              onChange={(event) => setSvgTextEditingValue(event.target.value)}
              onBlur={() => finishSvgTextEdit(true)}
              onKeyDown={(event) => {
                if (event.key === "Enter") { event.preventDefault(); finishSvgTextEdit(true); }
                if (event.key === "Escape") { event.preventDefault(); finishSvgTextEdit(false); }
              }}
            />,
            iframeDocument.body,
          ) : null}
          {iframeDocument && selected && !cropSession && !svgTextEditingTarget ? createPortal(
            <>
            {isPromotableHtmlElement(selected) ? <button
              type="button"
              className={`${MOVEABLE_EDITOR_CLASS} manual-editor-move-handle`}
              aria-label={t.moveElement}
              data-editor-tooltip={t.moveElement}
              onPointerDown={startHandleMove}
              style={{ position: "absolute", left: `${outlineBox(selected).left}px`, top: `${Math.max(0, outlineBox(selected).top - 30 + frameTick * 0)}px`, zIndex: 2147483646, cursor: "grab" }}
            ><Move size={16} aria-hidden="true" /></button> : null}
            <Moveable
              ref={moveableRef}
              className={MOVEABLE_EDITOR_CLASS}
              target={selected}
              draggable
              resizable
              origin={false}
              keepRatio={false}
              renderDirections={["nw", "n", "ne", "e", "se", "s", "sw", "w"]}
              linePadding={8}
              controlPadding={8}
              throttleDrag={1}
              onDragStart={(event) => {
                if (isDoubleClickGesture(event)) {
                  event.stopDrag();
                  dragGestureRef.current = null;
                  return;
                }
                forgetHover();
                dragGestureRef.current = {
                  before: serializeDocument(iframeDocument),
                  startLeft: 0,
                  startTop: 0,
                  localScale: { x: 1, y: 1 },
                  moved: false,
                };
              }}
              onDrag={(event) => {
                const gesture = dragGestureRef.current;
                if (!gesture || !exceedsDragThreshold(event.dist, scale)) return;
                if (!isPromotableHtmlElement(event.target as HTMLElement)) return;
                if (!gesture.moved) {
                  promoteToAbsolute(event.target as HTMLElement);
                  if ((event.target as HTMLElement).tagName === "IMG") {
                    (event.target as HTMLElement).style.objectFit = "fill";
                    (event.target as HTMLElement).style.objectPosition = "50% 50%";
                  }
                  gesture.startLeft = Number.parseFloat(event.target.style.left || "0") || 0;
                  gesture.startTop = Number.parseFloat(event.target.style.top || "0") || 0;
                  gesture.localScale = measureLocalScale(event.target as HTMLElement);
                  gesture.moved = true;
                }
                // Moveable renders inside the editor iframe while the fit-zoom
                // transform lives on the iframe's wrapper in the parent
                // document, so event deltas are already iframe-document
                // pixels. Dividing by the fit scale amplified every write by
                // 1/scale; combined with Moveable's fixed-edge drag
                // compensation that feedback loop diverged once the min-size
                // clamp engaged and the element flew out of the slide.
                const dx = event.dist[0];
                const dy = event.dist[1];
                event.target.style.left = `${gesture.startLeft + dx / gesture.localScale.x}px`;
                event.target.style.top = `${gesture.startTop + dy / gesture.localScale.y}px`;
              }}
              onDragEnd={() => {
                const gesture = dragGestureRef.current;
                if (gesture?.moved) markMutation(gesture.before);
                dragGestureRef.current = null;
                forgetHover();
              }}
              onResizeStart={(event) => {
                if (isDoubleClickGesture(event)) {
                  event.stopAble();
                  resizeGestureRef.current = null;
                  return;
                }
                forgetHover();
                if (isPromotableHtmlElement(event.target as HTMLElement)) promoteToAbsolute(event.target as HTMLElement);
                // Align Moveable's internal size floor with the clamp the onResize
                // handler applies when writing styles. Without this, Moveable
                // clamps its own bounding size at 0 once the pointer crosses the
                // opposite edge, so its control box (and the element at fit-zoom)
                // collapses to nothing while the shell still writes 16px — the
                // selected box visually "disappears" mid-resize.
                event.setMin([RESIZE_MIN_SIZE_PX, RESIZE_MIN_SIZE_PX]);
                resizeGestureRef.current = {
                  before: serializeDocument(iframeDocument),
                  startLeft: 0,
                  startTop: 0,
                  startWidth: 0,
                  startHeight: 0,
                  localScale: { x: 1, y: 1 },
                  moved: false,
                };
                const target = event.target as HTMLElement;
                const gesture = resizeGestureRef.current;
                if (gesture) {
                  gesture.startLeft = Number.parseFloat(target.style.left || "0") || 0;
                  gesture.startTop = Number.parseFloat(target.style.top || "0") || 0;
                  gesture.startWidth = target.offsetWidth || target.getBoundingClientRect().width;
                  gesture.startHeight = target.offsetHeight || target.getBoundingClientRect().height;
                  gesture.localScale = measureLocalScale(target);
                }
              }}
              onResize={(event) => {
                const gesture = resizeGestureRef.current;
                if (!gesture) return;
                if (!isPromotableHtmlElement(event.target as HTMLElement)) return;
                const resizeDistance: [number, number] = [event.dist[0], event.dist[1]];
                const dragDistance: [number, number] = [event.drag.dist[0], event.drag.dist[1]];
                if (!exceedsDragThreshold(resizeDistance, scale) && !exceedsDragThreshold(dragDistance, scale)) return;
                if (!gesture.moved) {
                  promoteToAbsolute(event.target as HTMLElement);
                  gesture.startLeft = Number.parseFloat(event.target.style.left || "0") || 0;
                  gesture.startTop = Number.parseFloat(event.target.style.top || "0") || 0;
                  // Layout size, so an element with its own transform does not
                  // resize from its painted bounding box.
                  const box = event.target as HTMLElement;
                  gesture.startWidth = box.offsetWidth || box.getBoundingClientRect().width;
                  gesture.startHeight = box.offsetHeight || box.getBoundingClientRect().height;
                  gesture.localScale = measureLocalScale(event.target as HTMLElement);
                  gesture.moved = true;
                }
                // Deltas are already iframe-document pixels (see onDrag); only
                // the element's own ancestor scale needs dividing out.
                const dw = resizeDistance[0];
                const dh = resizeDistance[1];
                const dx = dragDistance[0];
                const dy = dragDistance[1];
                let nextWidth = Math.max(RESIZE_MIN_SIZE_PX, gesture.startWidth + dw / gesture.localScale.x);
                let nextHeight = Math.max(RESIZE_MIN_SIZE_PX, gesture.startHeight + dh / gesture.localScale.y);
                let nextLeft = gesture.startLeft + dx / gesture.localScale.x;
                let nextTop = gesture.startTop + dy / gesture.localScale.y;
                const direction = event.direction ?? [0, 0];
                const lockRatio = isEditableImage(event.target as HTMLElement) &&
                  Boolean(event.inputEvent?.shiftKey) &&
                  direction[0] !== 0 &&
                  direction[1] !== 0;
                if (lockRatio) {
                  const ratio = gesture.startWidth / gesture.startHeight;
                  const widthChange = Math.abs((nextWidth - gesture.startWidth) / gesture.startWidth);
                  const heightChange = Math.abs((nextHeight - gesture.startHeight) / gesture.startHeight);
                  if (widthChange >= heightChange) nextHeight = Math.max(RESIZE_MIN_SIZE_PX, nextWidth / ratio);
                  else nextWidth = Math.max(16, nextHeight * ratio);
                  nextLeft = direction[0] < 0
                    ? gesture.startLeft + gesture.startWidth - nextWidth
                    : gesture.startLeft;
                  nextTop = direction[1] < 0
                    ? gesture.startTop + gesture.startHeight - nextHeight
                    : gesture.startTop;
                }
                event.target.style.width = `${nextWidth}px`;
                event.target.style.height = `${nextHeight}px`;
                event.target.style.left = `${nextLeft}px`;
                event.target.style.top = `${nextTop}px`;
              }}
              onResizeEnd={() => {
                const gesture = resizeGestureRef.current;
                if (gesture?.moved) markMutation(gesture.before);
                resizeGestureRef.current = null;
                forgetHover();
              }}
            />
            </>,
            iframeDocument.body,
          ) : null}
          {iframeDocument && cropSession ? createPortal(
            <ManualImageCropOverlay
              session={cropSession}
              canvasScale={scale}
              onChange={(frame, source) => {
                const current = cropSessionRef.current;
                if (!current) return;
                const next = { ...current, frame, source };
                cropSessionRef.current = next;
                setCropSession(next);
              }}
            />,
            iframeDocument.body,
          ) : null}
        </div>
        <div className="manual-editor-status-bar">
          <div className="manual-editor-zoom-control">
            <button data-editor-tooltip={t.fitWindow} data-performance-id="manual-editor.zoom.fit" className={`manual-editor-btn ghost ${zoom === "fit" ? "active" : ""}`} onClick={() => setZoom("fit")}>{t.fitWindow}</button>
            <button data-performance-id="manual-editor.zoom.out" className="manual-editor-btn icon ghost" onClick={() => setZoom(Math.max(0.25, scale - 0.1))} data-editor-tooltip={t.zoomOut} aria-label={t.zoomOut}><ZoomOut size={15} /></button>
            <span>{Math.round(scale * 100)}%</span>
            <button data-performance-id="manual-editor.zoom.in" className="manual-editor-btn icon ghost" onClick={() => setZoom(Math.min(2, scale + 0.1))} data-editor-tooltip={t.zoomIn} aria-label={t.zoomIn}><ZoomIn size={15} /></button>
          </div>
          <div className={`manual-save-status ${effectiveSaveStatus}`}><span className="manual-save-dot" />{saveStatusLabel}</div>
          <button data-editor-tooltip={controls.save} data-performance-id="manual-editor.save" className="manual-editor-btn primary" onClick={() => void saveAll()} disabled={savingAll || loading || (saveStatus === "saved" && dirtyStashCount === 0)}><Save size={15} />{controls.save}</button>
        </div>
      </main>
      <ManualEditorTooltip containerRef={editorRef} iframeDocument={iframeDocument} />
      <input ref={fileInputRef} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) void handleImage(file); event.currentTarget.value = ""; }} />
      <input ref={fontInputRef} hidden type="file" accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2" onChange={(event) => { const file = event.target.files?.[0]; if (file) void handleFontUpload(file); event.currentTarget.value = ""; }} />
      {confirm ? (
        <div className="manual-editor-confirm-backdrop" role="presentation">
          <div
            className="manual-editor-confirm unsaved"
            role="dialog"
            aria-modal="true"
            aria-labelledby="manual-editor-confirm-title"
            aria-describedby="manual-editor-confirm-body"
          >
            <div className="manual-editor-confirm-header">
              <span className="manual-editor-confirm-icon" aria-hidden="true"><AlertTriangle size={18} /></span>
              <strong id="manual-editor-confirm-title">{t.unsavedConfirm.title}</strong>
            </div>
            <p id="manual-editor-confirm-body">{t.unsavedConfirm.body}</p>
              <div className="manual-editor-confirm-actions"><button type="button" data-performance-id="manual-editor.exit.cancel" disabled={savingAll || loading} onClick={() => void resolveConfirm("cancel")}>{t.unsavedConfirm.keepEditing}</button><button type="button" data-performance-id="manual-editor.exit.discard" className="danger" disabled={savingAll || loading} onClick={() => void resolveConfirm("discard")}>{t.unsavedConfirm.discard}</button><button type="button" data-performance-id="manual-editor.exit.save" className="primary" disabled={savingAll || loading} onClick={() => void resolveConfirm("save")}>{controls.save}</button></div>

          </div>
        </div>
      ) : null}
    </section>
  );
}
