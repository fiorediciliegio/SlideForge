import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ImagePlus, Search, X } from "lucide-react";
import type { Messages } from "../../../i18n/messages";
import type { PageImageSearchResult } from "../../../api/pageImageSearchTypes";
import { matchesOutlineImage, mergeOutlineImageAssets, resolveOutlineImage, type OutlineImageAsset } from "../../outline/images";
import { PAGE_IMAGE_ATTACHMENT_LIMIT } from "../../outline/imageAttachmentLimit";
import { PageImageUpload } from "../../page-image-upload/PageImageUpload";
import type { PageImageUploadService } from "../../page-image-upload/service";
import type { OutlineImageLibraryService } from "../../outline/imageLibrary";
import { PageImageSearchPanel } from "../../page-image-search/PageImageSearch";
import { pageImageSearchAsset } from "../../page-image-search/images";
import type { PageImageSearchService } from "../../page-image-search/service";
import { OutlineImageThumbnail, type PreviewLoader } from "./OutlineImagePreview";

export { OutlineImageThumbnail, type PreviewLoader } from "./OutlineImagePreview";

function imageLabel(asset: OutlineImageAsset, t: Messages) {
  return asset.title || asset.source_filename || asset.description || t.outline.imageUnnamed;
}

export function OutlinePageImages(props: {
  t: Messages; ids: string[]; assets: OutlineImageAsset[]; busy: boolean; loading: boolean; error: boolean;
  loadPreview: PreviewLoader; onAdd: () => void; onRemove: (id: string) => void; onRetry: () => void;
}) {
  const { t, ids, assets, loadPreview } = props;
  const entryHintId = useId();
  return <section className="outline-field-block outline-page-images">
    <div className="outline-field-heading"><span className="outline-field-label">{t.outline.pageImages}<span className="outline-image-count">{ids.length}</span></span>
      <div className="outline-image-entry">
        <span className="outline-image-entry-hint" id={entryHintId}>{t.outline.imageEntryHint}</span>
        <button className="primary-btn outline-image-entry-button" type="button" aria-haspopup="dialog" aria-describedby={entryHintId}
          disabled={props.busy} onClick={props.onAdd}><ImagePlus size={18} aria-hidden="true" /><span>{t.outline.addImage}</span></button>
      </div>
    </div>
    {ids.length > PAGE_IMAGE_ATTACHMENT_LIMIT ? <p className="outline-image-picker-hint" role="status">{t.outline.imageCountHint}</p> : null}
    {props.error ? <p role="alert">{t.outline.imageLoadFailed} <button type="button" onClick={props.onRetry}>{t.outline.imageRetry}</button></p>
      : props.loading ? <p className="outline-images-empty" role="status">{t.outline.imageLoading}</p>
      : ids.length ? <div className="outline-selected-images">{ids.map((id) => {
        const asset = resolveOutlineImage(assets, id);
        return <article className="outline-selected-image" key={id}>
          {asset ? <OutlineImageThumbnail asset={asset} load={loadPreview} t={t} /> : <p>{t.outline.imageMissing}</p>}
          <div className="outline-image-caption"><strong>{asset ? imageLabel(asset, t) : t.outline.imageMissing}</strong>
            {asset ? <span>{asset.source === "uploaded" ? t.outline.uploadedImages : t.outline.searchedImages}</span> : null}</div>
          <button type="button" className="outline-image-remove" disabled={props.busy} onClick={() => props.onRemove(id)} aria-label={t.outline.removeImage} title={t.outline.removeImage}><X size={14} /></button>
        </article>;
      })}</div> : <div className="outline-image-empty-state"><p>{t.outline.noImages}</p></div>}
  </section>;
}

export function OutlineImagePicker(props: {
  t: Messages; pageIndex: number;
  outline: Array<{ title: string; content: string; creation_requirements?: string; page_id?: string; selected_image_ids?: string[] }>;
  assets: OutlineImageAsset[]; loadPreview: PreviewLoader;
  onChange: (ids: string[]) => void; onClose: () => void;
  imageUpload?: PageImageUploadService | null; onUploaded?: (image: OutlineImageAsset) => void;
  imageLibrary?: OutlineImageLibraryService | null;
  pageImageSearch?: PageImageSearchService | null; deckTitle?: string; globalRequirements?: string;
  loading?: boolean; error?: boolean; onRetry?: () => void;
}) {
  const { t, pageIndex, outline } = props;
  const page = outline[pageIndex];
  const [updates, setUpdates] = useState<OutlineImageAsset[]>([]);
  const assets = useMemo(() => mergeOutlineImageAssets(props.assets, updates), [props.assets, updates]);
  const assetsRef = useRef(assets); assetsRef.current = assets;
  const searchResults = useRef(new Map<string, PageImageSearchResult>());
  const loadPreview = useCallback<PreviewLoader>((id, size) => {
    const image = resolveOutlineImage(assetsRef.current, id);
    const result = image?.remote_candidate ? searchResults.current.get(image.sha256) : undefined;
    return result && props.pageImageSearch ? props.pageImageSearch.preview({ ...result, aps_paths: image?.remote_candidate?.aps_paths }) : props.loadPreview(id, size);
  }, [props.loadPreview, props.pageImageSearch]);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const tabsId = useId();
  const [tab, setTab] = useState<"library" | "search">("library");
  const [filter, setFilter] = useState<"all" | "uploaded" | "search">("all");
  const [query, setQuery] = useState("");
  const [uploading, setUploading] = useState(false);
  const uploadBusy = useRef(false);
  const [searching, setSearching] = useState(false);
  const searchBusy = useRef(false);
  const [adopting, setAdopting] = useState(false);
  const adoptionBusy = useRef(false);
  const mounted = useRef(true);
  const [failedImages, setFailedImages] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState(() => [...(page?.selected_image_ids ?? [])]);
  const selectedRef = useRef(selected);
  const initialIds = useRef(new Set(page?.selected_image_ids ?? []));
  const busy = uploading || searching || adopting;
  function change(ids: string[]) { selectedRef.current = ids; setSelected(ids); }
  function isBusy() { return uploadBusy.current || searchBusy.current || adoptionBusy.current; }
  function close() { if (!isBusy()) props.onClose(); }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function remove(id: string) {
    if (isBusy()) return;
    const asset = resolveOutlineImage(assets, id);
    change(selectedRef.current.filter((value) => value !== id));
    if (asset) setFailedImages((current) => { const next = new Set(current); next.delete(asset.sha256); return next; });
  }
  function toggle(asset: OutlineImageAsset) {
    if (isBusy()) return;
    const checked = selectedRef.current.some((id) => matchesOutlineImage(asset, id));
    change(checked ? selectedRef.current.filter((id) => !matchesOutlineImage(asset, id)) : [...selectedRef.current, asset.asset_id]);
    if (checked) setFailedImages((current) => { const next = new Set(current); next.delete(asset.sha256); return next; });
  }
  async function finish() {
    if (isBusy()) return;
    // 保留正式页面的历史标识；本窗口新选的候选若已入库，改用正式素材标识。
    const ids = selectedRef.current.map((id) => {
      const image = assets.find((asset) => matchesOutlineImage(asset, id));
      return image?.file_path && !initialIds.current.has(id) ? image.asset_id : id;
    });
    if (ids.some((id) => !resolveOutlineImage(assets, id))) return;
    const pending = ids.flatMap((id) => {
      const image = resolveOutlineImage(assets, id);
      return image?.remote_candidate ? [image.remote_candidate] : [];
    });
    if (!pending.length) { props.onChange(ids); props.onClose(); return; }
    if (!props.imageLibrary) { setFailedImages(new Set(pending.map((image) => image.sha256))); return; }
    adoptionBusy.current = true; setAdopting(true); setFailedImages(new Set());
    try {
      const ready = await props.imageLibrary.adoptMany(pending);
      if (!mounted.current) return;
      const byHash = new Map(ready.map((image) => [image.sha256, image]));
      const next = ids.map((id) => {
        const image = resolveOutlineImage(assets, id);
        return image?.remote_candidate ? byHash.get(image.sha256)?.asset_id ?? id : id;
      });
      change(next);
      setUpdates((current) => mergeOutlineImageAssets(current, ready));
      ready.forEach((image) => props.onUploaded?.(image));
      const failed = new Set(pending.filter((image) => !byHash.has(image.sha256)).map((image) => image.sha256));
      setFailedImages(failed);
      if (!failed.size) { props.onChange(next); props.onClose(); }
    } catch {
      if (mounted.current) setFailedImages(new Set(pending.map((image) => image.sha256)));
    } finally {
      adoptionBusy.current = false;
      if (mounted.current) setAdopting(false);
    }
  }
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    element?.querySelector<HTMLElement>("[data-image-autofocus]")?.focus({ preventScroll: true });
    return () => { element?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  const visible = assets.filter((asset) => (filter === "all" || filter === asset.source)
    && [asset.title, asset.description, asset.source_filename].join(" ").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const missingSelection = selected.some((id) => !resolveOutlineImage(assets, id));
  function switchTab(value: "library" | "search", focus = false) {
    if (adoptionBusy.current) return;
    setTab(value);
    if (focus) dialog.current?.querySelector<HTMLElement>(`[id="${tabsId}-${value}-tab"]`)?.focus();
  }
  return <dialog ref={dialog} className="outline-image-picker page-image-manager-dialog"
    onCancel={(event) => { event.preventDefault(); event.stopPropagation(); close(); }} aria-labelledby={titleId}>
    <header className="page-image-manager-header"><h2 id={titleId} data-image-autofocus tabIndex={-1}>{t.outline.chooseImages}</h2>
      <button type="button" className="secondary-btn compact" disabled={busy} onClick={close} aria-label={t.outline.imageClose}><X size={18} /></button>
    </header>
    <div className="page-image-manager-body">
      <section className="page-image-context" aria-label={t.outline.imagePageContext}>
        <div className="page-image-context-heading"><span>{t.outline.imagePageNumber.replace("{page}", String(pageIndex + 1))}</span>
          <h3>{page?.title}</h3></div>
        <details className="page-image-context-content"><summary><span>{t.outline.pageContent}</span>
          <span className="page-image-context-summary">{page?.content}</span><ChevronDown size={16} aria-hidden="true" /></summary>
          <p>{page?.content}</p>
          {page?.creation_requirements ? <><h4>{t.outline.pageCreationRequirements}</h4><p>{page.creation_requirements}</p></> : null}
        </details>
      </section>
      <section className="page-image-selected" aria-label={t.outline.imageSelected}>
        <h3>{t.outline.imageSelected}<span className="outline-image-count">{selected.length}</span></h3>
        {selected.length ? <div className="page-image-selected-list">{selected.map((id) => {
          const image = resolveOutlineImage(assets, id);
          return <article className="page-image-selected-card" key={id}>
            {image ? <OutlineImageThumbnail asset={image} load={loadPreview} t={t} />
              : <p className="outline-images-empty">{props.loading ? t.outline.imageLoading : t.outline.imageMissing}</p>}
            <div className="outline-image-caption"><strong>{image ? imageLabel(image, t) : t.outline.imageUnnamed}</strong>
              {image && failedImages.has(image.sha256) ? <small role="alert">{t.outline.imageFileFailed}</small> : null}</div>
            <button type="button" className="outline-image-remove" disabled={busy} onClick={() => remove(id)}
              aria-label={t.outline.removeImage} title={t.outline.removeImage}><X size={14} /></button>
          </article>;
        })}</div> : <p className="outline-images-empty">{t.outline.imageSelectedEmpty}</p>}
        {selected.length > PAGE_IMAGE_ATTACHMENT_LIMIT ? <p className="outline-image-picker-hint" role="status">{t.outline.imageCountHint}</p> : null}
      </section>
      {failedImages.size ? <p className="page-image-save-error" role="alert">{t.outline.imageAddFailed}</p> : null}
      <div className="page-image-tabs" role="tablist" aria-label={t.outline.imageSources}>
        {([['library', t.outline.imageLibraryTab], ['search', t.outline.imageSearchTab]] as const).map(([value, label]) =>
          <button type="button" key={value} role="tab" id={`${tabsId}-${value}-tab`} aria-controls={`${tabsId}-${value}-panel`}
            aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} disabled={adopting} onClick={() => switchTab(value)}
            onKeyDown={(event) => {
              if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                switchTab(event.key === "Home" ? "library" : event.key === "End" ? "search" : tab === "library" ? "search" : "library", true);
              }
            }}>{label}</button>)}
      </div>
      <div role="tabpanel" id={`${tabsId}-library-panel`} aria-labelledby={`${tabsId}-library-tab`} hidden={tab !== "library"}>
        <p className="outline-image-picker-hint">{t.outline.imageLibraryHint}</p>
        {props.imageUpload ? <PageImageUpload service={props.imageUpload} t={t} disabled={adopting || searching}
          onBusyChange={(value) => { uploadBusy.current = value; setUploading(value); }}
          onReady={(image) => {
            setUpdates((current) => mergeOutlineImageAssets(current, [image]));
            props.onUploaded?.(image);
            setQuery(""); setFilter("all");
            const next = selectedRef.current.map((id) => {
              const existing = resolveOutlineImage(assets, id);
              return existing?.remote_candidate && existing.sha256 === image.sha256 ? image.asset_id : id;
            });
            const alreadySelected = next.some((id) => id === image.asset_id || resolveOutlineImage(assets, id)?.sha256 === image.sha256);
            change(alreadySelected ? next : [...next, image.asset_id]);
            setFailedImages((current) => { const next = new Set(current); next.delete(image.sha256); return next; });
          }} /> : null}
        <div className="outline-image-picker-controls">
          <div className="outline-image-filters">{([['all', t.outline.allImages], ['uploaded', t.outline.uploadedImages], ['search', t.outline.searchedImages]] as const).map(([value, label]) =>
            <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}</div>
          <label className="outline-image-search"><Search size={16} /><input aria-label={t.outline.imageSearchPlaceholder}
            placeholder={t.outline.imageSearchPlaceholder} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        </div>
        {props.error ? <p role="alert">{t.outline.imageLoadFailed} <button type="button" className="secondary-btn compact" onClick={props.onRetry}>{t.outline.imageRetry}</button></p>
          : props.loading ? <p className="outline-images-empty" role="status">{t.outline.imageLoading}</p>
          : <div className="outline-image-library">{visible.length ? visible.map((asset) => {
            const usedOn = outline.flatMap((item, index) => index !== pageIndex && item.selected_image_ids?.some((id) => matchesOutlineImage(asset, id)) ? [index + 1] : []);
            const checked = selected.some((id) => matchesOutlineImage(asset, id));
            const usage = t.outline.imageUsedOnPage.replace('{page}', usedOn.join(', '));
            return <article key={asset.asset_id} className={`outline-image-option ${checked ? 'is-selected' : ''}`}>
              <OutlineImageThumbnail asset={asset} load={loadPreview} t={t} />
              <button type="button" className="outline-image-select" aria-pressed={checked}
                disabled={busy || Boolean(asset.remote_candidate && !props.imageLibrary)} onClick={() => toggle(asset)}>
                <span className="outline-image-check" aria-hidden="true">{checked ? <Check size={15} /> : null}</span>
                <span className="outline-image-caption"><strong>{imageLabel(asset, t)}</strong><span>{asset.description}</span>
                  {failedImages.has(asset.sha256) ? <small role="alert">{t.outline.imageFileFailed}</small> : null}</span>
              </button>
              {usedOn.length ? usedOn.length > 3 ? <details className="outline-image-usage"><summary>{t.outline.imageUsedOnPages.replace('{count}', String(usedOn.length))}</summary><span>{usage}</span></details>
                : <p className="outline-image-usage">{usage}</p> : null}
            </article>;
          }) : <p className="outline-images-empty">{t.outline.imageEmptyLibrary}</p>}</div>}
      </div>
      <div role="tabpanel" id={`${tabsId}-search-panel`} aria-labelledby={`${tabsId}-search-tab`} hidden={tab !== "search"}>
        <PageImageSearchPanel service={props.pageImageSearch ?? null} t={t} disabled={uploading || adopting || !props.imageLibrary}
          context={{ title: props.deckTitle ?? "", global_creation_requirements: props.globalRequirements ?? "",
            page: { ...page, title: page?.title ?? "", content: page?.content ?? "", selected_image_ids: selected } }}
          loadPreview={loadPreview} resolveImage={(result) => assets.find((image) => image.sha256 === result.sha256) ?? pageImageSearchAsset(result)}
          isSelected={(image) => selected.some((id) => matchesOutlineImage(image, id))} isFailed={(image) => failedImages.has(image.sha256)}
          onToggle={toggle} onBusyChange={(value) => { searchBusy.current = value; setSearching(value); }}
          onResults={(results) => {
            results.forEach((result) => searchResults.current.set(result.sha256, result));
            setUpdates((current) => mergeOutlineImageAssets(current, results.map(pageImageSearchAsset)));
          }} />
      </div>
    </div>
    <footer><span>{t.outline.imageCount.replace('{count}', String(selected.length))}</span>
      <div className="page-image-manager-actions"><button type="button" className="secondary-btn" disabled={busy} onClick={close}>{t.controls.cancel}</button>
        <button type="button" className="primary-btn" disabled={busy || missingSelection} aria-busy={adopting || undefined} onClick={() => void finish()}>
          {adopting ? <><span className="spinner small" aria-hidden="true" />{t.outline.imagePreparing}</> : t.outline.imageDone}</button></div>
    </footer>
  </dialog>;
}
