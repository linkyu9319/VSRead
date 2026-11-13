import test from 'node:test';
import assert from 'node:assert/strict';
import { OnlineProgressWriter } from '../src/webview/onlineProgress';

test('在线章节进度合并为最后一次捕获的位置，离开时可立即flush', async () => {
  const sent: unknown[] = [];
  const writer = new OnlineProgressWriter(async position => { sent.push(position); }, () => {});
  writer.put({ chapter: 2, scroll: .2 });
  writer.put({ chapter: 2, scroll: .7 });
  await writer.flush();
  assert.deepEqual(sent, [{ chapter: 2, scroll: .7 }]);
});

test('在线旧进度延迟失败时不覆盖已经排队的新章节位置', async () => {
  const sent: number[] = [];
  let started!: () => void;
  let fail!: (error: Error) => void;
  const pending = new Promise<void>(resolve => { started = resolve; });
  const writer = new OnlineProgressWriter(async position => {
    sent.push(position.chapter);
    if (position.chapter === 1) {
      started();
      await new Promise<void>((_resolve, reject) => { fail = reject; });
    }
  }, () => {});
  writer.put({ chapter: 1, scroll: .8 });
  const first = writer.flush();
  await pending;
  writer.put({ chapter: 2, scroll: 0 });
  const second = writer.flush();
  fail(new Error('旧位置写入失败'));
  await Promise.all([first, second]);
  await writer.flush();
  assert.deepEqual(sent, [1, 2]);
});
