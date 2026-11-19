import { randomUUID } from 'node:crypto';
import type { AggregateSearchJob, OnlineSearchResult, SearchSourceStatus } from '../../shared/online';
import type { OnlineLibrary } from './library';

interface SearchTask {
  job: AggregateSearchJob;
  controller: AbortController;
  seen: Set<string>;
  origins: Map<string, string>;
}

const clone = <T>(value: T): T => structuredClone(value);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500);
const limit = (value: number | undefined, fallback: number, maximum: number) => Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.floor(value!))) : fallback;

/** 一个阅读面板独享搜索任务；快源独立返回，停止或新搜索会立即使旧任务失效。 */
export class AggregateSearchManager {
  private tasks = new Map<string, SearchTask>();
  private concurrency: number;
  private maxResults: number;

  constructor(private library: OnlineLibrary, options: { concurrency?: number; maxResults?: number } = {}) {
    this.concurrency = limit(options.concurrency, 4, 4);
    this.maxResults = limit(options.maxResults, 500, 500);
  }

  start(query: string, sourceIds: string[]): AggregateSearchJob {
    if (typeof query !== 'string' || !query.trim() || query.length > 200) throw new Error('搜索内容需要 1–200 个字符');
    if (!Array.isArray(sourceIds) || !sourceIds.length || sourceIds.length > 50 || sourceIds.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))) throw new Error('请选择 1–50 个有效书源');
    if (new Set(sourceIds).size !== sourceIds.length) throw new Error('请勿重复选择同一书源');
    const available = new Map(this.library.listSearchSources().map(source => [source.id, source]));
    const sources: SearchSourceStatus[] = sourceIds.map(sourceId => {
      const source = available.get(sourceId);
      if (!source) throw new Error('选中的书源已停用或不存在，请重新选择');
      return { sourceId, name: source.name, state: 'queued', count: 0 };
    });
    this.cancelAll();
    const task: SearchTask = {
      job: { id: randomUUID(), query: query.trim(), state: 'running', sources, results: [], truncated: false },
      controller: new AbortController(), seen: new Set(),
      origins: new Map(sourceIds.map(id => [id, new URL(available.get(id)!.baseUrl).origin])),
    };
    this.tasks.set(task.job.id, task);
    // 只保留当前及上一次快照，迟到的取消请求也不会误停新任务。
    while (this.tasks.size > 2) this.tasks.delete(this.tasks.keys().next().value!);
    void this.run(task);
    return clone(task.job);
  }

  status(id: string): AggregateSearchJob { return clone(this.task(id).job); }

  cancel(id: string): AggregateSearchJob {
    const task = this.task(id);
    this.cancelTask(task);
    return clone(task.job);
  }

  cancelAll(): void { for (const task of this.tasks.values()) this.cancelTask(task); }

  private task(id: string): SearchTask {
    if (typeof id !== 'string' || id.length > 100) throw new Error('搜索任务标识无效');
    const task = this.tasks.get(id);
    if (!task) throw new Error('搜索任务已结束或已被替换，请重新搜索');
    return task;
  }

  private cancelTask(task: SearchTask): void {
    if (task.job.state !== 'running') return;
    task.job.state = 'cancelled';
    for (const source of task.job.sources) if (source.state === 'queued' || source.state === 'running') source.state = 'cancelled';
    task.controller.abort();
  }

  private async run(task: SearchTask): Promise<void> {
    try {
      await this.library.prepareSearchSources(task.job.sources.map(source => source.sourceId));
      if (task.job.state !== 'running') return;
      const queued = [...task.job.sources];
      const activeOrigins = new Set<string>();
      const worker = async () => {
        while (task.job.state === 'running') {
          // 同域排队不能占满并发窗口，优先让其他域的书源独立返回结果。
          const index = queued.findIndex(source => !activeOrigins.has(task.origins.get(source.sourceId)!));
          if (index < 0) return;
          const [source] = queued.splice(index, 1);
          const origin = task.origins.get(source.sourceId)!;
          activeOrigins.add(origin);
          source.state = 'running';
          const started = Date.now();
          try {
            const results = await this.library.search(source.sourceId, task.job.query, 1, task.controller.signal);
            if (task.job.state !== 'running') return;
            source.state = 'success';
            source.count = results.length;
            this.append(task, results);
          } catch (error) {
            if (task.job.state !== 'running') return;
            source.state = 'error';
            source.error = message(error);
          } finally {
            activeOrigins.delete(origin);
            if (task.job.state === 'running') source.elapsedMs = Date.now() - started;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.concurrency, task.job.sources.length) }, worker));
      if (task.job.state === 'running') task.job.state = 'completed';
    } catch (error) {
      if (task.job.state !== 'running') return;
      task.job.state = 'failed';
      task.job.error = message(error);
      for (const source of task.job.sources) if (source.state === 'queued' || source.state === 'running') { source.state = 'error'; source.error = task.job.error; }
    }
  }

  private append(task: SearchTask, results: OnlineSearchResult[]): void {
    for (const result of results) {
      const key = `${result.sourceId}\n${result.url}`;
      if (task.seen.has(key)) continue;
      if (task.job.results.length >= this.maxResults) { task.job.truncated = true; continue; }
      task.seen.add(key);
      task.job.results.push(clone(result));
    }
  }
}
