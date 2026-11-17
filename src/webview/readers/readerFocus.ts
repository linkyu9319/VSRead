/** 先把旧 iframe 的焦点交给稳定的阅读节点，防止 iframe 销毁时一并丢失键盘焦点。 */
export function focusReadingSurface(surface: HTMLElement): void {
  const document = surface.ownerDocument;
  if (!surface.isConnected || !document.hasFocus() || document.querySelector('[role="dialog"]')) return;
  if (document.activeElement?.closest('input,select,textarea,[contenteditable]:not([contenteditable="false"])')) return;
  // 只在导航开始时同步转交；异步加载期间用户转去其他控件或 IDE 后不再抢回。
  surface.focus({ preventScroll: true });
}
