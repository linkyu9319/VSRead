import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

type Bridge = Pick<typeof import('../src/webview/bridge'), 'request'>;
interface SentMessage { id: string; method: string; args?: unknown }

// 直接运行生产桥代码；每个 VM 对应一次 Webview 加载，Host 可将旧回复投到新页面。
const bridgeCode = ts.transpileModule(readFileSync(new URL('../src/webview/bridge.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function createView(options: { failSend?: boolean } = {}) {
  const messages: SentMessage[] = [];
  const timers = new Map<number, () => void>();
  const listeners: ((event: { data: unknown }) => void)[] = [];
  let timerId = 0;
  const exported: Record<string, unknown> = {};
  const browser = {
    crypto: webcrypto,
    acquireVsCodeApi: () => ({
      getState: () => undefined, setState: () => {},
      postMessage: (message: SentMessage) => {
        messages.push(message);
        if (options.failSend) throw new Error('private-send-error');
      },
    }),
    addEventListener: (name: string, listener: (event: { data: unknown }) => void) => {
      if (name === 'message') listeners.push(listener);
    },
  };
  const context = vm.createContext({
    exports: exported, module: { exports: exported }, window: browser, crypto: webcrypto,
    setTimeout: (callback: () => void) => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
  });
  vm.runInContext(bridgeCode, context, { filename: 'bridge.cjs' });
  return {
    bridge: exported as unknown as Bridge, messages, timers,
    deliver: (data: unknown) => { for (const listener of listeners) listener({ data }); },
  };
}

const checkResult = { state: 'available', currentVersion: '0.1.12', latestVersion: '0.2.2', message: '发现新版本 0.2.2' };
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

test('Webview 重载后旧会话的 void 回复不会提前结束新版本检查', async () => {
  const oldView = createView();
  const oldSave = oldView.bridge.request('progress', {
    id: 'a'.repeat(64),
    progress: { position: { format: 'txt', offset: 42 }, percentage: .42, updatedAt: '2026-11-20T00:00:00.000Z' },
  });
  const oldId = oldView.messages[0].id;
  const newView = createView();
  const checking = newView.bridge.request('updates.check', undefined);
  const newId = newView.messages[0].id;
  assert.notEqual(newId, oldId, '每次加载的首个请求也必须拥有独立 ID');
  assert(newId.length <= 100, 'Host 的请求 ID 校验上限为 100');
  let settled = false;
  void checking.then(() => { settled = true; });

  newView.deliver({ id: oldId });
  await tick();
  assert.equal(settled, false);
  assert.equal(newView.timers.size, 1);
  newView.deliver({ id: newId, result: checkResult });
  assert.equal(await checking, checkResult);
  assert.equal(newView.timers.size, 0);

  oldView.deliver({ id: oldId });
  assert.equal(await oldSave, undefined);
  assert.equal(oldView.timers.size, 0);
});

test('同 ID 的请求回声和事件消息不能冒充 RPC 结果', async () => {
  const view = createView();
  const checking = view.bridge.request('updates.check', undefined);
  const sent = view.messages[0];
  let settled = false;
  void checking.then(() => { settled = true; });
  view.deliver(sent);
  view.deliver({ id: sent.id, event: 'focus', result: undefined });
  await tick();
  assert.equal(settled, false);
  assert.equal(view.timers.size, 1);
  view.deliver({ id: sent.id, result: checkResult });
  assert.equal(await checking, checkResult);
  assert.equal(view.timers.size, 0);
});

test('只包含 ID 的合法 void 回复仍可完成保存类 RPC', async () => {
  const view = createView();
  const saving = view.bridge.request('focus', { enabled: false });
  view.deliver({ id: view.messages[0].id });
  assert.equal(await saving, undefined);
  assert.equal(view.timers.size, 0);
});

test('同步发送失败及时拒绝并清理超时，不暴露底层异常', async () => {
  const view = createView({ failSend: true });
  await assert.rejects(view.bridge.request('updates.check', undefined), (error: unknown) => {
    const message = (error as Error).message;
    assert.match(message, /无法发送请求/);
    assert(!message.includes('private-send-error'));
    return true;
  });
  assert.equal(view.timers.size, 0);
  // 发送失败后即使 Host 返回同 ID 消息，也不应留下可被再次消费的请求。
  view.deliver({ id: view.messages[0].id, result: checkResult });
  assert.equal(view.timers.size, 0);
});

test('空白或畸形错误回复返回明确失败，不会被当作成功的空结果', async () => {
  for (const error of ['', '   ', {}, null]) {
    const view = createView();
    const checking = view.bridge.request('updates.check', undefined);
    view.deliver({ id: view.messages[0].id, error });
    await assert.rejects(checking, /操作失败/);
    assert.equal(view.timers.size, 0);
  }
});
