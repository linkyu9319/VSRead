/** 保留原始进度精度，只在展示时统一转换为两位小数。 */
export function formatPercentage(value: number | undefined): string {
  const fraction = typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  return `${(fraction * 100).toFixed(2)}%`;
}
