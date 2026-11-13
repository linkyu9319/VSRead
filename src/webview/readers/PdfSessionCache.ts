interface Entry<T> {
  key: string; weight: number; users: number; touched: number; removed: boolean;
  controller: AbortController; ready: Promise<T>; value?: T;
  timer?: ReturnType<typeof setTimeout>;
}

export interface PdfLease<T> { ready: Promise<T>; release(): void }

/** 只保留少量最近阅读的 PDF；进行中的读取在最后一个使用者离开时取消。 */
export class PdfSessionCache<T> {
  private entries = new Map<string, Entry<T>>();
  constructor(
    private dispose: (value: T) => void | Promise<void>,
    private options: { maxEntries: number; maxWeight: number; idleMs: number; weight?(value: T): number },
  ) {}

  acquire(key: string, weight: number, load: (signal: AbortSignal) => Promise<T>): PdfLease<T> {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { key, weight, users: 0, touched: Date.now(), removed: false, controller: new AbortController(), ready: undefined! };
      const created = entry;
      this.entries.set(key, created);
      created.ready = Promise.resolve().then(() => load(created.controller.signal)).then(value => {
        created.value = value;
        created.weight = this.options.weight?.(value) ?? created.weight;
        if (created.removed) this.disposeValue(value);
        else if (!created.users) this.keepIdle(created);
        else this.trim();
        return value;
      }, error => { this.remove(created); throw error; });
    }
    clearTimeout(entry.timer);
    entry.users++;
    this.trim();
    let released = false;
    return {
      ready: entry.ready,
      release: () => {
        if (released) return;
        released = true;
        entry.users--;
        entry.touched = Date.now();
        if (!entry.users && !entry.removed) {
          if (entry.value === undefined) this.remove(entry);
          else this.keepIdle(entry);
        }
      },
    };
  }

  private keepIdle(entry: Entry<T>): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => { if (!entry.users) this.remove(entry); }, this.options.idleMs);
    // Node 单测中的计时器不应阻止退出；浏览器计时器没有 unref，仍按正常生命周期回收。
    (entry.timer as unknown as { unref?(): void }).unref?.();
    this.trim();
  }

  private trim(): void {
    const idle = [...this.entries.values()].filter(item => !item.users).sort((a, b) => a.touched - b.touched);
    let totalWeight = [...this.entries.values()].reduce((sum, item) => sum + item.weight, 0);
    // 优先保障正在阅读的文档；仅驱逐闲置会话，没有闲置项时允许活动文档暂时超出预算。
    while (idle.length && (this.entries.size > this.options.maxEntries || totalWeight > this.options.maxWeight)) {
      const oldest = idle.shift()!;
      totalWeight -= oldest.weight;
      this.remove(oldest);
    }
  }
  private remove(entry: Entry<T>): void {
    if (entry.removed) return;
    entry.removed = true;
    clearTimeout(entry.timer);
    entry.controller.abort();
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    if (entry.value !== undefined) this.disposeValue(entry.value);
  }
  private disposeValue(value: T): void {
    try { void Promise.resolve(this.dispose(value)).catch(() => undefined); }
    catch { /* 清理失败不应阻塞新文档加载或触发未处理的异步异常。 */ }
  }
  clear(): void { for (const entry of this.entries.values()) this.remove(entry); }
  invalidate(key: string): void { const entry = this.entries.get(key); if (entry) this.remove(entry); }
  get size(): number { return this.entries.size; }
}
