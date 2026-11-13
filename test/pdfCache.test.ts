import test from 'node:test';
import assert from 'node:assert/strict';
import { PdfSessionCache } from '../src/webview/readers/PdfSessionCache';

test('PDF 文档短时重开复用同一加载结果，引用计数避免销毁活动会话', async () => {
  const disposed: string[] = [];
  let loads = 0;
  const cache = new PdfSessionCache<string>(value => { disposed.push(value); }, { maxEntries: 2, maxWeight: 10, idleMs: 1000 });
  try {
    const first = cache.acquire('a', 1, async () => { loads++; return 'document'; });
    assert.equal(await first.ready, 'document'); first.release();
    const second = cache.acquire('a', 1, async () => { loads++; return 'unexpected'; });
    assert.equal(await second.ready, 'document');
    assert.equal(loads, 1); assert.deepEqual(disposed, []);
    second.release(); second.release();
    assert.equal(cache.size, 1);
  } finally { cache.clear(); }
  assert.deepEqual(disposed, ['document']);
});

test('PDF 尚未完成时离开会取消读取，并允许下一次重新加载', async () => {
  let signal!: AbortSignal;
  let finish!: (value: string) => void;
  const disposed: string[] = [];
  const cache = new PdfSessionCache<string>(value => { disposed.push(value); }, { maxEntries: 2, maxWeight: 10, idleMs: 1000 });
  const first = cache.acquire('a', 1, async input => { signal = input; return new Promise<string>(resolve => { finish = resolve; }); });
  await Promise.resolve();
  first.release();
  assert.equal(signal.aborted, true);
  const second = cache.acquire('a', 1, async () => 'new');
  finish('old'); await first.ready;
  assert.equal(await second.ready, 'new');
  assert.deepEqual(disposed, ['old']);
  second.release(); cache.clear();
  assert.deepEqual(disposed, ['old', 'new']);
});

test('PDF 缓存按数量、字节预算和闲置时间回收', async () => {
  const disposed: number[] = [];
  const cache = new PdfSessionCache<number>(value => { disposed.push(value); }, { maxEntries: 2, maxWeight: 10, idleMs: 15 });
  for (let i = 1; i <= 3; i++) { const lease = cache.acquire(String(i), 4, async () => i); await lease.ready; lease.release(); }
  assert.equal(cache.size, 2);
  assert.deepEqual(disposed, [1]);
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(cache.size, 0);
  assert.deepEqual(disposed.sort(), [1, 2, 3]);
  cache.clear();
});

test('取得第三本 PDF 时立即驱逐闲置旧书，最新活动会话优先', async () => {
  const disposed: number[] = [];
  const cache = new PdfSessionCache<number>(value => { disposed.push(value); }, { maxEntries: 2, maxWeight: 10, idleMs: 1000 });
  try {
    const first = cache.acquire('a', 3, async () => 1); await first.ready; first.release();
    const second = cache.acquire('b', 3, async () => 2); await second.ready; second.release();
    const third = cache.acquire('c', 3, async () => 3);
    assert.equal(cache.size, 2);
    assert.deepEqual(disposed, [1]);
    await third.ready;
    assert.equal(cache.size, 2);
    third.release();
  } finally { cache.clear(); }
});

test('PDF 实际大小更新后立即执行预算，活动大文档离开后回收', async () => {
  const disposed: number[] = [];
  const cache = new PdfSessionCache<number>(value => { disposed.push(value); }, { maxEntries: 5, maxWeight: 10, idleMs: 1000, weight: value => value });
  try {
    const first = cache.acquire('a', 1, async () => 4); await first.ready; first.release();
    const large = cache.acquire('b', 1, async () => 12); await large.ready;
    assert.equal(cache.size, 1);
    assert.deepEqual(disposed, [4]);
    large.release();
    assert.equal(cache.size, 0);
    assert.deepEqual(disposed, [4, 12]);
  } finally { cache.clear(); }
});
