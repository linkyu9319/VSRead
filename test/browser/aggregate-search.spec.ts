import { test, expect, type Page } from '@playwright/test';
import type { OnlineSearchResult } from '../../src/shared/online';

const ids = { fast: 'a'.repeat(64), slow: 'b'.repeat(64), failing: 'c'.repeat(64), disabled: 'd'.repeat(64), builtin: 'e'.repeat(64) };
const makeSource = (id: string, name: string, enabled = true) => ({
  id, name, enabled, baseUrl: 'https://books.example/', searchUrl: '/search?q={{key}}&page={{page}}',
  search: { bookList: '.book', name: '.title@text', bookUrl: 'a@href' },
  toc: { chapterList: '.chapter', chapterName: '@text', chapterUrl: '@href' }, content: { content: '#content@text' },
});
const result = (sourceId: string, title: string, author: string | undefined, slug: string): OnlineSearchResult => ({ sourceId, title, author, url: 'https://books.example/' + slug });

async function mockAggregateHost(page: Page) {
  await page.addInitScript(({ configuredSources, configuredBuiltins, ids }) => {
    const state = { sources: configuredSources, books: [] as any[] };
    const settings = { theme: 'light', fontSize: 19, lineHeight: 1.9, fontFamily: 'serif', flow: 'scrolled', zoom: 1, backgroundColor: '#faf8f2', textColor: '#302e2a' };
    const jobs: Record<string, any> = {};
    const starts = new Map<string, () => void>();
    let sequence = 0;
    let view: unknown = {};
    const lastJob = (query: string) => Object.values(jobs).filter(job => job.query === query).at(-1);
    (window as any).__aggregateCalls = [];
    (window as any).__aggregateSources = state.sources;
    (window as any).__heldAggregateStatus = [];
    (window as any).__aggregateJob = lastJob;
    (window as any).__releaseAggregateStart = (query: string) => { starts.get(query)?.(); starts.delete(query); };
    (window as any).__advanceAggregate = (query: string, patch: any) => {
      const job = lastJob(query);
      if (!job) throw new Error('未找到聚合搜索任务');
      Object.assign(job, patch);
      if (patch.state === 'completed') {
        for (const source of job.sources) {
          source.state = patch.errors?.includes(source.sourceId) ? 'error' : 'success';
          source.error = source.state === 'error' ? '该书源连接超时' : undefined;
          source.count = job.results.filter((book: any) => book.sourceId === source.sourceId).length;
          source.elapsedMs = 720;
        }
      }
    };
    window.acquireVsCodeApi = () => ({
      getState: () => view, setState: next => { view = next; },
      postMessage: async ({ id, method, args }: any) => {
        (window as any).__aggregateCalls.push({ method, args });
        try {
          let value: any;
          const book = state.books.find(item => item.id === args?.id);
          switch (method) {
            case 'init': value = { version: 1, books: [], settings }; break;
            case 'sources.list': value = state.sources; break;
            case 'sources.builtin.list': value = configuredBuiltins; break;
            case 'online.list': value = state.books; break;
            case 'sources.builtin.add': throw new Error('聚合搜索无需逐个添加内置来源');
            case 'sources.toggle': state.sources.find(source => source.id === args.id)!.enabled = args.enabled; value = state.sources; break;
            case 'online.searchAll.start': {
              for (const old of Object.values(jobs)) if (old.state === 'running') old.state = 'cancelled';
              for (const builtin of configuredBuiltins) if (args.sourceIds.includes(builtin.sourceId) && !state.sources.some(source => source.id === builtin.sourceId)) {
                state.sources.push({ ...state.sources[0], id: builtin.sourceId, name: builtin.name, enabled: true });
              }
              const results = (window as any).__aggregateInitialResults ?? [{ sourceId: ids.fast, title: args.query + '快书', author: '作者甲', url: 'https://books.example/' + args.query + '/fast' }];
              const job = {
                id: 'aggregate-' + (++sequence), query: args.query, state: 'running', truncated: false, results,
                sources: args.sourceIds.map((sourceId: string) => ({
                  sourceId, name: state.sources.find(source => source.id === sourceId)?.name ?? '内置来源',
                  state: sourceId === ids.fast ? 'success' : sourceId === ids.slow ? 'running' : 'queued',
                  count: results.filter((book: any) => book.sourceId === sourceId).length,
                })),
              };
              jobs[job.id] = job;
              const snapshot = structuredClone(job);
              if ((window as any).__holdAggregateStarts?.includes(args.query)) await new Promise<void>(resolve => starts.set(args.query, resolve));
              value = snapshot;
              break;
            }
            case 'online.searchAll.status': {
              const snapshot = structuredClone(jobs[args.id]);
              value = (window as any).__holdAggregateStatus
                ? await new Promise(resolve => (window as any).__heldAggregateStatus.push({ id: args.id, respond: (override: any) => resolve(override ?? snapshot) }))
                : snapshot;
              break;
            }
            case 'online.searchAll.cancel': {
              const job = jobs[args.id];
              if (!job) throw new Error('搜索任务不存在');
              if (job.state === 'running') {
                job.state = 'cancelled';
                for (const source of job.sources) if (source.state === 'queued' || source.state === 'running') source.state = 'cancelled';
              }
              value = job; break;
            }
            case 'online.search': value = [{ sourceId: args.sourceId, title: '单源第 ' + args.page + ' 页', author: '单源作者', url: 'https://books.example/single/' + args.page }]; break;
            case 'online.add': {
              (window as any).__aggregateAdded = structuredClone(args.result);
              let added = state.books.find(item => item.sourceId === args.result.sourceId && item.url === args.result.url);
              if (!added) {
                added = { ...args.result, id: String(state.books.length + 1).padStart(64, '0'), addedAt: new Date().toISOString(), cachedChapters: [],
                  chapters: [{ id: 'f'.repeat(64), title: '第一章 星海', url: 'https://books.example/chapter/one' }] };
                state.books.push(added);
              }
              value = added; break;
            }
            case 'online.open': value = book; break;
            case 'online.chapter': value = { chapter: book.chapters[0], text: '第一章 星海\n在线章节正文。', cached: true }; break;
            case 'online.progress': book.progress = { chapter: args.chapter, scroll: args.scroll, updatedAt: new Date().toISOString() }; break;
            case 'online.cacheAll.status': value = { bookId: book.id, state: 'idle', total: 1, completed: 0, failed: 0, cachedChapters: [] }; break;
            case 'focus': break;
            case 'settings': Object.assign(settings, args); break;
            default: throw new Error('未模拟请求 ' + method);
          }
          const response = structuredClone({ id, result: value });
          setTimeout(() => window.postMessage(response, '*'), 0);
        } catch (error) { window.postMessage({ id, error: (error as Error).message }, '*'); }
      },
    });
  }, {
    ids,
    configuredSources: [makeSource(ids.fast, '快源'), makeSource(ids.slow, '慢源'), makeSource(ids.failing, '失败源'), makeSource(ids.disabled, '停用来源', false)],
    configuredBuiltins: [
      { id: 'demo-builtin', sourceId: ids.builtin, name: '内置来源', description: '未添加的内置来源', language: '中文', searchUrl: '/search?q={{key}}&page={{page}}' },
      { id: 'disabled-builtin', sourceId: ids.disabled, name: '停用来源', description: '已显式停用', language: '中文', searchUrl: '/search?q={{key}}&page={{page}}' },
    ],
  });
}

async function chooseAggregate(page: Page) {
  await page.getByLabel('搜索书源', { exact: true }).selectOption('__aggregate__');
}
async function searchFor(page: Page, query: string) {
  await page.getByLabel('搜索书名或作者', { exact: true }).fill(query);
  await page.getByRole('region', { name: '在线搜索', exact: true }).getByRole('button', { name: '搜索', exact: true }).click();
}
const calls = (page: Page, method: string) => page.evaluate(method => (window as any).__aggregateCalls.filter((call: any) => call.method === method), method);

test.beforeEach(async ({ page }) => {
  await mockAggregateHost(page); await page.goto('/');
  await page.getByRole('button', { name: '在线书源', exact: true }).click();
  await expect(page.getByLabel('搜索书源', { exact: true })).toHaveValue(ids.fast);
});

test('聚合快源先出结果且可直接加入，慢源与局部失败不阻塞并可重试', async ({ page }) => {
  await chooseAggregate(page);
  await expect(page.getByLabel('聚合书源 内置来源', { exact: true })).toBeChecked();
  await expect(page.getByLabel('聚合书源 停用来源', { exact: true })).toHaveCount(0);
  await searchFor(page, '星海');
  const status = page.getByRole('region', { name: '搜索来源状态', exact: true });
  await expect(status.locator('.aggregate-status-row').filter({ hasText: '慢源' })).toContainText('搜索中');
  const fast = page.locator('.aggregate-result-row').filter({ hasText: '星海快书' });
  await fast.getByRole('button', { name: '加入书架', exact: true }).click();
  await expect(fast.getByRole('button', { name: '打开阅读', exact: true })).toBeEnabled();
  expect((await calls(page, 'sources.builtin.add')).length).toBe(0);
  expect(await page.evaluate(() => (window as any).__aggregateAdded.sourceId)).toBe(ids.fast);
  await expect(page.getByRole('button', { name: '停止搜索', exact: true })).toBeVisible();
  await page.evaluate(({ results, errors }) => (window as any).__advanceAggregate('星海', { state: 'completed', results, errors }), {
    results: [result(ids.fast, '星海快书', '作者甲', '星海/fast'), result(ids.slow, '星海慢书', '作者乙', 'slow')], errors: [ids.failing],
  });
  await expect(page.locator('.aggregate-result-row')).toHaveCount(2);
  await expect(status).toContainText('该书源连接超时');
  await expect(status).toContainText('0.7 秒');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await status.getByRole('button', { name: '重试搜索', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'online.searchAll.start')).length).toBe(2);
});

test('严格书名作者分组，来源去重及选择保持，按当前变体加入和打开', async ({ page }) => {
  const a = result(ids.fast, 'Star 海', '作 者甲', 'a');
  const b = result(ids.slow, 'ＳＴＡＲ海', '作者甲', 'b');
  await page.evaluate(results => { (window as any).__aggregateInitialResults = results; }, [a, b, a]);
  await chooseAggregate(page); await searchFor(page, '分组');
  await expect(page.locator('.aggregate-result-row')).toHaveCount(1);
  const variant = page.getByLabel('选择《Star 海》的来源', { exact: true });
  await expect(variant.locator('option')).toHaveCount(2);
  await variant.selectOption(JSON.stringify([b.sourceId, b.url]));
  const more = [
    a, b, a, result(ids.builtin, 'star海', '作者甲', 'builtin'),
    result(ids.fast, 'Star海', undefined, 'unknown-a'), result(ids.slow, 'Ｓｔａｒ 海', '', 'unknown-b'),
    result(ids.failing, 'Star海', '作者乙', 'other-author'), result(ids.fast, 'Star海 第二卷', '作者甲', 'volume'),
    result(ids.fast, 'Star·海', '作者甲', 'punctuation'),
  ];
  await page.evaluate(results => (window as any).__advanceAggregate('分组', { results }), more);
  await expect(page.locator('.aggregate-result-row')).toHaveCount(5);
  await expect(variant).toHaveValue(JSON.stringify([b.sourceId, b.url]));
  await expect(variant.locator('option')).toHaveCount(3);
  await expect(page.getByLabel('选择《Star海》的来源', { exact: true }).locator('option')).toHaveCount(2);
  const grouped = page.locator('.aggregate-result-row').first();
  await expect(grouped.locator('h3')).toHaveText('Star 海');
  await grouped.getByRole('button', { name: '加入书架', exact: true }).click();
  await expect(grouped.getByRole('button', { name: '打开阅读', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__aggregateAdded)).toEqual(b);
  await variant.selectOption(JSON.stringify([a.sourceId, a.url]));
  await expect(grouped.getByRole('button', { name: '加入书架', exact: true })).toBeVisible();
  await variant.selectOption(JSON.stringify([b.sourceId, b.url]));
  await grouped.getByRole('button', { name: '打开阅读', exact: true }).click();
  await expect(page.locator('.online-chapter-content h3')).toHaveText('第一章 星海');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('新关键词的结果不被迟到的旧 start 覆盖，旧取消也不影响新任务', async ({ page }) => {
  await chooseAggregate(page);
  await page.evaluate(() => { (window as any).__holdAggregateStarts = ['旧关键词']; });
  await searchFor(page, '旧关键词');
  await expect.poll(async () => (await calls(page, 'online.searchAll.start')).length).toBe(1);
  await searchFor(page, '新关键词');
  await expect(page.locator('.aggregate-result-row')).toContainText('新关键词快书');
  const ids = await page.evaluate(() => ({ old: (window as any).__aggregateJob('旧关键词').id, current: (window as any).__aggregateJob('新关键词').id }));
  await page.evaluate(() => (window as any).__releaseAggregateStart('旧关键词'));
  await expect.poll(async () => (await calls(page, 'online.searchAll.cancel')).some((call: any) => call.args.id === ids.old)).toBe(true);
  expect((await calls(page, 'online.searchAll.cancel')).some((call: any) => call.args.id === ids.current)).toBe(false);
  await expect(page.locator('.online-result-summary')).toContainText('新关键词');
  await expect(page.locator('.online-search-results')).not.toContainText('旧关键词快书');
});

test('停止搜索保留当前结果，迟到的轮询不能重新写入', async ({ page }) => {
  await chooseAggregate(page);
  await page.evaluate(() => { (window as any).__holdAggregateStatus = true; });
  await searchFor(page, '停止');
  await expect(page.locator('.aggregate-result-row')).toContainText('停止快书');
  await expect.poll(() => page.evaluate(() => (window as any).__heldAggregateStatus.length)).toBe(1);
  await page.getByRole('button', { name: '停止搜索', exact: true }).click();
  await expect(page.getByRole('region', { name: '搜索来源状态', exact: true })).toContainText('已停止搜索');
  await page.evaluate(sourceId => {
    const job = (window as any).__aggregateJob('停止');
    (window as any).__heldAggregateStatus[0].respond({ ...job, state: 'completed', results: [{ sourceId, title: '迟到污染', url: 'https://books.example/late' }] });
  }, ids.slow);
  await expect.poll(async () => (await calls(page, 'online.searchAll.cancel')).length).toBe(1);
  await expect(page.locator('.aggregate-result-row')).toContainText('停止快书');
  await expect(page.locator('.online-search-results')).not.toContainText('迟到污染');
});

test('切回单源取消迟到任务，并保留原有搜索分页', async ({ page }) => {
  await chooseAggregate(page);
  await page.evaluate(() => { (window as any).__holdAggregateStarts = ['切换']; });
  await searchFor(page, '切换');
  await expect.poll(async () => (await calls(page, 'online.searchAll.start')).length).toBe(1);
  await page.getByLabel('搜索书源', { exact: true }).selectOption(ids.fast);
  await page.evaluate(() => (window as any).__releaseAggregateStart('切换'));
  await expect.poll(async () => (await calls(page, 'online.searchAll.cancel')).length).toBe(1);
  await searchFor(page, '单源');
  await expect(page.locator('.online-result-summary')).toContainText('第 1 页');
  await page.getByRole('region', { name: '在线搜索', exact: true }).getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.locator('.online-result-summary')).toContainText('第 2 页');
  expect((await calls(page, 'online.search')).map((call: any) => call.args.page)).toEqual([1, 2]);
  await expect(page.getByRole('region', { name: '搜索来源状态', exact: true })).toHaveCount(0);
});

test('离开搜索页后迟到 start 仅取消自己的任务，不污染重开后的搜索', async ({ page }) => {
  await chooseAggregate(page);
  await page.evaluate(() => { (window as any).__holdAggregateStarts = ['离开']; });
  await searchFor(page, '离开');
  await expect.poll(async () => (await calls(page, 'online.searchAll.start')).length).toBe(1);
  await page.getByRole('button', { name: '返回书架', exact: true }).click();
  await page.getByRole('button', { name: '在线书源', exact: true }).click();
  await chooseAggregate(page); await searchFor(page, '重开');
  await expect(page.locator('.aggregate-result-row')).toContainText('重开快书');
  const current = await page.evaluate(() => (window as any).__aggregateJob('重开').id);
  await page.evaluate(() => (window as any).__releaseAggregateStart('离开'));
  await expect.poll(async () => (await calls(page, 'online.searchAll.cancel')).length).toBe(1);
  expect((await calls(page, 'online.searchAll.cancel')).some((call: any) => call.args.id === current)).toBe(false);
  await expect(page.locator('.online-search-results')).not.toContainText('离开快书');
});

test('全部书源报错时明确搜索失败，停止与完成竞争时以完成快照为准', async ({ page }) => {
  await chooseAggregate(page);
  await page.evaluate(() => { (window as any).__aggregateInitialResults = []; });
  await searchFor(page, '失败');
  await expect(page.getByRole('button', { name: '停止搜索', exact: true })).toBeVisible();
  await page.evaluate(sourceIds => (window as any).__advanceAggregate('失败', { state: 'completed', results: [], errors: sourceIds }), [ids.fast, ids.slow, ids.failing, ids.builtin]);
  await expect(page.locator('.online-empty-note')).toContainText('全部书源搜索失败');
  await expect(page.locator('.online-search-results')).not.toContainText('没有找到匹配');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.evaluate(() => { (window as any).__holdAggregateStatus = true; });
  await page.getByRole('button', { name: '重试搜索', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'online.searchAll.start')).length).toBe(2);
  await page.evaluate(() => (window as any).__advanceAggregate('失败', { state: 'completed', results: [], errors: [] }));
  await page.getByRole('button', { name: '停止搜索', exact: true }).click();
  await expect(page.getByRole('region', { name: '搜索来源状态', exact: true })).toContainText('搜索完成');
  await expect(page.getByRole('region', { name: '搜索来源状态', exact: true })).not.toContainText('已停止搜索');
});

test('聚合范围默认只选前50个，可清空并且不会包含停用内置源', async ({ page }) => {
  await page.evaluate(() => {
    const sources = (window as any).__aggregateSources;
    for (let index = 100; index < 152; index++) sources.push({ ...sources[0], id: index.toString(16).padStart(64, '0'), name: '额外来源 ' + index });
  });
  await page.getByRole('button', { name: '返回书架', exact: true }).click();
  await page.getByRole('button', { name: '在线书源', exact: true }).click();
  await chooseAggregate(page);
  const selection = page.locator('.aggregate-source-picker');
  await expect(selection.locator('input:checked')).toHaveCount(50);
  await expect(selection.locator('input:disabled')).toHaveCount(6);
  await selection.getByRole('button', { name: '清空', exact: true }).click();
  await expect(selection.locator('input:checked')).toHaveCount(0);
  await expect(selection.locator('input:disabled')).toHaveCount(0);
  await selection.getByRole('button', { name: '选择前 50 个', exact: true }).click();
  await expect(selection.locator('input:checked')).toHaveCount(50);
  await expect(page.getByLabel('聚合书源 停用来源', { exact: true })).toHaveCount(0);
});
