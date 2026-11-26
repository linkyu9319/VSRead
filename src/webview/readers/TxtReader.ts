import type { OpenBook, ReaderSettings, ReadingPosition, TextIndex } from '../../shared/model';
import { request } from '../bridge';
import { progress, type ReaderAdapter, type ReaderEvents, type SearchHit } from './types';
import { resetReadingScroll, scrollReadingSurface, stopReadingScroll } from './readerScroll';

interface TxtParagraph { element: HTMLParagraphElement; text: Text; start: number; end: number }

export class TxtReader implements ReaderAdapter {
  private source!: OpenBook;
  private index!: TextIndex;
  private current = 0;
  private paragraphs: TxtParagraph[] = [];
  private textOffsets = new Map<Node, number>();
  private article: HTMLElement;
  private destroyed = false;
  private loading = false;
  private generation = 0;
  private searchGeneration = 0;
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
      if (changed && !this.loading && this.paragraphs.length) this.restore(this.lastOffset);
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
  private renderParagraphs(text: string): void {
    const fragment = document.createDocumentFragment();
    const paragraphs: TxtParagraph[] = [];
    const offsets = new Map<Node, number>();
    const lines = text.split('\n');
    let cursor = 0;
    for (const line of lines) {
      const start = cursor;
      const end = start + line.length;
      cursor = end + 1;
      if (!line.trim()) continue;
      const p = document.createElement('p');
      p.className = 'txt-para';
      const node = document.createTextNode(line);
      p.append(node);
      fragment.append(p);
      paragraphs.push({ element: p, text: node, start, end });
      offsets.set(node, start);
    }
    if (!paragraphs.length) {
      const p = document.createElement('p');
      p.className = 'txt-para';
      const node = document.createTextNode(text);
      p.append(node);
      fragment.append(p);
      paragraphs.push({ element: p, text: node, start: 0, end: text.length });
      offsets.set(node, 0);
    }
    this.paragraphs = paragraphs;
    this.textOffsets = offsets;
    this.article.replaceChildren(fragment);
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
      this.renderParagraphs(chunk.text);
      resetReadingScroll(this.container);
      if (bottom) this.container.scrollTop = this.container.scrollHeight;
      else this.restore(offset ?? chunk.part.start);
      this.loading = false;
      this.emit();
    } finally { if (generation === this.generation) this.loading = false; }
  }
  private restore(offset: number): void {
    if (!this.paragraphs.length || !this.index) return;
    const partStart = this.index.parts[this.current].start;
    if (offset <= partStart) { resetReadingScroll(this.container); this.lastOffset = partStart; return; }
    const local = Math.max(0, offset - partStart);
    const para = this.paragraphs.find(item => item.end >= local) ?? this.paragraphs[this.paragraphs.length - 1];
    const within = Math.max(0, Math.min(para.text.length - 1, local - para.start));
    const range = document.createRange();
    range.setStart(para.text, within);
    range.setEnd(para.text, Math.min(within + 1, para.text.length));
    const rectangle = range.getBoundingClientRect();
    this.container.scrollTop += rectangle.top - this.container.getBoundingClientRect().top - 28;
    this.lastOffset = offset;
  }
  private offset(): number {
    if (!this.paragraphs.length) return 0;
    const part = this.index.parts[this.current];
    if (this.container.scrollTop < 2) return part.start;
    const bounds = this.article.getBoundingClientRect();
    const viewport = this.container.getBoundingClientRect();
    const caretDocument = document as Document & { caretRangeFromPoint(x: number, y: number): Range | null };
    const range = caretDocument.caretRangeFromPoint?.(Math.max(viewport.left + 5, bounds.left + 2), viewport.top + 30);
    const paraStart = range?.startContainer ? this.textOffsets.get(range.startContainer) : undefined;
    if (paraStart !== undefined && range) {
      return Math.min(this.index.length, part.start + paraStart + range.startOffset);
    }
    const visible = this.paragraphs.find(item => item.element.getBoundingClientRect().bottom > viewport.top + 28);
    if (visible) return Math.min(this.index.length, part.start + visible.start);
    const length = Math.max(1, part.end - part.start);
    const ratio = this.container.scrollTop / Math.max(1, this.container.scrollHeight - this.container.clientHeight);
    return Math.min(this.index.length, part.start + Math.round(ratio * length));
  }
  private emit(): void {
    if (!this.paragraphs.length || this.loading || this.destroyed) return;
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
  async goTo(target: string): Promise<void> {
    if (target.startsWith('offset:')) {
      const [, part, offset] = target.split(':');
      await this.show(Number(part), Number(offset));
      return;
    }
    await this.show(Number(target));
  }
  async search(query: string): Promise<SearchHit[]> {
    const trimmed = query.trim();
    if (!trimmed || !this.index) return [];
    const token = ++this.searchGeneration;
    try {
      const results = await request('text.search', { id: this.source.book.id, query: trimmed });
      if (this.destroyed || token !== this.searchGeneration) return [];
      return results.map(hit => ({ id: `offset:${hit.part}:${hit.offset}`, label: `${hit.title} · ${hit.snippet}` }));
    } catch {
      // 兼容未实现宿主搜索的浏览器回归环境，回退按分块检索。
      const needle = trimmed.toLocaleLowerCase();
      const hits: SearchHit[] = [];
      for (const part of this.index.parts) {
        if (this.destroyed || token !== this.searchGeneration || hits.length >= 100) break;
        const chunk = await request('text', { id: this.source.book.id, part: part.index });
        if (this.destroyed || token !== this.searchGeneration) break;
        const lower = chunk.text.toLocaleLowerCase();
        let from = 0;
        while (hits.length < 100) {
          const at = lower.indexOf(needle, from);
          if (at < 0) break;
          const snippet = chunk.text.slice(Math.max(0, at - 18), at + trimmed.length + 42).replace(/\s+/g, ' ').trim();
          hits.push({ id: `offset:${part.index}:${part.start + at}`, label: `${part.title} · ${snippet}` });
          from = at + Math.max(1, needle.length);
        }
      }
      return hits;
    }
  }
  scroll(direction: -1 | 1): void {
    if (!this.destroyed && !this.loading && this.paragraphs.length) scrollReadingSurface(this.container, direction, this.settings.fontSize * this.settings.lineHeight);
  }
  update(settings: ReaderSettings): void {
    const typographyChanged = this.settings.fontSize !== settings.fontSize || this.settings.lineHeight !== settings.lineHeight
      || this.settings.fontFamily !== settings.fontFamily || this.settings.maxWidth !== settings.maxWidth
      || this.settings.paragraphSpacing !== settings.paragraphSpacing;
    this.settings = settings;
    this.article.style.fontSize = `${settings.fontSize}px`;
    this.article.style.lineHeight = String(settings.lineHeight);
    this.article.style.maxWidth = `${settings.maxWidth ?? 830}px`;
    this.article.style.setProperty('--para-gap', `${settings.paragraphSpacing ?? 0.8}em`);
    this.article.style.fontFamily = settings.fontFamily === 'serif' ? '"Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", SimSun, serif' : 'system-ui, "Microsoft YaHei", sans-serif';
    if (this.paragraphs.length && typographyChanged) this.restore(this.lastOffset);
  }
  destroy(): void {
    // React 清理时容器可能已脱离 DOM，此时重新计算滚动偏移会覆盖有效进度。
    this.destroyed = true;
    this.generation++;
    this.searchGeneration++;
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.container.removeEventListener('scroll', this.onScroll);
    this.container.replaceChildren();
  }
}
