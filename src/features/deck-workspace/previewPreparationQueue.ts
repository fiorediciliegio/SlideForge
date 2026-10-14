/** A shared limit across covers, grids and thumbnail rails. */
export function createPreviewPreparationQueue(limit = 4, options: { deferStart?: boolean } = {}) {
  const waiting: Array<{ start: (release: () => void) => void; cancelled: boolean; priority: () => number }> = [];
  let active = 0;
  let scheduled = false;
  function schedule() {
    if (!options.deferStart) { pump(); return; }
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; pump(); });
  }
  function pump() {
    while (active < limit && waiting.length) {
      waiting.sort((a, b) => a.priority() - b.priority());
      const job = waiting.shift()!;
      if (job.cancelled) continue;
      active++;
      let released = false;
      job.start(() => {
        if (released) return;
        released = true;
        active--;
        schedule();
      });
    }
  }
  return (start: (release: () => void) => void, priority: () => number = () => 0) => {
    const job = { start, cancelled: false, priority };
    waiting.push(job);
    schedule();
    return () => { job.cancelled = true; };
  };
}

export const queuePreviewPreparation = createPreviewPreparationQueue();
