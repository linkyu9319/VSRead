import { test, expect, type Page } from '@playwright/test';

const source = {
  id: 'e'.repeat(64), name: '测试书源', baseUrl: 'https://fiction.example/', enabled: true,
  searchUrl: '/search?q={{key}}&page={{page}}',
  search: { bookList: '.book', name: '.title@text', bookUrl: 'a@href' },
  toc: { chapterList: '.chapter', chapterName: '@text', chapterUrl: '@href' },
  content: { content: '#content@text' },
};

async function mockOnlineHost(page: Page) {
  await page.addInitScript(({ configuredSource }) => {
    const settings = { theme: 'light', fontSize: 19, lineHeight: 1.9, fontFamily: 'serif', flow: 'scrolled', zoom: 1, backgroundColor: '#faf8f2', textColor: '#302e2a' };
    const state = JSON.parse(localStorage.getItem('online-fixture') ?? '{"sources":[],"books":[]}');
    const localBooks = JSON.parse(localStorage.getItem('local-fixture') ?? '[]');
    (window as any).__onlineRpc = [];
    window.acquireVsCodeApi = () => ({
      getState: () => JSON.parse(localStorage.getItem('fixture-view') ?? '{}'), setState: value => localStorage.setItem('fixture-view', JSON.stringify(value)),
      postMessage: async ({ id, method, args }: any) => {
        (window as any).__onlineRpc.push({ method, args });
        try {
          let result: any;
          const book = state.books.find((book: any) => book.id === args?.id);
          switch (method) {
            case 'init': result = { version: 1, books: localBooks, settings }; break;
            case 'remove': {
              const index = localBooks.findIndex((item: any) => item.id === args.id);
              if (index >= 0) localBooks.splice(index, 1);
              result = { version: 1, books: localBooks, settings }; break;
            }
            case 'sources.list': result = state.sources; break;
            case 'sources.builtin.list': result = []; break;
            case 'sources.builtin.add': throw new Error('此回归未使用内置书源');
            case 'online.list': result = state.books; break;
            case 'sources.import': {
              const imported = args.url ? [configuredSource] : JSON.parse(args.json);
              const values = Array.isArray(imported) ? imported : [imported];
              const rejected = values.filter(item => item.unsupported).map(item => ({ name: item.name, reason: '不支持 JavaScript 规则' }));
              const accepted = values.filter(item => !item.unsupported);
              if (accepted.length) state.sources = [configuredSource];
              result = { sources: state.sources, imported: accepted.length, rejected };
              break;
            }
            case 'sources.toggle': state.sources[0].enabled = args.enabled; result = state.sources; break;
            case 'sources.remove': state.sources = state.sources.filter((item: any) => item.id !== args.id); result = state.sources; break;
            case 'online.search':
              if ((window as any).__failSearch) throw new Error('网络请求超时，请稍后重试');
              if ((window as any).__offline) throw new Error('网络不可用');
              result = [{ sourceId: configuredSource.id, title: '星海在线', author: '测试作者', url: 'https://fiction.example/book/one' }];
              break;
            case 'online.add': {
              let added = state.books.find((item: any) => item.url === args.result.url);
              if (!added) {
                added = { ...args.result, id: 'f'.repeat(64), addedAt: new Date().toISOString(), cachedChapters: [], chapters: ['第一章 星海', '第二章 远航', '第三章 归途'].map((title, index) => ({ id: String(index + 1).repeat(64), title, url: `https://fiction.example/chapter/${index + 1}` })) };
                state.books.push(added);
              }
              result = added; break;
            }
            case 'online.open': result = book; break;
            case 'online.chapter': {
              const cached = book.cachedChapters.includes(args.chapter);
              if (!cached && (window as any).__offline) throw new Error('该章节尚未缓存，离线时无法读取');
              if (!cached) book.cachedChapters.push(args.chapter);
              result = { chapter: book.chapters[args.chapter], text: `${book.chapters[args.chapter].title}\n` + '这是在线获取后保存在本地的纯文本正文。\n'.repeat(100), cached };
              break;
            }
            case 'online.progress': book.progress = { chapter: args.chapter, scroll: args.scroll, updatedAt: new Date().toISOString() }; break;
            case 'online.cache': {
              let cached = 0, failed = 0;
              for (let index = args.from; index < Math.min(book.chapters.length, args.from + args.count); index++) {
                if ((window as any).__offline && !book.cachedChapters.includes(index)) { failed++; continue; }
                if (!book.cachedChapters.includes(index)) book.cachedChapters.push(index);
                cached++;
              }
              result = { cached, failed }; break;
            }
            case 'online.clearCache': book.cachedChapters = []; result = book; break;
            case 'online.remove': state.books = state.books.filter((item: any) => item.id !== args.id); result = state.books; break;
            case 'updates.check': result = { state: 'available', currentVersion: '0.1.2', latestVersion: '0.2.0', releaseUrl: 'https://github.com/linkyu9319/VSRead/releases/tag/v0.2.0', message: '发现新版本 0.2.0' }; break;
            case 'updates.open': (window as any).__releaseOpened = true; break;
            case 'updates.auth': (window as any).__authAction = args.action; break;
            case 'settings': Object.assign(settings, args); break;
            case 'focus': break;
            case 'diagnostics.open': (window as any).__logsOpened = true; break;
            default: throw new Error(`未模拟的请求 ${method}`);
          }
          localStorage.setItem('online-fixture', JSON.stringify(state));
          localStorage.setItem('local-fixture', JSON.stringify(localBooks));
          const response = structuredClone({ id, result });
          setTimeout(() => window.postMessage(response, '*'), 0);
        } catch (error) { window.postMessage({ id, error: (error as Error).message }, '*'); }
      },
    });
  }, { configuredSource: source });
}

test.beforeEach(async ({ page }) => {
  await mockOnlineHost(page); await page.goto('/');
  await expect(page.getByRole('region', { name: '我的书架', exact: true })).toBeVisible();
  await expect(page.locator('.shelf-loading')).toHaveCount(0);
});

test('书源导入、搜索、章节缓存、离线重开与进度恢复', async ({ page }) => {
  await page.getByRole('button', { name: '在线书源', exact: true }).click();
  await expect(page.getByRole('region', { name: '书源管理', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '导入书源', exact: true }).click();
  await page.getByLabel('书源 JSON', { exact: true }).fill(JSON.stringify([source, { name: '脚本书源', unsupported: true }]));
  await page.getByRole('button', { name: '导入书源', exact: true }).click();
  await expect(page.locator('.source-import-report')).toContainText('已导入 1 个书源');
  await expect(page.locator('.source-import-report')).toContainText('不支持 JavaScript');
  await page.getByLabel('启用 测试书源').uncheck();
  await expect(page.getByLabel('启用 测试书源')).not.toBeChecked();
  await expect(page.getByRole('button', { name: '搜索', exact: true })).toBeDisabled();
  await page.getByLabel('启用 测试书源').check();
  await expect(page.getByLabel('启用 测试书源')).toBeChecked();
  await page.getByLabel('搜索书名或作者').fill('星海');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.getByRole('button', { name: '加入书架', exact: true }).click();
  await page.getByRole('button', { name: '查看我的书架', exact: true }).click();
  const shelf = page.getByRole('region', { name: '我的书架', exact: true });
  await expect(shelf).toContainText('星海在线');
  await shelf.getByRole('button', { name: '阅读 星海在线', exact: true }).click();
  await expect(page.locator('.online-chapter-content')).toContainText('第一章 星海');
  await page.getByRole('button', { name: '第二章 远航', exact: true }).click();
  await expect(page.locator('.online-chapter-content')).toContainText('第二章 远航');
  await page.getByTestId('online-reading-surface').evaluate(element => { element.scrollTop = 500; element.dispatchEvent(new Event('scroll', { bubbles: true })); });
  await expect(page.locator('.online-reader .page-controls')).toContainText('进度已保存');
  await page.getByLabel('缓存章节数').fill('2');
  await page.getByRole('button', { name: '缓存章节', exact: true }).click();
  await expect(page.locator('.online-message')).toContainText('成功 2 章');
  await page.evaluate(() => { (window as any).__offline = true; });
  await page.getByRole('region', { name: '在线阅读器', exact: true }).getByRole('button', { name: '返回书架', exact: true }).click();
  await shelf.getByRole('button', { name: '阅读 星海在线', exact: true }).click();
  await expect(page.locator('.online-chapter-content')).toContainText('第二章 远航');
  await expect.poll(() => page.getByTestId('online-reading-surface').evaluate(element => element.scrollTop)).toBeGreaterThan(300);
  await expect(page.locator('.online-reader .page-controls')).toContainText('离线缓存');
  await page.getByRole('button', { name: '下一章', exact: true }).click();
  await expect(page.locator('.online-chapter-content')).toContainText('第三章 归途');
  await page.getByRole('region', { name: '在线阅读器', exact: true }).getByRole('button', { name: '返回书架', exact: true }).click();
  await page.screenshot({ path: '.test-data/online-shelf.png' });
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.reload();
  await page.getByRole('region', { name: '我的书架', exact: true }).getByRole('button', { name: '阅读 星海在线', exact: true }).click();
  await expect(page.locator('.online-chapter-content')).toContainText('第三章 归途');
  await expect(page.locator('.online-reader .page-controls')).toContainText('进度已保存');
  await page.reload();
  await expect(page.locator('.online-chapter-content')).toContainText('第三章 归途');
});

test('配置链接导入与版本检查入口', async ({ page }) => {
  await page.getByRole('button', { name: '在线书源', exact: true }).click();
  await page.getByRole('button', { name: '导入书源', exact: true }).click();
  await page.getByRole('tab', { name: '配置链接', exact: true }).click();
  await page.getByLabel('书源配置链接').fill('https://fiction.example/sources.json');
  await page.getByRole('button', { name: '导入书源', exact: true }).click();
  await expect(page.locator('.source-import-report')).toContainText('已导入 1 个书源');
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '软件更新', exact: true });
  await expect(dialog).toContainText('发现新版本 0.2.0');
  await dialog.getByRole('button', { name: '查看发布页', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__releaseOpened)).toBe(true);
  await dialog.getByRole('button', { name: '配置访问令牌', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__authAction)).toBe('set');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

async function openSavedOnlineBook(page: Page, chapter = 0, scroll = 0) {
  const book = {
    id: 'f'.repeat(64), sourceId: source.id, title: '星海在线', author: '测试作者', url: 'https://fiction.example/book/one',
    addedAt: '2026-11-13T00:00:00.000Z', cachedChapters: [0, 1, 2],
    chapters: ['第一章 星海', '第二章 远航', '第三章 归途'].map((title, index) => ({ id: String(index + 1).repeat(64), title, url: `https://fiction.example/chapter/${index + 1}` })),
    progress: { chapter, scroll, updatedAt: '2026-11-13T00:00:00.000Z' },
  };
  await page.evaluate(({ source, book }) => localStorage.setItem('online-fixture', JSON.stringify({ sources: [source], books: [book] })), { source, book });
  await page.reload();
  await page.getByRole('region', { name: '我的书架', exact: true }).getByRole('button', { name: '阅读 星海在线', exact: true }).click();
  await expect(page.locator('.online-chapter-content h3')).toHaveText(book.chapters[chapter].title);
  await expect(page.getByRole('button', { name: '刷新本章', exact: true })).toBeEnabled();
}

test('在线章节上下键滚动且输入框保留按键行为', async ({ page }) => {
  await openSavedOnlineBook(page, 0, .35);
  const surface = page.getByTestId('online-reading-surface');
  const before = await surface.evaluate(element => element.scrollTop);
  expect(before).toBeGreaterThan(300);
  await surface.focus();
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => surface.evaluate(element => element.scrollTop)).toBeGreaterThan(before + 20);
  const down = await surface.evaluate(element => element.scrollTop);
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => surface.evaluate(element => element.scrollTop)).toBeLessThan(down - 20);
  await expect(page.locator('.online-chapter-content h3')).toHaveText('第一章 星海');

  const cacheCount = page.getByLabel('缓存章节数');
  await cacheCount.focus();
  const atInput = await surface.evaluate(element => element.scrollTop);
  await page.keyboard.press('ArrowUp');
  await expect(cacheCount).toHaveValue('6');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.online-chapter-content h3')).toHaveText('第一章 星海');
  expect(await surface.evaluate(element => element.scrollTop)).toBe(atInput);
  await page.getByLabel('筛选在线章节').fill('星海');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.online-chapter-content h3')).toHaveText('第一章 星海');
  expect(await surface.evaluate(element => element.scrollTop)).toBe(atInput);
});

test('在线章节末尾连续切章回到章首，重开才恢复保存位置', async ({ page }) => {
  await openSavedOnlineBook(page, 0, 1);
  const surface = page.getByTestId('online-reading-surface');
  await expect.poll(() => surface.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2);
  await page.getByRole('button', { name: '下一章', exact: true }).click();
  await expect(page.locator('.online-chapter-content h3')).toHaveText('第二章 远航');
  await expect.poll(() => surface.evaluate(element => element.scrollTop)).toBe(0);
  await expect(page.locator('.online-reader .page-controls')).toContainText('进度已保存');
  const newChapterPositions = await page.evaluate(() => (window as any).__onlineRpc.filter((call: any) => call.method === 'online.progress' && call.args.chapter === 1).map((call: any) => call.args.scroll));
  expect(newChapterPositions.length).toBeGreaterThan(0);
  expect(newChapterPositions.every((scroll: number) => scroll === 0)).toBe(true);
  await surface.evaluate(element => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event('scroll', { bubbles: true })); });
  await surface.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.online-chapter-content h3')).toHaveText('第三章 归途');
  await expect.poll(() => surface.evaluate(element => element.scrollTop)).toBe(0);
  await surface.evaluate(element => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event('scroll', { bubbles: true })); });
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.online-chapter-content h3')).toHaveText('第二章 远航');
  await expect.poll(() => surface.evaluate(element => element.scrollTop)).toBe(0);
  await surface.evaluate(element => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event('scroll', { bubbles: true })); });
  await page.keyboard.press('PageDown');
  await expect(page.locator('.online-chapter-content h3')).toHaveText('第三章 归途');
  await expect.poll(() => surface.evaluate(element => element.scrollTop)).toBe(0);
  await surface.evaluate(element => { element.scrollTop = 620; element.dispatchEvent(new Event('scroll', { bubbles: true })); });
  await expect(page.locator('.online-reader .page-controls')).toContainText('进度已保存');
  await page.getByRole('region', { name: '在线阅读器', exact: true }).getByRole('button', { name: '返回书架', exact: true }).click();
  await page.getByRole('region', { name: '我的书架', exact: true }).getByRole('button', { name: '阅读 星海在线', exact: true }).click();
  await expect(page.locator('.online-chapter-content h3')).toHaveText('第三章 归途');
  await expect.poll(() => surface.evaluate(element => element.scrollTop)).toBeGreaterThan(580);
  await expect.poll(() => surface.evaluate(element => element.scrollTop)).toBeLessThan(660);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('在线专注模式改变视口后保持章节位置并支持键盘切章', async ({ page }) => {
  await openSavedOnlineBook(page, 1, .4);
  const surface = page.getByTestId('online-reading-surface');
  const ratio = () => surface.evaluate(element => element.scrollTop / Math.max(1, element.scrollHeight - element.clientHeight));
  await expect.poll(ratio).toBeGreaterThan(.395);
  await expect.poll(ratio).toBeLessThan(.405);
  await page.getByRole('button', { name: '专注阅读', exact: true }).click();
  await expect(page.locator('.app')).toHaveAttribute('data-focus', 'true');
  await expect(page.locator('.online-toc')).not.toBeVisible();
  await expect.poll(ratio).toBeGreaterThan(.395);
  await expect.poll(ratio).toBeLessThan(.405);
  await surface.focus();
  await page.keyboard.press('ArrowDown');
  await expect.poll(ratio).toBeGreaterThan(.405);
  await surface.evaluate(element => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event('scroll', { bubbles: true })); });
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.online-chapter-content h3')).toHaveText('第三章 归途');
  await expect.poll(() => surface.evaluate(element => element.scrollTop)).toBe(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('.app')).not.toHaveAttribute('data-focus', 'true');
  await expect(page.locator('.online-toc')).toBeVisible();
  await expect.poll(() => surface.evaluate(element => element.scrollTop)).toBe(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('我的书架混排本地与在线书籍，继续阅读与移除互不影响', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('local-fixture', JSON.stringify([
    { id: 'a'.repeat(64), format: 'txt', title: '本地星海', importedAt: '2026-11-12T00:00:00.000Z', size: 100 },
    { id: 'b'.repeat(64), format: 'pdf', title: '本地远航', importedAt: '2026-11-11T00:00:00.000Z', size: 100 },
  ])));
  await openSavedOnlineBook(page, 1, .25);
  await page.getByRole('button', { name: '我的书架', exact: true }).click();
  const shelf = page.getByRole('region', { name: '我的书架', exact: true });
  await expect(shelf.locator('.book-card')).toHaveCount(3);
  await expect(shelf.locator('.shelf-summary')).toHaveText('本地 2 本 · 在线 1 本');
  const online = shelf.locator('[data-book-kind="online"]');
  await expect(online).toContainText('在线 · 测试书源');
  await expect(online).toContainText('已缓存 3 / 3 章');
  await expect(online).toContainText('继续阅读');
  await page.screenshot({ path: '.test-data/unified-shelf.png' });
  await shelf.getByRole('button', { name: '阅读 星海在线', exact: true }).click();
  await expect(page.locator('.online-chapter-content h3')).toHaveText('第二章 远航');
  await page.getByRole('region', { name: '在线阅读器', exact: true }).getByRole('button', { name: '返回书架', exact: true }).click();
  await shelf.getByRole('button', { name: '移除 本地星海', exact: true }).click();
  await expect(shelf.locator('.book-card')).toHaveCount(2);
  await expect(online).toContainText('星海在线');
  await expect(shelf).toContainText('本地远航');
  await shelf.getByRole('button', { name: '移除在线书籍 星海在线', exact: true }).click();
  await shelf.getByRole('button', { name: '取消', exact: true }).click();
  await expect(online).toHaveCount(1);
  await shelf.getByRole('button', { name: '移除在线书籍 星海在线', exact: true }).click();
  await shelf.getByRole('button', { name: '确定移除', exact: true }).click();
  await expect(shelf.locator('.book-card')).toHaveCount(1);
  await expect(shelf).toContainText('本地远航');
  await expect(shelf.locator('.shelf-summary')).toHaveText('本地 1 本 · 在线 0 本');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('online-fixture')!).sources.length)).toBe(1);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('书源报错可从错误提示直接打开本地诊断日志', async ({ page }) => {
  await page.getByRole('button', { name: '在线书源', exact: true }).click();
  await page.getByRole('button', { name: '导入书源', exact: true }).click();
  await page.getByLabel('书源 JSON', { exact: true }).fill(JSON.stringify(source));
  await page.getByRole('button', { name: '导入书源', exact: true }).click();
  await expect(page.locator('.source-import-report')).toContainText('已导入 1 个书源');
  await page.evaluate(() => { (window as any).__failSearch = true; });
  await page.getByLabel('搜索书名或作者').fill('超时测试');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('网络请求超时');
  await page.getByRole('alert').getByRole('button', { name: '查看日志', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__logsOpened)).toBe(true);
});
