import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DiagnosticLog, diagnosticUrl } from '../src/extension/diagnostics';

test('本地日志去除搜索路径、查询参数、凭据、正文与密钥，保留诊断阶段', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vsread-logs-'));
  const output: string[] = [];
  try {
    const log = new DiagnosticLog(root, { output: line => output.push(line) });
    log.write('error', 'network.error', { operation: 'search', source: '测试来源', stage: 'response', status: 503, url: 'https://USER_SECRET:PASS_SECRET@books.example/KEYWORD_SECRET?q=QUERY_SECRET&token=TOKEN_SECRET', error: 'failed https://books.example/KEYWORD_SECRET?key=TOKEN_SECRET token=TOKEN_SECRET', keyword: 'KEYWORD_SECRET', content: 'BOOK_BODY_SECRET', authorization: 'AUTH_SECRET' });
    log.write('info', 'network.complete', { operation: 'chapter', url: 'https://books.example/chapter/1?token=TOKEN_SECRET#FRAGMENT_SECRET', bytes: 2000, elapsedMs: 75 });
    log.write('warn', 'invalid', { operation: 'search', url: 'https://%bad/' });
    log.write('error', 'headers.error', { error: 'Authorization: Bearer BEARER_SECRET\nProxy-Authorization: Basic BASIC_SECRET\nCookie: session=COOKIE_SECRET; second=SECOND_COOKIE_SECRET\n{"authorization":"Bearer JSON_AUTH_SECRET","token":"JSON_TOKEN_SECRET"}' });
    await log.flush();
    const text = await readFile(log.filePath, 'utf8');
    assert(!/USER_SECRET|PASS_SECRET|KEYWORD_SECRET|QUERY_SECRET|TOKEN_SECRET|BOOK_BODY_SECRET|AUTH_SECRET|FRAGMENT_SECRET|BEARER_SECRET|BASIC_SECRET|COOKIE_SECRET/.test(text));
    assert(!/USER_SECRET|PASS_SECRET|KEYWORD_SECRET|TOKEN_SECRET/.test(output.join('\n')));
    const entries = text.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(entries[0].source, '测试来源'); assert.equal(entries[0].status, 503);
    assert.equal(entries[0].url, 'https://books.example/[redacted-path]');
    assert.equal(entries[1].url, 'https://books.example/chapter/1');
    assert.equal(diagnosticUrl('file:///private'), 'file:///private');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('日志串行写入并轮转，最多保留三个有界文件', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vsread-logs-rotate-'));
  try {
    const log = new DiagnosticLog(root, { maxBytes: 300 });
    for (let index = 0; index < 15; index++) log.write('info', 'step', { index, detail: 'x'.repeat(110) });
    await log.flush();
    const files = await readdir(root);
    assert.deepEqual(files.sort(), ['vsread.log', 'vsread.log.1', 'vsread.log.2']);
    for (const filename of files) {
      assert((await stat(path.join(root, filename))).size <= 300);
      for (const line of (await readFile(path.join(root, filename), 'utf8')).trim().split('\n')) JSON.parse(line);
    }
    assert.equal(JSON.parse((await readFile(log.filePath, 'utf8')).trim()).index, 14);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('日志写盘失败不阻断阅读调用，目录恢复后可继续写入', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vsread-logs-failure-'));
  try {
    const directory = path.join(root, 'occupied'); await writeFile(directory, 'file');
    const output: string[] = [];
    const log = new DiagnosticLog(directory, { output: line => output.push(line) });
    log.write('error', 'network.error', { errorCode: 'ETIMEDOUT' });
    await assert.doesNotReject(log.flush());
    assert(output.some(line => line.includes('无法写入本地诊断日志')));
    await rm(directory);
    log.write('info', 'recovered'); await log.flush();
    assert((await readFile(log.filePath, 'utf8')).includes('recovered'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
