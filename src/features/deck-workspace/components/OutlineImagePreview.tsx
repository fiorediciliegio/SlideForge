import { useEffect, useRef, useState } from "react";
import { Expand, Image as ImageIcon, X } from "lucide-react";
import type { Messages } from "../../../i18n/messages";
import type { OutlineImageAsset } from "../../outline/images";

export type PreviewLoader = (id: string, size?: "thumbnail" | "large") => Promise<string>;

function imageLabel(asset: OutlineImageAsset, t: Messages) {
  return asset.title || asset.source_filename || asset.description || t.outline.imageUnnamed;
}

function OutlineImagePreview({ asset, load, t, onClose }: { asset: OutlineImageAsset; load: PreviewLoader; t: Messages; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    let active = true;
    setUrl(""); setFailed(false);
    void load(asset.asset_id, "large").then((value) => { if (active) setUrl(value); }, () => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [asset.asset_id, load, retry]);
  return <dialog ref={dialog} className="outline-image-preview" aria-label={t.outline.imageEnlarge}
    onCancel={(event) => { event.preventDefault(); event.stopPropagation(); onClose(); }}>
    <header><strong>{imageLabel(asset, t)}</strong>
      <button type="button" className="secondary-btn compact" onClick={onClose} aria-label={t.outline.imageClose}><X size={18} /></button></header>
    {failed ? <p role="alert">{t.outline.imagePreviewFailed} <button type="button" className="secondary-btn compact" onClick={() => setRetry((value) => value + 1)}>{t.outline.imageRetry}</button></p>
      : url ? <img src={url} alt={imageLabel(asset, t)} onError={() => setFailed(true)} /> : <p role="status">{t.outline.imageLoading}</p>}
    <p>{asset.description}</p>
  </dialog>;
}

export function OutlineImageThumbnail({ asset, load, t }: { asset: OutlineImageAsset; load: PreviewLoader; t: Messages }) {
  const box = useRef<HTMLButtonElement>(null);
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  const [preview, setPreview] = useState(false);
  useEffect(() => {
    let active = true;
    setUrl(""); setFailed(false);
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void load(asset.asset_id).then((value) => { if (active) setUrl(value); }, () => { if (active) setFailed(true); });
    }, { rootMargin: "120px" });
    if (box.current) observer.observe(box.current);
    return () => { active = false; observer.disconnect(); };
  }, [asset.asset_id, load]);
  return <><button type="button" className="outline-image-thumbnail" ref={box} onClick={() => setPreview(true)} aria-label={`${t.outline.imageEnlarge} · ${imageLabel(asset, t)}`}>
    {url && !failed ? <img src={url} alt={imageLabel(asset, t)} onError={() => setFailed(true)} /> : <><ImageIcon size={24} aria-hidden="true" /><span>{failed ? t.outline.imagePreviewFailed : t.outline.imageLoading}</span></>}
    <span className="outline-image-expand"><Expand size={14} aria-hidden="true" />{t.outline.imageEnlarge}</span>
  </button>{preview ? <OutlineImagePreview asset={asset} load={load} t={t} onClose={() => setPreview(false)} /> : null}</>;
}

