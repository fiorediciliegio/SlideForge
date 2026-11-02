/** API key 管理：与 HTTP 服务共用哈希存储、原子写入和迁移逻辑。 */
import { issueKey, listKeys, rechargeKey } from "../src/billing/index.js";

const args = process.argv.slice(2);
const command = args[0];
function argOf(name: string, fallback?: string): string {
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing argument ${name}`);
}

if (command === "issue") {
  const name = argOf("--name");
  const points = Number(argOf("--points", "100"));
  const issued = await issueKey(name, points);
  console.log(`已签发：${issued.key}\nname=${name} · 初始点数=${points}`);
  console.log("原始 key 只显示这一次，请妥善保存。服务端仅保存 SHA-256 哈希。");
  console.log(`客户端调用时带请求头：X-API-Key: ${issued.key}`);
} else if (command === "recharge") {
  const result = await rechargeKey(argOf("--key"), Number(argOf("--points")));
  console.log(`充值完成，当前余额=${result.balance}`);
} else if (command === "list") {
  const keys = await listKeys();
  for (const record of keys) console.log(`${record.key_prefix}…  ${record.name}  余额=${record.balance}`);
  if (!keys.length) console.log("（暂无 key；文件不存在时为本地开发模式，全放行）");
} else {
  console.log("用法：issue --name <名> --points <点数> | recharge --key <原始key或哈希> --points <点数> | list");
}
