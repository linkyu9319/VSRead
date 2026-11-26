export interface SourceRules {
  bookList: string; name: string; bookUrl: string; author?: string;
}
export interface BookSource {
  id: string; name: string; baseUrl: string; enabled: boolean;
  ruleType?: 'html' | 'json';
  jsonResponse?: { successPath: string; successValue: string | number | boolean };
  searchUrl: string; search: SourceRules;
  bookInfo?: { init?: string; name?: string; author?: string; tocUrl?: string };
  toc: { chapterList: string; chapterName: string; chapterUrl: string };
  content: { content: string };
}
export interface BuiltinSourceSummary {
  id: string; name: string; description: string; language: string; sourceId: string; searchUrl: string;
}
export interface SourceImportResult { sources: BookSource[]; imported: number; rejected: { name: string; reason: string }[] }
export interface OnlineSearchResult { sourceId: string; title: string; author?: string; url: string }
export interface SearchSourceStatus {
  sourceId: string; name: string;
  state: 'queued' | 'running' | 'success' | 'error' | 'cancelled';
  count: number; elapsedMs?: number; error?: string;
}
export interface AggregateSearchJob {
  id: string; query: string; state: 'running' | 'completed' | 'cancelled' | 'failed';
  sources: SearchSourceStatus[]; results: OnlineSearchResult[]; truncated: boolean; error?: string;
}
export interface OnlineChapter { id: string; title: string; url: string }
export interface OnlineBookRecord {
  id: string; sourceId: string; title: string; author?: string; url: string;
  addedAt: string; chapters: OnlineChapter[];
  progress?: { chapter: number; scroll: number; updatedAt: string };
  cachedChapters: number[];
  pinned?: boolean;
  newChapters?: number;
  lastCheckedAt?: string;
}
export interface ReplaceRule {
  id: string; name: string; pattern: string; replacement: string;
  isRegex: boolean; enabled: boolean; scope?: string;
}
export interface BatchUpdateSummary {
  checked: number; skipped: number;
  updated: { bookId: string; title: string; added: number }[];
  failed: { bookId: string; title: string; error: string }[];
  books: OnlineBookRecord[];
}
export interface ExportTxtResult {
  exported: boolean; filePath?: string; exportedChapters: number; totalChapters: number;
}
export interface OnlineChapterContent { chapter: OnlineChapter; text: string; cached: boolean }
export interface CacheAllJob {
  bookId: string;
  state: 'idle' | 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed';
  total: number; completed: number; failed: number;
  currentChapter?: number; error?: string;
  cachedChapters: number[];
}
export interface OnlineState { sources: BookSource[]; books: OnlineBookRecord[]; replaceRules?: ReplaceRule[] }

export interface UpdateStatus {
  state: 'available' | 'current' | 'unavailable'; currentVersion: string;
  latestVersion?: string; releaseUrl?: string; publishedAt?: string; message: string;
  errorCode?: 'rate-limited' | 'forbidden' | 'unauthorized'; retryAt?: string;
}
export interface UpdateInstallResult {
  state: 'installed' | 'cancelled'; version?: string; message: string;
}

export interface OnlineRequests {
  'sources.builtin.list': { args: undefined; result: BuiltinSourceSummary[] };
  'sources.builtin.add': { args: { id: string }; result: BookSource[] };
  'sources.list': { args: undefined; result: BookSource[] };
  'sources.import': { args: { json?: string; url?: string }; result: SourceImportResult };
  'sources.toggle': { args: { id: string; enabled: boolean }; result: BookSource[] };
  'sources.remove': { args: { id: string }; result: BookSource[] };
  'online.list': { args: undefined; result: OnlineBookRecord[] };
  'online.search': { args: { sourceId: string; query: string; page: number }; result: OnlineSearchResult[] };
  'online.searchAll.start': { args: { query: string; sourceIds: string[] }; result: AggregateSearchJob };
  'online.searchAll.status': { args: { id: string }; result: AggregateSearchJob };
  'online.searchAll.cancel': { args: { id: string }; result: AggregateSearchJob };
  'online.add': { args: { result: OnlineSearchResult }; result: OnlineBookRecord };
  'online.open': { args: { id: string; refresh?: boolean }; result: OnlineBookRecord };
  'online.chapter': { args: { id: string; chapter: number; refresh?: boolean }; result: OnlineChapterContent };
  'online.progress': { args: { id: string; chapter: number; scroll: number }; result: void };
  'online.pin': { args: { id: string; pinned: boolean }; result: OnlineBookRecord };
  'online.switchSource': { args: { id: string; result: OnlineSearchResult }; result: OnlineBookRecord };
  'online.checkUpdates': { args: { ids?: string[] } | undefined; result: BatchUpdateSummary };
  'online.exportTxt': { args: { id: string }; result: ExportTxtResult };
  'online.cache': { args: { id: string; from: number; count: number }; result: { cached: number; failed: number } };
  'online.cacheAll.start': { args: { id: string }; result: CacheAllJob };
  'online.cacheAll.status': { args: { id: string }; result: CacheAllJob };
  'online.cacheAll.cancel': { args: { id: string }; result: CacheAllJob };
  'online.clearCache': { args: { id: string }; result: OnlineBookRecord };
  'online.remove': { args: { id: string }; result: OnlineBookRecord[] };
  'replaceRules.list': { args: undefined; result: ReplaceRule[] };
  'replaceRules.save': { args: { rule: Omit<ReplaceRule, 'id'> & { id?: string } }; result: ReplaceRule[] };
  'replaceRules.toggle': { args: { id: string; enabled: boolean }; result: ReplaceRule[] };
  'replaceRules.remove': { args: { id: string }; result: ReplaceRule[] };
  'updates.check': { args: undefined; result: UpdateStatus };
  'updates.install': { args: undefined; result: UpdateInstallResult };
  'updates.reload': { args: undefined; result: void };
  'updates.open': { args: undefined; result: void };
  'updates.auth': { args: { action: 'set' | 'clear' }; result: void };
}
