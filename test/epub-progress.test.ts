import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateEpubProgress } from '../src/webview/readers/epubProgress';

test('EPUB 未建立全书字符索引时，章内翻页也推进百分比', () => {
  const location = (page: number) => ({ start: { cfi: 'epubcfi(test)', index: 2, percentage: 0, displayed: { page, total: 10 } } });
  assert.equal(estimateEpubProgress(location(1), 10), .2);
  assert.equal(estimateEpubProgress(location(6), 10), .25);
  assert(estimateEpubProgress(location(10), 10) < .3);
});

test('EPUB 保留引擎已提供的真实百分比，并处理首尾和无效分页值', () => {
  assert.equal(estimateEpubProgress({ start: { cfi: '', index: 5, percentage: 0 } }, 10, true), 0);
  assert.equal(estimateEpubProgress({ start: { cfi: '', index: 5, percentage: .5234 } }, 10, true), .5234);
  assert.equal(estimateEpubProgress({ atEnd: true }, 10), 1);
  assert.equal(estimateEpubProgress({ start: { cfi: '', index: 0, displayed: { page: 0, total: 0 } } }, 10), 0);
  assert.equal(estimateEpubProgress({}, NaN), 0);
});
