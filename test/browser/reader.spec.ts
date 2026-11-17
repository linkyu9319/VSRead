import { test, expect, type Page } from '@playwright/test';

async function mockHost(page: Page) {
  await page.addInitScript(() => {
    const initial = {
      version: 1, settings: { theme: 'ide', fontSize: 19, lineHeight: 1.9, fontFamily: 'serif', flow: 'scrolled', zoom: 1, backgroundColor: '#faf8f2', textColor: '#302e2a' },
      books: ['txt', 'epub', 'pdf'].map((format, i) => ({ id: String.fromCharCode(97 + i).repeat(64), format, title: `示例 ${format}`, importedAt: '2026-11-12', size: 1024 })),
    };
    let library = JSON.parse(localStorage.getItem('test-library') || JSON.stringify(initial));
    const textData = async () => {
      const text = await (await fetch('/fixtures/demo.txt')).text();
      const middle = text.indexOf('第二章');
      return { text, index: { encoding: 'utf-8', length: text.length, parts: [
        { index: 0, title: '第一章 星海', start: 0, end: middle, chapter: true },
        { index: 1, title: '第二章 远航', start: middle, end: text.length, chapter: true },
      ] } };
    };
    window.acquireVsCodeApi = () => ({
      getState: () => ({}), setState: () => {},
      postMessage: async ({ id, method, args }: any) => {
        let result;
        const book = args?.id && library.books.find((book: any) => book.id === args.id);
        if (method === 'init' || method === 'import') result = library;
        if (method === 'online.list' || method === 'sources.list') result = [];
        if (method === 'open' || method === 'encoding') {
          library.lastBookId = book.id;
          result = { book, ...(book.format === 'txt' ? { textIndex: (await textData()).index } : {}) };
        }
        if (method === 'text') { const { text, index } = await textData(); const part = index.parts[args.part]; result = { part, text: text.slice(part.start, part.end) }; }
        if (method === 'binary') {
          const fixture = book.format === 'pdf' ? (window as any).__pdfFixture || 'demo.pdf' : 'demo.' + book.format;
          const bytes = new Uint8Array(await (await fetch('/fixtures/' + fixture)).arrayBuffer());
          const part = bytes.subarray(args.offset, args.offset + 512 * 1024);
          const reads = ((window as any).__binaryReads ??= []);
          reads.push({ offset: args.offset, length: part.length, total: bytes.length });
          let binary = '';
          for (const byte of part) binary += String.fromCharCode(byte);
          result = { base64: btoa(binary), total: bytes.length };
        }
        if (method === 'progress') book.progress = args.progress;
        if (method === 'metadata') Object.assign(book, args);
        if (method === 'settings') library.settings = args;
        if (method === 'remove') { library.books = library.books.filter((item: any) => item.id !== args.id); result = library; }
        localStorage.setItem('test-library', JSON.stringify(library));
        const payload = structuredClone({ id, result });
        setTimeout(() => window.postMessage(payload, '*'), 0);
      },
    });
  });
}

test.beforeEach(async ({ page }) => { await mockHost(page); await page.goto('/'); });

async function holdEpubNavigation(page: Page, count = 1) {
  await page.evaluate(count => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'srcdoc');
    const set = descriptor?.set;
    if (!descriptor || !set) throw new Error('浏览器不支持 EPUB 导航应答闸门');
    (window as any).__heldEpubFrames = [];
    let remaining = count;
    // 延迟真实 iframe 加载，让输入框、弹层与切换标签页发生在导航完成前。
    Object.defineProperty(HTMLIFrameElement.prototype, 'srcdoc', {
      ...descriptor,
      set(value: string) {
        if (remaining-- > 0) (window as any).__heldEpubFrames.push(() => set.call(this, value));
        else set.call(this, value);
      },
    });
  }, count);
}

async function waitForHeldEpubFrame(page: Page, index = 0) {
  await expect.poll(() => page.evaluate(() => (window as any).__heldEpubFrames.length)).toBeGreaterThan(index);
}

async function releaseEpubFrame(page: Page, index = 0) {
  await page.evaluate(index => (window as any).__heldEpubFrames[index](), index);
}

async function expectReadingFocus(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const engine = document.querySelector('[data-testid="reader-engine"]');
    return document.hasFocus() && !!engine?.contains(document.activeElement);
  })).toBe(true);
}

test('TXT 章节、翻页、偏好和重启恢复', async ({ page }) => {
  await page.getByRole('button', { name: '阅读 示例 txt' }).click();
  await expect(page.locator('.txt-content')).toContainText('第一章 星海');
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect.poll(() => page.locator('.txt-surface').evaluate(element => element.scrollTop)).toBeGreaterThan(100);
  await page.getByRole('button', { name: '第二章 远航', exact: true }).click();
  await expect(page.locator('.txt-content')).toContainText('第二章 远航');
  await page.getByRole('button', { name: '阅读设置', exact: true }).click();
  await page.getByLabel('阅读主题').selectOption('light');
  await page.getByLabel('字号', { exact: true }).fill('24');
  await expect(page.locator('.app')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('.save-indicator')).toContainText('进度已保存');
  await page.reload();
  await expect(page.locator('.txt-content')).toContainText('第二章 远航');
  await expect(page.locator('.txt-content')).toHaveCSS('font-size', '24px');
  await expect(page.locator('.app')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('自定义颜色和精确字号可保存，点外部与 Esc 关闭偏好', async ({ page }) => {
  await page.getByRole('button', { name: '阅读 示例 txt' }).click();
  await expect(page.locator('.txt-content')).toBeVisible();
  await page.getByRole('button', { name: '阅读设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '阅读偏好' });
  await page.getByLabel('阅读主题').selectOption('custom');
  await page.getByLabel('背景颜色', { exact: true }).fill('#cce8cf');
  await page.getByLabel('文字颜色', { exact: true }).fill('#25342a');
  await page.getByLabel('字号数值', { exact: true }).fill('28');
  await expect(settings).toBeVisible();
  await expect(page.locator('.app')).toHaveCSS('background-color', 'rgb(204, 232, 207)');
  await expect(page.locator('.txt-content')).toHaveCSS('color', 'rgb(37, 52, 42)');
  await expect(page.locator('.txt-content')).toHaveCSS('font-size', '28px');
  await page.screenshot({ path: '.test-data/preferences-0.1.2.png' });
  await page.locator('.settings-dismiss').click({ position: { x: 30, y: 190 } });
  await expect(settings).toHaveCount(0);
  await page.getByRole('button', { name: '阅读设置', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  await expect(page.getByRole('button', { name: '阅读设置', exact: true })).toBeFocused();
  await page.reload();
  await expect(page.locator('.txt-content')).toHaveCSS('font-size', '28px');
  await expect(page.locator('.app')).toHaveCSS('background-color', 'rgb(204, 232, 207)');
  await expect(page.locator('.reading-percentage')).toHaveText(/\d+\.\d{2}%/);
  await page.getByRole('button', { name: '我的书架', exact: true }).click();
  await expect(page.locator('.book-card').filter({ hasText: '示例 txt' })).toContainText(/已读 \d+\.\d{2}%/);
});

test('EPUB iframe、内嵌图片样式、脚本隔离及 CFI 恢复', async ({ page }) => {
  await page.getByRole('button', { name: '阅读 示例 epub' }).click();
  const frame = page.frameLocator('.epub-surface iframe');
  await expect(frame.locator('h1')).toHaveText('第一章 星海');
  await expect(frame.locator('h1')).toHaveCSS('color', 'rgb(30, 120, 90)');
  await expect.poll(() => frame.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await expect(frame.locator('script')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__epubScriptRan)).toBeUndefined();
  await page.getByRole('button', { name: '第二章 远航', exact: true }).click();
  await expect(frame.locator('h1')).toHaveText('第二章 远航');
  await expect(page.locator('.save-indicator')).toContainText('进度已保存');
  await expect(page.locator('.reading-percentage')).not.toHaveText('0.00%');
  await page.reload();
  await expect(page.frameLocator('.epub-surface iframe').locator('h1')).toHaveText('第二章 远航');
  await page.getByRole('button', { name: '阅读设置', exact: true }).click();
  await page.getByLabel('阅读方式').selectOption('paginated');
  await page.getByLabel('阅读主题').selectOption('custom');
  await page.getByLabel('背景颜色', { exact: true }).fill('#f4ecd8');
  await page.getByLabel('文字颜色', { exact: true }).fill('#483d2e');
  await page.getByLabel('字号数值', { exact: true }).fill('26');
  const restoredFrame = page.frameLocator('.epub-surface iframe');
  await expect(restoredFrame.locator('body')).toHaveCSS('background-color', 'rgb(244, 236, 216)');
  await expect(restoredFrame.locator('p').first()).toHaveCSS('color', 'rgb(72, 61, 46)');
  await expect(restoredFrame.locator('p').first()).toHaveCSS('font-size', '26px');
  await expect(restoredFrame.locator('h1')).toHaveCSS('color', 'rgb(30, 120, 90)');
  await page.locator('.settings-dismiss').click({ position: { x: 400, y: 300 } });
  await expect(page.getByRole('dialog', { name: '阅读偏好' })).toHaveCount(0);
  await page.getByRole('button', { name: '阅读设置', exact: true }).click();
  await page.getByLabel('阅读主题').selectOption('ide');
  await page.addStyleTag({ content: ':root { --vscode-editor-background: #112233; --vscode-editor-foreground: #ddeeff; }' });
  await page.evaluate(() => document.body.setAttribute('data-vscode-theme-id', 'test-theme'));
  await expect(restoredFrame.locator('body')).toHaveCSS('background-color', 'rgb(17, 34, 51)');
  await expect(restoredFrame.locator('p').first()).toHaveCSS('color', 'rgb(221, 238, 255)');
  await page.getByRole('button', { name: '阅读设置', exact: true }).click();
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('PDF 返回书架再开复用数据，翻页不重新传输全书', async ({ page }) => {
  await page.getByRole('button', { name: '阅读 示例 pdf' }).click();
  await expect(page.locator('canvas[aria-label="第 1 页"]')).toBeVisible();
  await expect(page.locator('.textLayer')).toContainText('VSRead - Page 1');
  const reads = await page.evaluate(() => (window as any).__binaryReads?.length ?? 0);
  expect(reads).toBeGreaterThan(0);
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.locator('.textLayer')).toContainText('VSRead - Page 2');
  await expect(page.locator('.save-indicator')).toContainText('进度已保存');
  await page.getByRole('button', { name: '我的书架', exact: true }).click();
  await page.getByRole('button', { name: '阅读 示例 pdf' }).click();
  await expect(page.locator('canvas[aria-label="第 2 页"]')).toBeVisible();
  await expect(page.locator('.textLayer')).toContainText('VSRead - Page 2');
  expect(await page.evaluate(() => (window as any).__binaryReads.length)).toBe(reads);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('大 PDF 首屏只请求所需片段', async ({ page }) => {
  await page.evaluate(() => { (window as any).__pdfFixture = 'large.pdf'; });
  await page.getByRole('button', { name: '阅读 示例 pdf' }).click();
  await expect(page.locator('.textLayer')).toContainText('VSRead - Page 1');
  const reading = await page.evaluate(() => {
    const reads = (window as any).__binaryReads as { length: number; total: number }[];
    return { transferred: reads.reduce((sum, read) => sum + read.length, 0), total: reads[0].total };
  });
  expect(reading.total).toBeGreaterThan(4 * 1024 * 1024);
  expect(reading.transferred).toBeLessThan(reading.total / 2);
  console.log(`大 PDF 首屏传输 ${reading.transferred} / ${reading.total} 字节`);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('PDF 本地 Worker、文字层、目录、搜索、缩放及页码恢复', async ({ page }) => {
  await page.getByRole('button', { name: '阅读 示例 pdf' }).click();
  await expect(page.locator('canvas[aria-label="第 1 页"]')).toBeVisible();
  await expect(page.locator('.textLayer')).toContainText('VSRead - Page 1');
  await page.getByRole('button', { name: 'Chapter Two', exact: true }).click();
  await expect(page.locator('canvas[aria-label="第 2 页"]')).toBeVisible();
  await page.getByLabel('搜索 PDF 文字').fill('Chapter 3');
  await page.getByRole('button', { name: '查找', exact: true }).click();
  await page.getByRole('button', { name: /第 3 页 ·/ }).click();
  await expect(page.locator('canvas[aria-label="第 3 页"]')).toBeVisible();
  await page.getByRole('button', { name: '关闭搜索结果' }).click();
  await page.getByRole('button', { name: '阅读设置', exact: true }).click();
  await page.getByLabel('PDF 缩放').fill('1.5');
  await expect(page.locator('.textLayer')).toContainText('VSRead - Page 3');
  await expect(page.locator('.save-indicator')).toContainText('进度已保存');
  await page.reload();
  await expect(page.locator('canvas[aria-label="第 3 页"]')).toBeVisible();
  await expect(page.locator('.textLayer')).toContainText('VSRead - Page 3');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('TXT 上下键在章内滚动，末尾右键换章回到章首', async ({ page }) => {
  await page.getByRole('button', { name: '阅读 示例 txt' }).click();
  const surface = page.locator('.txt-surface');
  await expect(page.locator('.txt-content')).toContainText('第一章 星海');
  await surface.focus();
  await expect.poll(() => surface.evaluate(node => node.scrollTop)).toBeLessThan(5);
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => surface.evaluate(node => node.scrollTop)).toBeGreaterThan(90);
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => surface.evaluate(node => node.scrollTop)).toBeLessThan(10);
  await surface.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.txt-content')).toContainText('第一章 星海');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.txt-content')).toContainText('第二章 远航');
  await expect.poll(() => surface.evaluate(node => node.scrollTop)).toBeLessThan(5);
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => surface.evaluate(node => node.scrollTop)).toBeGreaterThan(90);
  await expect(page.locator('.save-indicator')).toContainText('进度已保存');
  const savedOffset = await page.evaluate(() => JSON.parse(localStorage.getItem('test-library')!).books[0].progress.position.offset as number);
  await page.reload();
  await expect(page.locator('.txt-content')).toContainText('第二章 远航');
  await expect.poll(() => page.locator('.txt-surface').evaluate(node => node.scrollTop)).toBeGreaterThan(20);
  const restoredOffset = await page.evaluate(() => JSON.parse(localStorage.getItem('test-library')!).books[0].progress.position.offset as number);
  expect(Math.abs(restoredOffset - savedOffset)).toBeLessThan(60);
});

test('EPUB iframe 上下键滚动当前章，右键切章不继承末尾位置', async ({ page }) => {
  await page.getByRole('button', { name: '阅读 示例 epub' }).click();
  const frame = page.frameLocator('.epub-surface iframe');
  const surface = page.locator('.epub-surface .epub-container');
  await expect(frame.locator('h1')).toHaveText('第一章 星海');
  await frame.locator('h1').click();
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => surface.evaluate(node => node.scrollTop)).toBeGreaterThan(90);
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => surface.evaluate(node => node.scrollTop)).toBeLessThan(10);
  await surface.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await page.keyboard.press('ArrowDown');
  await expect(frame.locator('h1')).toHaveText('第一章 星海');
  await page.keyboard.press('ArrowRight');
  await expect(page.frameLocator('.epub-surface iframe').locator('h1')).toHaveText('第二章 远航');
  await expect.poll(() => surface.evaluate(node => node.scrollTop)).toBeLessThan(5);
  await page.frameLocator('.epub-surface iframe').locator('h1').click();
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => surface.evaluate(node => node.scrollTop)).toBeGreaterThan(90);
  await expect(page.locator('.save-indicator')).toContainText('进度已保存');
  await page.reload();
  await expect(page.frameLocator('.epub-surface iframe').locator('h1')).toHaveText('第二章 远航');
  await expect.poll(() => page.locator('.epub-surface .epub-container').evaluate(node => node.scrollTop)).toBeGreaterThan(20);
});

test('EPUB 滚动模式左键和上一页回到前章章首，连续切章不沿用位置', async ({ page }) => {
  await page.getByRole('button', { name: '阅读 示例 epub' }).click();
  const frame = page.frameLocator('.epub-surface iframe');
  const surface = page.locator('.epub-surface .epub-container');
  const savedCfi = () => page.evaluate(() => JSON.parse(localStorage.getItem('test-library')!).books.find((book: any) => book.format === 'epub').progress?.position.cfi as string | undefined);
  const focusFrame = () => frame.locator('body').evaluate(node => { node.tabIndex = 0; node.focus({ preventScroll: true }); });
  await expect(frame.locator('h1')).toHaveText('第一章 星海');
  await expect.poll(savedCfi).toMatch(/^epubcfi\(/);
  const firstChapterStart = await savedCfi();

  await page.getByRole('button', { name: '第二章 远航', exact: true }).click();
  await expect(frame.locator('h1')).toHaveText('第二章 远航');
  await surface.evaluate(node => { node.scrollTop = (node.scrollHeight - node.clientHeight) * .63; node.dispatchEvent(new Event('scroll')); });
  await expect.poll(() => surface.evaluate(node => node.scrollTop)).toBeGreaterThan(500);
  await focusFrame();
  await page.keyboard.press('ArrowLeft');
  await expect(frame.locator('h1')).toHaveText('第一章 星海');
  await expect.poll(() => surface.evaluate(node => node.scrollTop)).toBeLessThan(5);
  await expect.poll(savedCfi).toBe(firstChapterStart);

  await focusFrame();
  await page.keyboard.press('ArrowRight');
  await expect(frame.locator('h1')).toHaveText('第二章 远航');
  await expect.poll(() => surface.evaluate(node => node.scrollTop)).toBeLessThan(5);
  await surface.evaluate(node => { node.scrollTop = node.scrollHeight; node.dispatchEvent(new Event('scroll')); });
  await page.getByRole('button', { name: '上一页', exact: true }).click();
  await expect(frame.locator('h1')).toHaveText('第一章 星海');
  await expect.poll(() => surface.evaluate(node => node.scrollTop)).toBeLessThan(5);
  await expect.poll(savedCfi).toBe(firstChapterStart);

  await surface.evaluate(node => { node.scrollTop = 650; node.dispatchEvent(new Event('scroll')); });
  await expect.poll(savedCfi).not.toBe(firstChapterStart);
  await focusFrame();
  await page.keyboard.press('ArrowRight');
  await expect(frame.locator('h1')).toHaveText('第二章 远航');
  await expect.poll(() => surface.evaluate(node => node.scrollTop)).toBeLessThan(5);
  await focusFrame();
  await page.keyboard.press('ArrowLeft');
  await expect(frame.locator('h1')).toHaveText('第一章 星海');
  await expect.poll(() => surface.evaluate(node => node.scrollTop)).toBeLessThan(5);
  await expect.poll(savedCfi).toBe(firstChapterStart);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('EPUB iframe 切章保留真实焦点，无需再点击即可连续键盘阅读与目录跳转', async ({ page }) => {
  await page.getByRole('button', { name: '阅读 示例 epub' }).click();
  const frame = page.frameLocator('.epub-surface iframe');
  const surface = page.locator('.epub-surface .epub-container');
  await expect(frame.locator('h1')).toHaveText('第一章 星海');
  await frame.locator('h1').click();
  await expectReadingFocus(page);
  await page.keyboard.press('ArrowRight');
  await expect(frame.locator('h1')).toHaveText('第二章 远航');
  // CDP 可以向已失焦页面强发按键，因此必须同时检查真实 document.hasFocus。
  await expectReadingFocus(page);
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => surface.evaluate(node => node.scrollTop)).toBeGreaterThan(90);
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => surface.evaluate(node => node.scrollTop)).toBeLessThan(10);
  await page.keyboard.press('ArrowLeft');
  await expect(frame.locator('h1')).toHaveText('第一章 星海');
  await expectReadingFocus(page);
  await page.keyboard.press('ArrowRight');
  await expect(frame.locator('h1')).toHaveText('第二章 远航');
  await expectReadingFocus(page);
  await page.getByRole('button', { name: '第一章 星海', exact: true }).click();
  await expect(frame.locator('h1')).toHaveText('第一章 星海');
  await expectReadingFocus(page);
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => surface.evaluate(node => node.scrollTop)).toBeGreaterThan(90);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('EPUB 延迟切章完成不抢回目录搜索焦点，后续导航完成也保持输入', async ({ page }) => {
  await page.getByRole('button', { name: '阅读 示例 epub' }).click();
  const frame = page.frameLocator('.epub-surface iframe');
  await expect(frame.locator('h1')).toHaveText('第一章 星海');
  await holdEpubNavigation(page, 2);
  await page.getByRole('button', { name: '第二章 远航', exact: true }).click();
  await waitForHeldEpubFrame(page);
  await page.getByRole('button', { name: '第一章 星海', exact: true }).click();
  const filter = page.getByLabel('筛选目录', { exact: true });
  await filter.fill('星海');
  await releaseEpubFrame(page);
  await waitForHeldEpubFrame(page, 1);
  await expect(filter).toBeFocused();
  await releaseEpubFrame(page, 1);
  await expect(frame.locator('h1')).toHaveText('第一章 星海');
  await expect(filter).toBeFocused();
  const before = await page.locator('.epub-surface .epub-container').evaluate(node => node.scrollTop);
  await page.keyboard.press('ArrowDown');
  expect(await page.locator('.epub-surface .epub-container').evaluate(node => node.scrollTop)).toBe(before);
});

test('EPUB 切章等待期间打开阅读设置，完成后保留设置控件焦点', async ({ page }) => {
  await page.getByRole('button', { name: '阅读 示例 epub' }).click();
  const frame = page.frameLocator('.epub-surface iframe');
  await expect(frame.locator('h1')).toHaveText('第一章 星海');
  await frame.locator('h1').click();
  await holdEpubNavigation(page);
  await page.keyboard.press('ArrowRight');
  await waitForHeldEpubFrame(page);
  await page.getByRole('button', { name: '阅读设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '阅读偏好', exact: true });
  const font = page.getByLabel('字体', { exact: true });
  await font.focus();
  await releaseEpubFrame(page);
  await expect(frame.locator('h1')).toHaveText('第二章 远航');
  await expect(settings).toBeVisible();
  await expect(font).toBeFocused();
  const consumed = await frame.locator('body').evaluate(node => {
    node.tabIndex = 0;
    node.focus({ preventScroll: true });
    const event = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true });
    node.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(consumed).toBe(false);
  await expect(frame.locator('h1')).toHaveText('第二章 远航');
  await expect(settings).toBeVisible();
});

test('EPUB 等待切章时切到其他标签页，异步完成不夺取焦点', async ({ page, context }) => {
  await page.getByRole('button', { name: '阅读 示例 epub' }).click();
  const frame = page.frameLocator('.epub-surface iframe');
  await expect(frame.locator('h1')).toHaveText('第一章 星海');
  await frame.locator('h1').click();
  await holdEpubNavigation(page);
  await page.keyboard.press('ArrowRight');
  await waitForHeldEpubFrame(page);
  const other = await context.newPage();
  const readerProtocol = await context.newCDPSession(page);
  const otherProtocol = await context.newCDPSession(other);
  try {
    // Playwright 默认把每个页面都模拟为获焦；这里验证真实标签页切换。
    await Promise.all([
      readerProtocol.send('Emulation.setFocusEmulationEnabled', { enabled: false }),
      otherProtocol.send('Emulation.setFocusEmulationEnabled', { enabled: false }),
    ]);
    await other.setContent('<input aria-label="临时工作区输入框" />');
    await other.bringToFront();
    const input = other.getByLabel('临时工作区输入框', { exact: true });
    await input.focus();
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
    await releaseEpubFrame(page);
    await expect(frame.locator('h1')).toHaveText('第二章 远航');
    await expect(input).toBeFocused();
    expect(await page.evaluate(() => document.hasFocus())).toBe(false);
    expect(await other.evaluate(() => document.hasFocus())).toBe(true);
  } finally {
    await Promise.all([readerProtocol.detach(), otherProtocol.detach()]);
    await other.close();
  }
});

test('EPUB 分页模式上一页只退一页，不强制返回章节开头', async ({ page }) => {
  await page.getByRole('button', { name: '阅读 示例 epub' }).waitFor();
  await page.evaluate(() => {
    const library = JSON.parse(localStorage.getItem('test-library')!);
    library.settings.flow = 'paginated';
    localStorage.setItem('test-library', JSON.stringify(library));
  });
  await page.reload();
  await page.getByRole('button', { name: '阅读 示例 epub' }).click();
  const savedCfi = () => page.evaluate(() => JSON.parse(localStorage.getItem('test-library')!).books.find((book: any) => book.format === 'epub').progress?.position.cfi as string | undefined);
  await expect(page.frameLocator('.epub-surface iframe').locator('h1')).toHaveText('第一章 星海');
  await expect.poll(savedCfi).toMatch(/^epubcfi\(/);
  const firstPage = await savedCfi();
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect.poll(savedCfi).not.toBe(firstPage);
  const secondPage = await savedCfi();
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect.poll(savedCfi).not.toBe(secondPage);
  await page.getByRole('button', { name: '上一页', exact: true }).click();
  await expect.poll(savedCfi).toBe(secondPage);
  expect(await savedCfi()).not.toBe(firstPage);
  await expect(page.frameLocator('.epub-surface iframe').locator('h1')).toHaveText('第一章 星海');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('PDF 上下键只滚动当前页，右键下一页从页首显示', async ({ page }) => {
  await page.getByRole('button', { name: '阅读 示例 pdf' }).click();
  const surface = page.locator('.pdf-surface');
  await expect(page.locator('.textLayer')).toContainText('VSRead - Page 1');
  await surface.focus();
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => surface.evaluate(node => node.scrollTop)).toBeGreaterThan(80);
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => surface.evaluate(node => node.scrollTop)).toBeLessThan(10);
  await surface.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.textLayer')).toContainText('VSRead - Page 1');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.textLayer')).toContainText('VSRead - Page 2');
  await expect.poll(() => surface.evaluate(node => node.scrollTop)).toBeLessThan(5);
  await page.getByLabel('搜索 PDF 文字').focus();
  await page.keyboard.press('ArrowDown');
  expect(await surface.evaluate(node => node.scrollTop)).toBeLessThan(5);
});

test('EPUB iframe 专注快捷键支持 Ctrl/Meta，忽略重复且保留当前阅读位置', async ({ page }) => {
  await page.getByRole('button', { name: '阅读 示例 epub' }).click();
  const frame = page.frameLocator('.epub-surface iframe');
  const surface = page.locator('.epub-surface .epub-container');
  await expect(frame.locator('h1')).toHaveText('第一章 星海');
  await page.getByRole('button', { name: '第二章 远航', exact: true }).click();
  await expect(frame.locator('h1')).toHaveText('第二章 远航');
  await expect(page.locator('.save-indicator')).toContainText('进度已保存');
  const initial = await page.evaluate(() => JSON.parse(localStorage.getItem('test-library')!).books[1].progress.position.cfi as string);
  await surface.evaluate(node => { node.scrollTop = 500; });
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('test-library')!).books[1].progress.position.cfi as string)).not.toBe(initial);
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('test-library')!).books[1].progress.position.cfi as string);
  const focusBody = () => frame.locator('body').evaluate(node => { node.tabIndex = 0; node.focus({ preventScroll: true }); });
  await focusBody();
  await page.keyboard.press('Control+Alt+h');
  await expect(page.locator('.app-header')).toBeHidden();
  await expect(frame.locator('h1')).toHaveText('第二章 远航');
  await expect.poll(() => surface.evaluate(node => node.scrollTop)).toBeGreaterThan(100);
  await frame.locator('body').dispatchEvent('keydown', { key: 'h', ctrlKey: true, altKey: true, repeat: true });
  await expect(page.locator('.app-header')).toBeHidden();
  await focusBody();
  await page.keyboard.press('Escape');
  await expect(page.locator('.app-header')).toBeVisible();
  await expect(frame.locator('h1')).toHaveText('第二章 远航');
  await expect.poll(() => surface.evaluate(node => node.scrollTop)).toBeGreaterThan(100);
  await frame.locator('body').dispatchEvent('keydown', { key: 'h', metaKey: true, altKey: true });
  await expect(page.locator('.app-header')).toBeHidden();
  await frame.locator('body').dispatchEvent('keydown', { key: 'Escape', repeat: true });
  await expect(page.locator('.app-header')).toBeHidden();
  await focusBody();
  await page.keyboard.press('Escape');
  await expect(page.locator('.app-header')).toBeVisible();
  await expect(page.locator('.save-indicator')).toContainText('进度已保存');
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('test-library')!).books[1].progress.position.cfi as string);
  expect(after.split('!')[0]).toBe(before.split('!')[0]);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
