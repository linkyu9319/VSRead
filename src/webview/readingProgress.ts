const flushers = new Set<() => Promise<void>>();

/** 重载前等待当前阅读器发送尚在防抖队列中的位置，再让 Host 完成落盘。 */
export function registerProgressFlusher(flush: () => Promise<void>): () => void {
  flushers.add(flush);
  return () => { flushers.delete(flush); };
}

export async function flushReadingProgress(): Promise<void> {
  await Promise.all([...flushers].map(flush => flush()));
}
