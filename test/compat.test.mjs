/**
 * 安装闸门：插件声明的宿主版本必须接受当前 dsh（0.2.1-rc.2）。
 *
 * 0.11.0 的 peer 范围是 `>=0.0.1-rc.5 <0.2.0-0`，0.2.x 一装就被
 * `incompatible-version` 拒绝。这里把「能装」变成回归测试。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

const root = fileURLToPath(new URL('..', import.meta.url));
const RUNTIME = '0.2.1-rc.2';

async function manifest() {
  return JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
}

test('engines.dsh 接受当前宿主版本', async () => {
  const pkg = await manifest();
  assert.ok(pkg.engines?.dsh, '必须声明 engines.dsh，否则由 peer 范围决定安装');
  assert.equal(semver.satisfies(RUNTIME, pkg.engines.dsh, { includePrerelease: true }), true,
    `engines.dsh=${pkg.engines.dsh} 不接受 ${RUNTIME}`);
});

test('dsh peer 范围接受当前宿主版本（不能被上限卡住）', async () => {
  const pkg = await manifest();
  for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue;
    assert.equal(semver.satisfies(RUNTIME, range, { includePrerelease: true }), true,
      `${name}@${range} 不接受 ${RUNTIME}`);
  }
});

test('宿主 devDependency 固定为当前版本', async () => {
  const pkg = await manifest();
  assert.equal(pkg.devDependencies?.['@deepseek-ai/dsh-llm-pi-ai'], RUNTIME,
    'host-schema 测试必须对着当前宿主跑');
});
