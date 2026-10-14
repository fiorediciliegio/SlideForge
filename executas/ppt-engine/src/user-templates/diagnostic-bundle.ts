import { cp, lstat, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { writeDirectoryDiagnosticArchive } from "../diagnostics/archive.js";
import { withDiagnosticDirectoryLock } from "../diagnostics/log.js";
import { isDiagnosticLoggingEnabled } from "../diagnostic-logging.js";
import { resolveUserTemplateDirectory } from "./storage.js";

export async function prepareUserTemplateDiagnosticBundle(input: { id: string }) {
  const directory = await resolveUserTemplateDirectory(input.id);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ppt-template-diagnostics-"));
  const archiveDir = path.join(os.tmpdir(), "ppt-engine-workspace-diagnostic-bundles");
  await mkdir(archiveDir, { recursive: true });
  const archivePath = path.join(archiveDir, `${input.id}-${randomUUID()}.zip`);
  const createdAt = new Date().toISOString();
  try {
    const logSnapshot = path.join(temporary, ".log");
    // Freeze only logs while copying. New frames may continue arriving, and
    // ordinary artifacts keep their existing stability checks during archiving.
    await withDiagnosticDirectoryLock(directory, async () => {
      try { const info = await lstat(path.join(directory, ".log")); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid template log directory"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      await cp(path.join(directory, ".log"), logSnapshot, { recursive: true, dereference: false, verbatimSymlinks: true });
    });
    const hasLogs = await stat(logSnapshot).then(() => true, () => false);
    const result = await writeDirectoryDiagnosticArchive({
      archivePath,
      trees: [
        { directory, prefix: input.id, exclude: [".log"] },
        ...(hasLogs ? [{ directory: logSnapshot, prefix: `${input.id}/.log` }] : []),
      ],
      extraEntries: [{ name: `${input.id}/diagnostic-bundle.json`, content: JSON.stringify({
        schema_version: 1, target: { kind: "user-template", id: input.id },
        collection_started_at: createdAt, logs_captured_at: new Date().toISOString(),
        diagnostic_logging_enabled: isDiagnosticLoggingEnabled(), atomic_snapshot: false,
        observation_layer: "session.run.payload", logs_present: hasLogs,
      }, null, 2) }],
    });
    return {
      workspace_id: input.id, archive_path: archivePath,
      filename: `${input.id}-template-diagnostics.zip`, size_bytes: result.size_bytes,
      content_type: "application/zip", aps_path: `user-templates/${input.id}/diagnostics/current-template.zip`,
      created_at: createdAt,
    };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
