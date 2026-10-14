import type { PageThumbnail } from "../../api/pageThumbnail";
import { createPreviewPreparationQueue } from "./previewPreparationQueue";

/** Cache transport separately from live images; expiry never unloads a displayed image. */
export function createPageThumbnailCache() {
  const cache = new Map<string, { value: PageThumbnail; until: number }>();
  const pending = new Map<string, Promise<PageThumbnail>>();
  // Collect one React effect batch before starting requests, so DOM order cannot override rail priority.
  const queue = createPreviewPreparationQueue(4, { deferStart: true });
  return (key: string, load: () => Promise<PageThumbnail>, force = false, priority: () => number = () => 0): Promise<PageThumbnail> => {
    if (force) cache.delete(key);
    const existing = cache.get(key);
    if (existing && existing.until > Date.now()) {
      cache.delete(key); cache.set(key, existing);
      return Promise.resolve(existing.value);
    }
    cache.delete(key);
    const running = pending.get(key);
    if (running) return running;
    const request = new Promise<PageThumbnail>((resolve, reject) => {
      queue((release) => {
        void Promise.resolve().then(load).then((value) => {
          const until = value.expires_at ? Date.parse(value.expires_at) - 60_000 : Date.now() + 30 * 60_000;
          if (until > Date.now()) cache.set(key, { value, until });
          while (cache.size > 256 || [...cache.values()].reduce((bytes, entry) => bytes + entry.value.image_url.length * 2, 0) > 16 * 1024 * 1024) {
            cache.delete(cache.keys().next().value!);
          }
          resolve(value);
        }, reject).finally(() => { pending.delete(key); release(); });
      }, priority);
    });
    pending.set(key, request);
    return request;
  };
}
export const loadCachedPageThumbnail = createPageThumbnailCache();
