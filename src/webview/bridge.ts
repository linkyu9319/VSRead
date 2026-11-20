import type { Requests, RpcResponse } from '../shared/model';

interface VsCodeApi { postMessage(message: unknown): void; getState(): unknown; setState(value: unknown): void }
declare global { interface Window { acquireVsCodeApi?: () => VsCodeApi } }
const api = window.acquireVsCodeApi?.();
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
// 标签页重建后计数会从头开始，使用会话前缀隔离旧 Host 请求的迟到回复。
const session = crypto.randomUUID();
let sequence = 0;

window.addEventListener('message', event => {
  const response = event.data as RpcResponse;
  if (!response || typeof response !== 'object' || Array.isArray(response) || typeof response.id !== 'string' || 'method' in response || 'event' in response) return;
  const entry = pending.get(response.id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(response.id);
  if ('error' in response) entry.reject(new Error(typeof response.error === 'string' && response.error.trim() ? response.error : '操作失败，请重试。'));
  else entry.resolve(response.result);
});

export function request<K extends keyof Requests>(method: K, args: Requests[K]['args']): Promise<Requests[K]['result']> {
  if (!api) return Promise.reject(new Error('请在 CodeBuddy 或 VS Code 中打开 VSRead。'));
  const id = `vsread-${session}-${++sequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('操作超时，请重新打开阅读器后重试')); }, method === 'import' || method === 'online.cache' || method === 'updates.install' ? 600_000 : 120_000);
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
    try { api.postMessage({ id, method, args }); }
    catch {
      clearTimeout(timer); pending.delete(id);
      reject(new Error('无法发送请求，请重新打开阅读器后重试。'));
    }
  });
}
interface SavedView { view: 'shelf' | 'online'; bookId?: string; onlineBookId?: string; focus?: boolean }
export function savedView(): SavedView {
  const value = api?.getState();
  if (!value || typeof value !== 'object') return { view: 'shelf' };
  const state = value as Record<string, unknown>;
  const id = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
  return { view: state.view === 'online' ? 'online' : 'shelf', bookId: id(state.bookId), onlineBookId: id(state.onlineBookId), focus: state.focus === true };
}
export function rememberBook(id?: string): void { api?.setState({ view: 'shelf', bookId: id, focus: savedView().focus }); }
export function rememberOnline(id?: string): void { api?.setState({ view: 'online', onlineBookId: id, focus: savedView().focus }); }
export function rememberFocus(focus: boolean): void { api?.setState({ ...savedView(), focus }); }
