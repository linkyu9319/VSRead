import type { Progress } from '../shared/model';

/** 合并滚动事件，但切书、隐藏窗口和销毁前立即发送最后位置。 */
export class ProgressWriter {
  private pending = new Map<string, { value: Progress; revision: number }>();
  private revisions = new Map<string, number>();
  private timer?: ReturnType<typeof setTimeout>;
  private running: Promise<void> = Promise.resolve();
  constructor(private send: (id: string, progress: Progress) => Promise<void>, private report: (error?: unknown) => void) {}
  put(id: string, progress: Progress): void {
    const revision = (this.revisions.get(id) ?? 0) + 1;
    this.revisions.set(id, revision);
    this.pending.set(id, { value: progress, revision });
    if (!this.timer) this.timer = setTimeout(() => { void this.flush(); }, 250);
  }
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const batch = [...this.pending];
    this.pending.clear();
    this.running = this.running.then(async () => {
      for (const [id, entry] of batch) {
        try {
          await this.send(id, entry.value);
          if (this.revisions.get(id) === entry.revision) this.report();
        }
        catch (error) {
          // 较新位置可能已经排队；只有当前版本失败才能重试，避免旧位置覆盖新位置。
          if (this.revisions.get(id) === entry.revision) {
            this.pending.set(id, entry);
            this.report(error);
          }
        }
      }
    });
    return this.running;
  }
}
