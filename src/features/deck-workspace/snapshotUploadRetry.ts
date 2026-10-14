/** 限制后台上传尝试次数，避免连接异常时不断创建任务。 */
export const SNAPSHOT_UPLOAD_MAX_RETRIES = 12;

export function snapshotUploadBackoffMs(retry: number): number {
  return Math.min(1500 * retry, 10_000);
}
