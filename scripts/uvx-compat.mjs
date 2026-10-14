// uvx 兼容垫片（preload，随 --import 注入 CLI 进程）。
// 背景：部分运行环境（如 Kimi 内置运行时）只提供 uv.exe、不提供 uvx.exe，
// 且该 uv 构建不做 "uvx" 多路复用检测（复制为 uvx.exe 仍按 uv 主命令解析）。
// anna-app CLI 的 python bridge 硬编码 spawn("uvx", ["--from", pkg, cmd])，
// 这里在进程级把 uvx 调用改写为完全等价的 `uv tool run`
// （uvx 本身就是 uv tool run 的官方别名）。
// 可用 ANNA_UV_BIN 环境变量指定 uv 路径，默认从 PATH 解析 "uv"。
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const origSpawn = childProcess.spawn;
const UV_BIN = process.env.ANNA_UV_BIN || "uv";

function isUvx(file) {
  const base = String(file).split(/[\\/]/).pop().toLowerCase();
  return base === "uvx" || base === "uvx.exe";
}

childProcess.spawn = function patchedSpawn(file, args, options) {
  if (isUvx(file)) {
    // spawn 签名重载：(file, args?, options?)，args 可能缺省为 options 对象
    const realArgs = Array.isArray(args) ? args : [];
    const realOptions = Array.isArray(args) ? options : args;
    return origSpawn.call(this, UV_BIN, ["tool", "run", ...realArgs], realOptions);
  }
  return origSpawn.call(this, file, args, options);
};

// 关键：ESM `import { spawn } from "node:child_process"` 拿到的是内置模块
// 的 ESM 门面快照，改 module.exports 不会自动同步，必须显式刷新
syncBuiltinESMExports();
