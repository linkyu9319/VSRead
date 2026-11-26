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
    const jobs = (state.cacheJobs ??= {});
    const snapshot = (book: any) => {
      const job = jobs[book.id] ?? { state: 'idle', failed: 0 };
      return { bookId: book.id, state: job.state, total: book.chapters.length, completed: book.cachedChapters.length, failed: job.failed, currentChapter: job.currentChapter, error: job.error, cachedChapters: [...book.cachedChapters] };
    };
    (window as any).__advanceCacheAll = (options: { fail?: boolean; limit?: boolean } = {}) => {
      const book = state.books[0], job = book && jobs[book.id];
      if (!job) throw new Error('没有缓存任务');
      if (job.state === 'cancelling') job.state = 'cancelled';
      else if (job.state === 'running') {
        if (options.limit) { job.state = 'failed'; job.error = '离线缓存已达到体积上限，请先清理不需要的缓存'; }
        else {
          const index = job.currentChapter;
          if (options.fail) job.failed++;
          else if (!book.cachedChapters.includes(index)) book.cachedChapters.push(index);
          let next = index + 1;
          while (next < book.chapters.length && book.cachedChapters.includes(next)) next++;
          if (next >= book.chapters.length) {
            job.state = 'completed'; job.currentChapter = undefined;
            job.error = job.failed ? `仍有 ${job.failed} 章未缓存，可继续缓存` : undefined;
          } else job.currentChapter = next;
        }
      }
      localStorage.setItem('online-fixture', JSON.stringify(state));
    };
    (window as any).__onlineRpc = [];
    (window as any).__heldOnlineProgress = [];
    (window as any).__finishOnlineProgress = () => {
      (window as any).__holdOnlineProgress = false;
      for (const pending of (window as any).__heldOnlineProgress.splice(0)) pending.resolve();
    };
    window.acquireVsCodeApi = () => ({
      getState: () => JSON.parse(localStorage.getItem('fixture-view') ?? '{}'), setState: value => localStorage.setItem('fixture-view', JSON.stringify(value)),
      postMessage: async ({ id, method, args }: any) => {
        (window as any).__onlineRpc.push({ id, method, args });
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
            case 'online.progress': {
              if ((window as any).__holdOnlineProgress) await new Promise<void>(resolve => {
                (window as any).__heldOnlineProgress.push({ args: structuredClone(args), resolve });
              });
              book.progress = { chapter: args.chapter, scroll: args.scroll, updatedAt: new Date().toISOString() };
              break;
            }
            case 'online.cache': {
              if (['running', 'cancelling'].includes(jobs[book.id]?.state)) throw new Error('请先取消全本缓存');
              let cached = 0, failed = 0;
              for (let index = args.from; index < Math.min(book.chapters.length, args.from + args.count); index++) {
                if ((window as any).__offline && !book.cachedChapters.includes(index)) { failed++; continue; }
                if (!book.cachedChapters.includes(index)) book.cachedChapters.push(index);
                cached++;
              }
              result = { cached, failed }; break;
            }
            case 'online.cacheAll.status': result = snapshot(book); break;
            case 'online.cacheAll.start': {
              let index = 0;
              while (index < book.chapters.length && book.cachedChapters.includes(index)) index++;
              jobs[book.id] = { state: index >= book.chapters.length ? 'completed' : 'running', failed: 0, currentChapter: index >= book.chapters.length ? undefined : index };
              result = snapshot(book); break;
            }
            case 'online.cacheAll.cancel': if (jobs[book.id]?.state === 'running') jobs[book.id].state = 'cancelling'; result = snapshot(book); break;
            case 'online.clearCache': delete jobs[book.id]; book.cachedChapters = []; result = book; break;
            case 'online.remove': state.books = state.books.filter((item: any) => item.id !== args.id); result = state.books; break;
            case 'updates.check': {
              const configured = (window as any).__checkResponses?.shift();
              if ((window as any).__holdCheck) await new Promise<void>(resolve => {
                (window as any).__finishCheck = () => { (window as any).__holdCheck = false; resolve(); };
              });
              if (configured && 'error' in configured) {
                setTimeout(() => window.postMessage({ id, error: configured.error }, '*'), 0);
                return;
              }
              result = configured && 'result' in configured ? configured.result : { state: 'available', currentVersion: '0.1.2', latestVersion: '0.2.0', releaseUrl: 'https://github.com/linkyu9319/VSRead/releases/tag/v0.2.0', message: '发现新版本 0.2.0' };
              break;
            }
            case 'updates.install': {
              (window as any).__installAttempts = ((window as any).__installAttempts ?? 0) + 1;
              if ((window as any).__holdInstall) await new Promise<void>(resolve => { (window as any).__finishInstall = resolve; });
              if ((window as any).__failInstall) throw new Error('更新未完成，请稍后重试');
              result = (window as any).__cancelInstall
                ? { state: 'cancelled', message: '已取消更新，当前版本保持不变' }
                : { state: 'installed', version: '0.2.0', message: '更新已安装，重载窗口后生效' };
              break;
            }
            case 'updates.reload':
              (window as any).__progressAtReload = structuredClone(state.books[0]?.progress);
              (window as any).__reloadRequested = true; break;
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

for (const first of [
  { state: 'current', currentVersion: '0.1.12', latestVersion: '0.1.12', message: '当前版本已是最新正式版本。' },
  { state: 'unavailable', currentVersion: '0.1.12', message: '无法连接 GitHub，请检查网络连接后重试。' },
]) {
  test(`顶部检查更新在 ${first.state} 后重新请求，不复用旧状态`, async ({ page }) => {
    await page.evaluate(first => {
      (window as any).__checkResponses = [{ result: first }, { result: { state: 'available', currentVersion: '0.1.12', latestVersion: '0.2.1', message: '发现新版本 0.2.1' } }];
    }, first);
    const toggle = page.locator('[data-update-toggle]');
    const dialog = page.getByRole('dialog', { name: '软件更新', exact: true });
    await toggle.click();
    await expect(dialog).toContainText(first.message);
    await dialog.getByRole('button', { name: '关闭软件更新', exact: true }).click();
    await page.evaluate(() => { (window as any).__holdCheck = true; });
    await toggle.click();
    await expect(dialog.getByRole('status')).toHaveText('正在从 GitHub 获取最新版本，请稍候…');
    await expect(dialog).not.toContainText(first.message);
    await page.evaluate(() => (window as any).__finishCheck());
    await expect(dialog).toContainText('发现新版本 0.2.1');
    await expect(dialog).not.toContainText(first.message);
    expect(await page.evaluate(() => (window as any).__onlineRpc.filter((call: any) => call.method === 'updates.check').length)).toBe(2);
    // 弹层已打开时再点顶部，也应继续发起主动检查。
    await toggle.click();
    await expect(dialog).toContainText('发现新版本 0.2.0');
    expect(await page.evaluate(() => (window as any).__onlineRpc.filter((call: any) => call.method === 'updates.check').length)).toBe(3);
  });
}

test('检查请求异常后可从顶部重试，慢请求有反馈且重开不重复', async ({ page }) => {
  await page.evaluate(() => { (window as any).__checkResponses = [{ error: '模拟检查请求失败' }]; });
  const toggle = page.locator('[data-update-toggle]');
  const dialog = page.getByRole('dialog', { name: '软件更新', exact: true });
  await toggle.click();
  await expect(dialog.getByRole('alert')).toHaveText('模拟检查请求失败');
  await dialog.getByRole('button', { name: '关闭软件更新', exact: true }).click();
  await page.evaluate(() => { (window as any).__holdCheck = true; });
  await toggle.click();
  await expect(dialog.getByRole('status')).toHaveText('正在从 GitHub 获取最新版本，请稍候…');
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '检查中…', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '关闭软件更新', exact: true }).click();
  await toggle.click();
  await expect(dialog.getByRole('status')).toHaveText('正在从 GitHub 获取最新版本，请稍候…');
  expect(await page.evaluate(() => (window as any).__onlineRpc.filter((call: any) => call.method === 'updates.check').length)).toBe(2);
  await page.evaluate(() => (window as any).__finishCheck());
  await expect(dialog).toContainText('发现新版本 0.2.0');
  await expect(dialog.getByRole('button', { name: '一键更新', exact: true })).toBeEnabled();
});

test('更新检查空回复与畸形结果明确报错，重试可恢复且不显示原始响应', async ({ page }) => {
  await page.evaluate(() => {
    (window as any).__checkResponses = [
      { result: undefined }, { result: null }, { result: {} }, { result: 'private-response-body' },
      { result: { state: 'available', currentVersion: '0.1.12', latestVersion: '0.2.2', message: '' } },
      { result: { state: 'unexpected', currentVersion: '0.1.12', message: 'private-response-body' } },
      { result: { state: { toString: 'private-response-body' }, currentVersion: '0.1.12', message: 'private-response-body' } },
    ];
  });
  const dialog = page.getByRole('dialog', { name: '软件更新', exact: true });
  for (let attempt = 0; attempt < 7; attempt++) {
    await page.locator('[data-update-toggle]').click();
    await expect(dialog.getByRole('alert')).toHaveText('更新检查返回异常，请重试或打开诊断日志。');
    await expect(dialog.getByRole('button', { name: '检查更新', exact: true })).toBeEnabled();
    await expect(dialog.getByRole('button', { name: '一键更新', exact: true })).toHaveCount(0);
    await expect(dialog).not.toContainText('private-response-body');
  }
  await dialog.getByRole('button', { name: '检查更新', exact: true }).click();
  await expect(dialog).toContainText('发现新版本 0.2.0');
  await expect(dialog.getByRole('alert')).toHaveCount(0);
});

test('更新检查空错误或非文本错误均有固定反馈，不会静默完成', async ({ page }) => {
  await page.evaluate(() => {
    (window as any).__checkResponses = [{ error: '' }, { error: null }, { error: { body: 'private-error-body' } }];
  });
  const dialog = page.getByRole('dialog', { name: '软件更新', exact: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.locator('[data-update-toggle]').click();
    await expect(dialog.getByRole('alert')).toHaveText('操作失败，请重试。');
    await expect(dialog.getByRole('button', { name: '检查更新', exact: true })).toBeEnabled();
    await expect(dialog).not.toContainText('private-error-body');
  }
});

test('页面重载隔离旧会话回复，非RPC回显不会提前结束新检查', async ({ page }) => {
  await page.evaluate(() => { (window as any).__holdCheck = true; });
  await page.locator('[data-update-toggle]').click();
  const dialog = page.getByRole('dialog', { name: '软件更新', exact: true });
  await expect(dialog.getByRole('button', { name: '检查中…', exact: true })).toBeDisabled();
  const previous = await page.evaluate(() => (window as any).__onlineRpc.find((call: any) => call.method === 'updates.check').id as string);

  await page.reload();
  await expect(page.getByRole('region', { name: '我的书架', exact: true })).toBeVisible();
  await page.evaluate(() => { (window as any).__holdCheck = true; });
  await page.locator('[data-update-toggle]').click();
  await expect(dialog.getByRole('button', { name: '检查中…', exact: true })).toBeDisabled();
  const current = await page.evaluate(() => (window as any).__onlineRpc.find((call: any) => call.method === 'updates.check').id as string);
  expect(current).not.toBe(previous);
  expect(current.length).toBeLessThanOrEqual(100);
  await page.evaluate(async ({ previous, current }) => {
    // 等三个消息均投递后再断言，避免测试在事件尚未处理时提前通过。
    await new Promise<void>(resolve => {
      let received = 0;
      const delivered = (event: MessageEvent) => {
        if (event.data?.id !== previous && event.data?.id !== current) return;
        if (++received === 3) { window.removeEventListener('message', delivered); resolve(); }
      };
      window.addEventListener('message', delivered);
      window.postMessage({ id: previous }, '*');
      window.postMessage({ id: current, method: 'updates.check' }, '*');
      window.postMessage({ id: current, event: 'progress' }, '*');
    });
  }, { previous, current });
  await expect(dialog.getByRole('button', { name: '检查中…', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await page.evaluate(() => (window as any).__finishCheck());
  await expect(dialog).toContainText('发现新版本 0.2.0');
  await expect(dialog.getByRole('button', { name: '一键更新', exact: true })).toBeEnabled();
});

test('配置或清除令牌后自动重查并清除旧错误', async ({ page }) => {
  await page.evaluate(() => {
    (window as any).__checkResponses = [
      { error: '旧令牌检查失败' },
      { result: { state: 'available', currentVersion: '0.1.12', latestVersion: '0.2.1', message: '发现新版本 0.2.1' } },
      { result: { state: 'current', currentVersion: '0.1.12', latestVersion: '0.1.12', message: '当前版本已是最新正式版本。' } },
    ];
  });
  await page.locator('[data-update-toggle]').click();
  const dialog = page.getByRole('dialog', { name: '软件更新', exact: true });
  await expect(dialog.getByRole('alert')).toHaveText('旧令牌检查失败');
  await dialog.getByRole('button', { name: '配置访问令牌', exact: true }).click();
  await expect(dialog).toContainText('发现新版本 0.2.1');
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__authAction)).toBe('set');
  await dialog.getByRole('button', { name: '清除令牌', exact: true }).click();
  await expect(dialog).toContainText('当前版本已是最新正式版本。');
  await expect(dialog).not.toContainText('发现新版本 0.2.1');
  expect(await page.evaluate(() => (window as any).__authAction)).toBe('clear');
  expect(await page.evaluate(() => (window as any).__onlineRpc.filter((call: any) => call.method === 'updates.check').length)).toBe(3);
});

test('一键更新安装期间不重复操作，关闭面板后保留结果并可重载窗口', async ({ page }) => {
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '软件更新', exact: true });
  await expect(dialog.getByRole('button', { name: '一键更新', exact: true })).toBeEnabled();
  await page.evaluate(() => { (window as any).__holdInstall = true; });
  await dialog.getByRole('button', { name: '一键更新', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '正在更新…', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '检查更新', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '配置访问令牌', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '关闭软件更新', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '正在更新…', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).__onlineRpc.filter((call: any) => call.method === 'updates.check').length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__installAttempts)).toBe(1);
  await dialog.getByRole('button', { name: '关闭软件更新', exact: true }).click();
  await page.evaluate(() => (window as any).__finishInstall());
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  await expect(dialog).toContainText('更新已安装，重载窗口后生效');
  await expect(dialog.getByRole('button', { name: '一键更新', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: '关闭软件更新', exact: true }).click();
  await page.locator('[data-update-toggle]').click();
  await expect(dialog.getByRole('button', { name: '重载窗口', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__onlineRpc.filter((call: any) => call.method === 'updates.check').length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__installAttempts)).toBe(1);
  await dialog.getByRole('button', { name: '重载窗口', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__reloadRequested)).toBe(true);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('一键更新失败后可重试或打开发布页，成功后才提示重载', async ({ page }) => {
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '软件更新', exact: true });
  await page.evaluate(() => { (window as any).__failInstall = true; });
  await dialog.getByRole('button', { name: '一键更新', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('更新未完成，请稍后重试');
  await expect(dialog.getByRole('button', { name: '重载窗口', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: '查看发布页', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__releaseOpened)).toBe(true);
  await page.evaluate(() => { (window as any).__failInstall = false; });
  await dialog.getByRole('button', { name: '重试更新', exact: true }).click();
  await expect(dialog).toContainText('更新已安装，重载窗口后生效');
  await expect(dialog.getByRole('button', { name: '重载窗口', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__installAttempts)).toBe(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('取消一键更新保留可更新状态，不误显示安装成功', async ({ page }) => {
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '软件更新', exact: true });
  await page.evaluate(() => { (window as any).__cancelInstall = true; });
  await dialog.getByRole('button', { name: '一键更新', exact: true }).click();
  await expect(dialog).toContainText('已取消更新，当前版本保持不变');
  await expect(dialog.getByRole('button', { name: '重载窗口', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '一键更新', exact: true })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

async function openSavedOnlineBook(page: Page, chapter = 0, scroll = 0, cachedChapters = [0, 1, 2]) {
  const book = {
    id: 'f'.repeat(64), sourceId: source.id, title: '星海在线', author: '测试作者', url: 'https://fiction.example/book/one',
    addedAt: '2026-11-13T00:00:00.000Z', cachedChapters,
    chapters: ['第一章 星海', '第二章 远航', '第三章 归途'].map((title, index) => ({ id: String(index + 1).repeat(64), title, url: `https://fiction.example/chapter/${index + 1}` })),
    progress: { chapter, scroll, updatedAt: '2026-11-13T00:00:00.000Z' },
  };
  await page.evaluate(({ source, book }) => localStorage.setItem('online-fixture', JSON.stringify({ sources: [source], books: [book] })), { source, book });
  await page.reload();
  await page.getByRole('region', { name: '我的书架', exact: true }).getByRole('button', { name: '阅读 星海在线', exact: true }).click();
  await expect(page.locator('.online-chapter-content h3')).toHaveText(book.chapters[chapter].title);
  await expect(page.getByRole('button', { name: '刷新本章', exact: true })).toBeEnabled();
}

test('更新后重载窗口先等待在线章节最新进度保存成功', async ({ page }) => {
  await openSavedOnlineBook(page, 1, .25);
  await expect(page.locator('.online-reader .page-controls')).toContainText('进度已保存');
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '软件更新', exact: true });
  await dialog.getByRole('button', { name: '一键更新', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '重载窗口', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '关闭软件更新', exact: true }).click();

  await page.evaluate(() => { (window as any).__holdOnlineProgress = true; });
  const surface = page.getByTestId('online-reading-surface');
  const expectedScroll = await surface.evaluate(element => {
    element.scrollTop = (element.scrollHeight - element.clientHeight) * .64;
    element.dispatchEvent(new Event('scroll'));
    return element.scrollTop / (element.scrollHeight - element.clientHeight);
  });
  await expect(page.locator('.online-reader .page-controls')).toContainText('正在保存…');
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  await dialog.getByRole('button', { name: '重载窗口', exact: true }).click();
  // 用宿主应答闸门控制保存完成，不依赖 400ms 防抖是否已经触发。
  await expect.poll(() => page.evaluate(() => (window as any).__heldOnlineProgress.length)).toBeGreaterThan(0);
  const held = await page.evaluate(() => (window as any).__heldOnlineProgress.map((pending: any) => pending.args));
  expect(held.at(-1).chapter).toBe(1);
  expect(held.at(-1).scroll).toBeCloseTo(expectedScroll, 5);
  expect(await page.evaluate(() => (window as any).__reloadRequested === true)).toBe(false);
  expect(await page.evaluate(() => (window as any).__onlineRpc.some((call: any) => call.method === 'updates.reload'))).toBe(false);

  await page.evaluate(() => (window as any).__finishOnlineProgress());
  await expect.poll(() => page.evaluate(() => (window as any).__reloadRequested)).toBe(true);
  const savedAtReload = await page.evaluate(() => (window as any).__progressAtReload);
  expect(savedAtReload.chapter).toBe(1);
  expect(savedAtReload.scroll).toBeCloseTo(expectedScroll, 5);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

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

test('全本缓存实时显示进度，离开阅读器继续下载，重开保留阅读位置', async ({ page }) => {
  await openSavedOnlineBook(page, 0, .2, [0]);
  const controls = page.getByLabel('全本缓存', { exact: true });
  await controls.getByRole('button', { name: '缓存全本', exact: true }).click();
  await expect(controls.getByRole('button', { name: '取消缓存', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '缓存章节', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '清除缓存', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '刷新目录', exact: true })).toBeDisabled();
  await page.evaluate(() => (window as any).__advanceCacheAll());
  await expect(controls).toContainText('已缓存 2 / 3 章');
  await page.getByRole('button', { name: '下一章', exact: true }).click();
  await expect(page.locator('.online-chapter-content h3')).toHaveText('第二章 远航');
  const surface = page.getByTestId('online-reading-surface');
  await surface.evaluate(node => { node.scrollTop = 420; node.dispatchEvent(new Event('scroll')); });
  await expect(page.locator('.online-reader .page-controls')).toContainText('进度已保存');
  await page.getByRole('region', { name: '在线阅读器', exact: true }).getByRole('button', { name: '返回书架', exact: true }).click();
  await expect(page.getByRole('region', { name: '我的书架', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__onlineRpc.filter((item: any) => item.method === 'online.cacheAll.cancel').length)).toBe(0);
  await page.evaluate(() => (window as any).__advanceCacheAll());
  await page.getByRole('button', { name: '阅读 星海在线', exact: true }).click();
  await expect(controls).toContainText('已缓存 3 / 3 章');
  await expect(controls).toContainText('全本已缓存，可离线阅读');
  await expect(controls.getByRole('button', { name: '全本已缓存', exact: true })).toBeDisabled();
  await expect(page.locator('.online-chapter-content h3')).toHaveText('第二章 远航');
  await expect.poll(() => surface.evaluate(node => node.scrollTop)).toBeGreaterThan(380);
  await expect.poll(() => surface.evaluate(node => node.scrollTop)).toBeLessThan(460);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('全本缓存可取消、保留已下载章节，并继续重试失败章节', async ({ page }) => {
  await openSavedOnlineBook(page, 0, .3, [0]);
  const controls = page.getByLabel('全本缓存', { exact: true });
  await controls.getByRole('button', { name: '缓存全本', exact: true }).click();
  await controls.getByRole('button', { name: '取消缓存', exact: true }).click();
  await expect(controls).toContainText('正在停止缓存');
  await page.evaluate(() => (window as any).__advanceCacheAll());
  await expect(controls).toContainText('缓存已取消，已下载章节保留');
  await expect(controls).toContainText('已缓存 1 / 3 章');
  await controls.getByRole('button', { name: '继续缓存', exact: true }).click();
  await page.evaluate(() => (window as any).__advanceCacheAll({ fail: true }));
  await page.evaluate(() => (window as any).__advanceCacheAll());
  await expect(controls).toContainText('本轮失败 1 章');
  await expect(controls).toContainText('仍有 1 章未缓存，可继续缓存');
  await expect(controls).toContainText('已缓存 2 / 3 章');
  await controls.getByRole('button', { name: '继续缓存', exact: true }).click();
  await page.evaluate(() => (window as any).__advanceCacheAll());
  await expect(controls).toContainText('全本已缓存，可离线阅读');
  await expect(controls).toContainText('已缓存 3 / 3 章');
  await expect(page.locator('.online-chapter-content h3')).toHaveText('第一章 星海');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('全本缓存达到限额会暂停并提示清理，清理后可重新缓存', async ({ page }) => {
  await openSavedOnlineBook(page, 1, .4, [1]);
  const controls = page.getByLabel('全本缓存', { exact: true });
  await controls.getByRole('button', { name: '缓存全本', exact: true }).click();
  await page.evaluate(() => (window as any).__advanceCacheAll({ limit: true }));
  await expect(controls).toContainText('缓存已暂停');
  await expect(controls).toContainText('离线缓存已达到体积上限，请先清理不需要的缓存');
  await expect(controls.getByRole('button', { name: '继续缓存', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '清除缓存', exact: true }).click();
  await expect(controls).toContainText('已缓存 0 / 3 章');
  await expect(controls.getByRole('button', { name: '缓存全本', exact: true })).toBeEnabled();
  await expect(page.locator('.online-chapter-content h3')).toHaveText('第二章 远航');
  await expect.poll(() => page.getByTestId('online-reading-surface').evaluate(node => node.scrollTop / Math.max(1, node.scrollHeight - node.clientHeight))).toBeGreaterThan(.395);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('在线章节快速滚动后立即从顶部返回书架仍保存最新位置', async ({ page }) => {
  await openSavedOnlineBook(page, 0, .1, [0]);
  await expect(page.locator('.online-reader .page-controls')).toContainText('进度已保存');
  await page.evaluate(() => {
    const surface = document.querySelector<HTMLElement>('[data-testid="online-reading-surface"]')!;
    const maxScroll = Math.max(1, surface.scrollHeight - surface.clientHeight);
    surface.scrollTop = Math.round(maxScroll * .8);
    surface.dispatchEvent(new Event('scroll', { bubbles: true }));
    // 在同一帧内直接触发顶部“我的书架”卸载阅读器，验证不丢失尚未进入 rAF 的新位置。
    const shelfButton = document.querySelector<HTMLButtonElement>('.app-header button[aria-label="我的书架"]')!;
    shelfButton.click();
  });
  await expect(page.getByRole('region', { name: '我的书架', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('online-fixture') ?? '{}');
    return saved.books?.[0]?.progress?.scroll ?? 0;
  })).toBeGreaterThan(.75);
});
