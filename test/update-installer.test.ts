import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { installUpdate, selectUpdateAsset, verifyUpdatePackage, type UpdateAsset } from '../src/extension/updateInstaller';

const version = '0.2.0';
const identity = { name: 'vsread', publisher: 'vsread-local', version };
const checksum = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function packageFixture(overrides: Record<string, unknown> = {}, entry = 'extension/package.json') {
  const zip = new JSZip();
  zip.file(entry, JSON.stringify({ ...identity, ...overrides }));
  const bytes = await zip.generateAsync({ type: 'nodebuffer' });
  const asset: UpdateAsset = { id: 123, version, name: `vsread-${version}.vsix`, size: bytes.length, sha256: checksum(bytes) };
  return { bytes, asset };
}

function releaseFor(asset: UpdateAsset, assetOverrides: Record<string, unknown> = {}, tag = `v${version}`) {
  return {
    tag_name: tag, draft: false, prerelease: false,
    assets: [{ id: asset.id, name: asset.name, size: asset.size, state: 'uploaded', digest: `sha256:${asset.sha256}`, ...assetOverrides }],
  };
}

async function directoryFixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vsread-update-test-'));
  await writeFile(path.join(directory, 'keep.txt'), '保留原有文件');
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert(path.basename(directory).startsWith('vsread-update-test-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  });
  return directory;
}

async function assertClean(directory: string) {
  assert.deepEqual(await readdir(directory), ['keep.txt']);
  assert.equal(await readFile(path.join(directory, 'keep.txt'), 'utf8'), '保留原有文件');
}

test('更新包选择绑定正式版本、标准包名和 GitHub 校验值，忽略任意下载网址', async () => {
  const { asset } = await packageFixture();
  const release = releaseFor(asset, { browser_download_url: 'https://evil.example/arbitrary.vsix', url: 'http://127.0.0.1/private' });
  assert.deepEqual(selectUpdateAsset(version, release), asset);
  assert.deepEqual(selectUpdateAsset(version, releaseFor(asset, {}, version)), asset);
  for (const overrides of [
    { name: 'other.vsix' }, { state: 'new' }, { id: 0 }, { id: 1.5 }, { id: '123' },
    { size: 0 }, { size: 64 * 1024 * 1024 + 1 }, { size: '1024' },
    { digest: undefined }, { digest: null }, { digest: 'md5:' + 'a'.repeat(32) }, { digest: 'sha256:broken' },
  ]) assert.throws(() => selectUpdateAsset(version, releaseFor(asset, overrides)));
  for (const release of [null, [], {}, { tag_name: `v${version}`, assets: [] }, releaseFor(asset, {}, 'v0.3.0')]) {
    assert.throws(() => selectUpdateAsset(version, release));
  }
});

test('VSIX 校验同时检查字节长度、SHA256、扩展身份和包内版本', async () => {
  const { bytes, asset } = await packageFixture();
  await verifyUpdatePackage(bytes, asset);
  await assert.rejects(verifyUpdatePackage(bytes, { ...asset, size: asset.size + 1 }));
  await assert.rejects(verifyUpdatePackage(bytes, { ...asset, sha256: '0'.repeat(64) }));
  for (const overrides of [{ publisher: 'another-publisher' }, { name: 'another-extension' }, { version: '0.3.0' }]) {
    const wrong = await packageFixture(overrides);
    await assert.rejects(verifyUpdatePackage(wrong.bytes, wrong.asset));
  }
  const wrongEntry = await packageFixture({}, 'package.json');
  await assert.rejects(verifyUpdatePackage(wrongEntry.bytes, wrongEntry.asset));
  const invalidBytes = Buffer.from('not a VSIX archive');
  await assert.rejects(verifyUpdatePackage(invalidBytes, { ...asset, size: invalidBytes.length, sha256: checksum(invalidBytes) }));
});

test('一键更新将完整已校验文件交给 IDE，安装返回后仅清理本次临时目录', async t => {
  const directory = await directoryFixture(t);
  const { bytes, asset } = await packageFixture();
  const controller = new AbortController();
  const progress: Array<[number, number]> = [];
  let downloads = 0;
  let installs = 0;
  const result = await installUpdate(asset, {
    directory, token: 'private-test-token', signal: controller.signal,
    onProgress: (received, total) => progress.push([received, total]),
    download: async (selected, token, signal, onProgress) => {
      downloads++;
      assert.deepEqual(selected, asset);
      assert.equal(token, 'private-test-token');
      assert.equal(signal, controller.signal);
      onProgress?.(bytes.length, bytes.length);
      return bytes;
    },
    install: async file => {
      installs++;
      const relative = path.relative(directory, file);
      assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
      assert.notEqual(path.dirname(file), directory, '安装文件必须位于本次任务独立子目录');
      assert.deepEqual(await readFile(file), bytes);
      assert.equal((await stat(file)).isFile(), true);
    },
  });
  assert.equal(downloads, 1);
  assert.equal(installs, 1);
  assert.deepEqual(progress, [[bytes.length, bytes.length]]);
  assert.equal(result.state, 'installed');
  assert.equal(result.version, version);
  assert.equal(typeof result.message, 'string');
  await assertClean(directory);
});

test('完整性或包内身份错误时不调用 IDE 安装，并清理临时下载', async t => {
  const directory = await directoryFixture(t);
  const good = await packageFixture();
  const wrongIdentity = await packageFixture({ publisher: 'unknown-publisher' });
  const wrongVersion = await packageFixture({ version: '9.9.9' });
  const cases = [
    { bytes: good.bytes, asset: { ...good.asset, sha256: '0'.repeat(64) } },
    { bytes: good.bytes, asset: { ...good.asset, size: good.asset.size + 1 } },
    wrongIdentity, wrongVersion,
  ];
  let installs = 0;
  for (const item of cases) {
    await assert.rejects(installUpdate(item.asset, {
      directory, download: async () => item.bytes, install: async () => { installs++; },
    }));
    await assertClean(directory);
  }
  assert.equal(installs, 0);
});

test('下载或 IDE 安装失败后清理临时文件，再次执行可正常重试', async t => {
  const directory = await directoryFixture(t);
  const { bytes, asset } = await packageFixture();
  let installs = 0;
  await assert.rejects(installUpdate(asset, {
    directory, download: async () => { throw new Error('模拟网络失败'); }, install: async () => { installs++; },
  }));
  assert.equal(installs, 0);
  await assertClean(directory);
  await assert.rejects(installUpdate(asset, {
    directory, download: async () => bytes, install: async file => { installs++; assert.deepEqual(await readFile(file), bytes); throw new Error('模拟安装失败'); },
  }));
  await assertClean(directory);
  const retried = await installUpdate(asset, { directory, download: async () => bytes, install: async () => { installs++; } });
  assert.equal(retried.state, 'installed');
  assert.equal(installs, 2);
  await assertClean(directory);
});

test('取消下载前或下载完成时停止安装，原目录不受影响', async t => {
  const directory = await directoryFixture(t);
  const { bytes, asset } = await packageFixture();
  let downloads = 0;
  let installs = 0;
  const before = new AbortController(); before.abort();
  const preCancelled = await installUpdate(asset, {
    directory, signal: before.signal,
    download: async () => { downloads++; return bytes; }, install: async () => { installs++; },
  });
  assert.equal(preCancelled.state, 'cancelled');
  assert.equal(downloads, 0);
  await assertClean(directory);
  const during = new AbortController();
  const cancelled = await installUpdate(asset, {
    directory, signal: during.signal,
    download: async () => { downloads++; during.abort(); return bytes; }, install: async () => { installs++; },
  });
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(installs, 0);
  await assertClean(directory);
  const interrupted = new AbortController();
  const interruptedResult = await installUpdate(asset, {
    directory, signal: interrupted.signal,
    download: async () => { interrupted.abort(); throw new Error('下载因取消中断'); }, install: async () => { installs++; },
  });
  assert.equal(interruptedResult.state, 'cancelled');
  assert.equal(installs, 0);
  await assertClean(directory);
});

test('IDE 已完成安装后收到取消，不误报成功安装被取消', async t => {
  const directory = await directoryFixture(t);
  const { bytes, asset } = await packageFixture();
  const controller = new AbortController();
  const result = await installUpdate(asset, {
    directory, signal: controller.signal, download: async () => bytes,
    install: async file => { assert.deepEqual(await readFile(file), bytes); controller.abort(); },
  });
  assert.equal(result.state, 'installed');
  await assertClean(directory);
});
