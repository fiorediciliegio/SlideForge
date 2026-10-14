import { useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import type { OutlineDetail } from "../../../data/mockDeck";
import type { Messages } from "../../../i18n/messages";
import { cloneOutlineItems } from "../../outline/model";
import type { OutlineImageAsset } from "../../outline/images";
import { OutlineDialog } from "./OutlineDialog";
import { OutlineImagePicker, OutlinePageImages, type PreviewLoader } from "./OutlineImages";
import { mergeOutlineImageAssets } from "../../outline/images";

export function OutlinePageDetails(props: {
  imageLibrary?: import("../../outline/imageLibrary").OutlineImageLibraryService | null;
  imageUpload?: import("../../page-image-upload/service").PageImageUploadService | null;
  pageImageSearch: import("../../page-image-search/service").PageImageSearchService | null;
  deckTitle: string; globalRequirements: string; loadImages: () => Promise<OutlineImageAsset[]>;
  t: Messages;
  index: number;
  outline: OutlineDetail[];
  images: OutlineImageAsset[];
  imageLoading: boolean;
  imageError: boolean;
  loadPreview: PreviewLoader;
  retryImages: () => void;
  onSave: (item: OutlineDetail) => Promise<boolean>;
  onClose: () => void;
}) {
  const { t, index, outline } = props;
  const [item, setItem] = useState(() => cloneOutlineItems([outline[index]!])[0]!);
  const [picker, setPicker] = useState(false);
  const [uploadedImages, setUploadedImages] = useState<OutlineImageAsset[]>([]);
  const images = mergeOutlineImageAssets(props.images, uploadedImages);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const title = titleRef.current;
    if (!title) return;
    const resize = () => {
      title.style.height = "auto";
      const borderHeight = title.offsetHeight - title.clientHeight;
      title.style.height = `${title.scrollHeight + borderHeight}px`;
    };
    resize();
    // dialog 在 showModal 后才参与布局；同时响应窄窗口下的标题宽度变化。
    let width = 0;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width !== width) {
        width = entry.contentRect.width;
        resize();
      }
    });
    observer?.observe(title);
    window.addEventListener("resize", resize);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, [item.title]);
  const pickerOutline = outline.map((page, pageIndex) => pageIndex === index ? item : page);
  function update(patch: Partial<OutlineDetail>) {
    setFailed(false);
    setItem((current) => ({ ...current, ...patch }));
  }
  async function save() {
    if (saving || !item.title.trim() || !item.content.trim()) return;
    setSaving(true);
    setFailed(false);
    try {
      if (await props.onSave(item)) props.onClose();
      else setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  }
  return <OutlineDialog className="outline-details" labelledBy="outline-details-title" busy={saving} onClose={props.onClose}>
    <form className="outline-details-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <header className="outline-dialog-header">
        <div className="outline-details-heading">
          <p id="outline-details-title" tabIndex={-1} data-outline-autofocus>
            {t.outlineReview.pageDetails.replace("{page}", String(index + 1).padStart(2, "0"))}
          </p>
            <span className="outline-page-type-select"><select aria-label={t.outline.pageType} value={item.page_type} disabled={saving}
              onChange={(event) => update({ page_type: event.target.value as OutlineDetail["page_type"] })}>
              <option value="standard">{t.outline.pageTypeStandard}</option><option value="cover">{t.outline.pageTypeCover}</option>
            </select><ChevronDown size={14} aria-hidden="true" /></span>
        <button type="button" className="outline-dialog-close" disabled={saving} onClick={props.onClose} aria-label={t.controls.close}><X size={20} /></button>
        </div>
            <textarea ref={titleRef} className="outline-details-title" rows={1} required
              aria-label={t.outline.pageTitle} title={t.outline.editPageTitleHint}
              placeholder={t.outline.untitledPage} value={item.title} disabled={saving}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
              }}
              onChange={(event) => {
                const title = event.target.value.replace(/\r?\n|\r/gu, " ");
                update({ title, title_segments: [{ text: title, source: "user", focus: false }], analysis: undefined });
              }} />
      </header>
      <div className="outline-dialog-body outline-details-fields">
        <label>{t.outline.pageContent}<textarea required rows={6} value={item.content} disabled={saving}
          placeholder={t.outline.contentPlaceholder} onChange={(event) => update({ content: event.target.value, analysis: undefined })} /></label>
        <label>{t.outline.pageCreationRequirements}<textarea rows={3} value={item.creation_requirements ?? ""} disabled={saving}
          placeholder={t.outline.creationRequirementsHint} onChange={(event) => update({ creation_requirements: event.target.value || undefined })} /></label>
        <OutlinePageImages t={t} ids={item.selected_image_ids ?? []} assets={images} busy={saving}
          loading={props.imageLoading} error={props.imageError} loadPreview={props.loadPreview} onRetry={props.retryImages}
          onAdd={() => setPicker(true)} onRemove={(id) => update({ selected_image_ids: (item.selected_image_ids ?? []).filter((value) => value !== id) })} />
        {failed ? <p className="outline-dialog-error" role="alert">{t.outlineReview.saveFailed}</p> : null}
      </div>
      <footer className="outline-dialog-footer">
        <p>{t.outlineReview.pageEditHint}</p>
        <button className="secondary-btn" type="button" disabled={saving} onClick={props.onClose}>{t.controls.cancel}</button>
        <button className="primary-btn" type="submit" disabled={saving || !item.title.trim() || !item.content.trim()}>
          {saving ? <span className="spinner small" /> : null}{t.outlineReview.saveChanges}</button>
      </footer>
    </form>
    {picker ? <OutlineImagePicker t={t} pageIndex={index} outline={pickerOutline} assets={images} loadPreview={props.loadPreview}
      pageImageSearch={props.pageImageSearch} deckTitle={props.deckTitle} globalRequirements={props.globalRequirements}
      loading={props.imageLoading} error={props.imageError} onRetry={props.retryImages}
      imageLibrary={props.imageLibrary} imageUpload={props.imageUpload} onUploaded={(image) => {
        setUploadedImages((current) => mergeOutlineImageAssets(current, [image]));
        props.retryImages();
      }}
      onChange={(ids) => update({ selected_image_ids: ids })} onClose={() => setPicker(false)} /> : null}
  </OutlineDialog>;
}
