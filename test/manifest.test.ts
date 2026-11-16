import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type ManifestFixture = {
  contributes: {
    viewsContainers: Record<string, Array<{ id: unknown; title: string; icon: string }>>;
    views: Record<string, Array<{ id: string; name: string }>>;
  };
};

const manifest = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as ManifestFixture;
const validator = import(pathToFileURL(path.resolve('scripts/validate-manifest.mjs')).href)
  .then(module => module.validateManifest as (manifest: unknown) => void);

function withContainer(id: unknown): ManifestFixture {
  const fixture = structuredClone(manifest);
  const originalKey = Object.keys(fixture.contributes.views)[0];
  const views = fixture.contributes.views[originalKey];
  fixture.contributes.viewsContainers.activitybar[0].id = id;
  fixture.contributes.views = { [typeof id === 'string' ? id : 'vsread-library']: views };
  return fixture;
}

test('项目 manifest 满足原生活动栏容器约束', async () => {
  const validate = await validator;
  assert.doesNotThrow(() => validate(manifest));
});

test('活动栏容器 ID 含点时，即使视图引用一致也必须拒绝', async () => {
  const validate = await validator;
  // 复现 0.1.6 / 0.1.7：引用一致不代表容器 ID 能被 IDE 接受。
  const fixture = withContainer('vsread.library');
  assert.throws(() => validate(fixture), /id|容器|container/i);
});

test('活动栏容器 ID 拒绝空值、非字符串和非法字符', async () => {
  const validate = await validator;
  for (const id of ['', 123, null, undefined, 'vsread library', 'vsread/library']) {
    assert.throws(() => validate(withContainer(id)), /id|容器|container/i, `未拒绝容器 ID ${String(id)}`);
  }
});

test('视图不能引用未声明的自定义容器', async () => {
  const validate = await validator;
  const fixture = withContainer('vsread-library');
  fixture.contributes.views['vsread-missing'] = fixture.contributes.views['vsread-library'];
  delete fixture.contributes.views['vsread-library'];
  assert.throws(() => validate(fixture), /容器|container/i);
});

test('合法容器可保留含点的视图 ID，容器规则不应用于视图', async () => {
  const validate = await validator;
  const fixture = withContainer('vsread-library');
  assert.equal(fixture.contributes.views['vsread-library'][0].id, 'vsread.library.launcher');
  assert.doesNotThrow(() => validate(fixture));
});
