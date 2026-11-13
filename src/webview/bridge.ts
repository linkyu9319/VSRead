import type { Requests, RpcResponse } from '../shared/model';

interface VsCodeApi { postMessage(message: unknown): void; getState(): unknown; setState(value: unknown): void }
declare global { interface Window { acquireVsCodeApi?: () => VsCodeApi } }
const api = window.acquireVsCodeApi?.();
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
let sequence = 0;

window.addEventListener('message', event => {
  const response = event.data as RpcResponse;
  if (!response || typeof response.id !== 'string') return;
  const entry = pending.get(response.id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(response.id);
  if (response.error) entry.reject(new Error(response.error));
  else entry.resolve(response.result);
});

export function request<K extends keyof Requests>(method: K, args: Requests[K]['args']): Promise<Requests[K]['result']> {
  if (!api) return Promise.reject(new Error('请在 CodeBuddy 或 VS Code 中打开 VSRead。'));
  const id = `vsread-${++sequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('操作超时，请重新打开阅读器后重试')); }, method === 'import' || method === 'online.cache' ? 600_000 : 120_000);
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
    api.postMessage({ id, method, args });
  });
}
interface SavedView { view: 'shelf' | 'online'; bookId?: string; onlineBookId?: string }
export function savedView(): SavedView {
  const value = api?.getState();
  if (!value || typeof value !== 'object') return { view: 'shelf' };
  const state = value as Record<string, unknown>;
  const id = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
  return { view: state.view === 'online' ? 'online' : 'shelf', bookId: id(state.bookId), onlineBookId: id(state.onlineBookId) };
}
export function rememberBook(id?: string): void { api?.setState({ view: 'shelf', bookId: id }); }
export function rememberOnline(id?: string): void { api?.setState({ view: 'online', onlineBookId: id }); }
