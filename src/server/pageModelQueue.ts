export interface PageModelIdentity { owner: string; project: string }
type Pending = { resolve: (release: () => void) => void; cleanup: () => void };
type Owner = { projects: Map<string, Pending[]>; order: string[] };

/** One logical business Node; only actual page-model requests consume slots. */
export class PageModelQueue {
  private active = 0;
  private owners = new Map<string, Owner>();
  private order: string[] = [];
  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("PAGE_MODEL_CONCURRENCY 必须为正整数");
  }
  get stats() {
    let pending = 0;
    for (const owner of this.owners.values()) for (const items of owner.projects.values()) pending += items.length;
    return { active: this.active, pending, capacity: this.capacity };
  }
  acquire(identity: PageModelIdentity, signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      let owner = this.owners.get(identity.owner);
      if (!owner) { owner = { projects: new Map(), order: [] }; this.owners.set(identity.owner, owner); this.order.push(identity.owner); }
      let items = owner.projects.get(identity.project);
      if (!items) { items = []; owner.projects.set(identity.project, items); owner.order.push(identity.project); }
      const cancel = () => {
        const index = items!.indexOf(item);
        if (index < 0) return;
        items!.splice(index, 1); this.removeEmpty(identity.owner, identity.project); item.cleanup(); reject(signal!.reason); this.drain();
      };
      const item: Pending = { resolve, cleanup: () => signal?.removeEventListener("abort", cancel) };
      items.push(item); signal?.addEventListener("abort", cancel, { once: true }); this.drain();
    });
  }
  private removeEmpty(ownerId: string, projectId: string) {
    const owner = this.owners.get(ownerId)!;
    if (!owner.projects.get(projectId)!.length) { owner.projects.delete(projectId); owner.order = owner.order.filter(id => id !== projectId); }
    if (!owner.order.length) { this.owners.delete(ownerId); this.order = this.order.filter(id => id !== ownerId); }
  }
  private drain() {
    while (this.active < this.capacity && this.order.length) {
      const ownerId = this.order.shift()!, owner = this.owners.get(ownerId)!;
      const projectId = owner.order.shift()!, items = owner.projects.get(projectId)!, item = items.shift()!;
      if (items.length) owner.order.push(projectId); else owner.projects.delete(projectId);
      if (owner.order.length) this.order.push(ownerId); else this.owners.delete(ownerId);
      item.cleanup(); this.active++;
      let released = false;
      item.resolve(() => { if (released) return; released = true; this.active--; this.drain(); });
    }
  }
}

let shared: PageModelQueue | undefined;
export const pageModelQueue = () => shared ??= new PageModelQueue(Number(process.env.PAGE_MODEL_CONCURRENCY ?? 12));
