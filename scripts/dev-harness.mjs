// dev 启动包装器：anna-app CLI 只认 --port，不认 --host。
// Kimi Work 等平台启动 `npm run dev` 时会追加 --host/--port 参数，
// 这里过滤未知参数，只把端口透传给 anna-app dev，避免 "unknown option" 直接退出。
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(appRoot, "node_modules", "@anna-ai", "cli", "dist", "cli.js");

const args = process.argv.slice(2);
let port = null;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--port" && args[i + 1]) {
    port = args[i + 1];
    i++;
  } else if (arg.startsWith("--port=")) {
    port = arg.slice("--port=".length);
  }
  // --host 及其余未知参数一律丢弃：harness 固定监听 0.0.0.0，host 无意义
}

const cliArgs = ["dev", "--storage", "aps", "--no-watch"];
if (port && /^\d+$/.test(port)) cliArgs.push("--port", port);

// 通过 --import 注入 uvx 兼容垫片：在只有 uv.exe 的环境里把
// CLI 内部的 spawn("uvx", ...) 改写为等价的 `uv tool run`。
// Windows 下 --import 需要 file:// URL，不能直接给绝对路径
const uvxCompat = pathToFileURL(path.join(appRoot, "scripts", "uvx-compat.mjs")).href;

const child = spawn(process.execPath, ["--import", uvxCompat, cliPath, ...cliArgs], {
  cwd: appRoot,
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 0));
