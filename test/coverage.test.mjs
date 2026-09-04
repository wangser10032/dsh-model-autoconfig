/**
 * 真值库对 pi-ai 内置目录的覆盖率。
 * 基准：findCatalogDir()（真实安装 = profiles 层 pnpm 提升目录）。
 * 核心厂商 100%；全目录 ≥80%。禁止 skip。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCatalogDir, loadCatalog } from '../src/catalog.mjs';
import { findVendorModel, vendorForCatalogRoute } from '../src/vendors.mjs';

const CORE = [
  'openai', 'anthropic', 'google', 'google-vertex', 'deepseek', 'xai', 'groq',
  'openrouter', 'zai', 'zai-coding-cn', 'moonshotai', 'moonshotai-cn',
  'minimax', 'minimax-cn', 'openai-codex',
];

function hitOf(e) {
  return findVendorModel(e.id, vendorForCatalogRoute(e.provider));
}

test('pi-ai 目录覆盖率：核心厂商 100%，全目录 ≥80%', () => {
  const dir = findCatalogDir();
  assert.ok(dir, '找不到 pi-ai 数据目录');
  const entries = loadCatalog(dir, 0);
  assert.ok(entries.length > 100, `目录条目过少：${entries.length}`);

  const byProv = new Map();
  for (const e of entries) {
    if (!byProv.has(e.provider)) byProv.set(e.provider, []);
    byProv.get(e.provider).push(e);
  }

  const lines = [];
  const coreMiss = [];
  let coreHit = 0, coreN = 0, allHit = 0;
  for (const [p, list] of [...byProv.entries()].sort()) {
    const miss = [];
    let hit = 0;
    for (const e of list) {
      if (hitOf(e)) hit++;
      else miss.push(e.id);
    }
    allHit += hit;
    const core = CORE.includes(p);
    if (core) {
      coreHit += hit;
      coreN += list.length;
      for (const id of miss) coreMiss.push(`${p}:${id}`);
    }
    lines.push(`${core ? '*' : ' '} ${p} ${hit}/${list.length} (${(hit / list.length * 100).toFixed(1)}%)${miss.length ? ` miss=${miss.slice(0, 6).join(',')}` : ''}`);
  }

  const allRate = allHit / entries.length;
  const coreRate = coreN ? coreHit / coreN : 0;
  const table = lines.join('\n');
  assert.equal(coreMiss.length, 0,
    `核心厂商未 100%（${(coreRate * 100).toFixed(1)}% ${coreHit}/${coreN}）\n${coreMiss.slice(0, 30).join('\n')}\n---\n${table}`);
  assert.ok(allRate >= 0.80,
    `全目录覆盖 ${(allRate * 100).toFixed(1)}% < 80%（${allHit}/${entries.length}）\n${table}`);
});

test('优先缺口清单全部命中且档位有出处', () => {
  const cases = [
    ['o3', 'openai'],
    ['o4-mini', 'openai'],
    ['gpt-4.1', 'openai'],
    ['gpt-4o', 'openai'],
    ['claude-sonnet-4-5', 'anthropic'],
    ['kimi-k2-thinking', 'moonshot'],
    ['mimo-v2.5', 'xiaomi'],
    ['Ring-2.6-1T', 'ant-ling'],
    ['Ling-2.6-flash', 'ant-ling'],
    ['deepseek-v3.2', 'deepseek'],
    ['gemini-flash-lite-latest', 'google'],
  ];
  for (const [id, vendor] of cases) {
    const h = findVendorModel(id);
    assert.ok(h, `${id} 应命中真值库`);
    assert.equal(h.vendor.id, vendor, `${id} 厂商不符`);
  }
});

test('火山/硅基/百炼真实 id 硬映射与软规则', () => {
  const ark = [
    ['deepseek-v4-pro-260425', 'doubao'],
    ['doubao-seed-2-1-pro-260628', 'doubao'],
    ['doubao-seed-2.0-pro', 'doubao'],
    ['ark-code-latest', 'doubao'],
    ['glm-5-2-260617', 'doubao'],
  ];
  for (const [id, vendor] of ark) {
    const h = findVendorModel(id, 'doubao');
    assert.ok(h, `${id} 应命中`);
    assert.equal(h.vendor.id, vendor, `${id} 厂商不符`);
  }
  const sf = [
    'Pro/deepseek-ai/DeepSeek-V4-Pro',
    'deepseek-ai/DeepSeek-V4-Flash',
    'Pro/zai-org/GLM-5.2',
    'Qwen/Qwen3-VL-235B-A22B-Thinking',
    'moonshotai/Kimi-K3',
  ];
  for (const id of sf) assert.ok(findVendorModel(id), `${id} 硅基在服 id 应命中`);
  const bailian = ['qwen3.8-max', 'qwen3.7-plus', 'deepseek-v3.2', 'kimi-k2.6', 'MiniMax-M2.5'];
  for (const id of bailian) assert.ok(findVendorModel(id), `${id} 百炼 id 应命中`);
});
