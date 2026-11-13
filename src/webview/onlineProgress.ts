export interface ChapterPosition { chapter: number; scroll: number }

/** 只发送已捕获的位置；过时的失败请求不能覆盖较新的阅读位置。 */
export class OnlineProgressWriter {
  private pending?: { value: ChapterPosition; revision: number };
  private revision = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private running: Promise<void> = Promise.resolve();

  constructor(
    private send: (position: ChapterPosition) => Promise<void>,
    private report: (error?: unknown) => void,
  ) {}

  put(value: ChapterPosition): void {
    this.pending = { value, revision: ++this.revision };
    if (!this.timer) this.timer = setTimeout(() => { void this.flush(); }, 400);
  }

  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const entry = this.pending;
    this.pending = undefined;
    if (!entry) return this.running;
    this.running = this.running.then(async () => {
      try {
        await this.send(entry.value);
        if (entry.revision === this.revision) this.report();
      } catch (error) {
        if (entry.revision === this.revision) {
          this.pending = entry;
          this.report(error);
        }
      }
    });
    return this.running;
  }
}
