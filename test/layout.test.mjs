/**
 * AGENTS.md 与仓库布局、宿主契约常量保持一致。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPAT_GATES } from '../src/dsh/host.mjs';
import { HOST_APIS, THINKING_FORMATS } from '../src/dsh/levels.mjs';
import { name } from '../src/dsh/plugin.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('版本 0.10.0，入口仍兼容 src/plugin.mjs', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const plugin = JSON.parse(await readFile(join(root, 'dsh.plugin.json'), 'utf8'));
  assert.equal(pkg.version, '0.10.0');
  assert.equal(plugin.version, '0.10.0');
  assert.equal(pkg.main, './src/plugin.mjs');
  assert.equal(plugin.main, 'src/plugin.mjs');
  assert.equal(name, 'model-autoconfig');
});

test('三层目录存在且 AGENTS.md 点名的路径都在', async () => {
  const agents = await readFile(join(root, 'AGENTS.md'), 'utf8');
  assert.match(agents, /src\/dsh\/plugin\.mjs/);
  assert.match(agents, /src\/truth\/vendors\.mjs/);
  assert.match(agents, /src\/match\/id\.mjs/);
  const listed = [...agents.matchAll(/`(src\/[^`]+)`/g)].map((m) => m[1])
    .filter((p) => p.endsWith('.mjs') && !p.includes('*'));
  const { access } = await import('node:fs/promises');
  for (const rel of listed) {
    await access(join(root, rel));
  }
  const layers = ['dsh', 'truth', 'match'];
  for (const layer of layers) {
    const files = await readdir(join(root, 'src', layer));
    assert.ok(files.some((f) => f.endsWith('.mjs')), `${layer} 应有源文件`);
  }
});

test('AGENTS.md 宿主契约枚举与代码导出一致', async () => {
  const agents = await readFile(join(root, 'AGENTS.md'), 'utf8');
  for (const api of HOST_APIS) assert.match(agents, new RegExp(api));
  for (const tf of THINKING_FORMATS) assert.match(agents, new RegExp(tf.replace(/-/g, '\\-')));
  assert.match(agents, /没有 `reasoning_effort`/);
  assert.doesNotMatch(agents, /thinkingFormat` 11 值：[^。]*reasoning_effort/);
  assert.equal(COMPAT_GATES['openai-completions'].length, 17);
  assert.equal(COMPAT_GATES['openai-responses'].length, 3);
  assert.equal(COMPAT_GATES['anthropic-messages'].length, 7);
  assert.match(agents, /openai-completions 17/);
  assert.match(agents, /anthropic-messages 7/);
});

test('README ≤150 行', async () => {
  const text = await readFile(join(root, 'README.md'), 'utf8');
  const lines = text.split('\n').length;
  assert.ok(lines <= 150, `README 有 ${lines} 行`);
});
