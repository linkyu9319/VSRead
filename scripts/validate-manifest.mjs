import assert from 'node:assert/strict';

/** 在构建前检查原生视图贡献，避免清单被 IDE 拒绝后宿主测试仍然通过。 */
export function validateManifest(manifest) {
  const containers = new Set();
  for (const entries of Object.values(manifest.contributes?.viewsContainers ?? {})) {
    assert(Array.isArray(entries), 'viewsContainers 必须声明为数组');
    for (const container of entries) {
      // 与 VS Code viewsExtensionPoint.ts 的 isValidViewsContainer 保持一致；视图 ID 可以使用点号。
      assert(typeof container.id === 'string' && /^[a-zA-Z0-9_-]+$/.test(container.id), `视图容器 id 无效：${String(container.id)}；只允许字母、数字、_ 和 -`);
      assert(!containers.has(container.id), `视图容器 id 重复：${container.id}`);
      assert(typeof container.title === 'string' && container.title.trim(), `视图容器 ${container.id} 缺少标题`);
      assert(typeof container.icon === 'string' && container.icon.trim(), `视图容器 ${container.id} 缺少图标`);
      containers.add(container.id);
    }
  }
  const builtinContainers = new Set(['explorer', 'debug', 'scm', 'test']);
  const views = new Set();
  const events = new Set(manifest.activationEvents ?? []);
  for (const [containerId, entries] of Object.entries(manifest.contributes?.views ?? {})) {
    assert(containers.has(containerId) || builtinContainers.has(containerId), `视图引用了不存在的容器：${containerId}`);
    assert(Array.isArray(entries), `容器 ${containerId} 的视图必须声明为数组`);
    for (const view of entries) {
      assert(typeof view.id === 'string' && view.id.trim(), '视图 id 不能为空');
      assert(!views.has(view.id), `视图 id 重复：${view.id}`);
      assert(events.has(`onView:${view.id}`), `缺少显式视图激活事件：${view.id}`);
      views.add(view.id);
    }
  }
  for (const command of manifest.contributes?.commands ?? []) {
    assert(events.has(`onCommand:${command.command}`), `缺少显式命令激活事件：${command.command}`);
  }
}
