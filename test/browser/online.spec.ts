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
    (window as any).__onlineRpc = [];
    window.acquireVsCodeApi = () => ({
      getState: () => JSON.parse(localStorage.getItem('fixture-view') ?? '{}'), setState: value => localStorage.setItem('fixture-view', JSON.stringify(value)),
      postMessage: async ({ id, method, args }: any) => {
        (window as any).__onlineRpc.push({ method, args });
        try {
          let result: any;
          const book = state.books.find((book: any) => book.id === args?.id);
          switch (method) {
            case 'init': result = { version: 1, books: [], settings }; break;
            case 'sources.list': result = state.sources; break;
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
            default: throw new Error(`未模拟的请求 ${method}`);
          }
          localStorage.setItem('online-fixture', JSON.stringify(state));
          const response = structuredClone({ id, result });
          setTimeout(() => window.postMessage(response, '*'), 0);
        } catch (error) { window.postMessage({ id, error: (error as Error).message }, '*'); }
      },
    });
  }, { configuredSource: source });
}

test.beforeEach(async ({ page }) => { await mockOnlineHost(page); await page.goto('/'); });

test('书源导入、搜索、章节缓存、离线重开与进度恢复', async ({ page }) => {
  await page.getByRole('button', { name: '在线书源', exact: true }).click();
  await expect(page.getByRole('region', { name: '书源管理', exact: true })).toBeVisible();
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
  const shelf = page.getByRole('region', { name: '在线书架', exact: true });
  await expect(shelf).toContainText('星海在线');
  await shelf.getByRole('button', { name: '开始阅读', exact: true }).click();
  await expect(page.locator('.online-chapter-content')).toContainText('第一章 星海');
  await page.getByRole('button', { name: '第二章 远航', exact: true }).click();
  await expect(page.locator('.online-chapter-content')).toContainText('第二章 远航');
  await page.getByTestId('online-reading-surface').evaluate(element => { element.scrollTop = 500; element.dispatchEvent(new Event('scroll', { bubbles: true })); });
  await expect(page.locator('.online-reader .page-controls')).toContainText('进度已保存');
  await page.getByLabel('缓存章节数').fill('2');
  await page.getByRole('button', { name: '缓存章节', exact: true }).click();
  await expect(page.locator('.online-message')).toContainText('成功 2 章');
  await page.evaluate(() => { (window as any).__offline = true; });
  await page.getByRole('button', { name: '在线书架', exact: true }).click();
  await shelf.getByRole('button', { name: '继续阅读', exact: true }).click();
  await expect(page.locator('.online-chapter-content')).toContainText('第二章 远航');
  await expect.poll(() => page.getByTestId('online-reading-surface').evaluate(element => element.scrollTop)).toBeGreaterThan(300);
  await expect(page.locator('.online-reader .page-controls')).toContainText('离线缓存');
  await page.getByRole('button', { name: '下一章', exact: true }).click();
  await expect(page.locator('.online-chapter-content')).toContainText('第三章 归途');
  await page.getByRole('button', { name: '在线书架', exact: true }).click();
  await page.screenshot({ path: '.test-data/online-shelf.png' });
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: '在线书源', exact: true }).click();
  await page.getByRole('region', { name: '在线书架', exact: true }).getByRole('button', { name: '继续阅读', exact: true }).click();
  await expect(page.locator('.online-chapter-content')).toContainText('第三章 归途');
  await expect(page.locator('.online-reader .page-controls')).toContainText('进度已保存');
  await page.reload();
  await expect(page.locator('.online-chapter-content')).toContainText('第三章 归途');
});

test('配置链接导入与版本检查入口', async ({ page }) => {
  await page.getByRole('button', { name: '在线书源', exact: true }).click();
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

test('公版示例只导入配置，不自动搜索或下载', async ({ page }) => {
  await page.getByRole('button', { name: '在线书源', exact: true }).click();
  await page.getByRole('button', { name: '公版示例', exact: true }).click();
  await expect(page.locator('.source-import-report')).toContainText('已导入 1 个书源');
  const calls = await page.evaluate(() => (window as any).__onlineRpc as { method: string; args?: { json?: string } }[]);
  const imported = calls.find(call => call.method === 'sources.import');
  expect(JSON.parse(imported!.args!.json!).bookSourceName).toBe('Project Gutenberg');
  expect(calls.some(call => call.method === 'online.search' || call.method === 'online.chapter')).toBe(false);
});
