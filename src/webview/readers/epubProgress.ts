export interface EpubLocation {
  start?: {
    cfi: string;
    index: number;
    percentage?: number;
    displayed?: { page: number; total: number };
  };
  atEnd?: boolean;
}

/** 无全书字符索引时，按章节和当前章虚拟页估算；恢复位置仍以 CFI 为准。 */
export function estimateEpubProgress(location: EpubLocation, spineLength: number, hasLocations = false): number {
  if (location.atEnd) return 1;
  const start = location.start;
  if (!start) return 0;
  // epub.js 未生成 locations 时仍会报告 percentage: 0，不能把它当作真实的卷首位置。
  if (hasLocations && typeof start.percentage === 'number' && Number.isFinite(start.percentage)) return Math.min(1, Math.max(0, start.percentage));
  const count = Number.isFinite(spineLength) && spineLength > 0 ? spineLength : 1;
  const index = Number.isFinite(start.index) ? Math.max(0, Math.min(count - 1, start.index)) : 0;
  const page = start.displayed?.page ?? 1;
  const total = start.displayed?.total ?? 1;
  const withinChapter = Number.isFinite(page) && Number.isFinite(total) && total > 0 ? Math.max(0, Math.min(1, (page - 1) / total)) : 0;
  return Math.min(1, (index + withinChapter) / count);
}
