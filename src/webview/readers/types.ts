import type { BookRecord, OpenBook, Progress, ReaderSettings, ReadingPosition, TocItem } from '../../shared/model';

export interface SearchHit { id: string; label: string }
export interface ReaderEvents {
  toc(items: TocItem[]): void;
  progress(progress: Progress): void;
  metadata(metadata: Partial<Pick<BookRecord, 'title' | 'author' | 'cover'>>): void;
  error(error: unknown): void;
}
/** 引擎只操作挂载节点，持久化与 IDE API 由上层负责，便于以后适配桌面容器。 */
export interface ReaderAdapter {
  load(source: OpenBook, position?: ReadingPosition): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  goTo(target: string): Promise<void>;
  scroll(direction: -1 | 1): void;
  update(settings: ReaderSettings): void;
  destroy(): void;
  search?(query: string): Promise<SearchHit[]>;
}
export function progress(position: ReadingPosition, percentage: number): Progress {
  return { position, percentage: Math.min(1, Math.max(0, percentage)), updatedAt: new Date().toISOString() };
}
export function readingColors(settings: ReaderSettings): { background: string; foreground: string } {
  if (settings.theme === 'custom') return { background: settings.backgroundColor, foreground: settings.textColor };
  if (settings.theme === 'light') return { background: '#faf8f2', foreground: '#302e2a' };
  if (settings.theme === 'dark') return { background: '#1c2025', foreground: '#d4d7d9' };
  const css = getComputedStyle(document.querySelector('.app') ?? document.body);
  return { background: css.getPropertyValue('--vscode-editor-background').trim() || '#1e2227', foreground: css.getPropertyValue('--vscode-editor-foreground').trim() || '#d7dce2' };
}
