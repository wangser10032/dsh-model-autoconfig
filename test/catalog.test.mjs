/**
 * catalog.mjs —— 载入与缓存。
 *
 * 插件每个事件都跑一轮同步；loadCatalog 不缓存的话，每轮都对
 * pi-ai 目录做 readdir + 全量 readFileSync + JSON.parse（同步 I/O，
 * 阻塞 dsh web 进程的事件循环），而这个目录在进程生命周期里基本不变。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { audit, loadCatalog } from '../src/catalog.mjs';

const dir = mkdtempSync(join(tmpdir(), 'dsh-mac-catalog-'));
const write = (name, obj) => writeFileSync(join(dir, name), JSON.stringify(obj));
write('deepseek.json', { 'openai-completions': {
  'deepseek-v4-flash': { id: 'deepseek-v4-flash', reasoning: true },
} });

test.after(() => rmSync(dir, { recursive: true, force: true }));

test('解析出扁平模型数组，形状正确', () => {
  const entries = loadCatalog(dir, 0);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    provider: 'deepseek', api: 'openai-completions', id: 'deepseek-v4-flash',
    model: { id: 'deepseek-v4-flash', reasoning: true },
  });
});

test('同一目录 45s 内命中缓存（返回同一引用，不再读盘）', () => {
  const a = loadCatalog(dir);
  const b = loadCatalog(dir);
  assert.equal(a, b, '插件每轮同步都调 loadCatalog，不缓存会反复同步读盘');
});

test('ttlMs=0 跳过缓存，能看到磁盘上的新内容', () => {
  // 先取到当前缓存里的快照引用
  const before = loadCatalog(dir);
  write('zai.json', { 'openai-completions': { 'glm-5.3': { id: 'glm-5.3' } } });
  // 默认 TTL 路径在缓存有效期内仍返回旧快照（同一引用，不读盘）
  assert.equal(loadCatalog(dir), before, 'TTL 未过期时磁盘变化不可见');
  // ttlMs=0 绕过缓存读到新内容，并顺带把缓存刷新成新快照
  const fresh = loadCatalog(dir, 0);
  assert.ok(fresh.some((e) => e.id === 'glm-5.3'));
  assert.ok(loadCatalog(dir).some((e) => e.id === 'glm-5.3'));
});

test('audit：真值库认为可看图而目录没声明 image 的记入 missingVision', () => {
  const a = audit([
    { provider: 'deepseek', id: 'deepseek-v4-flash', model: { input: ['text'] } },
    { provider: 'deepseek', id: 'deepseek-v4-flash-vision', model: { input: ['text'] } },
    { provider: 'anthropic', id: 'claude-opus-5', model: { input: ['text', 'image'] } },
  ]);
  assert.deepEqual(a.missingVision.map((e) => e.id), ['deepseek-v4-flash-vision']);
});

test('目录变了不走同一个缓存槽', () => {
  const dir2 = mkdtempSync(join(tmpdir(), 'dsh-mac-catalog2-'));
  try {
    writeFileSync(join(dir2, 'x.json'), JSON.stringify({ a: { m1: { id: 'm1' } } }));
    const e1 = loadCatalog(dir2);
    const e2 = loadCatalog(dir);
    assert.notEqual(e1, e2);
    assert.equal(e1[0].id, 'm1');
  } finally { rmSync(dir2, { recursive: true, force: true }); }
});
