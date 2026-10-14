import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CheckCircle2, Copy, GripVertical, MoreHorizontal, Pencil, Plus, RefreshCw, Save, Sparkles, Trash2 } from "lucide-react";
import type { OutlineDetail } from "../../../data/mockDeck";
import type { Messages } from "../../../i18n/messages";
import { cloneOutlineItems, type EditableOutline } from "../../outline/model";
import { mergeOutlineImageAssets, type OutlineImageAsset } from "../../outline/images";
import { ProcessPanel } from "../../process-progress/ProcessProgress";
import type { ProcessStep } from "../../process-progress/model";
import type { LoadingKind } from "../types";
import { ErrorNotice } from "./ErrorNotice";
import { OutlineCardImages } from "./OutlineCardImages";
import { OutlineImagePicker } from "./OutlineImages";
import { OutlinePageDetails } from "./OutlinePageDetails";
import { OutlineRewriteDialog } from "./OutlineRewriteDialog";

interface OutlinePageProps {
  imageLibrary?: import("../../outline/imageLibrary").OutlineImageLibraryService | null;
  imageUpload?: import("../../page-image-upload/service").PageImageUploadService | null;
  pageImageSearch: import("../../page-image-search/service").PageImageSearchService | null;
  workspaceKey: string;
  loadImages: () => Promise<OutlineImageAsset[]>;
  loadImagePreview: (id: string, size?: "thumbnail" | "large") => Promise<string>;
  t: Messages;
  progress?: ProcessStep[];
  title: string;
  globalRequirements: string;
  setGlobalRequirements: (value: string) => void;
  outline: OutlineDetail[];
  dirty: boolean;
  saving: boolean;
  error: string;
  errorDetail?: string;
  loading: LoadingKind;
  setTitle: (value: string) => void;
  replaceItems: (items: OutlineDetail[]) => void;
  feedback: string;
  setFeedback: (value: string) => void;
  applyFeedback: () => Promise<EditableOutline | undefined>;
  save: (value?: EditableOutline) => Promise<boolean>;
  retry: () => Promise<void>;
  backToRequirements: () => void;
  forward?: () => void;
  confirm: () => Promise<void>;
}

export function OutlinePage(props: OutlinePageProps) {
  // 工作区切换时销毁未提交的详情、配图选择和 AI 预览。
  return <OutlineReview key={props.workspaceKey} {...props} />;
}

function OutlineReview(props: OutlinePageProps) {
  const { t, title, outline, loading, saving, error, errorDetail } = props;
  const [images, setImages] = useState<OutlineImageAsset[]>([]);
  const [addedImages, setAddedImages] = useState<OutlineImageAsset[]>([]);
  const assets = useMemo(() => mergeOutlineImageAssets(images, addedImages), [images, addedImages]);
  const [imageLoading, setImageLoading] = useState(true);
  const [imageError, setImageError] = useState(false);
  const [imageRetry, setImageRetry] = useState(0);
  const [detailsIndex, setDetailsIndex] = useState<number | null>(null);
  const [imagePickerIndex, setImagePickerIndex] = useState<number | null>(null);
  const [rewriteOpen, setRewriteOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [menuIndex, setMenuIndex] = useState<number | null>(null);
  const [menuAbove, setMenuAbove] = useState(false);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const dragRef = useRef<number | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const menu = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const creating = !saving && (loading === "outline" || loading === "uploadedSourceAnalysis");
  const busy = loading !== "none" || saving;
  const progressHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (creating) progressHeading.current?.scrollIntoView({ block: "start" }); }, [creating]);
  const loadPreview = useMemo(() => {
    const cache = new Map<string, Promise<string>>();
    return (id: string, size: "thumbnail" | "large" = "thumbnail") => {
      const key = `${id}:${size}`;
      let promise = cache.get(key);
      if (!promise) {
        promise = props.loadImagePreview(id, size).then((url) => { if (!url.startsWith("data:")) cache.delete(key); return url; }).catch((error) => { cache.delete(key); throw error; });
        cache.set(key, promise);
      }
      return promise;
    };
  }, [props.loadImagePreview, imageRetry]);
  useEffect(() => {
    let active = true;
    setImageLoading(true); setImageError(false);
    if (loading !== "none") return () => { active = false; };
    void props.loadImages().then((assets) => { if (active) setImages(assets); }, () => { if (active) setImageError(true); })
      .finally(() => { if (active) setImageLoading(false); });
    return () => { active = false; };
  }, [props.loadImages, loading, imageRetry]);
  useEffect(() => {
    if (busy) { setMenuIndex(null); setDrag(null); dragRef.current = null; }
  }, [busy]);
  useEffect(() => {
    if (menuIndex === null) return;
    function dismiss(event: PointerEvent) {
      if (!menu.current?.contains(event.target as Node)) setMenuIndex(null);
    }
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [menuIndex]);

  function movePage(from: number, to: number, focus = false) {
    if (busy || from === to || to < 0 || to >= outline.length || !outline[from]) return;
    const next = cloneOutlineItems(outline);
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    props.replaceItems(next);
    setMenuIndex(null);
    setAnnouncement(t.outlineReview.pageMoved.replace("{title}", item!.title).replace("{page}", String(to + 1)));
    if (focus) requestAnimationFrame(() => list.current?.querySelector<HTMLButtonElement>(`[data-outline-page="${to}"] .outline-drag-handle`)?.focus());
  }
  function insertPage(index: number, copy?: OutlineDetail) {
    if (busy) return;
    const next = cloneOutlineItems(outline);
    const item: OutlineDetail = copy ? { ...cloneOutlineItems([copy])[0]!, selected_image_ids: [] } : {
      page_type: "standard", title: t.outline.newPageTitle,
      content: t.outline.newPageContent, title_segments: [{ text: t.outline.newPageTitle, source: "user", focus: false }],
    };
    next.splice(index, 0, item);
    props.replaceItems(next);
    setMenuIndex(null);
    setDetailsIndex(index);
  }
  function deletePage(index: number) {
    if (busy || outline.length <= 1) return;
    props.replaceItems(cloneOutlineItems(outline.filter((_, itemIndex) => itemIndex !== index)));
    setMenuIndex(null);
  }
  function openDetails(index: number) {
    if (busy) return;
    setMenuIndex(null);
    setDetailsIndex(index);
  }
  function openImages(index: number) {
    if (busy) return;
    setMenuIndex(null);
    setImagePickerIndex(index);
  }
  function updatePageImages(index: number, ids: string[]) {
    if (busy || !outline[index]) return;
    const next = cloneOutlineItems(outline);
    next[index]!.selected_image_ids = [...ids];
    props.replaceItems(next);
  }

  if (creating) return <section className="page active requirements-page requirements-loading">
    <div className="requirements-breathing-mark"><RefreshCw size={26} /></div>
    <h1 ref={progressHeading}>{t.outline.loadingTitle}</h1><p>{t.outline.loadingBody}</p>
    <ProcessPanel t={t} steps={props.progress ?? []} />
  </section>;

  if (error && outline.length === 0) return <section className="page active requirements-page requirements-error">
    <h1>{t.outline.errorTitle}</h1><ErrorNotice t={t} tone="block" summary={error} detail={errorDetail} />
    <ProcessPanel t={t} steps={props.progress ?? []} />
    <div className="requirements-error-actions">
      <button data-performance-id="outline.create.retry" className="primary-btn" type="button" onClick={() => void props.retry()} disabled={busy}><RefreshCw size={16} />{t.outline.retry}</button>
      <button data-performance-id="outline.back-to-requirements" className="secondary-btn" type="button" onClick={props.backToRequirements}><ArrowLeft size={16} />{t.outline.backToRequirements}</button>
    </div>
  </section>;

  return <section className="page active outline-page outline-review">
    <div className="page-header compact outline-v2-header">
      <div><div className="page-title">{t.outline.title}</div><p>{t.outline.helper}</p></div>
      <div className="outline-header-title-wrap">
        <span className="outline-header-title-label">{t.outline.presentationTitle}</span>
        {editingTitle ? <input autoFocus aria-label={t.outline.presentationTitle} value={title} disabled={busy}
          onChange={(event) => props.setTitle(event.target.value)} onBlur={() => setEditingTitle(false)}
          onKeyDown={(event) => { if (event.key === "Enter" || event.key === "Escape") event.currentTarget.blur(); }} />
          : <button type="button" className="outline-header-title" onClick={() => setEditingTitle(true)} disabled={busy} aria-label={t.outlineReview.editPresentationTitle}>
            <strong>{title || t.outline.untitledPresentation}</strong><Pencil size={14} /></button>}
      </div>
    </div>
    {error && !rewriteOpen ? <ErrorNotice t={t} tone="inline" summary={error} detail={errorDetail} /> : null}
    <div className="outline-global-requirements outline-details-fields">
      <label>{t.outline.globalCreationRequirements}
        <textarea rows={3} value={props.globalRequirements} disabled={busy} placeholder={t.outline.creationRequirementsHint}
          onChange={(event) => props.setGlobalRequirements(event.target.value)} />
      </label>
    </div>
    <div className="outline-structure">
      <div className="outline-structure-toolbar">
        <div className="outline-toolbar-summary"><strong>{t.outline.pageListTitle}</strong><span>{t.outline.pageListCount.replace("{count}", String(outline.length))}</span></div>
        <div className="outline-structure-actions">
          <button className="secondary-btn" type="button" onClick={() => insertPage(outline.length)} disabled={busy}><Plus size={17} />{t.outline.addPage}</button>
          <button data-performance-id="outline.rewrite.open" className="primary-btn" type="button" onClick={() => setRewriteOpen(true)} disabled={busy}><Sparkles size={16} />{t.outlineReview.aiEdit}</button>
        </div>
      </div>
      <div ref={list} className="outline-compact-list">
        {outline.map((item, index) => <article key={index} data-outline-page={index}
          className={`outline-compact-card${drag?.from === index ? " is-dragging" : ""}${drag && drag.from !== index && drag.to === index ? drag.from < index ? " drop-after" : " drop-before" : ""}`}
          onDragOver={(event) => {
            if (busy || dragRef.current === null) return;
            event.preventDefault(); event.dataTransfer.dropEffect = "move";
            setDrag({ from: dragRef.current, to: index });
          }}
          onDrop={(event) => {
            event.preventDefault();
            if (dragRef.current !== null) movePage(dragRef.current, index, true);
            dragRef.current = null; setDrag(null);
          }}>
          <button className="outline-drag-handle" type="button" draggable={!busy} disabled={busy}
            aria-label={t.outlineReview.dragPage.replace("{page}", String(index + 1))} title={t.outlineReview.dragPage.replace("{page}", String(index + 1))}
            onDragStart={(event) => {
              dragRef.current = index; setDrag({ from: index, to: index }); setMenuIndex(null);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", String(index));
              const card = event.currentTarget.closest<HTMLElement>(".outline-compact-card");
              if (card) event.dataTransfer.setDragImage(card, 24, card.offsetHeight / 2);
            }}
            onDragEnd={() => { dragRef.current = null; setDrag(null); }}
            onKeyDown={(event) => {
              if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                event.preventDefault(); movePage(index, index + (event.key === "ArrowUp" ? -1 : 1), true);
              }
            }}><GripVertical size={17} /></button>
          <button type="button" className="outline-compact-summary" disabled={busy} onClick={() => openDetails(index)} aria-haspopup="dialog">
            <span className="outline-compact-number">{String(index + 1).padStart(2, "0")}</span>
            <span className="outline-compact-heading">
              {item.page_type === "cover" ? <span className="outline-page-type outline-page-type-cover">{t.outline.pageTypeCover}</span> : null}
              <strong>{item.title || t.outline.untitledPage}</strong>
            </span>
          </button>
          <OutlineCardImages t={t} pageIndex={index} ids={item.selected_image_ids ?? []} assets={assets}
            busy={busy} loading={imageLoading} error={imageError} loadPreview={loadPreview} onManage={() => openImages(index)} />
          <div className="outline-more" ref={menuIndex === index ? menu : undefined}
            onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMenuIndex((current) => current === index ? null : current); }}
            onKeyDown={(event) => {
              if (event.key === "Escape") { setMenuIndex(null); event.currentTarget.querySelector<HTMLButtonElement>(".outline-more-trigger")?.focus(); }
            }}>
            <button type="button" className="outline-icon-button outline-more-trigger" disabled={busy}
              aria-label={t.outlineReview.moreActions.replace("{page}", String(index + 1))} aria-expanded={menuIndex === index} aria-controls={`outline-actions-${index}`}
              onClick={(event) => {
                setMenuAbove(event.currentTarget.getBoundingClientRect().bottom + 270 > window.innerHeight);
                setMenuIndex((current) => current === index ? null : index);
              }}><MoreHorizontal size={20} /></button>
            {menuIndex === index ? <div className={`outline-more-actions${menuAbove ? " is-above" : ""}`} id={`outline-actions-${index}`} role="group" aria-label={t.outline.pageActions}>
              <button type="button" onClick={() => insertPage(index)}><Plus size={15} />{t.outline.insertBefore}</button>
              <button type="button" onClick={() => insertPage(index + 1)}><Plus size={15} />{t.outline.insertAfter}</button>
              <button type="button" onClick={() => insertPage(index + 1, item)}><Copy size={15} />{t.outline.duplicatePage}</button>
              <button type="button" disabled={index === 0} onClick={() => movePage(index, index - 1, true)}><ArrowUp size={15} />{t.outline.moveUp}</button>
              <button type="button" disabled={index === outline.length - 1} onClick={() => movePage(index, index + 1, true)}><ArrowDown size={15} />{t.outline.moveDown}</button>
              <button className="danger" type="button" disabled={outline.length <= 1} onClick={() => deletePage(index)}><Trash2 size={15} />{t.outline.deletePage}</button>
            </div> : null}
          </div>
        </article>)}
      </div>
    </div>
    <span className="outline-sr-only" role="status" aria-live="polite">{announcement}</span>
    <div className="outline-card-footer">
      <div className="stage-navigation">
        <button data-performance-id="outline.back-to-requirements" className="secondary-btn" type="button" onClick={props.backToRequirements} disabled={busy}><ArrowLeft size={16} />{t.outline.backToRequirements}</button>
        {props.forward ? <button data-performance-id="outline.forward" className="secondary-btn" type="button" onClick={props.forward} disabled={busy}>{t.controls.forward}<ArrowRight size={16} /></button> : null}
      </div>
      <div className="outline-footer-right"><span className="outline-save-state">{saving ? t.outline.saving : props.dirty ? t.outline.unsaved : t.outline.saved}</span>
        <div className="outline-footer-actions">
          <button data-performance-id="outline.save" className="secondary-btn" type="button" onClick={() => void props.save()} disabled={busy || !props.dirty}><Save size={16} />{t.outline.saveChanges}</button>
          <button data-performance-id="outline.confirm" className="primary-btn" type="button" onClick={() => void props.confirm()} disabled={busy}>
            {loading === "deck" ? <span className="spinner small" /> : <CheckCircle2 size={16} />}{t.controls.confirmOutline}</button>
        </div>
      </div>
    </div>
    {detailsIndex !== null && outline[detailsIndex] ? <OutlinePageDetails imageLibrary={props.imageLibrary} imageUpload={props.imageUpload} pageImageSearch={props.pageImageSearch} deckTitle={title} globalRequirements={props.globalRequirements} loadImages={props.loadImages} t={t} index={detailsIndex} outline={outline}
      images={assets} imageLoading={imageLoading} imageError={imageError} loadPreview={loadPreview} retryImages={() => setImageRetry((value) => value + 1)}
      onSave={(item) => props.save({ title, global_creation_requirements: props.globalRequirements, items: outline.map((page, index) => index === detailsIndex ? item : page) })} onClose={() => setDetailsIndex(null)} /> : null}
    {imagePickerIndex !== null && outline[imagePickerIndex] ? <OutlineImagePicker t={t} pageIndex={imagePickerIndex} outline={outline}
      assets={assets} loadPreview={loadPreview} loading={imageLoading} error={imageError} onRetry={() => setImageRetry((value) => value + 1)}
      imageLibrary={props.imageLibrary} imageUpload={props.imageUpload} pageImageSearch={props.pageImageSearch}
      deckTitle={title} globalRequirements={props.globalRequirements} onUploaded={(image) => {
        setAddedImages((current) => mergeOutlineImageAssets(current, [image]));
        setImageRetry((value) => value + 1);
      }} onChange={(ids) => updatePageImages(imagePickerIndex, ids)} onClose={() => setImagePickerIndex(null)} /> : null}
    {rewriteOpen ? <OutlineRewriteDialog t={t} current={{ title, global_creation_requirements: props.globalRequirements, items: outline }} feedback={props.feedback} setFeedback={props.setFeedback}
      generate={props.applyFeedback} apply={props.save} error={error} errorDetail={errorDetail} progress={props.progress ?? []} onClose={() => setRewriteOpen(false)} /> : null}
  </section>;
}
