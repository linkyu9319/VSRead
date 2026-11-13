import type { OnlineRequests } from './online';

export type BookFormat = 'txt' | 'epub' | 'pdf';
export type TextEncoding = 'auto' | 'utf-8' | 'gb18030' | 'utf-16le' | 'utf-16be';
export interface TocItem { id: string; label: string; children?: TocItem[] }
export type ReadingPosition =
  | { format: 'txt'; offset: number }
  | { format: 'epub'; cfi: string }
  | { format: 'pdf'; page: number; scroll: number };
export interface Progress { position: ReadingPosition; percentage: number; updatedAt: string }
export interface ReaderSettings {
  theme: 'ide' | 'light' | 'dark' | 'custom'; fontSize: number; lineHeight: number;
  backgroundColor: string; textColor: string;
  fontFamily: 'serif' | 'sans-serif'; flow: 'paginated' | 'scrolled'; zoom: number;
}
export const DEFAULT_SETTINGS: ReaderSettings = {
  theme: 'ide', fontSize: 19, lineHeight: 1.9, fontFamily: 'serif', flow: 'scrolled', zoom: 1,
  backgroundColor: '#faf8f2', textColor: '#302e2a',
};
export interface BookRecord {
  id: string; format: BookFormat; title: string; author?: string; cover?: string;
  importedAt: string; size: number; encoding?: string; progress?: Progress;
}
export interface Library { version: 1; books: BookRecord[]; settings: ReaderSettings; lastBookId?: string }
export interface TextPart { index: number; title: string; start: number; end: number; chapter: boolean }
export interface TextIndex { encoding: string; length: number; parts: TextPart[] }
export interface OpenBook { book: BookRecord; textIndex?: TextIndex }
export interface TextChunk { text: string; part: TextPart }
export interface BinaryChunk { base64: string; total: number }

export interface Requests extends OnlineRequests {
  init: { args: undefined; result: Library & { initialView?: 'online'; initialFocus?: boolean } };
  import: { args: undefined; result: Library };
  open: { args: { id: string }; result: OpenBook };
  text: { args: { id: string; part: number }; result: TextChunk };
  binary: { args: { id: string; offset: number }; result: BinaryChunk };
  progress: { args: { id: string; progress: Progress }; result: void };
  settings: { args: ReaderSettings; result: void };
  metadata: { args: { id: string; title?: string; author?: string; cover?: string }; result: void };
  encoding: { args: { id: string; encoding: TextEncoding }; result: OpenBook };
  remove: { args: { id: string }; result: Library };
  focus: { args: { enabled: boolean }; result: void };
}
export interface RpcRequest { id: string; method: keyof Requests; args?: unknown }
export type RpcResponse = { id: string; result?: unknown; error?: string };
