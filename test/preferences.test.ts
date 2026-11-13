import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPercentage } from '../src/shared/format';
import { normalizeSettings } from '../src/shared/validation';
import { DEFAULT_SETTINGS } from '../src/shared/model';

test('进度统一显示两位小数，保留微小阅读量和边界', () => {
  assert.equal(formatPercentage(.051234), '5.12%');
  assert.equal(formatPercentage(.0001), '0.01%');
  assert.equal(formatPercentage(1), '100.00%');
  assert.equal(formatPercentage(-1), '0.00%');
  assert.equal(formatPercentage(Infinity), '0.00%');
});
test('旧版偏好自动补全颜色，拒绝无效 CSS 并保留合法自定义配置', () => {
  const legacy = normalizeSettings({ theme: 'dark', fontSize: 24 });
  assert.equal(legacy.backgroundColor, DEFAULT_SETTINGS.backgroundColor);
  assert.equal(legacy.fontSize, 24);
  const custom = normalizeSettings({ theme: 'custom', backgroundColor: '#CCE8CF', textColor: '#25342A', fontSize: 28 });
  assert.equal(custom.theme, 'custom');
  assert.equal(custom.backgroundColor, '#cce8cf');
  assert.equal(custom.textColor, '#25342a');
  assert.equal(normalizeSettings({ backgroundColor: 'url(file:///private)', textColor: '#123' }).backgroundColor, DEFAULT_SETTINGS.backgroundColor);
  assert.equal(normalizeSettings({ textColor: 'red;display:none' }).textColor, DEFAULT_SETTINGS.textColor);
});
