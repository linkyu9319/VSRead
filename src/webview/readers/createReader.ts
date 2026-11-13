import type { BookFormat, ReaderSettings } from '../../shared/model';
import type { ReaderAdapter, ReaderEvents } from './types';

export async function createReader(format: BookFormat, node: HTMLElement, settings: ReaderSettings, events: ReaderEvents): Promise<ReaderAdapter> {
  switch (format) {
    case 'txt': return new (await import('./TxtReader')).TxtReader(node, settings, events);
    case 'epub': return new (await import('./EpubReader')).EpubReader(node, settings, events);
    case 'pdf': return new (await import('./PdfReader')).PdfReader(node, settings, events);
  }
}
