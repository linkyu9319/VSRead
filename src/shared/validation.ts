import { DEFAULT_SETTINGS, type BookFormat, type Progress, type ReaderSettings } from './model';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function boundedNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}
export function normalizeSettings(value: unknown): ReaderSettings {
  const input = isRecord(value) ? value : {};
  return {
    theme: input.theme === 'dark' || input.theme === 'light' || input.theme === 'custom' ? input.theme : 'ide',
    // 只接受颜色值，避免把任意 CSS 表达式写入 Webview 和 EPUB 样式。
    backgroundColor: typeof input.backgroundColor === 'string' && /^#[0-9a-f]{6}$/i.test(input.backgroundColor) ? input.backgroundColor.toLowerCase() : DEFAULT_SETTINGS.backgroundColor,
    textColor: typeof input.textColor === 'string' && /^#[0-9a-f]{6}$/i.test(input.textColor) ? input.textColor.toLowerCase() : DEFAULT_SETTINGS.textColor,
    fontSize: boundedNumber(input.fontSize, 12, 40, DEFAULT_SETTINGS.fontSize),
    lineHeight: boundedNumber(input.lineHeight, 1.2, 3, DEFAULT_SETTINGS.lineHeight),
    fontFamily: input.fontFamily === 'sans-serif' ? 'sans-serif' : 'serif',
    flow: input.flow === 'paginated' ? 'paginated' : 'scrolled',
    zoom: boundedNumber(input.zoom, 0.5, 3, 1),
  };
}
export function validateProgress(value: unknown, format: BookFormat): Progress {
  if (!isRecord(value) || !isRecord(value.position) || value.position.format !== format) {
    throw new Error('阅读位置格式无效');
  }
  const position = value.position;
  if (format === 'txt' && typeof position.offset === 'number' && Number.isSafeInteger(position.offset) && position.offset >= 0) {
    return { position: { format, offset: position.offset }, percentage: boundedNumber(value.percentage, 0, 1, 0), updatedAt: new Date().toISOString() };
  }
  if (format === 'pdf' && typeof position.page === 'number' && Number.isSafeInteger(position.page) && position.page > 0) {
    return { position: { format, page: position.page, scroll: boundedNumber(position.scroll, 0, 1, 0) }, percentage: boundedNumber(value.percentage, 0, 1, 0), updatedAt: new Date().toISOString() };
  }
  if (format === 'epub' && typeof position.cfi === 'string' && position.cfi.startsWith('epubcfi(') && position.cfi.length < 4096) {
    return { position: { format, cfi: position.cfi }, percentage: boundedNumber(value.percentage, 0, 1, 0), updatedAt: new Date().toISOString() };
  }
  throw new Error('阅读位置无效');
}
