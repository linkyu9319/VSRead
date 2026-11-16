import { useCallback, useEffect, useRef, useState } from 'react';
import type { CacheAllJob, OnlineBookRecord } from '../../shared/online';
import { request } from '../bridge';

interface Props {
  book: OnlineBookRecord; busy: boolean; refreshVersion: number;
  onStatus(value: CacheAllJob): void; onBusyChange(value: boolean): void; onError(error: unknown): void;
}

const running = (job?: CacheAllJob) => job?.state === 'running' || job?.state === 'cancelling';

/** 全本下载由 Host 持有；组件只查询进度，离开阅读器不会取消后台任务。 */
export function CacheAllControls(props: Props) {
  const [job, setJob] = useState<CacheAllJob>();
  const [checking, setChecking] = useState(true);
  const [pending, setPending] = useState<'start' | 'cancel' | ''>('');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const latest = useRef(props);
  const active = useRef(true);
  const revision = useRef(0);
  const lastError = useRef('');
  latest.current = props;
  const isRunning = running(job);
  const apply = useCallback((next: CacheAllJob) => {
    setJob(next); setChecking(false); setError(''); lastError.current = '';
    latest.current.onStatus(next);
  }, []);
  const report = useCallback((cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    setError(message);
    if (lastError.current !== message) { lastError.current = message; latest.current.onError(cause); }
  }, []);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; revision.current++; };
  }, []);
  useEffect(() => {
    // 手动清理/批量缓存期间不应用旧轮询快照，避免把已清空的索引重新画回界面。
    if (props.busy) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const token = revision.current;
      let again = isRunning;
      try {
        const next = await request('online.cacheAll.status', { id: props.book.id });
        if (!alive || !active.current || latest.current.busy || token !== revision.current) return;
        apply(next); again = running(next);
      } catch (cause) {
        if (!alive || !active.current || token !== revision.current) return;
        report(cause);
      } finally {
        if (alive && active.current && again) timer = setTimeout(() => { void poll(); }, 1000);
      }
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [props.book.id, props.refreshVersion, props.busy, isRunning, retry, apply, report]);
  useEffect(() => { latest.current.onBusyChange(checking || !!pending || isRunning); }, [checking, pending, isRunning]);

  const action = async (kind: 'start' | 'cancel') => {
    if (pending || (kind === 'start' && (props.busy || checking || isRunning))) return;
    const token = ++revision.current;
    setPending(kind); setError('');
    try {
      const next = await request(kind === 'start' ? 'online.cacheAll.start' : 'online.cacheAll.cancel', { id: props.book.id });
      if (active.current && token === revision.current) apply(next);
    } catch (cause) { if (active.current && token === revision.current) report(cause); }
    finally { if (active.current && token === revision.current) { setPending(''); setRetry(value => value + 1); } }
  };
  const total = props.book.chapters.length;
  const completed = props.book.cachedChapters.length;
  const full = total > 0 && completed >= total;
  const canContinue = job && !isRunning && !full && job.state !== 'idle';
  const caption = checking ? '正在读取全本缓存状态…'
    : job?.state === 'cancelling' ? '正在停止缓存，当前章节完成后结束'
    : job?.state === 'running' ? `后台缓存中${job.currentChapter === undefined ? '' : ` · 正在读取第 ${job.currentChapter + 1} 章`}`
    : full ? '全本已缓存，可离线阅读'
    : job?.state === 'cancelled' ? '缓存已取消，已下载章节保留'
    : job?.state === 'failed' ? '缓存已暂停，可处理问题后继续'
    : job?.state === 'completed' ? '本轮缓存结束，可继续重试未缓存章节'
    : '缓存后可离线阅读，关闭阅读器仍会继续下载';
  return <div className="cache-all-controls" role="group" aria-label="全本缓存">
    <div className="cache-all-actions"><button className="text-button" disabled={props.busy || checking || !!pending || isRunning || !total || full} onClick={() => { void action('start'); }}>{pending === 'start' ? '正在启动…' : isRunning ? '缓存全本中…' : full ? '全本已缓存' : canContinue ? '继续缓存' : '缓存全本'}</button>{isRunning && <button className="text-button" disabled={!!pending || job?.state === 'cancelling'} onClick={() => { void action('cancel'); }}>取消缓存</button>}<span className="online-inline-status">已缓存 {completed} / {total} 章{job && job.failed > 0 ? ` · 本轮失败 ${job.failed} 章` : ''}</span><progress aria-label="全本缓存进度" max={Math.max(1, total)} value={completed} /></div>
    <p className="cache-all-caption" role="status">{caption}</p>
    {job?.error && !isRunning && !full && <p className="cache-all-error">{job.error}</p>}
    {error && <p className="cache-all-error" role="alert">缓存状态读取失败：{error}<button className="text-button" onClick={() => setRetry(value => value + 1)}>重试状态</button></p>}
  </div>;
}
