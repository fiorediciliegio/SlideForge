/** 有界异步任务队列：保护 LLM、Chrome 与内存，避免请求直接放大为生成并发。 */
export class QueueFullError extends Error {
  constructor() {
    super("生成队列已满，请稍后重试");
    this.name = "QueueFullError";
  }
}

interface QueuedTask {
  run: () => Promise<unknown>;
}

export class AsyncJobQueue {
  private readonly pending: QueuedTask[] = [];
  private active = 0;

  constructor(
    readonly concurrency: number,
    readonly maxPending: number,
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("queue concurrency 必须为正整数");
    if (!Number.isInteger(maxPending) || maxPending < 0) throw new Error("queue maxPending 必须为非负整数");
  }

  enqueue(run: () => Promise<void>): void {
    if (this.pending.length >= this.maxPending) throw new QueueFullError();
    this.pending.push({ run });
    this.drain();
  }

  /** HTTP / MCP 重操作等待结果时仍占用同一容量名额。 */
  submit<T>(run: () => Promise<T>): Promise<T> {
    if (this.pending.length >= this.maxPending) return Promise.reject(new QueueFullError());
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        run: async () => {
          try { resolve(await run()); } catch (error) { reject(error); }
        },
      });
      this.drain();
    });
  }

  get stats(): { active: number; pending: number; concurrency: number; maxPending: number } {
    return {
      active: this.active,
      pending: this.pending.length,
      concurrency: this.concurrency,
      maxPending: this.maxPending,
    };
  }

  private drain(): void {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const task = this.pending.shift()!;
      this.active++;
      void task.run().catch(() => undefined).finally(() => {
        this.active--;
        this.drain();
      });
    }
  }
}
