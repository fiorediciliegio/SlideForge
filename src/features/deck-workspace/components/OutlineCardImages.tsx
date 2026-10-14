import { Image as ImageIcon, Plus } from "lucide-react";
import type { Messages } from "../../../i18n/messages";
import { resolveOutlineImage, type OutlineImageAsset } from "../../outline/images";
import { OutlineImageThumbnail, type PreviewLoader } from "./OutlineImagePreview";

export function OutlineCardImages(props: {
  t: Messages; pageIndex: number; ids: string[]; assets: OutlineImageAsset[];
  busy: boolean; loading: boolean; error: boolean;
  loadPreview: PreviewLoader; onManage: () => void;
}) {
  const { t, ids } = props;
  const visible = ids.slice(0, 3);
  const remaining = ids.length - visible.length;
  const manageLabel = t.outlineReview.managePageImages.replace("{page}", String(props.pageIndex + 1));
  const remainingLabel = t.outlineReview.moreImages.replace("{count}", String(remaining));
  const unavailableLabel = props.loading ? t.outline.imageLoading : props.error ? t.outline.imageLoadFailed : t.outline.imageMissing;

  return <div className="outline-card-images" role="group"
    aria-label={`${t.outline.pageImages} · ${t.outline.imageCount.replace("{count}", String(ids.length))}`}>
    {visible.map((id, index) => {
      const asset = resolveOutlineImage(props.assets, id);
      const overflow = remaining > 0 && index === visible.length - 1;
      return <div className="outline-card-image" key={id} title={overflow ? remainingLabel : undefined}>
        {asset ? <OutlineImageThumbnail asset={asset} load={props.loadPreview} t={t} />
          : <span className="outline-card-image-placeholder" role="img" aria-label={unavailableLabel} title={unavailableLabel}>
            <ImageIcon size={20} aria-hidden="true" /></span>}
        {overflow ? <span className="outline-card-image-overflow" aria-hidden="true">+{remaining}</span> : null}
      </div>;
    })}
    <button type="button" className="outline-card-image-add" disabled={props.busy}
      aria-label={manageLabel} title={`${manageLabel} · ${t.outline.imageEntryHint}`} aria-haspopup="dialog" onClick={props.onManage}>
      <Plus size={20} aria-hidden="true" />
    </button>
  </div>;
}
