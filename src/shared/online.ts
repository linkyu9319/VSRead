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
export interface OnlineChapter { id: string; title: string; url: string }
export interface OnlineBookRecord {
  id: string; sourceId: string; title: string; author?: string; url: string;
  addedAt: string; chapters: OnlineChapter[];
  progress?: { chapter: number; scroll: number; updatedAt: string };
  cachedChapters: number[];
}
export interface OnlineChapterContent { chapter: OnlineChapter; text: string; cached: boolean }
export interface OnlineState { sources: BookSource[]; books: OnlineBookRecord[] }

export interface UpdateStatus {
  state: 'available' | 'current' | 'unavailable'; currentVersion: string;
  latestVersion?: string; releaseUrl?: string; publishedAt?: string; message: string;
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
  'online.add': { args: { result: OnlineSearchResult }; result: OnlineBookRecord };
  'online.open': { args: { id: string; refresh?: boolean }; result: OnlineBookRecord };
  'online.chapter': { args: { id: string; chapter: number; refresh?: boolean }; result: OnlineChapterContent };
  'online.progress': { args: { id: string; chapter: number; scroll: number }; result: void };
  'online.cache': { args: { id: string; from: number; count: number }; result: { cached: number; failed: number } };
  'online.clearCache': { args: { id: string }; result: OnlineBookRecord };
  'online.remove': { args: { id: string }; result: OnlineBookRecord[] };
  'updates.check': { args: undefined; result: UpdateStatus };
  'updates.open': { args: undefined; result: void };
  'updates.auth': { args: { action: 'set' | 'clear' }; result: void };
}
