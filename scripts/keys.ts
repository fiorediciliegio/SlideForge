/**
 * API key 管理：签发 / 充值 / 列表。
 *
 * 用法：
 *   node --import tsx/esm scripts/keys.ts issue --name "张三" --points 200
 *   node --import tsx/esm scripts/keys.ts recharge --key sk-xxx --points 100
 *   node --import tsx/esm scripts/keys.ts list
 */
import path from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";

const DATA_DIR = path.resolve(import.meta.dirname, "..", "data");
const KEYS_FILE = path.join(DATA_DIR, "api-keys.json");

type KeyStore = Record<string, { name: string; balance: number }>;

async function readKeys(): Promise<KeyStore> {
  if (!existsSync(KEYS_FILE)) return {};
  return JSON.parse(await readFile(KEYS_FILE, "utf8")) as KeyStore;
}

async function writeKeys(keys: KeyStore): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(KEYS_FILE, JSON.stringify(keys, null, 2), "utf8");
}

const args = process.argv.slice(2);
const command = args[0];
function argOf(name: string, fallback?: string): string {
  const idx = args.indexOf(name);
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing argument ${name}`);
}

const keys = await readKeys();

if (command === "issue") {
  const name = argOf("--name");
  const points = Number(argOf("--points", "100"));
  const key = `sk-${randomBytes(16).toString("hex")}`;
  keys[key] = { name, balance: points };
  await writeKeys(keys);
  console.log(`已签发：${key}\nname=${name} · 初始点数=${points}`);
  console.log("客户端调用时带请求头：X-API-Key: " + key);
} else if (command === "recharge") {
  const key = argOf("--key");
  const points = Number(argOf("--points"));
  if (!keys[key]) throw new Error(`key 不存在：${key}`);
  keys[key].balance += points;
  await writeKeys(keys);
  console.log(`已充值 ${points} 点，当前余额=${keys[key].balance}`);
} else if (command === "list") {
  for (const [key, record] of Object.entries(keys)) {
    console.log(`${key.slice(0, 10)}…  ${record.name}  余额=${record.balance}`);
  }
  if (Object.keys(keys).length === 0) console.log("（暂无 key；文件不存在时为本地开发模式，全放行）");
} else {
  console.log("用法：issue --name <名> --points <点数> | recharge --key <key> --points <点数> | list");
}
