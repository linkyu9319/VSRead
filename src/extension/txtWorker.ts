import { parentPort, workerData } from 'node:worker_threads';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { decodeText, indexText } from './text';
import type { TextEncoding } from '../shared/model';

async function prepare() {
  const data = workerData as { source: string; directory: string; encoding: TextEncoding };
  const { text, encoding } = decodeText(await readFile(data.source), data.encoding);
  const index = indexText(text, encoding);
  for (const part of index.parts) {
    await writeFile(path.join(data.directory, `${part.index}.txt`), text.slice(part.start, part.end), 'utf8');
  }
  await writeFile(path.join(data.directory, 'index.json'), JSON.stringify(index), 'utf8');
  parentPort?.postMessage(index);
}
prepare().catch(error => { throw error; });
