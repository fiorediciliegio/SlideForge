import { createWriteStream } from "node:fs";
import { lstat, readlink, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { ZipArchive, type Archiver, type ArchiverError } from "archiver";

export type DiagnosticBundleEntrySnapshot =
  | {
      kind: "file";
      entry_name: string;
      absolute_path: string;
      relative_path: string;
      size: number;
      mtime_ms: number;
      mode: number;
      ino: number;
    }
  | {
      kind: "symlink";
      entry_name: string;
      absolute_path: string;
      relative_path: string;
      target: string;
      mode: number;
      ino: number;
    };

function diagnosticBundleEntryName(workspaceId: string, relativePath = ""): string {
  const suffix = relativePath.split(path.sep).join("/");
  return suffix ? `${workspaceId}/${suffix}` : `${workspaceId}/`;
}

export async function appendDiagnosticBundleTree(
  archive: Archiver,
  workspaceDir: string,
  workspaceId: string,
  snapshotsByEntryName: Map<string, DiagnosticBundleEntrySnapshot>,
  exclude: readonly string[] = [],
): Promise<void> {
  const rootInfo = await lstat(workspaceDir);
  archive.append(Buffer.alloc(0), {
    name: diagnosticBundleEntryName(workspaceId),
    type: "directory",
    date: rootInfo.mtime,
    mode: rootInfo.mode,
  });

  async function walk(directoryPath: string, relativeDirectory: string): Promise<void> {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolutePath = path.join(directoryPath, entry.name);
      const relativePath = relativeDirectory
        ? path.join(relativeDirectory, entry.name)
        : entry.name;
      if (exclude.includes(relativePath)) continue;
      const entryName = diagnosticBundleEntryName(workspaceId, relativePath);
      const entryInfo = await lstat(absolutePath);

      if (entryInfo.isDirectory()) {
        archive.append(Buffer.alloc(0), {
          name: `${entryName}/`,
          type: "directory",
          date: entryInfo.mtime,
          mode: entryInfo.mode,
        });
        await walk(absolutePath, relativePath);
        continue;
      }

      if (entryInfo.isFile()) {
        snapshotsByEntryName.set(entryName, {
          kind: "file",
          entry_name: entryName,
          absolute_path: absolutePath,
          relative_path: relativePath.split(path.sep).join("/"),
          size: entryInfo.size,
          mtime_ms: entryInfo.mtimeMs,
          mode: entryInfo.mode,
          ino: entryInfo.ino,
        });
        archive.file(absolutePath, {
          name: entryName,
          date: entryInfo.mtime,
          mode: entryInfo.mode,
          stats: entryInfo,
        });
        continue;
      }

      if (entryInfo.isSymbolicLink()) {
        const target = await readlink(absolutePath);
        snapshotsByEntryName.set(entryName, {
          kind: "symlink",
          entry_name: entryName,
          absolute_path: absolutePath,
          relative_path: relativePath.split(path.sep).join("/"),
          target,
          mode: entryInfo.mode,
          ino: entryInfo.ino,
        });
        archive.symlink(entryName, target, entryInfo.mode);
        continue;
      }

      throw new Error(
        `Workspace Diagnostic Bundle does not support special file: ${relativePath.split(path.sep).join("/")}`,
      );
    }
  }

  await walk(workspaceDir, "");
}

export async function verifyDiagnosticBundleEntry(
  snapshot: DiagnosticBundleEntrySnapshot,
): Promise<void> {
  let current;
  try {
    current = await lstat(snapshot.absolute_path);
  } catch {
    throw new Error(
      `Workspace entry disappeared while the diagnostic bundle was being created: ${snapshot.relative_path}`,
    );
  }

  if (snapshot.kind === "file") {
    if (
      !current.isFile() ||
      current.size !== snapshot.size ||
      current.mtimeMs !== snapshot.mtime_ms ||
      current.mode !== snapshot.mode ||
      current.ino !== snapshot.ino
    ) {
      throw new Error(
        `Workspace file changed while the diagnostic bundle was being created: ${snapshot.relative_path}`,
      );
    }
    return;
  }

  const currentTarget = current.isSymbolicLink()
    ? await readlink(snapshot.absolute_path)
    : null;
  if (
    !current.isSymbolicLink() ||
    currentTarget !== snapshot.target ||
    current.mode !== snapshot.mode ||
    current.ino !== snapshot.ino
  ) {
    throw new Error(
      `Workspace symbolic link changed while the diagnostic bundle was being created: ${snapshot.relative_path}`,
    );
  }
}

/** Pure directory archiving: callers own identity validation and any snapshot policy. */
export async function writeDirectoryDiagnosticArchive(input: {
  archivePath: string;
  trees: Array<{ directory: string; prefix: string; exclude?: readonly string[] }>;
  extraEntries?: Array<{ name: string; content: string }>;
}): Promise<{ size_bytes: number }> {
  const archivePath = input.archivePath;
  const output = createWriteStream(archivePath, { flags: "wx" });
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const snapshotsByEntryName = new Map<string, DiagnosticBundleEntrySnapshot>();
  const verificationChecks: Promise<void>[] = [];
  let verificationError: unknown = null;
  archive.on("warning", (error: ArchiverError) => archive.destroy(error));
  archive.on("entry", (entry) => {
    const snapshot = snapshotsByEntryName.get(entry.name);
    if (!snapshot) return;
    verificationChecks.push(
      verifyDiagnosticBundleEntry(snapshot).catch((error) => {
        verificationError ??= error;
      }),
    );
  });
  const completed = pipeline(archive, output);

  try {
    for (const tree of input.trees) {
      await appendDiagnosticBundleTree(archive, tree.directory, tree.prefix, snapshotsByEntryName, tree.exclude);
    }
    for (const extra of input.extraEntries ?? []) archive.append(extra.content, { name: extra.name });
    await archive.finalize();
    await completed;
    await Promise.all(verificationChecks);
    if (verificationError) {
      throw verificationError;
    }
    const archiveInfo = await stat(archivePath);
    if (!archiveInfo.isFile() || archiveInfo.size <= 0) {
      throw new Error("Workspace Diagnostic Bundle archive is empty");
    }

    return { size_bytes: archiveInfo.size };
  } catch (error) {
    archive.abort();
    output.destroy();
    await completed.catch(() => undefined);
    await unlink(archivePath).catch(() => undefined);
    throw error;
  }
}
