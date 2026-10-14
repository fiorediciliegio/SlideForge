import { invokeTimeoutSummary } from "../deck-workspace/userFacingError";
import { useEffect, useRef, useState } from "react";
import { Upload } from "lucide-react";
import type { Messages } from "../../i18n";
import type { OutlineImageAsset } from "../outline/images";
import { PAGE_IMAGE_ACCEPT, type PageImageUploadService, validatePageImageFile } from "./service";

type UploadRow = { id: string; filename: string; file?: File; image?: OutlineImageAsset;
  status: "waiting" | "uploading" | "failed" | "ready"; error?: string };

export function PageImageUpload(props: {
  service: PageImageUploadService; t: Messages; onReady: (image: OutlineImageAsset) => void; onBusyChange: (busy: boolean) => void;
  disabled?: boolean;
}) {
  const text = props.t.pageImageUpload;
  const input = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<UploadRow[]>([]);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const mounted = useRef(true);
  const callbacks = useRef(props);
  callbacks.current = props;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function run(batch: UploadRow[]) {
    if (running.current || callbacks.current.disabled) return;
    running.current = true; setBusy(true); callbacks.current.onBusyChange(true);
    const update = (row: UploadRow) => {
      if (mounted.current) setRows((current) => current
        .filter((item) => item.id === row.id || !row.image || item.image?.asset_id !== row.image.asset_id)
        .map((item) => item.id === row.id ? { ...row } : item));
    };
    try {
      for (const row of batch) {
        if (!mounted.current) break;
        delete row.error;
        try {
          row.status = "uploading"; update(row);
          row.image = await props.service.upload(row.file!);
          row.file = undefined;
          row.status = "ready"; update(row);
          if (mounted.current) callbacks.current.onReady(row.image);
        } catch (error) {
          row.status = "failed"; row.error = error instanceof Error ? error.message : ""; update(row);
        }
      }
    } finally {
      running.current = false;
      if (mounted.current) { setBusy(false); callbacks.current.onBusyChange(false); }
    }
  }

  function choose(files: File[]) {
    if (running.current || callbacks.current.disabled) return;
    const batch = files.map((file): UploadRow => {
      const row: UploadRow = { id: crypto.randomUUID(), filename: file.name, file, status: "waiting" };
      try { validatePageImageFile(file); }
      catch (error) { row.status = "failed"; row.error = (error as Error).message; row.file = undefined; }
      return row;
    });
    setRows((current) => [...current, ...batch]);
    void run(batch.filter((row) => row.status === "waiting"));
  }

  function errorText(row: UploadRow) {
    if (row.error?.includes("PAGE_IMAGE_FILE_TOO_LARGE")) return text.tooLarge;
    if (row.error?.includes("PAGE_IMAGE_INVALID_FILE")) return text.invalidFile;
    if (row.error?.includes("PAGE_IMAGE_LIBRARY_LIMIT")) return text.libraryLimit;
    return invokeTimeoutSummary(props.t, row.error, text.uploadFailed);
  }
  return <section className="page-image-upload" aria-label={text.upload}>
    <div className="page-image-upload-heading">
      <button className="secondary-btn compact" type="button" disabled={busy || props.disabled} onClick={() => input.current?.click()}><Upload size={15} />{text.upload}</button>
      <input ref={input} type="file" multiple accept={PAGE_IMAGE_ACCEPT} hidden aria-label={text.upload} disabled={busy || props.disabled}
        onChange={(event) => { choose(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
      <p>{text.hint}</p>
    </div>
    {rows.length ? <ul className="page-image-upload-list" aria-live="polite">{rows.map((row) => <li key={row.id}>
      <span className="page-image-upload-name" title={row.filename}>{row.filename}</span>
      <span role={row.status === "failed" ? "alert" : "status"}>{row.status === "failed" ? errorText(row) : text[row.status]}</span>
      {row.status === "failed" && row.file ? <button type="button" className="secondary-btn compact" disabled={busy || props.disabled}
        onClick={() => void run([{ ...row }])}>{props.t.outline.imageRetry}</button> : null}
    </li>)}</ul> : null}
    {busy ? <p role="status">{text.busyHint}</p> : null}
  </section>;
}
