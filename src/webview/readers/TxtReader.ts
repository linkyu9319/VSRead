import type { OpenBook, ReaderSettings, ReadingPosition, TextIndex } from '../../shared/model';
import { request } from '../bridge';
import { progress, type ReaderAdapter, type ReaderEvents } from './types';
import { resetReadingScroll, scrollReadingSurface, stopReadingScroll } from './readerScroll';

export class TxtReader implements ReaderAdapter {
  private source!: OpenBook;
  private index!: TextIndex;
  private current = 0;
  private text?: Text;
  private article: HTMLElement;
  private destroyed = false;
  private loading = false;
  private generation = 0;
  private resize: ResizeObserver;
  private lastOffset = 0;
  private frame = 0;
  private viewportWidth = 0;
  private viewportHeight = 0;

  constructor(private container: HTMLElement, private settings: ReaderSettings, private events: ReaderEvents) {
    this.article = document.createElement('article');
    this.article.className = 'txt-content';
    container.className = 'engine-surface txt-surface';
    container.append(this.article);
    container.addEventListener('scroll', this.onScroll, { passive: true });
    this.viewportWidth = container.clientWidth;
    this.viewportHeight = container.clientHeight;
    this.resize = new ResizeObserver(() => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      const changed = width !== this.viewportWidth || height !== this.viewportHeight;
      this.viewportWidth = width;
      this.viewportHeight = height;
      // 首次观察通知不代表尺寸改变，避免首次显示后又把章首对齐到正文行。
      if (changed && !this.loading && this.text) this.restore(this.lastOffset);
    });
    this.resize.observe(container);
    this.update(settings);
  }
  async load(source: OpenBook, position?: ReadingPosition): Promise<void> {
    this.source = source;
    if (!source.textIndex?.parts.length) throw new Error('TXT 章节索引为空');
    this.index = source.textIndex;
    this.events.toc(this.index.parts.map(part => ({ id: String(part.index), label: part.title })));
    const offset = position?.format === 'txt' ? Math.min(position.offset, this.index.length - 1) : 0;
    const part = this.index.parts.find(part => part.start <= offset && part.end > offset) ?? this.index.parts[0];
    await this.show(part.index, offset);
  }
  private async show(index: number, offset?: number, bottom = false): Promise<void> {
    if (!this.index.parts[index] || this.destroyed) return;
    const generation = ++this.generation;
    this.loading = true;
    stopReadingScroll(this.container);
    try {
      const chunk = await request('text', { id: this.source.book.id, part: index });
      if (this.destroyed || generation !== this.generation) return;
      this.current = index;
      this.text = document.createTextNode(chunk.text);
      this.article.replaceChildren(this.text);
      resetReadingScroll(this.container);
      if (bottom) this.container.scrollTop = this.container.scrollHeight;
      else this.restore(offset ?? chunk.part.start);
      this.loading = false;
      this.emit();
    } finally { if (generation === this.generation) this.loading = false; }
  }
  private restore(offset: number): void {
    if (!this.text || !this.index) return;
    const start = this.index.parts[this.current].start;
    if (offset <= start) { resetReadingScroll(this.container); this.lastOffset = start; return; }
    const local = Math.max(0, Math.min(this.text.length - 1, offset - start));
    const range = document.createRange();
    range.setStart(this.text, local);
    range.setEnd(this.text, Math.min(local + 1, this.text.length));
    const rectangle = range.getBoundingClientRect();
    this.container.scrollTop += rectangle.top - this.container.getBoundingClientRect().top - 28;
    this.lastOffset = offset;
  }
  private offset(): number {
    if (!this.text) return 0;
    if (this.container.scrollTop < 2) return this.index.parts[this.current].start;
    const bounds = this.article.getBoundingClientRect();
    const viewport = this.container.getBoundingClientRect();
    const caretDocument = document as Document & { caretRangeFromPoint(x: number, y: number): Range | null };
    const range = caretDocument.caretRangeFromPoint?.(Math.max(viewport.left + 5, bounds.left + 2), viewport.top + 30);
    const local = range?.startContainer === this.text ? range.startOffset : Math.round((this.container.scrollTop / Math.max(1, this.container.scrollHeight - this.container.clientHeight)) * this.text.length);
    return Math.min(this.index.length, this.index.parts[this.current].start + local);
  }
  private emit(): void {
    if (!this.text || this.loading || this.destroyed) return;
    this.lastOffset = this.offset();
    const atEnd = this.current === this.index.parts.length - 1 && this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight < 4;
    this.events.progress(progress({ format: 'txt', offset: this.lastOffset }, atEnd ? 1 : this.lastOffset / this.index.length));
  }
  private onScroll = () => {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.emit());
  };
  async next(): Promise<void> {
    if (this.loading) return;
    if (this.container.scrollTop + this.container.clientHeight >= this.container.scrollHeight - 5) await this.show(this.current + 1);
    else { this.container.scrollTop += this.container.clientHeight * 0.88; this.emit(); }
  }
  async previous(): Promise<void> {
    if (this.loading) return;
    if (this.container.scrollTop < 5) await this.show(this.current - 1, undefined, true);
    else { this.container.scrollTop -= this.container.clientHeight * 0.88; this.emit(); }
  }
  async goTo(target: string): Promise<void> { await this.show(Number(target)); }
  scroll(direction: -1 | 1): void {
    if (!this.destroyed && !this.loading && this.text) scrollReadingSurface(this.container, direction, this.settings.fontSize * this.settings.lineHeight);
  }
  update(settings: ReaderSettings): void {
    const typographyChanged = this.settings.fontSize !== settings.fontSize || this.settings.lineHeight !== settings.lineHeight || this.settings.fontFamily !== settings.fontFamily;
    this.settings = settings;
    this.article.style.fontSize = `${settings.fontSize}px`;
    this.article.style.lineHeight = String(settings.lineHeight);
    this.article.style.fontFamily = settings.fontFamily === 'serif' ? '"Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", SimSun, serif' : 'system-ui, "Microsoft YaHei", sans-serif';
    if (this.text && typographyChanged) this.restore(this.lastOffset);
  }
  destroy(): void {
    // React 清理时容器可能已脱离 DOM，此时重新计算滚动偏移会覆盖有效进度。
    this.destroyed = true;
    this.generation++;
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.container.removeEventListener('scroll', this.onScroll);
    this.container.replaceChildren();
  }
}
