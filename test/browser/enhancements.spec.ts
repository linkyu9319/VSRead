import { test, expect, type Page } from '@playwright/test';

const sourceA = {
  id: 'e'.repeat(64), name: '源甲', baseUrl: 'https://a.example/', enabled: true,
  searchUrl: '/search?q={{key}}&page={{page}}',
  search: { bookList: '.book', name: '.title@text', bookUrl: 'a@href' },
  toc: { chapterList: '.chapter', chapterName: '@text', chapterUrl: '@href' },
  content: { content: '#content@text' },
};
const sourceB = {
  ...sourceA, id: 'd'.repeat(64), name: '源乙', baseUrl: 'https://b.example/',
};

async function mockEnhancedHost(page: Page) {
  await page.addInitScript(({ sourceA, sourceB }) => {
    const initialLibrary = {
      version: 1,
      settings: {
        theme: 'ide', fontSize: 19, lineHeight: 1.9, maxWidth: 830, paragraphSpacing: 0.8,
        fontFamily: 'serif', flow: 'scrolled', zoom: 1,
        backgroundColor: '#faf8f2', textColor: '#302e2a',
        pdfFilter: 'none', preloadNextChapter: true,
      },
      books: [
        { id: 'a'.repeat(64), format: 'txt', title: '本地星海', author: '作者一', importedAt: '2026-11-12T00:00:00.000Z', size: 1024 },
        { id: 'b'.repeat(64), format: 'epub', title: '远航指南', author: '作者二', importedAt: '2026-11-11T00:00:00.000Z', size: 2048 },
        { id: 'c'.repeat(64), format: 'pdf', title: '架构手册', author: '作者三', importedAt: '2026-11-10T00:00:00.000Z', size: 4096 },
      ],
    };
    const initialOnline = {
      sources: [sourceA, sourceB],
      replaceRules: [] as any[],
      books: [{
        id: 'f'.repeat(64), sourceId: sourceA.id, title: '在线星海', author: '作者甲',
        url: 'https://a.example/book/1', addedAt: '2026-11-13T00:00:00.000Z',
        cachedChapters: [0],
        chapters: ['第一章 启程', '第二章 迷雾港口', '第三章 远航'].map((title, index) => ({
          id: String(index + 1).repeat(64), title, url: `https://a.example/c/${index + 1}`,
        })),
        progress: { chapter: 0, scroll: 0, updatedAt: '2026-11-13T00:00:00.000Z' },
      }],
    };
    const library = JSON.parse(localStorage.getItem('enh-library') ?? JSON.stringify(initialLibrary));
    const online = JSON.parse(localStorage.getItem('enh-online') ?? JSON.stringify(initialOnline));
    const jobs: Record<string, any> = {};
    (window as any).__rpcCalls = [];

    const textData = async () => {
      const text = await (await fetch('/fixtures/demo.txt')).text();
      const middle = text.indexOf('第二章');
      return {
        text,
        index: {
          encoding: 'utf-8', length: text.length, parts: [
            { index: 0, title: '第一章 星海', start: 0, end: middle, chapter: true },
            { index: 1, title: '第二章 远航', start: middle, end: text.length, chapter: true },
          ],
        },
      };
    };

    window.acquireVsCodeApi = () => ({
      getState: () => ({}), setState: () => {},
      postMessage: async ({ id, method, args }: any) => {
        (window as any).__rpcCalls.push({ method, args });
        try {
          let result: any;
          const localBook = args?.id && library.books.find((item: any) => item.id === args.id);
          const onlineBook = args?.id && online.books.find((item: any) => item.id === args.id);
          switch (method) {
            case 'init': result = library; break;
            case 'open':
              library.lastBookId = localBook.id;
              result = { book: localBook, ...(localBook.format === 'txt' ? { textIndex: (await textData()).index } : {}) };
              break;
            case 'text': {
              const { text, index } = await textData();
              const part = index.parts[args.part];
              result = { part, text: text.slice(part.start, part.end) };
              break;
            }
            case 'text.search': {
              const { text, index } = await textData();
              const needle = String(args.query).toLocaleLowerCase();
              const hits: any[] = [];
              for (const part of index.parts) {
                const slice = text.slice(part.start, part.end);
                const at = slice.toLocaleLowerCase().indexOf(needle);
                if (at >= 0) hits.push({ part: part.index, offset: part.start + at, title: part.title, snippet: slice.slice(Math.max(0, at - 10), at + 30) });
              }
              result = hits;
              break;
            }
            case 'binary': {
              const bytes = new Uint8Array(await (await fetch('/fixtures/demo.' + localBook.format)).arrayBuffer());
              const part = bytes.subarray(args.offset, args.offset + 512 * 1024);
              let binary = '';
              for (const byte of part) binary += String.fromCharCode(byte);
              result = { base64: btoa(binary), total: bytes.length };
              break;
            }
            case 'progress': localBook.progress = args.progress; break;
            case 'metadata': Object.assign(localBook, args); break;
            case 'settings': library.settings = args; break;
            case 'pin': localBook.pinned = args.pinned || undefined; result = library; break;
            case 'sources.list': result = online.sources; break;
            case 'sources.builtin.list': result = []; break;
            case 'online.list': result = online.books; break;
            case 'online.pin': onlineBook.pinned = args.pinned || undefined; result = onlineBook; break;
            case 'online.open':
              if (onlineBook.newChapters) delete onlineBook.newChapters;
              result = onlineBook;
              break;
            case 'online.chapter': {
              const cached = onlineBook.cachedChapters.includes(args.chapter);
              if (!cached) onlineBook.cachedChapters.push(args.chapter);
              const chapter = onlineBook.chapters[args.chapter];
              const body = `${chapter.title}\n` + '这是测试正文段落内容，用于验证排版、预加载与换源。\n'.repeat(60);
              result = { chapter, text: body, cached };
              break;
            }
            case 'online.progress': onlineBook.progress = { chapter: args.chapter, scroll: args.scroll, updatedAt: new Date().toISOString() }; break;
            case 'online.cacheAll.status': result = { bookId: onlineBook.id, state: 'idle', total: onlineBook.chapters.length, completed: onlineBook.cachedChapters.length, failed: 0, cachedChapters: [...onlineBook.cachedChapters] }; break;
            case 'online.checkUpdates': {
              const target = online.books[0];
              target.chapters.push({ id: '9'.repeat(64), title: '第四章 新章', url: 'https://a.example/c/4' });
              target.newChapters = 1;
              result = { checked: 1, skipped: 0, updated: [{ bookId: target.id, title: target.title, added: 1 }], failed: [], books: online.books };
              break;
            }
            case 'online.searchAll.start': {
              const job = {
                id: 'switch-job-1', query: args.query, state: 'completed', truncated: false,
                sources: args.sourceIds.map((sourceId: string) => ({ sourceId, name: online.sources.find((s: any) => s.id === sourceId)?.name ?? '源', state: 'success', count: 1 })),
                results: [
                  { sourceId: sourceA.id, title: '在线星海', author: '作者甲', url: 'https://a.example/book/1' },
                  { sourceId: sourceB.id, title: '在线星海', author: '作者甲', url: 'https://b.example/book/alt' },
                ],
              };
              jobs[job.id] = job;
              result = job;
              break;
            }
            case 'online.searchAll.status': result = jobs[args.id]; break;
            case 'online.searchAll.cancel': result = jobs[args.id]; break;
            case 'online.switchSource': {
              onlineBook.sourceId = args.result.sourceId;
              onlineBook.url = args.result.url;
              onlineBook.chapters = ['序言', '第一章 启程', '第二章 迷雾港口'].map((title, index) => ({
                id: String(index + 5).repeat(64), title, url: `https://b.example/c/${index}`,
              }));
              onlineBook.cachedChapters = [];
              onlineBook.progress = { chapter: 1, scroll: 0, updatedAt: new Date().toISOString() };
              result = onlineBook;
              break;
            }
            case 'online.exportTxt': result = { exported: true, filePath: 'C:/export/在线星海.txt', exportedChapters: onlineBook.cachedChapters.length, totalChapters: onlineBook.chapters.length }; break;
            case 'replaceRules.list': result = online.replaceRules; break;
            case 'replaceRules.save': {
              const rule = { ...args.rule, id: args.rule.id ?? 'rule-' + (online.replaceRules.length + 1) };
              online.replaceRules = online.replaceRules.some((item: any) => item.id === rule.id)
                ? online.replaceRules.map((item: any) => item.id === rule.id ? rule : item)
                : [...online.replaceRules, rule];
              result = online.replaceRules;
              break;
            }
            case 'replaceRules.toggle':
              online.replaceRules = online.replaceRules.map((item: any) => item.id === args.id ? { ...item, enabled: args.enabled } : item);
              result = online.replaceRules;
              break;
            case 'replaceRules.remove':
              online.replaceRules = online.replaceRules.filter((item: any) => item.id !== args.id);
              result = online.replaceRules;
              break;
            case 'focus': break;
            default: throw new Error(`未模拟的请求 ${method}`);
          }
          localStorage.setItem('enh-library', JSON.stringify(library));
          localStorage.setItem('enh-online', JSON.stringify(online));
          setTimeout(() => window.postMessage(structuredClone({ id, result }), '*'), 0);
        } catch (error) { window.postMessage({ id, error: (error as Error).message }, '*'); }
      },
    });
  }, { sourceA, sourceB });
}

test.beforeEach(async ({ page }) => {
  await mockEnhancedHost(page);
  await page.goto('/');
  await expect(page.getByRole('region', { name: '我的书架', exact: true })).toBeVisible();
});

test('书架筛选、排序、置顶与在线批量检查更新', async ({ page }) => {
  const shelf = page.getByRole('region', { name: '我的书架', exact: true });
  await expect(shelf.locator('.book-card')).toHaveCount(4);

  // 置顶“架构手册”后应排在第一位
  await shelf.getByRole('button', { name: '置顶 架构手册', exact: true }).click();
  await expect(shelf.locator('.book-card').first()).toContainText('架构手册');
  await expect(shelf.locator('.book-card').first()).toContainText('置顶');

  // 分类筛选：仅已置顶
  await page.getByLabel('书籍分类筛选').selectOption('pinned');
  await expect(shelf.locator('.book-card')).toHaveCount(1);
  await expect(shelf.locator('.book-card').first()).toContainText('架构手册');

  // 恢复全部并按关键词筛选
  await page.getByLabel('书籍分类筛选').selectOption('all');
  await page.getByLabel('筛选书架').fill('星海');
  await expect(shelf.locator('.book-card')).toHaveCount(2);
  await page.getByLabel('筛选书架').fill('');

  // 批量检查更新并显示新章徽标
  await shelf.getByRole('button', { name: '检查在线书籍更新', exact: true }).click();
  await expect(shelf.locator('.shelf-notice')).toContainText('1 本有更新（共 +1 章）');
  await expect(shelf.locator('[data-book-kind="online"]')).toContainText('+1 新章');

  // 筛选“有更新”仅展示在线星海
  await page.getByLabel('书籍分类筛选').selectOption('updated');
  await expect(shelf.locator('.book-card')).toHaveCount(1);
  await expect(shelf.locator('.book-card').first()).toContainText('在线星海');
});

test('正文宽度、段间距、TXT/EPUB 书内搜索与 PDF 护眼滤镜', async ({ page }) => {
  // TXT 排版宽度与书内搜索
  await page.getByRole('button', { name: '阅读 本地星海', exact: true }).click();
  await expect(page.locator('.txt-content')).toContainText('第一章 星海');
  await page.getByRole('button', { name: '阅读设置', exact: true }).click();
  await page.getByLabel('正文宽度').fill('640');
  await page.getByLabel('段间距').fill('1.6');
  await expect(page.locator('.txt-content')).toHaveCSS('max-width', '640px');
  await page.keyboard.press('Escape');

  await page.getByLabel('搜索 TXT 文字').fill('远航');
  await page.getByRole('button', { name: '查找', exact: true }).click();
  await page.locator('.search-results > button').first().click();
  await expect(page.locator('.txt-content')).toContainText('第二章 远航');

  // EPUB 书内搜索
  await page.getByRole('button', { name: '我的书架', exact: true }).click();
  await page.getByRole('button', { name: '阅读 远航指南', exact: true }).click();
  await expect(page.frameLocator('.epub-surface iframe').locator('h1')).toHaveText('第一章 星海');
  await page.getByLabel('搜索 EPUB 文字').fill('第二章');
  await page.getByRole('button', { name: '查找', exact: true }).click();
  await page.locator('.search-results > button').first().click();
  await expect(page.frameLocator('.epub-surface iframe').locator('h1')).toHaveText('第二章 远航');

  // PDF 深色反色滤镜
  await page.getByRole('button', { name: '我的书架', exact: true }).click();
  await page.getByRole('button', { name: '阅读 架构手册', exact: true }).click();
  await expect(page.locator('canvas[aria-label="第 1 页"]')).toBeVisible();
  await page.getByRole('button', { name: '阅读设置', exact: true }).click();
  await page.getByLabel('PDF 滤镜').selectOption('dark');
  await expect(page.locator('.pdf-surface')).toHaveAttribute('data-pdf-filter', 'dark');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('在线阅读预加载下一章、换源切换、导出 TXT 与正文净化规则管理', async ({ page }) => {
  await page.getByRole('button', { name: '阅读 在线星海', exact: true }).click();
  await expect(page.locator('.online-chapter-content h3')).toHaveText('第一章 启程');

  // 滚动超过 45% 后自动静默预加载下一章（第 2 章）
  const surface = page.getByTestId('online-reading-surface');
  await surface.evaluate(el => {
    el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * 0.6);
    el.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await expect(page.locator('.online-reader-cache')).toContainText('已缓存 2 / 3 章');

  // 导出已缓存章节为 TXT
  await page.getByRole('button', { name: '导出 TXT', exact: true }).click();
  await expect(page.locator('.online-message')).toContainText('已导出 2 / 3 章为 TXT');

  // 换源：打开换源面板并切换至“源乙”
  await page.getByRole('button', { name: '换源', exact: true }).click();
  const panel = page.getByRole('complementary', { name: '换源选择', exact: true });
  await expect(panel).toContainText('源乙');
  await panel.getByRole('button', { name: '切换至此源', exact: true }).click();
  await expect(page.locator('.online-reader-heading')).toContainText('源乙');
  await expect(page.locator('.online-message')).toContainText('已切换书源');

  // 正文净化规则管理（在线书源页按需展开）
  await page.getByRole('button', { name: '在线书源', exact: true }).click();
  await page.getByRole('button', { name: '管理净化规则', exact: true }).click();
  await page.getByLabel('规则名称').fill('过滤测试广告');
  await page.getByLabel('匹配内容').fill('测试广告词');
  await page.getByRole('button', { name: '添加规则', exact: true }).click();
  const rulesSection = page.getByRole('region', { name: '正文净化规则', exact: true });
  await expect(rulesSection).toContainText('过滤测试广告');
  await rulesSection.getByLabel('启用规则 过滤测试广告').uncheck();
  await expect(rulesSection.getByLabel('启用规则 过滤测试广告')).not.toBeChecked();
  await rulesSection.getByRole('button', { name: '移除规则 过滤测试广告', exact: true }).click();
  await expect(rulesSection).not.toContainText('过滤测试广告');
  await expect(page.getByRole('alert')).toHaveCount(0);
});
