import { test, expect, type Page } from '@playwright/test';

async function mockHost(page: Page) {
  await page.addInitScript(() => {
    const rule = { search: { bookList: '.book', name: '@text', bookUrl: '@href' }, toc: { chapterList: 'a', chapterName: '@text', chapterUrl: '@href' }, content: { content: 'article@text' } };
    const builtinSources = ['中文公版', '多语言图书', '英文公版'].map((name, index) => ({ ...rule, id: String.fromCharCode(97 + index).repeat(64), name, enabled: true, baseUrl: `https://books${index}.example/`, searchUrl: '/search?q={{key}}' }));
    const catalog = builtinSources.map((source, index) => ({ id: `builtin-${index}`, sourceId: source.id, name: source.name, description: `${source.name}的公开图书目录`, language: index === 0 ? 'zh' : 'en', searchUrl: source.searchUrl }));
    const state = JSON.parse(localStorage.getItem('catalog-library') ?? '{"sources":[]}');
    const text = '第一章 星海\n' + '这里是正文，专注模式保持当前阅读位置。\n'.repeat(180);
    const part = { index: 0, title: '第一章 星海', start: 0, end: text.length, chapter: true };
    const book = { id: 'd'.repeat(64), title: '专注模式示例', format: 'txt', importedAt: '2026-11-13', size: text.length };
    const library = { version: 1, books: [book], settings: { theme: 'light', fontSize: 19, lineHeight: 1.9, fontFamily: 'serif', flow: 'scrolled', zoom: 1, backgroundColor: '#faf8f2', textColor: '#302e2a' } };
    (window as any).__catalogRpc = [];
    window.acquireVsCodeApi = () => ({
      getState: () => JSON.parse(localStorage.getItem('catalog-view') ?? '{}'),
      setState: value => localStorage.setItem('catalog-view', JSON.stringify(value)),
      postMessage: ({ id, method, args }: any) => {
        (window as any).__catalogRpc.push({ method, args });
        let result: any;
        switch (method) {
          case 'init': result = library; break;
          case 'open': result = { book, textIndex: { encoding: 'utf-8', length: text.length, parts: [part] } }; break;
          case 'text': result = { part, text }; break;
          case 'sources.list': result = state.sources; break;
          case 'sources.builtin.list': result = catalog; break;
          case 'sources.builtin.add': {
            const source = builtinSources[Number(args.id.split('-')[1])];
            if (!state.sources.some((item: any) => item.id === source.id)) state.sources.push(source);
            result = state.sources; break;
          }
          case 'sources.import': {
            const source = { ...rule, ...JSON.parse(args.json), id: 'e'.repeat(64), enabled: true };
            state.sources.push(source); result = { sources: state.sources, imported: 1, rejected: [] }; break;
          }
          case 'online.list': result = (window as any).__restoreFixture ? [(window as any).__restoreFixture] : []; break;
          case 'online.open': (window as any).__releaseRestore = () => window.postMessage({ id, result: (window as any).__restoreFixture }, '*'); return;
          case 'online.search': result = [{ sourceId: args.sourceId, title: `搜索结果 ${args.query}`, url: 'https://books0.example/book/1' }]; break;
          case 'focus': (window as any).__hostFocus = args.enabled; break;
          case 'progress': (window as any).__savedProgress = args.progress; break;
        }
        localStorage.setItem('catalog-library', JSON.stringify(state));
        setTimeout(() => window.postMessage(structuredClone({ id, result }), '*'), 0);
      },
    });
  });
}

test.beforeEach(async ({ page }) => { await mockHost(page); await page.goto('/'); });

test('顶部搜索直接选择内置书源，保留自定义新增入口且不会自动联网', async ({ page }) => {
  await page.getByRole('button', { name: '在线书源', exact: true }).click();
  const search = page.getByRole('region', { name: '在线搜索', exact: true });
  const manager = page.getByRole('region', { name: '书源管理', exact: true });
  await expect(search).toBeInViewport();
  await expect(page.getByLabel('搜索书源').locator('optgroup[label="内置书源"] option')).toHaveCount(3);
  await expect(page.getByLabel('书源 JSON', { exact: true })).toHaveCount(0);
  expect((await search.boundingBox())!.y).toBeLessThan((await manager.boundingBox())!.y);
  expect(await page.evaluate(() => (window as any).__catalogRpc.some((item: any) => ['sources.builtin.add', 'online.search'].includes(item.method)))).toBe(false);
  await page.getByLabel('搜索书源').selectOption('b'.repeat(64));
  await page.getByLabel('搜索书名或作者').fill('Pride');
  await page.getByLabel('搜索书名或作者').press('Enter');
  await expect(search).toContainText('搜索结果 Pride');
  await expect(manager).toContainText('多语言图书');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__catalogRpc.filter((item: any) => item.method === 'online.search').length)).toBe(2);
  expect(await page.evaluate(() => (window as any).__catalogRpc.filter((item: any) => item.method === 'sources.builtin.add').length)).toBe(1);
  await page.getByRole('button', { name: '新增书源', exact: true }).click();
  await page.getByLabel('书源 JSON', { exact: true }).fill(JSON.stringify({ name: '我的中文书源', baseUrl: 'https://custom.example/', searchUrl: '/?q={{key}}' }));
  await page.getByRole('button', { name: '导入书源', exact: true }).click();
  await expect(page.locator('.source-import-report')).toContainText('已导入 1 个书源');
  await expect(page.getByLabel('搜索书源').locator('optgroup[label="我的书源"] option')).toHaveText('我的中文书源');
  await page.getByLabel('搜索书源').selectOption('e'.repeat(64));
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__catalogRpc.filter((item: any) => item.method === 'online.search').at(-1)?.args.sourceId)).toBe('e'.repeat(64));
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.screenshot({ path: '.test-data/builtin-search.png' });
});

test('一键专注隐藏品牌和工具栏，快捷键恢复并记住模式', async ({ page }) => {
  await page.getByRole('button', { name: '阅读 专注模式示例', exact: true }).click();
  await expect(page.locator('.txt-content')).toBeVisible();
  await page.locator('.txt-surface').evaluate(node => { node.scrollTop = 600; node.dispatchEvent(new Event('scroll')); });
  await page.getByRole('button', { name: '专注阅读', exact: true }).click();
  await expect(page.locator('.app')).toHaveAttribute('data-focus', 'true');
  await expect(page.locator('.app-header')).toBeHidden();
  await expect(page.locator('.reader-toolbar')).toBeHidden();
  await expect(page.locator('.contents-panel')).toBeHidden();
  await expect(page.locator('.page-controls')).toBeHidden();
  await expect(page.locator('.app-status')).toBeHidden();
  await expect(page.locator('.txt-content')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__hostFocus)).toBe(true);
  await expect.poll(() => page.locator('.txt-surface').evaluate(node => node.scrollTop)).toBeGreaterThan(400);
  await page.keyboard.press('Escape');
  await expect(page.locator('.app-header')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__hostFocus)).toBe(false);
  await page.keyboard.press('Control+Alt+h');
  await expect(page.locator('.app-header')).toBeHidden();
  await page.reload();
  await expect(page.locator('.app-header')).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window as any).__hostFocus)).toBe(true);
  await page.locator('.focus-restore').hover();
  await page.getByRole('button', { name: '退出专注阅读', exact: true }).click();
  await expect(page.locator('.app-header')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('返回在线搜索后，迟到的恢复请求不会重新打开旧书', async ({ page }) => {
  await page.addInitScript(() => {
    const id = 'f'.repeat(64);
    (window as any).__restoreFixture = { id, sourceId: 'a'.repeat(64), title: '旧书', url: 'https://books0.example/book/old', addedAt: '2026-11-13', chapters: [], cachedChapters: [] };
    localStorage.setItem('catalog-view', JSON.stringify({ view: 'online', onlineBookId: id }));
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__releaseRestore)).toBe('function');
  await page.getByRole('button', { name: '在线书源', exact: true }).click();
  await expect(page.getByRole('region', { name: '在线搜索', exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).__releaseRestore());
  await expect(page.getByRole('region', { name: '在线搜索', exact: true })).toBeVisible();
  await expect(page.locator('.online-reader')).toHaveCount(0);
});
