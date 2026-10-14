import { CircleHelp } from "lucide-react";
import type { Messages } from "../../i18n/messages";

interface BatchTestingJsonHelpProps {
  t: Messages;
}

export function BatchTestingJsonHelp({ t }: BatchTestingJsonHelpProps) {
  return (
    <span className="batch-testing-json-help">
      <button
        type="button"
        className="batch-testing-json-help-button"
        aria-label={t.batchTesting.jsonHelpLabel}
        title={t.batchTesting.jsonHelpLabel}
      >
        <CircleHelp size={16} aria-hidden="true" />
      </button>
      <span className="batch-testing-json-tooltip" role="tooltip">
        <strong>{t.batchTesting.jsonHelpLabel}</strong>
        <span>{t.batchTesting.jsonHelpBody}</span>
        <small>{t.batchTesting.jsonHelpExample}</small>
        <code>{`{
  "repeat": 1,
  "target_stage": "pptx-exported",
  "briefs": [
    { "id": "investor-deck", "brief": "Create an investor presentation", "repeat": 2,
      "attachments": [{ "filename": "notes.pdf", "mime_type": "application/pdf", "size_bytes": 12345,
        "host_upload": { "transport": "host_upload", "r2_key": "...", "url": "...", "mime_type": "application/pdf", "size_bytes": 12345 } }] },
    { "brief": "Create a market review presentation" }
  ]
}`}</code>
      </span>
    </span>
  );
}
