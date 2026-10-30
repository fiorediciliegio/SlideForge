/**
 * 极简 .env 加载（无第三方依赖）：文件存在则逐行注入 process.env（已有值不覆盖）。
 * 与 systemd EnvironmentFile 行为一致，便于本机彩排与云部署共用一份配置。
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

export function loadDotEnv(): void {
  const file = path.resolve(process.cwd(), ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && !(key in process.env)) process.env[key] = value;
  }
}
