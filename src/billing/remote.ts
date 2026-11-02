/** Go 骨架层认证计费客户端；远程模式下 Node 不接触密钥或台账文件。 */
export function remoteBillingEnabled(): boolean {
  return Boolean(process.env.SLIDEFORGE_BILLING_API_URL?.trim());
}

function internalBaseUrl(): string {
  return process.env.SLIDEFORGE_BILLING_API_URL!.trim().replace(/\/$/, "");
}

export async function callRemoteBilling<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${internalBaseUrl()}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-token": process.env.GATEWAY_INTERNAL_TOKEN ?? "",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json() as { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Go billing API ${response.status}`);
  return payload as T;
}

export async function callRemoteAdmin<T>(path: string, method: "GET" | "POST", body?: unknown): Promise<T> {
  const root = internalBaseUrl().replace(/\/internal$/, "");
  const response = await fetch(`${root}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-admin-token": process.env.SLIDEFORGE_ADMIN_TOKEN ?? "",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json() as { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Go gateway admin API ${response.status}`);
  return payload as T;
}
