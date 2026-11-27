import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { OnlineChapter, ReplaceRule } from '../../shared/online';
import { isRecord } from '../../shared/validation';

const MAX_RULES = 200;
const MAX_PATTERN_LENGTH = 500;
const MAX_REPLACEMENT_LENGTH = 1000;
const MAX_NAME_LENGTH = 100;
const MAX_SCOPE_LENGTH = 200;
const DEFAULT_REGEX_TIMEOUT_MS = 200;
const WORKER_IDLE_MS = 30_000;
type RegexResult = { ok: true; result: string } | { ok: false; reason: 'error' | 'timeout' | 'deadline' };

export class ReplaceRulesDeadlineError extends Error {
  constructor() {
    super('正文净化已超过总时限');
    this.name = 'ReplaceRulesDeadlineError';
  }
}

/** 基础静态 ReDoS 防护：拒绝明显会导致指数回溯的嵌套量词结构；运行期再由带超时的独立 Worker 兜底。 */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/;

const REGEX_WORKER_SCRIPT = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', ({ id, text, pattern, replacement }) => {
  try {
    const result = text.replace(new RegExp(pattern, 'gm'), replacement);
    parentPort.postMessage({ id, ok: true, result });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: error && error.message ? error.message : String(error) });
  }
});
`;

class RegexWorkerPool {
  private worker?: Worker;
  private queue = Promise.resolve();
  private sequence = 0;
  private idleTimer?: ReturnType<typeof setTimeout>;

  run(text: string, pattern: string, replacement: string, timeoutMs: number, deadlineMs?: number): Promise<RegexResult> {
    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    const task = this.queue.then((): RegexResult | Promise<RegexResult> => {
      clearTimeout(waitTimer);
      if (expired || (deadlineMs !== undefined && Date.now() >= deadlineMs)) return { ok: false, reason: 'deadline' };
      return this.execute(text, pattern, replacement, timeoutMs, deadlineMs);
    });
    this.queue = task.then(() => undefined, () => undefined);
    if (deadlineMs === undefined) return task;

    // 调用方在排队超时时立即继续，队列仍按序运行，轮到过期任务时跳过。
    const waiting = new Promise<RegexResult>(resolve => {
      waitTimer = setTimeout(() => {
        expired = true;
        resolve({ ok: false, reason: 'deadline' });
      }, Math.max(0, deadlineMs - Date.now()));
    });
    return Promise.race([task, waiting]);
  }

  dispose(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const current = this.worker;
    this.worker = undefined;
    if (current) void current.terminate();
  }

  private ensureWorker(): Worker {
    if (!this.worker) {
      const worker = new Worker(REGEX_WORKER_SCRIPT, { eval: true });
      worker.unref();
      worker.once('exit', () => { if (this.worker === worker) this.worker = undefined; });
      this.worker = worker;
    }
    return this.worker;
  }

  private scheduleIdle(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.dispose(), WORKER_IDLE_MS);
    this.idleTimer.unref?.();
  }

  private execute(text: string, pattern: string, replacement: string, timeoutMs: number, deadlineMs?: number): Promise<RegexResult> {
    clearTimeout(this.idleTimer);
    const worker = this.ensureWorker();
    const ruleBudget = Math.max(20, timeoutMs);
    const remaining = deadlineMs === undefined ? Infinity : deadlineMs - Date.now();
    if (remaining <= 0) {
      this.scheduleIdle();
      return Promise.resolve({ ok: false, reason: 'deadline' });
    }
    const id = ++this.sequence;
    return new Promise(resolve => {
      let settled = false;
      const finish = (outcome: RegexResult, terminateWorker = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('error', onError);
        worker.off('exit', onExit);
        if (terminateWorker) {
          if (this.worker === worker) this.worker = undefined;
          void worker.terminate();
        } else {
          this.scheduleIdle();
        }
        resolve(outcome);
      };
      const onMessage = (message: { id?: number; ok?: boolean; result?: string }) => {
        if (message?.id !== id) return;
        // 收到应答说明任务已结束，结果迟到时仍可复用 Worker。
        if (deadlineMs !== undefined && Date.now() >= deadlineMs) finish({ ok: false, reason: 'deadline' });
        else if (message.ok && typeof message.result === 'string') finish({ ok: true, result: message.result });
        else finish({ ok: false, reason: 'error' });
      };
      const onError = () => finish({ ok: false, reason: 'error' });
      const onExit = () => finish({ ok: false, reason: 'error' });
      const reason = remaining <= ruleBudget ? 'deadline' : 'timeout';
      const timer = setTimeout(() => finish({ ok: false, reason }, true), Math.min(ruleBudget, remaining));
      worker.on('message', onMessage);
      worker.once('error', onError);
      worker.once('exit', onExit);
      try { worker.postMessage({ id, text, pattern, replacement }); }
      catch { finish({ ok: false, reason: 'error' }); }
    });
  }
}

const regexRunner = new RegexWorkerPool();

export function disposeReplaceRuleWorker(): void {
  regexRunner.dispose();
}

export function normalizeReplaceRule(value: unknown, existingId?: string): ReplaceRule {
  if (!isRecord(value)) throw new Error('净化规则格式无效');
  const pattern = typeof value.pattern === 'string' ? value.pattern : '';
  if (!pattern || pattern.length > MAX_PATTERN_LENGTH) throw new Error(`匹配规则需要 1–${MAX_PATTERN_LENGTH} 个字符`);
  const replacement = typeof value.replacement === 'string' ? value.replacement : '';
  if (replacement.length > MAX_REPLACEMENT_LENGTH) throw new Error(`替换文本不能超过 ${MAX_REPLACEMENT_LENGTH} 个字符`);
  const isRegex = value.isRegex === true;
  if (isRegex) {
    if (NESTED_QUANTIFIER.test(pattern)) throw new Error('正则包含高风险嵌套量词，请简化表达式');
    try { new RegExp(pattern, 'gm'); }
    catch { throw new Error('正则表达式语法无效'); }
  }
  const name = typeof value.name === 'string' && value.name.trim()
    ? value.name.trim().slice(0, MAX_NAME_LENGTH)
    : pattern.slice(0, 30);
  const scope = typeof value.scope === 'string' && value.scope.trim()
    ? value.scope.trim().slice(0, MAX_SCOPE_LENGTH)
    : undefined;
  const id = typeof value.id === 'string' && /^[a-z0-9-]{8,64}$/i.test(value.id)
    ? value.id
    : (existingId ?? randomUUID());
  return {
    id,
    name,
    pattern,
    replacement,
    isRegex,
    enabled: value.enabled !== false,
    ...(scope ? { scope } : {}),
  };
}

export function normalizeReplaceRules(value: unknown): ReplaceRule[] {
  if (!Array.isArray(value)) return [];
  const rules: ReplaceRule[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (rules.length >= MAX_RULES) break;
    try {
      const rule = normalizeReplaceRule(item);
      if (seen.has(rule.id)) continue;
      seen.add(rule.id);
      rules.push(rule);
    } catch { /* 跳过损坏规则，不阻塞书库加载。 */ }
  }
  return rules;
}

function matchesScope(scope: string | undefined, context: { title: string; sourceName: string }): boolean {
  if (!scope) return true;
  const targets = scope.split(/[,，|]/).map(item => item.trim().toLocaleLowerCase()).filter(Boolean);
  if (!targets.length) return true;
  const title = context.title.toLocaleLowerCase();
  const source = context.sourceName.toLocaleLowerCase();
  return targets.some(token => title.includes(token) || source.includes(token));
}

export async function applyReplaceRules(
  text: string,
  rules: readonly ReplaceRule[],
  context: { title: string; sourceName: string },
  options: { timeoutMs?: number; deadlineMs?: number; skipRuleIds?: Set<string>; onTimeout?: (rule: ReplaceRule) => void } = {},
): Promise<string> {
  if (!text || !rules.length) return text;
  const active = rules.filter(rule => rule.enabled && !options.skipRuleIds?.has(rule.id) && matchesScope(rule.scope, context));
  if (!active.length) return text;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REGEX_TIMEOUT_MS;
  let output = text;
  let touched = false;
  for (const rule of active) {
    if (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs) throw new ReplaceRulesDeadlineError();
    if (options.skipRuleIds?.has(rule.id)) continue;
    if (rule.isRegex) {
      const outcome = await regexRunner.run(output, rule.pattern, rule.replacement, timeoutMs, options.deadlineMs);
      if (outcome.ok) {
        if (outcome.result !== output) { output = outcome.result; touched = true; }
      } else if (outcome.reason === 'deadline') {
        // 直接传递超时，避免调用方再次读时钟时把未净化完的文本当成成功结果。
        throw new ReplaceRulesDeadlineError();
      } else if (outcome.reason === 'timeout') {
        options.skipRuleIds?.add(rule.id);
        options.onTimeout?.(rule);
      }
    } else if (output.includes(rule.pattern)) {
      output = output.split(rule.pattern).join(rule.replacement);
      touched = true;
    }
  }
  if (!touched) return output;
  return output.replace(/\n{3,}/g, '\n\n').trim() || text;
}

const CN_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};
const CN_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 };

function parseChapterNumber(title: string): number | undefined {
  const normalized = title.normalize('NFKC');
  const arabic = normalized.match(/(?:第\s*|chapter\s*|ch\.?\s*)(\d+)/i) ?? normalized.match(/^\s*(\d+)[.、\s:：-]/);
  if (arabic) {
    const value = Number(arabic[1]);
    if (Number.isSafeInteger(value) && value >= 0) return value;
  }
  const cn = normalized.match(/第\s*([零〇一二两三四五六七八九十百千万]+)\s*[章节回卷部篇集]/);
  if (!cn) return undefined;
  let total = 0;
  let section = 0;
  let number = 0;
  for (const ch of cn[1]) {
    if (ch in CN_DIGITS) {
      number = CN_DIGITS[ch];
    } else if (ch in CN_UNITS) {
      const unit = CN_UNITS[ch];
      if (unit === 10000) {
        section = (section + (number || (section ? 0 : 1))) * unit;
        total += section;
        section = 0;
        number = 0;
      } else {
        section += (number || 1) * unit;
        number = 0;
      }
    }
  }
  const result = total + section + number;
  return result >= 0 ? result : undefined;
}

function normalizeChapterTitle(title: string): string {
  return title.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function stripChapterPrefix(title: string): string {
  return normalizeChapterTitle(
    title.normalize('NFKC').replace(/^\s*(?:第\s*[零〇一二两三四五六七八九十百千万\d]+\s*[章节回卷部篇集]|chapter\s*\d+|\d+\s*[.、:：-])\s*/i, ''),
  );
}

/** 换源时按章节标题、核心标题、章节号与原位置依次对齐目标目录。 */
export function matchChapterIndex(
  oldChapters: readonly OnlineChapter[],
  oldIndex: number | undefined,
  newChapters: readonly OnlineChapter[],
): number {
  if (!newChapters.length) return 0;
  if (oldIndex === undefined || oldIndex < 0 || !oldChapters.length) return 0;
  const clampedOld = Math.min(oldIndex, oldChapters.length - 1);
  const current = oldChapters[clampedOld];
  if (!current) return Math.min(clampedOld, newChapters.length - 1);

  const exactTarget = normalizeChapterTitle(current.title);
  if (exactTarget) {
    const exact = newChapters.findIndex(chapter => normalizeChapterTitle(chapter.title) === exactTarget);
    if (exact >= 0) return exact;
  }

  const coreTarget = stripChapterPrefix(current.title);
  if (coreTarget.length >= 2) {
    const core = newChapters.findIndex(chapter => stripChapterPrefix(chapter.title) === coreTarget);
    if (core >= 0) return core;
  }

  const targetNumber = parseChapterNumber(current.title);
  if (targetNumber !== undefined) {
    const byNumber = newChapters.findIndex(chapter => parseChapterNumber(chapter.title) === targetNumber);
    if (byNumber >= 0) return byNumber;
  }

  if (oldChapters.length === 1) return 0;
  const ratio = clampedOld / (oldChapters.length - 1);
  return Math.max(0, Math.min(newChapters.length - 1, Math.round(ratio * (newChapters.length - 1))));
}
