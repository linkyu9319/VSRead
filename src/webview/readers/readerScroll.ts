/** 方向键只移动当前阅读视口，到边界后停住，不隐式翻章。 */
export function scrollReadingSurface(surface: HTMLElement, direction: -1 | 1, lineHeight = 32): void {
  const distance = Math.max(48, Math.min(surface.clientHeight * .3, lineHeight * 3));
  surface.scrollBy({ top: direction * distance, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
}

/** 换章前取消浏览器尚未结束的平滑滚动，避免旧动画把新章重新推到末尾。 */
export function stopReadingScroll(surface: HTMLElement): void {
  surface.scrollTo({ top: surface.scrollTop, left: surface.scrollLeft, behavior: 'instant' });
}

export function resetReadingScroll(surface: HTMLElement, top = 0): void {
  surface.scrollTo({ top, left: 0, behavior: 'instant' });
}
