import { LoaderCircle } from "lucide-react";

interface SlidePreviewLoadingProps {
  label: string;
  compact?: boolean;
}

export function SlidePreviewLoading({ label, compact = false }: SlidePreviewLoadingProps) {
  return (
    <div className={`slide-preview-loading ${compact ? "compact" : ""}`} role="status" aria-live="polite" aria-label={label}>
      <LoaderCircle className="slide-preview-loading-icon" size={compact ? 16 : 28} aria-hidden="true" />
      {!compact ? <span className="slide-preview-loading-label" aria-hidden="true">{label}</span> : null}
    </div>
  );
}
