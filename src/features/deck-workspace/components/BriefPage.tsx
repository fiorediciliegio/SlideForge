import { SLIDE_FORMATS, type SlideAspectRatio } from "../../../slideFormat";
import { ArrowRight, Check, ChevronDown, ChevronLeft, ChevronRight, FileText, Image as ImageIcon, ImageOff, Paperclip, RectangleHorizontal, RectangleVertical, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatMessage, type Messages } from "../../../i18n/messages";
import type {
  UploadedSourceMaterial,
  UploadedSourcePreflightResult,
  VisualStylePreset,
} from "../../../api/types";

const ATTACHMENT_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const REVERSED_ASPECT_RATIOS: Record<SlideAspectRatio, SlideAspectRatio> = {
  "16:9": "9:16", "9:16": "16:9", "4:3": "3:4", "3:4": "4:3",
};
const ATTACHMENT_MAX_IMAGES = 50;
const ATTACHMENT_SINGLE_FILE_MAX_BYTES = 25 * 1024 * 1024;
const ATTACHMENT_TOTAL_MAX_BYTES = 100 * 1024 * 1024;
const SUPPORTED_ATTACHMENT_EXTENSIONS = new Set([
  ".txt", ".md", ".doc", ".docx", ".xls", ".xlsx", ".csv", ".pdf",
  ".png", ".jpg", ".jpeg", ".webp", ".gif",
]);
const ATTACHMENT_ACCEPT = [
  ".txt", ".md", ".doc", ".docx", ".xls", ".xlsx", ".csv", ".pdf",
  ".png", ".jpg", ".jpeg", ".webp", ".gif",
  "application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif",
].join(",");

// Keep live iframe previews on the exact same rendering path as the static
// WebP generator: the source slide is 1920×1080, then is rendered into the
// 1280×720 preview coordinate space.  Scaling the 1920px document directly
// in the UI produces noticeably different font and fine-line rasterisation.
const VISUAL_STYLE_PREVIEW_WIDTH = 1280;
const VISUAL_STYLE_PREVIEW_HEIGHT = 720;
const VISUAL_STYLE_PREVIEW_SOURCE_SCALE = VISUAL_STYLE_PREVIEW_WIDTH / 1920;

function prepareVisualStylePresetIframePreview(frame: HTMLIFrameElement | null): void {
  const document = frame?.contentDocument;
  const root = document?.documentElement;
  const body = document?.body;
  const slide = document?.querySelector<HTMLElement>(".slide");
  if (!root || !body || !slide) return;

  root.style.setProperty("margin", "0", "important");
  root.style.setProperty("padding", "0", "important");
  root.style.setProperty("width", `${VISUAL_STYLE_PREVIEW_WIDTH}px`, "important");
  root.style.setProperty("height", `${VISUAL_STYLE_PREVIEW_HEIGHT}px`, "important");
  root.style.setProperty("overflow", "hidden", "important");
  body.style.setProperty("display", "block", "important");
  body.style.setProperty("margin", "0", "important");
  body.style.setProperty("padding", "0", "important");
  body.style.setProperty("width", `${VISUAL_STYLE_PREVIEW_WIDTH}px`, "important");
  body.style.setProperty("height", `${VISUAL_STYLE_PREVIEW_HEIGHT}px`, "important");
  body.style.setProperty("overflow", "hidden", "important");
  slide.style.setProperty("position", "absolute", "important");
  slide.style.setProperty("inset", "0 auto auto 0", "important");
  slide.style.setProperty("margin", "0", "important");
  slide.style.setProperty("transform-origin", "top left", "important");
  slide.style.setProperty("transform", `scale(${VISUAL_STYLE_PREVIEW_SOURCE_SCALE})`, "important");
}

function applyVisualStylePresetIframeColorOverrides(
  frame: HTMLIFrameElement | null,
  html: string,
  preset: VisualStylePreset,
): void {
  const root = frame?.contentDocument?.documentElement;
  if (!root) return;
  for (const [name, value] of Object.entries(getVisualStylePresetColorVariableOverrides(html, preset))) {
    root.style.setProperty(name, value);
  }
}

function isImageAttachment(source: UploadedSourceMaterial): boolean {
  return ATTACHMENT_IMAGE_EXTENSIONS.has(source.extension.toLowerCase()) || source.mime_type.startsWith("image/");
}

function fileTypeLabel(extension: string, mimeType: string): string {
  const normalizedExtension = extension.trim().replace(/^\./, "");
  if (normalizedExtension) return normalizedExtension.toUpperCase();

  const subtype = mimeType.trim().split("/").at(-1);
  return subtype ? subtype.toUpperCase() : "FILE";
}

interface PendingAttachment {
  id: number;
  name: string;
  extension: string;
  mimeType: string;
  image: boolean;
}

import {
  buildVisualStylePresetFilterOptions,
  createEmptyVisualStylePresetFilters,
  filterVisualStylePresets,
  VISUAL_STYLE_PRESET_FILTER_FIELDS,
  type VisualStylePresetFilters,
} from "../../templates/visualStylePresetFilters";
import {
  findVisualStylePreset,
  getVisualStylePresetColorVariableOverrides,
  getVisualStylePresetColorVariants,
  getVisualStylePresetFamilyId,
  isVisualStylePresetSelection,
  loadVisualStylePresetReferenceHtmlPages,
  resolveVisualStylePresetColorVariant,
} from "../../templates/visualStylePresets";
import type { LoadingKind } from "../types";

export interface BriefPageProps {
  t: Messages;
  prompt: string;
  aspectRatio?: SlideAspectRatio;
  onAspectRatioChange?: (value: SlideAspectRatio) => void;
  aspectRatioLocked?: boolean;
  setPrompt: (value: string) => void;
  loading: LoadingKind;
  generateDeck: () => Promise<void>;
  visualStylePresets: readonly VisualStylePreset[];
  selectedVisualStylePresetId: string | null;
  onSelectVisualStylePreset: (presetId: string | null) => void;
  uploadedSources: readonly UploadedSourceMaterial[];
  uploadedSourcePreflights: readonly UploadedSourcePreflightResult[];
  uploadUploadedSource: (file: File) => Promise<void>;
  removeUploadedSource: (uploadedSourceId: string) => Promise<void>;
  onForward?: () => void;
  onManageUserTemplates?: () => void;
}

function VisualStylePresetLiveCardPreview({
  preset,
  variantId,
  visible,
}: {
  preset: VisualStylePreset;
  variantId: string | null;
  visible: boolean;
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [activated, setActivated] = useState(false);
  const [ready, setReady] = useState(false);
  const [scale, setScale] = useState(0.2);
  const variantPreset = useMemo(
    () => resolveVisualStylePresetColorVariant(preset, variantId) ?? preset,
    [preset, variantId],
  );

  // Retain an opened preview, but do not load HTML/fonts for untouched cards.
  useEffect(() => {
    if (visible) setActivated(true);
  }, [visible]);

  useEffect(() => {
    if (!activated) return;
    let cancelled = false;
    void loadVisualStylePresetReferenceHtmlPages(preset, { applyColorVariant: false })
      .then((pages) => {
        if (!cancelled) setHtml(pages[0]?.html ?? null);
      })
      .catch(() => {
        if (!cancelled) setHtml(null);
      });
    return () => { cancelled = true; };
  }, [preset, activated]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const updateScale = () => setScale(host.clientWidth / VISUAL_STYLE_PREVIEW_WIDTH);
    updateScale();
    const observer = new ResizeObserver(updateScale);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!html || !ready) return;
    applyVisualStylePresetIframeColorOverrides(frameRef.current, html, variantPreset);
  }, [html, ready, variantPreset]);

  const handleLoad = () => {
    const frame = frameRef.current;
    const fonts = frame?.contentDocument?.fonts;
    void (fonts?.ready ?? Promise.resolve()).then(() => {
      if (frameRef.current !== frame || !html) return;
      prepareVisualStylePresetIframePreview(frame);
      applyVisualStylePresetIframeColorOverrides(frame, html, variantPreset);
      setReady(true);
    });
  };

  return (
    <span ref={hostRef} className={`brief-style-preset-live-preview ${visible && ready ? "ready" : ""}`} aria-hidden="true">
      {html ? (
        <iframe
          ref={frameRef}
          className="brief-style-preset-live-preview-frame"
          sandbox="allow-same-origin"
          srcDoc={html}
          title=""
          style={{ transform: `scale(${scale})` }}
          onLoad={handleLoad}
        />
      ) : null}
    </span>
  );
}

function VisualStylePresetLiveModalThumbnail({
  html,
  preset,
}: {
  html: string;
  preset: VisualStylePreset;
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const [ready, setReady] = useState(false);
  const [scale, setScale] = useState(0.075);

  useEffect(() => {
    setReady(false);
  }, [html]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const updateScale = () => setScale(host.clientWidth / VISUAL_STYLE_PREVIEW_WIDTH);
    updateScale();
    const observer = new ResizeObserver(updateScale);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!ready) return;
    applyVisualStylePresetIframeColorOverrides(frameRef.current, html, preset);
  }, [html, preset, ready]);

  const handleLoad = () => {
    const frame = frameRef.current;
    const fonts = frame?.contentDocument?.fonts;
    void (fonts?.ready ?? Promise.resolve()).then(() => {
      if (frameRef.current !== frame) return;
      prepareVisualStylePresetIframePreview(frame);
      applyVisualStylePresetIframeColorOverrides(frame, html, preset);
      setReady(true);
    });
  };

  return (
    <span ref={hostRef} className="template-preview-modal-thumb-live" aria-hidden="true">
      <iframe
        ref={frameRef}
        className={`template-preview-modal-thumb-live-frame ${ready ? "ready" : ""}`}
        sandbox="allow-same-origin"
        title=""
        srcDoc={html}
        style={{ transform: `scale(${scale})` }}
        onLoad={handleLoad}
      />
    </span>
  );
}

export function BriefPage({
  t,
  prompt,
  aspectRatio = "16:9", onAspectRatioChange, aspectRatioLocked = false,
  setPrompt,
  loading,
  generateDeck,
  visualStylePresets,
  selectedVisualStylePresetId,
  onSelectVisualStylePreset,
  uploadedSources,
  uploadedSourcePreflights,
  uploadUploadedSource,
  removeUploadedSource,
  onForward,
  onManageUserTemplates,
}: BriefPageProps) {
  const busy = loading !== "none";
  const landscape = SLIDE_FORMATS[aspectRatio].width > SLIDE_FORMATS[aspectRatio].height;
  const availableFormats = Object.entries(SLIDE_FORMATS).filter(([, size]) => (size.width > size.height) === landscape);
  const [submitting, setSubmitting] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [attachmentSelectionError, setAttachmentSelectionError] = useState("");
  const pendingAttachmentIdRef = useRef(0);
  const [preview, setPreview] = useState<{ preset: VisualStylePreset; index: number; variantId: string | null } | null>(null);
  const [previewImage, setPreviewImage] = useState<{
    requestedUrl: string;
    displayedUrl: string | null;
    loading: boolean;
  } | null>(null);
  const previewImageCacheRef = useRef(new Set<string>());
  const [previewHtmlPages, setPreviewHtmlPages] = useState<{ presetId: string; pages: readonly string[] } | null>(null);
  const [previewHtmlLoading, setPreviewHtmlLoading] = useState(false);
  const previewFrameRef = useRef<HTMLIFrameElement | null>(null);
  const previewFrameHostRef = useRef<HTMLDivElement | null>(null);
  const [previewFrameReady, setPreviewFrameReady] = useState(false);
  const [previewFrameScale, setPreviewFrameScale] = useState(0.4);
  const [brokenPreviewIds, setBrokenPreviewIds] = useState<string[]>([]);
  const [hoveredColorVariants, setHoveredColorVariants] = useState<Record<string, string | null>>({});
  const [presetFilters, setPresetFilters] = useState<VisualStylePresetFilters>(
    createEmptyVisualStylePresetFilters,
  );
  const [templateSource, setTemplateSource] = useState<"built-in" | "user">(() => selectedVisualStylePresetId?.startsWith("user-") ? "user" : "built-in");
  const filterOptions = useMemo(
    () => buildVisualStylePresetFilterOptions(visualStylePresets),
    [visualStylePresets],
  );
  const filteredPresets = useMemo(
    () => templateSource === "user" ? visualStylePresets.filter((preset) => preset.source === "user") : filterVisualStylePresets(visualStylePresets.filter((preset) => preset.source !== "user"), presetFilters),
    [templateSource, presetFilters, visualStylePresets],
  );
  const selectedPreset = useMemo(
    () => visualStylePresets.find((preset) => preset.id === selectedVisualStylePresetId) ?? findVisualStylePreset(selectedVisualStylePresetId),
    [selectedVisualStylePresetId, visualStylePresets],
  );
  const currentPreviewPreset = useMemo(() => preview
    ? resolveVisualStylePresetColorVariant(preview.preset, preview.variantId) ?? preview.preset
    : null, [preview]);
  const currentPreviewHasColorVariants = Boolean(
    currentPreviewPreset && getVisualStylePresetColorVariants(currentPreviewPreset).length > 1,
  );
  const currentPreviewHtml = preview && previewHtmlPages?.presetId === getVisualStylePresetFamilyId(preview.preset)
    ? previewHtmlPages.pages[preview.index] ?? null
    : null;
  // A local guard so the very first click already locks the composer, before the
  // Workspace or requirements request has had a chance to move `loading`.
  // Settings controls persist in the background with optimistic UI. They must
  // not freeze each other or the whole composer while a Cloud RPC is in flight.
  // Attachment upload does not require the user to stop editing the Brief.
  // Deck creation remains blocked until every attachment has been committed.
  const nonUploadBusy = busy && loading !== "upload";
  const attachmentUploadPending = pendingAttachments.length > 0;
  const submitBlocked = nonUploadBusy || submitting || attachmentUploadPending;

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageCount = useMemo(
    // In-flight image uploads count too, so rapid consecutive file picks
    // cannot slip past the image cap before the previous commits land.
    () => uploadedSources.filter(isImageAttachment).length
      + pendingAttachments.filter((item) => item.image).length,
    [pendingAttachments, uploadedSources],
  );
  const imageLimitReached = imageCount >= ATTACHMENT_MAX_IMAGES;
  const failedAttachmentIds = useMemo(
    () => new Set(
      uploadedSourcePreflights
        .filter((result) => result.content_strategy === null)
        .map((result) => result.source_id),
    ),
    [uploadedSourcePreflights],
  );

  // Preview images are served by the host and can take a few seconds on Cloud.
  // Keep the last decoded image in the frame until the requested one is ready:
  // changing a page must never look like the app navigated away or refreshed.
  useEffect(() => {
    const url = currentPreviewPreset?.preview_images[preview?.index ?? 0]?.url;
    if (!url) {
      setPreviewImage(null);
      return;
    }
    let cancelled = false;
    const decoded = previewImageCacheRef.current.has(url);
    setPreviewImage((current) => current?.requestedUrl === url
      ? current
      : { requestedUrl: url, displayedUrl: decoded ? url : current?.displayedUrl ?? null, loading: !decoded });
    if (decoded) return;

    const image = new Image();
    image.onload = () => {
      if (!cancelled) setPreviewImage((current) => current?.requestedUrl === url
        ? { requestedUrl: url, displayedUrl: url, loading: false }
        : current);
      previewImageCacheRef.current.add(url);
    };
    image.onerror = () => {
      if (!cancelled) setPreviewImage((current) => current?.requestedUrl === url
        ? { ...current, loading: false }
        : current);
    };
    image.src = url;

    // The normal next/previous action should be instant when bandwidth allows.
    for (const offset of [-1, 1]) {
      const neighbour = currentPreviewPreset?.preview_images[(preview?.index ?? 0) + offset]?.url;
      if (neighbour) {
        const preload = new Image();
        preload.onload = () => previewImageCacheRef.current.add(neighbour);
        preload.src = neighbour;
      }
    }
    return () => { cancelled = true; };
  }, [preview?.index, currentPreviewPreset]);

  useEffect(() => {
    if (!currentPreviewPreset || !preview || !currentPreviewHasColorVariants) {
      setPreviewHtmlPages(null);
      setPreviewHtmlLoading(false);
      setPreviewFrameReady(false);
      return;
    }
    let cancelled = false;
    setPreviewHtmlPages(null);
    setPreviewHtmlLoading(true);
    setPreviewFrameReady(false);
    const familyId = getVisualStylePresetFamilyId(preview.preset);
    void loadVisualStylePresetReferenceHtmlPages(preview.preset, { applyColorVariant: false })
      .then((pages) => {
        if (!cancelled) setPreviewHtmlPages({ presetId: familyId, pages: pages.map((page) => page.html) });
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setPreviewHtmlLoading(false);
      });
    return () => { cancelled = true; };
  // Intentionally exclude the selected colour variant: it is applied to the
  // live document below, rather than causing the iframe to be replaced.
  }, [currentPreviewHasColorVariants, preview?.preset]);

  useEffect(() => {
    if (!currentPreviewHtml || !currentPreviewPreset || !previewFrameReady) return;
    applyVisualStylePresetIframeColorOverrides(previewFrameRef.current, currentPreviewHtml, currentPreviewPreset);
  }, [currentPreviewHtml, currentPreviewPreset, previewFrameReady]);

  useEffect(() => {
    // A new `srcDoc` replaces the iframe document but not the React ref. Reset
    // readiness before its load event, so the new page cannot inherit the old
    // page's ready state and skip selected-palette injection.
    setPreviewFrameReady(false);
  }, [currentPreviewHtml]);

  useEffect(() => {
    const host = previewFrameHostRef.current;
    if (!host) return;
    // `getBoundingClientRect()` includes the modal's entrance transform.  That
    // made the initial iframe about 1.5% too small while the card animated
    // from scale(.985), and ResizeObserver does not fire when only a transform
    // changes.  The layout width is stable throughout the animation.
    const updateScale = () => setPreviewFrameScale(host.clientWidth / VISUAL_STYLE_PREVIEW_WIDTH);
    updateScale();
    const observer = new ResizeObserver(updateScale);
    observer.observe(host);
    return () => observer.disconnect();
  }, [preview]);

  const handlePreviewFrameLoad = () => {
    const frame = previewFrameRef.current;
    const html = currentPreviewHtml;
    const preset = currentPreviewPreset;
    const fonts = frame?.contentDocument?.fonts;
    void (fonts?.ready ?? Promise.resolve()).then(() => {
      if (previewFrameRef.current !== frame || !html || !preset) return;
      prepareVisualStylePresetIframePreview(frame);
      applyVisualStylePresetIframeColorOverrides(frame, html, preset);
      setPreviewFrameReady(true);
    });
  };

  function selectPreviewPage(index: number) {
    // Keep the static preview underneath while the replacement iframe loads.
    // This is synchronous with the page-selection update, unlike an effect
    // which would briefly expose the replacement document's base palette.
    setPreviewFrameReady(false);
    setPreview((current) => current ? { ...current, index } : current);
  }

  async function handleAttachmentSelection(files: FileList | null) {
    if (!files || files.length === 0) return;
    setAttachmentSelectionError("");
    let remainingImageSlots = ATTACHMENT_MAX_IMAGES - imageCount;
    const acceptedFiles: Array<{ file: File; pending: PendingAttachment }> = [];
    for (const file of Array.from(files)) {
      const dot = file.name.lastIndexOf(".");
      const extension = dot >= 0 ? file.name.slice(dot).toLowerCase() : "";
      if (!SUPPORTED_ATTACHMENT_EXTENSIONS.has(extension)) {
        setAttachmentSelectionError(t.brief.attachments.unsupported);
        continue;
      }
      const isImage = ATTACHMENT_IMAGE_EXTENSIONS.has(extension) || file.type.startsWith("image/");
      if (isImage) {
        if (remainingImageSlots <= 0) continue; // enforce the ≤50 image cap
        remainingImageSlots -= 1;
      }
      acceptedFiles.push({
        file,
        pending: {
          id: pendingAttachmentIdRef.current++,
          name: file.name,
          extension,
          mimeType: file.type,
          image: isImage,
        },
      });
    }

    if (acceptedFiles.length === 0) return;
    if (acceptedFiles.some(({ file }) => file.size > ATTACHMENT_SINGLE_FILE_MAX_BYTES)) {
      setAttachmentSelectionError(t.brief.attachments.fileTooLarge);
      return;
    }
    const activeAttachmentBytes = uploadedSources.reduce((sum, source) => sum + source.size_bytes, 0);
    const selectedAttachmentBytes = acceptedFiles.reduce((sum, { file }) => sum + file.size, 0);
    if (activeAttachmentBytes + selectedAttachmentBytes > ATTACHMENT_TOTAL_MAX_BYTES) {
      setAttachmentSelectionError(t.brief.attachments.totalSizeExceeded);
      return;
    }

    setPendingAttachments((current) => [...current, ...acceptedFiles.map(({ pending }) => pending)]);
    await Promise.all(acceptedFiles.map(async ({ file, pending }) => {
      try {
        await uploadUploadedSource(file);
      } catch {
        // The normal limit paths are handled before Host Upload begins. This is
        // a final guard for stale state or a backend-side rejection.
        setAttachmentSelectionError(t.brief.attachments.uploadFailed);
      } finally {
        setPendingAttachments((current) => current.filter((item) => item.id !== pending.id));
      }
    }));
  }

  async function submitBrief() {
    if (submitBlocked || !prompt.trim()) return;
    setSubmitting(true);
    try {
      await generateDeck();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="page active brief-page">
      <h1 className="prompt-label">{t.brief.title}</h1>
      <div className="prompt-input-wrapper">
        {uploadedSources.length > 0 || pendingAttachments.length > 0 ? (
          <div className="brief-attachments" aria-label={t.brief.attachments.heading}>
            {uploadedSources.map((source) => {
              const image = isImageAttachment(source);
              const failed = failedAttachmentIds.has(source.uploaded_source_id);
              return (
                <span className={`brief-attachment-chip${failed ? " failed" : ""}`} key={source.uploaded_source_id} title={source.original_filename}>
                  <span className="brief-attachment-icon" aria-hidden="true">
                    {image ? <ImageIcon size={14} /> : <FileText size={14} />}
                  </span>
                  <span className="brief-attachment-name">{source.display_name || source.original_filename}</span>
                  <span className="brief-attachment-type">{fileTypeLabel(source.extension, source.mime_type)}</span>
                  {failed ? <span className="brief-attachment-failed">{t.brief.uploadedSourceStatus.error}</span> : null}
                  <button
                    data-performance-id="brief.attachment.remove"
                    type="button"
                    className="brief-attachment-remove"
                    aria-label={t.brief.attachments.remove}
                    disabled={nonUploadBusy || attachmentUploadPending}
                    onClick={() => void removeUploadedSource(source.uploaded_source_id)}
                  >
                    <X size={12} />
                  </button>
                </span>
              );
            })}
            {pendingAttachments.map((attachment) => (
              <span className="brief-attachment-chip pending" key={`pending-${attachment.id}`} title={attachment.name}>
                <span className="brief-attachment-icon" aria-hidden="true">
                  {attachment.image ? <ImageIcon size={14} /> : <FileText size={14} />}
                </span>
                <span className="brief-attachment-name">{attachment.name}</span>
                <span className="brief-attachment-type">{fileTypeLabel(attachment.extension, attachment.mimeType)}</span>
                <span className="brief-attachment-uploading"><span className="spinner small" aria-hidden="true" />{t.brief.attachments.uploading}</span>
              </span>
            ))}
          </div>
        ) : null}
        {attachmentSelectionError ? <p className="brief-preflight-error" role="alert">{attachmentSelectionError}</p> : null}
        <textarea
          className="prompt-input"
          id="deck-brief-prompt"
          name="deck-brief-prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={t.brief.placeholder}
          disabled={nonUploadBusy}
        />
        <div className="prompt-inline-actions">
          <div className="brief-page-format" title={aspectRatioLocked ? t.brief.pageSizeLocked : t.brief.pageSizeHelp}>
            <div className="brief-page-orientation" role="group" aria-label={t.brief.pageOrientation}>
              <button
                type="button"
                aria-pressed={landscape}
                disabled={submitBlocked || aspectRatioLocked}
                onClick={() => { if (!landscape) onAspectRatioChange?.(REVERSED_ASPECT_RATIOS[aspectRatio]); }}
              >
                <RectangleHorizontal size={16} aria-hidden="true" />
                {t.brief.landscape}
              </button>
              <button
                type="button"
                aria-pressed={!landscape}
                disabled={submitBlocked || aspectRatioLocked}
                onClick={() => { if (landscape) onAspectRatioChange?.(REVERSED_ASPECT_RATIOS[aspectRatio]); }}
              >
                <RectangleVertical size={16} aria-hidden="true" />
                {t.brief.portrait}
              </button>
            </div>
            <span className="brief-page-ratio-select">
              <select
                aria-label={t.brief.pageAspectRatio}
                value={aspectRatio}
                disabled={submitBlocked || aspectRatioLocked}
                onChange={(event) => onAspectRatioChange?.(event.target.value as SlideAspectRatio)}
              >
                {availableFormats.map(([ratio]) => <option key={ratio} value={ratio}>{ratio}</option>)}
              </select>
              <ChevronDown size={14} aria-hidden="true" />
            </span>
          </div>
          <div className="prompt-inline-buttons">
            <button
              data-performance-id="brief.attachment.add"
              className="inline-attach-btn"
              type="button"
              disabled={submitBlocked}
              title={imageLimitReached ? t.brief.attachments.imageLimitReached : t.brief.attachments.hint}
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip size={14} aria-hidden="true" />
              {t.brief.attachments.add}
            </button>
            <button
              data-performance-id="brief.create-deck"
              className="inline-create-btn"
              type="button"
              disabled={submitBlocked || !prompt.trim()}
              aria-busy={submitBlocked}
              onClick={() => void submitBrief()}
            >
              {submitBlocked
                ? <span className="spinner small" aria-hidden="true" />
                : <Sparkles size={14} aria-hidden="true" />}
              {t.controls.createDeck}
            </button>
          </div>
        </div>
        <input
          ref={fileInputRef}
          hidden
          type="file"
          multiple
          accept={ATTACHMENT_ACCEPT}
          onChange={(event) => {
            void handleAttachmentSelection(event.target.files);
            event.currentTarget.value = "";
          }}
        />
      </div>

      <section className="brief-style-presets" aria-labelledby="brief-style-presets-title">
        <div className="brief-style-presets-heading">
          <div>
            <h2 id="brief-style-presets-title">{t.template.title}</h2>
            <p>{t.template.helper}</p>
          </div>
          <span className="brief-style-presets-note">{selectedVisualStylePresetId ? t.template.selected : t.template.noneSelected}</span>
        </div>
        <div className="user-template-tabs" role="group" aria-label={t.template.title}>
          <button type="button" aria-pressed={templateSource === "built-in"} className={templateSource === "built-in" ? "active" : ""} onClick={() => setTemplateSource("built-in")}>{t.userTemplates.builtIn}</button>
          <button type="button" aria-pressed={templateSource === "user"} className={templateSource === "user" ? "active" : ""} onClick={() => setTemplateSource("user")}>{t.userTemplates.title}</button>
          {onManageUserTemplates ? <button type="button" className="user-template-manage" onClick={onManageUserTemplates}>{t.userTemplates.manage}</button> : null}
        </div>
        {templateSource === "built-in" ? <div className="brief-style-preset-filters" role="group" aria-label={t.template.filtersLabel}>
          {VISUAL_STYLE_PRESET_FILTER_FIELDS.map((field) => (
            <label className={`brief-style-preset-filter ${presetFilters[field] ? "active" : ""}`} key={field}>
              <span>{t.template.filters[field]}</span>
              <select
                value={presetFilters[field]}
                disabled={nonUploadBusy}
                title={presetFilters[field] || t.template.all}
                onChange={(event) => setPresetFilters((current) => ({ ...current, [field]: event.target.value }))}
              >
                <option value="">{t.template.all}</option>
                {filterOptions[field].map((option) => (
                  <option value={option} key={option}>{(t.template.filterValues[field as "user" | "use_case" | "industry" | "theme" | "color"] as Record<string, string> | undefined)?.[option] ?? option}</option>
                ))}
              </select>
              <ChevronDown className="brief-style-preset-filter-chevron" size={14} aria-hidden="true" />
            </label>
          ))}
        </div> : null}
        {templateSource === "user" && !filteredPresets.length ? <p>{t.userTemplates.empty}</p> : null}
        <div className="brief-style-preset-grid">
          {/* The "no preset" card keeps its visible label: HOME-004 only covers
              ordinary Visual Style Preset cards, and its final form is still an
              open product question. */}
          <button
            data-performance-id="brief.visual-style.clear"
            type="button"
            className={`brief-style-preset-card brief-style-preset-none-card ${!selectedVisualStylePresetId ? "active" : ""}`}
            disabled={nonUploadBusy}
            aria-pressed={!selectedVisualStylePresetId}
            onClick={() => onSelectVisualStylePreset(null)}
          >
            <span className="brief-style-preset-none-mark" aria-hidden="true">
              <svg viewBox="0 0 640 360" role="presentation">
                <rect x="80" y="62" width="480" height="236" rx="10" fill="#f8f9fb" stroke="#d8dce5" />
                <rect x="112" y="96" width="184" height="12" rx="6" fill="#d9dde7" />
                <rect x="112" y="126" width="276" height="8" rx="4" fill="#e4e7ee" />
                {/* The card title sits over this band, so the blocks stay fainter
                    than the rest of the illustration. */}
                <g className="brief-style-preset-none-blocks">
                  <rect x="112" y="184" width="124" height="64" rx="8" fill="#eef0f5" />
                  <rect x="252" y="184" width="124" height="64" rx="8" fill="#f1f3f7" />
                  <rect x="392" y="184" width="124" height="64" rx="8" fill="#ebeef4" />
                </g>
                <path d="M112 278H516" stroke="#e0e3ea" strokeLinecap="round" />
                <circle cx="510" cy="112" r="8" fill="#c9ceda" />
              </svg>
              {!selectedVisualStylePresetId ? (
                <span className="brief-style-preset-none-selection"><Check size={15} /></span>
              ) : null}
            </span>
            <span className="brief-style-preset-none-copy">
              <strong>{t.template.none}</strong>
            </span>
          </button>
          {filteredPresets.map((preset: VisualStylePreset) => {
            const selected = selectedPreset !== null && getVisualStylePresetFamilyId(selectedPreset) === getVisualStylePresetFamilyId(preset);
            const cover = preset.preview_images[0];
            const coverBroken = brokenPreviewIds.includes(preset.id);
            const colorVariants = getVisualStylePresetColorVariants(preset);
            const defaultVariantId = colorVariants[0]?.id ?? null;
            const selectedVariantId = selected
              ? selectedPreset?.selected_color_variant?.id ?? defaultVariantId
              : defaultVariantId;
            const hoveredVariantId = hoveredColorVariants[preset.id] ?? null;
            const cardVariantId = hoveredVariantId ?? selectedVariantId;
            const showLiveColorPreview = colorVariants.length > 1
              && (hoveredVariantId !== null || (selected && selectedVariantId !== defaultVariantId));
            return (
              <article
                className={`brief-style-preset-card ${selected ? "active" : ""} ${colorVariants.length > 1 ? "has-color-variants" : ""}`}
                key={preset.id}
                onPointerLeave={() => setHoveredColorVariants((current) => ({ ...current, [preset.id]: null }))}
              >
                <span className="brief-style-preset-image-wrap">
                  {coverBroken || !cover ? (
                    <span className="brief-style-preset-image-fallback" aria-hidden="true">
                      <ImageOff size={20} />
                    </span>
                  ) : (
                    <img
                      src={cover.url}
                      alt=""
                      loading="lazy"
                      onError={() => setBrokenPreviewIds((current) =>
                        current.includes(preset.id) ? current : [...current, preset.id])}
                    />
                  )}
                  {colorVariants.length > 1 ? (
                    <VisualStylePresetLiveCardPreview
                      preset={preset}
                      variantId={cardVariantId}
                      visible={showLiveColorPreview}
                    />
                  ) : null}
                </span>
                <button
                  data-performance-id="brief.visual-style.preview"
                  type="button"
                  className="brief-style-preset-select"
                  disabled={nonUploadBusy}
                  aria-haspopup="dialog"
                  onClick={() => setPreview({ preset, index: 0, variantId: selectedVariantId })}
                >
                  <span className="brief-style-preset-accessible-name">{preset.name}</span>
                </button>
                {colorVariants.length > 1 ? (
                  <>
                    <span className="brief-style-preset-color-count" aria-label={formatMessage(t.template.colorVariantCount, { count: colorVariants.length })}>{formatMessage(t.template.colorVariantCount, { count: colorVariants.length })}</span>
                    <span className="brief-style-preset-color-choices" aria-label={`${preset.name}: ${t.template.filters.color}`}>
                    {colorVariants.map((variant) => {
                      const variantPreset = resolveVisualStylePresetColorVariant(preset, variant.id) ?? preset;
                      return (
                        <button
                          type="button"
                          className={`brief-style-preset-color-choice ${isVisualStylePresetSelection(selectedVisualStylePresetId, variantPreset) ? "active" : ""}`}
                          key={variant.id}
                          title={variant.name}
                          aria-label={`${preset.name}: ${variant.name}`}
                          disabled={nonUploadBusy}
                          onPointerEnter={() => setHoveredColorVariants((current) => ({ ...current, [preset.id]: variant.id }))}
                          onFocus={() => setHoveredColorVariants((current) => ({ ...current, [preset.id]: variant.id }))}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            setPreview({ preset, index: 0, variantId: variant.id });
                          }}
                        >
                          {variant.swatches.map((color) => <i key={color} style={{ backgroundColor: color }} />)}
                        </button>
                      );
                    })}
                    </span>
                  </>
                ) : null}
                {selected ? (
                  <span className="brief-style-preset-selected" aria-hidden="true"><Check size={14} /></span>
                ) : null}
              </article>
            );
          })}
          {filteredPresets.length === 0 ? (
            <p className="brief-style-preset-empty">{t.template.noFilterMatches}</p>
          ) : null}
        </div>
      </section>

      {onForward ? (
        <div className="stage-navigation stage-navigation-end">
          <button data-performance-id="brief.forward" className="secondary-btn" type="button" onClick={onForward} disabled={nonUploadBusy}>
            {t.controls.forward}<ArrowRight size={16} aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {preview && currentPreviewPreset ? (
        <div
          className="template-preview-modal"
          role="dialog"
          aria-modal="true"
          aria-label={currentPreviewPreset.name}
          onClick={(event) => {
            // Do not rely on bubbling semantics across the SlideForge event bridge:
            // only a click that starts on the backdrop may dismiss the modal.
            if (event.target === event.currentTarget) setPreview(null);
          }}
        >
          <section className={`template-preview-modal-card ${currentPreviewHasColorVariants ? "has-color-variants" : ""}`}>
            <header className="template-preview-modal-header">
              <div className="template-preview-modal-title"><h2>{currentPreviewPreset.name}</h2><span>{currentPreviewPreset.description}</span></div>
              <button data-performance-id="brief.visual-style.preview.close" type="button" className="template-preview-modal-close" aria-label={t.template.close} onClick={() => setPreview(null)}><X size={17} /></button>
            </header>
            {getVisualStylePresetColorVariants(currentPreviewPreset).length > 1 ? (
              <div className="template-preview-modal-colors" role="group" aria-label={`${currentPreviewPreset.name}: ${t.template.filters.color}`}>
                <strong>{t.template.filters.color}</strong>
                <span>
                  {getVisualStylePresetColorVariants(currentPreviewPreset).map((variant) => (
                    <button
                      type="button"
                      key={variant.id}
                      className={preview.variantId === variant.id ? "active" : ""}
                      aria-pressed={preview.variantId === variant.id}
                      onClick={() => setPreview((current) => current ? { ...current, variantId: variant.id } : current)}
                    >
                      <span aria-hidden="true">{variant.swatches.map((color) => <i key={color} style={{ backgroundColor: color }} />)}</span>
                      {variant.name}
                    </button>
                  ))}
                </span>
              </div>
            ) : null}
            <div className="template-preview-modal-stage">
              <button data-performance-id="brief.visual-style.preview.previous" type="button" className="template-preview-modal-nav" aria-label={t.template.previous} disabled={preview.index === 0} onClick={(event) => { event.preventDefault(); event.stopPropagation(); selectPreviewPage(Math.max(0, preview.index - 1)); }}><ChevronLeft size={18} /></button>
              <div ref={previewFrameHostRef} className="template-preview-modal-frame">
                {previewImage?.displayedUrl ? <img src={previewImage.displayedUrl} alt={currentPreviewPreset.preview_images[preview.index]?.alt ?? currentPreviewPreset.name} /> : null}
                {currentPreviewHtml ? (
                  <iframe
                    key={`${getVisualStylePresetFamilyId(preview.preset)}:${preview.index}`}
                    ref={previewFrameRef}
                    className={`template-preview-modal-live-frame ${previewFrameReady ? "ready" : ""}`}
                    sandbox="allow-same-origin"
                    title={currentPreviewPreset.name}
                    srcDoc={currentPreviewHtml}
                    style={{ transform: `scale(${previewFrameScale})` }}
                    onLoad={handlePreviewFrameLoad}
                  />
                ) : null}
                {previewImage?.loading || previewHtmlLoading || (currentPreviewHasColorVariants && !previewFrameReady) ? <span className="template-preview-modal-loading" aria-live="polite"><span className="spinner small" /></span> : null}
                <span className="template-preview-modal-counter">{preview.index + 1} / {currentPreviewPreset.preview_images.length}</span>
              </div>
              <button data-performance-id="brief.visual-style.preview.next" type="button" className="template-preview-modal-nav" aria-label={t.template.next} disabled={preview.index >= currentPreviewPreset.preview_images.length - 1} onClick={(event) => { event.preventDefault(); event.stopPropagation(); selectPreviewPage(Math.min(currentPreviewPreset.preview_images.length - 1, preview.index + 1)); }}><ChevronRight size={18} /></button>
            </div>
            <div className="template-preview-modal-thumbs" role="tablist" aria-label={t.template.previewTitle}>
              {currentPreviewPreset.preview_images.map((image, index) => (
                <button
                  type="button"
                  role="tab"
                  key={image.url}
                  className={`template-preview-modal-thumb ${preview.index === index ? "active" : ""}`}
                  aria-selected={preview.index === index}
                  aria-label={`${t.template.previewTitle} ${index + 1}`}
                  onClick={() => selectPreviewPage(index)}
                >
                  <img src={image.url} alt={image.alt ?? `${currentPreviewPreset.name} ${index + 1}`} />
                  {currentPreviewHasColorVariants && previewHtmlPages?.presetId === getVisualStylePresetFamilyId(preview.preset) && previewHtmlPages.pages[index] ? (
                    <VisualStylePresetLiveModalThumbnail
                      html={previewHtmlPages.pages[index]}
                      preset={currentPreviewPreset}
                    />
                  ) : null}
                </button>
              ))}
            </div>
            <footer className="template-preview-modal-footer">
              <span className="template-preview-modal-layout-name">{currentPreviewPreset.selected_color_variant?.name ?? t.template.previewTitle}</span>
              <button
                data-performance-id="brief.visual-style.preview.use"
                type="button"
                className="template-use-btn"
                disabled={nonUploadBusy || isVisualStylePresetSelection(selectedVisualStylePresetId, currentPreviewPreset)}
                onClick={() => { onSelectVisualStylePreset(currentPreviewPreset.id); setPreview(null); }}
              >
                {isVisualStylePresetSelection(selectedVisualStylePresetId, currentPreviewPreset) ? <Check size={14} /> : null}
                {isVisualStylePresetSelection(selectedVisualStylePresetId, currentPreviewPreset) ? t.template.selected : t.controls.useTemplate}
              </button>
            </footer>
          </section>
        </div>
      ) : null}

    </section>
  );
}

export function ThinkingStatusText({ text, active = false, showOrb = false }: { text: string; active?: boolean; showOrb?: boolean }) {
  return <span className={`thinking-status-text ${active ? "active" : ""}`}>{showOrb ? <i /> : null}{text}</span>;
}
