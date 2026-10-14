// vite build 会清空 bundle/，把 harness 启动时生成的 anna-tool-ids.js 一并删掉，
// 导致运行中的 dev harness 报 "Missing Anna bundled tool id"。
// 构建后从 .anna-tool-ids.cache.js 恢复（harness 每次启动会重新生成权威版本）。
import { copyFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cache = path.join(root, ".anna-tool-ids.cache.js");
const target = path.join(root, "bundle", "anna-tool-ids.js");
if (!existsSync(target) && existsSync(cache)) {
  copyFileSync(cache, target);
  console.log("restored bundle/anna-tool-ids.js from cache");
}
