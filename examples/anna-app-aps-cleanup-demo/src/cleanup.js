// Shared by the UI and Executa: never interpret a directory as a raw prefix.
export function directoryPrefix(value) {
  if (typeof value !== "string") throw new Error("请输入目录路径。");
  const directory = value.endsWith("/") ? value.slice(0, -1) : value;
  if (!directory || directory.length > 1023 || /[\\\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(directory)
    || directory.split("/").some(part => !part || part === "." || part === ".." || part.trim() !== part)) {
    throw new Error("请输入相对目录，例如 workspaces 或 workspaces/ppt-20260719-143941；不允许根目录、空段或 ..。");
  }
  return `${directory}/`;
}

export function validateItem(item, prefix) {
  if (!item || typeof item.path !== "string" || !item.path.startsWith(prefix) || item.path === prefix) {
    throw new Error("APS 返回了目录范围外的文件，已中止。");
  }
  // Reuse strict path validation without changing the original object key.
  if (directoryPrefix(item.path) !== `${item.path}/`) throw new Error("文件路径无效。");
  if (typeof item.etag !== "string" || !item.etag) throw new Error(`文件缺少 ETag，不能安全删除：${item.path}`);
  return { path: item.path, etag: item.etag, size_bytes: Number(item.size_bytes) || 0 };
}

export async function scanDirectory(invoke, directory, { onProgress = () => {}, cancelled = () => false } = {}) {
  const prefix = directoryPrefix(directory);
  const items = new Map();
  const cursors = new Set();
  let cursor;
  do {
    if (cancelled()) throw new Error("扫描已停止，请重新预览。");
    const page = await invoke("list_directory", { directory: prefix, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(page?.items)) throw new Error("APS 文件列表格式无效。");
    for (const raw of page.items) {
      const item = validateItem(raw, prefix);
      const previous = items.get(item.path);
      if (previous && previous.etag !== item.etag) throw new Error("扫描时文件发生变化，请重新预览。");
      items.set(item.path, item);
    }
    onProgress(items.size);
    cursor = page.next_cursor;
    if (cursor != null && cursor !== "" && typeof cursor !== "string") throw new Error("APS 分页游标格式无效。");
    if (cursor && cursors.has(cursor)) throw new Error("APS 分页游标重复，无法确认完整目录。");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  if (cancelled()) throw new Error("扫描已停止，请重新预览。");
  return Object.freeze({ prefix, items: Object.freeze([...items.values()].map(Object.freeze)) });
}

export async function clearSnapshot(invoke, snapshot, confirmation, { onProgress = () => {}, cancelled = () => false } = {}) {
  const prefix = directoryPrefix(snapshot.prefix);
  if (confirmation !== prefix) throw new Error("确认路径必须与预览目录完全一致（包含末尾 /）。");
  // Validate the entire snapshot before the first mutation.
  const items = snapshot.items.map(item => validateItem(item, prefix));
  const results = [];
  for (const item of items) {
    if (cancelled()) break;
    try {
      const result = await invoke("delete_file", { directory: prefix, confirmation, path: item.path, etag: item.etag });
      // Host API documents {deleted:true}; the APS REST bridge returns {ok:true,path}.
      // Accept only an explicit success, and never attribute another path's result here.
      const pathMatches = result?.path === undefined || result.path === item.path;
      const confirmed = result?.deleted === true || (result?.ok === true && result.path === item.path);
      if (!confirmed || !pathMatches || result?.deleted === false || result?.ok === false) {
        throw new Error("服务端未确认删除，请重新扫描核实。");
      }
      results.push({ path: item.path, ok: true });
    } catch (error) {
      results.push({ path: item.path, ok: false, error: error.message || String(error) });
      // Stop on the first error; never retry a destructive request automatically.
      onProgress(results);
      break;
    }
    onProgress(results);
  }
  return results;
}
