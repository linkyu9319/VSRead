/** 只重试一次幂等 GET 的瞬时连接中断，沿用外层总超时；HTTP 拒绝和取消不重试。 */
export async function retryTransientRequest<T>(send: () => Promise<T>, signal: AbortSignal, onRetry: (code: string) => void): Promise<T> {
  signal.throwIfAborted();
  try { return await send(); }
  catch (error) {
    signal.throwIfAborted();
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== 'ECONNRESET' && code !== 'EPIPE' && code !== 'ERR_STREAM_PREMATURE_CLOSE') throw error;
    onRetry(code);
    signal.throwIfAborted();
    return send();
  }
}
