/**
 * 模型 id 匹配 —— 硬映射（src/aliases.mjs）+ 软匹配（src/match.mjs）。
 *
 * 匹配层决定「网关的怪 id 能不能拿到正确的档位表」。排序语义尤其重要：
 * 原样候选永远第一，否则 qwen3.8-max 这类本名以档位词结尾的 id
 * 会被软匹配剥掉 -max、配成错误的档位表 —— 而且没有任何报错。
 *
 * 守护断言沿用 vendors.test.mjs 的思路：每条对应一个已经发生过、
 * 或很容易发生的静默错误（别名表写了真值库不认识的 id、键含大写
 * 导致永远查不到、键本身已能命中变成死重）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_ALIASES } from '../src/aliases.mjs';
import { resolveModelCandidates } from '../src/match.mjs';
import { findAnyVendor, modelSpec, vendorForUrl } from '../src/vendors.mjs';
import { planGatewayRoute } from '../src/sync.mjs';

/* ── 硬映射 ──────────────────────────────────────────────────── */

test('硬映射：日期快照 id 命中，档位来自规范 id、发给网关的 id 不变', () => {
  const hit = findAnyVendor('deepseek-v4-pro-0813');
  assert.equal(hit.vendor.id, 'deepseek');
  assert.equal(hit.id, 'deepseek-v4-pro');
  assert.equal(hit.via, '硬映射');
  const r = planGatewayRoute('ubt', {
    baseURL: 'http://x/v1', models: [{ id: 'deepseek-v4-pro-0813' }],
  }, { fetchOk: false, ids: [] }, {});
  const m = r.profile.models[0];
  assert.equal(m.id, 'deepseek-v4-pro-0813');
  assert.equal(m.reasoningEfforts.off, null);
  assert.equal(m.reasoningEfforts.max, 'max');
  assert.ok(!('medium' in m.reasoningEfforts), 'deepseek 的 medium 是静默塌缩档，不该出现');
  assert.ok(r.notes.some((n) => n.includes('硬映射') && n.includes('deepseek-v4-pro-0813')));
});

test('硬映射：vendor/ 前缀 + 别名组合', () => {
  const hit = findAnyVendor('deepseek/deepseek-v4-flash-0731');
  assert.equal(hit.vendor.id, 'deepseek');
  assert.equal(hit.id, 'deepseek-v4-flash');
  assert.equal(hit.via, '硬映射');
});

test('硬映射：查表大小写不敏感', () => {
  const hit = findAnyVendor('DeepSeek-V4-Flash-0731');
  assert.equal(hit.id, 'deepseek-v4-flash');
  assert.equal(hit.via, '硬映射');
});

/* ── 软匹配 ──────────────────────────────────────────────────── */

test('软匹配：表里没有的日期快照也能剥（表不必无限膨胀）', () => {
  const hit = findAnyVendor('deepseek-v4-pro-0901');
  assert.equal(hit.vendor.id, 'deepseek');
  assert.equal(hit.id, 'deepseek-v4-pro');
  assert.equal(hit.via, '去日期后缀');
});

test('软匹配：YYYYMMDD / YYYY-MM-DD / YYMM 三种日期形态', () => {
  assert.equal(findAnyVendor('deepseek-v4-flash-20250901')?.via, '去日期后缀');
  assert.equal(findAnyVendor('deepseek-v4-flash-2025-09-01')?.via, '去日期后缀');
  assert.equal(findAnyVendor('deepseek-v4-flash-2507')?.via, '去日期后缀');
});

test('软匹配：YYMMDD 日期形态（火山方舟 -250828 风格）', () => {
  const hit = findAnyVendor('deepseek-v4-pro-250828');
  assert.equal(hit?.vendor.id, 'deepseek');
  assert.equal(hit?.id, 'deepseek-v4-pro');
  assert.equal(hit?.via, '去日期后缀');
});

test('软匹配：量化后缀', () => {
  const hit = findAnyVendor('deepseek-v4-flash-fp8');
  assert.equal(hit.id, 'deepseek-v4-flash');
  assert.equal(hit.via, '去量化后缀');
});

test('软匹配：把思考档焊进 id 的变体（-high）', () => {
  const hit = findAnyVendor('deepseek-v4-flash-high');
  assert.equal(hit.id, 'deepseek-v4-flash');
  assert.equal(hit.via, '去档位后缀');
});

test('软匹配：分隔符归一 —— 数字横杠换点（kimi-k2-5 → kimi-k2.5）', () => {
  // 选 kimi 做样例是有意的：其规则带点号（k2.[56]），横杠形式原样命中不了，
  // 才能真正测到这条路径。gpt-5-6-sol / glm-5_3 这类会被更宽的
  // gpt-5 / glm-5 前缀规则先原样命中，分隔符归一轮不到。
  const hit = findAnyVendor('kimi-k2-5');
  assert.equal(hit.vendor.id, 'moonshot');
  assert.equal(hit.id, 'kimi-k2.5');
  assert.equal(hit.via, '分隔符归一');
});

test('软匹配：分隔符归一 —— 下划线+数字横杠混合一步归一（kimi-k2_5）', () => {
  const hit = findAnyVendor('kimi-k2_5');
  assert.equal(hit.vendor.id, 'moonshot');
  assert.equal(hit.id, 'kimi-k2.5');
  assert.equal(hit.via, '分隔符归一');
});

test('软匹配：截断兜底 —— 结构化模式没覆盖的任意尾段', () => {
  // -preview 不在日期/量化/档位任何模式里，靠从右往左剥尾段命中
  const hit = findAnyVendor('deepseek-v4-pro-preview');
  assert.equal(hit.vendor.id, 'deepseek');
  assert.equal(hit.id, 'deepseek-v4-pro');
  assert.equal(hit.via, '去尾段');
});

test('软匹配：截断兜底排在结构化变换之后（日期快照仍标去日期后缀）', () => {
  // deepseek-v4-pro-0901 同时命中日期模式和截断，标的是更精确的那个
  assert.equal(findAnyVendor('deepseek-v4-pro-0901')?.via, '去日期后缀');
});

test('软匹配：下划线形式经分隔符归一命中，截断也对 _ 生效', () => {
  const cands = resolveModelCandidates('deepseek_v4_pro').map((c) => c.id);
  assert.ok(cands.includes('deepseek-v4-pro'), `应有归一候选：${cands.join(' / ')}`);
  assert.ok(cands.includes('deepseek_v4'), '截断应能剥 _pro');
  const hit = findAnyVendor('deepseek_v4_pro');
  assert.equal(hit.id, 'deepseek-v4-pro');
  assert.equal(hit.via, '分隔符归一');
});

/* ── 排序语义：原样永远第一 ─────────────────────────────────── */

test('排序：本名以档位词结尾的 id 不被误剥（qwen3.8-max）', () => {
  const hit = findAnyVendor('qwen3.8-max');
  assert.equal(hit.vendor.id, 'qwen');
  assert.equal(hit.id, 'qwen3.8-max');
  assert.equal(hit.via, '原样');
});

test('排序：gpt-oss-120b-medium 的 -medium 是名字一部分，不是档位变体', () => {
  const hit = findAnyVendor('gpt-oss-120b-medium');
  assert.equal(hit.id, 'gpt-oss-120b-medium');
  assert.equal(hit.via, '原样');
});

test('排序：候选列表去重且原样排第一', () => {
  const cands = resolveModelCandidates('GLM-5.3');
  assert.equal(cands[0].id, 'GLM-5.3');
  assert.equal(cands[0].via, '原样');
  const keys = cands.map((c) => c.id.toLowerCase());
  assert.equal(new Set(keys).size, keys.length, `候选重复：${keys.join(' / ')}`);
});

/* ── 反例：软匹配不制造假命中 ───────────────────────────────── */

test('认不出的 id 仍返回 null', () => {
  assert.equal(findAnyVendor('nope-nope'), null);
  assert.equal(findAnyVendor('totally-unknown-model'), null);
  assert.equal(findAnyVendor('my-custom-slot'), null);
  assert.equal(findAnyVendor('deepseek-v3'), null);
});

test('平台专属规则不参与全局匹配：Qwen/ 前缀不再配上 Groq 档位', () => {
  // ModelScope / 硅基流动 / 百炼的 org/model 形式（Qwen/Qwen3-235B-A22B）
  // 曾原样命中 groq 的 /^qwen\//i 规则，被配上 Groq 专属 wire 拼写
  // （off:'none' / high:'default'）—— 发给这些平台就是错的。
  assert.equal(findAnyVendor('Qwen/Qwen3-235B-A22B'), null);
  // 带 -vl 的仍走 qwen 视觉规则（去前缀路径），不受 platformOnly 影响
  assert.equal(findAnyVendor('Qwen/Qwen3-VL-8B-Instruct')?.vendor.id, 'qwen');
});

test('platformOnly 只拦全局匹配：URL 命中 Groq 平台时规则仍生效', () => {
  const v = vendorForUrl('https://api.groq.com/openai/v1');
  assert.equal(v?.id, 'groq');
  assert.ok(modelSpec(v, 'qwen/qwen3-32b'), 'Groq 平台的 qwen/ 形式应命中自家规则');
});

/* ── 守护：别名表自洽（注入缺陷 → 变红） ───────────────────── */

test('守护：表的值必须能被真值库原样命中（写不存在的规范 id 等于没配）', () => {
  for (const [from, to] of Object.entries(MODEL_ALIASES)) {
    const hit = findAnyVendor(to);
    assert.ok(hit, `${from} → ${to}：目标 id 真值库不认识`);
    assert.equal(hit.via, '原样',
      `${from} → ${to}：目标自己还要靠解析才能命中，不是规范 id —— 应直接写它命中的那个`);
  }
});

test('守护：表的键一律小写（查表按小写做，含大写的键永远查不到）', () => {
  for (const key of Object.keys(MODEL_ALIASES)) {
    assert.equal(key, key.toLowerCase(), `键 ${key} 含大写`);
  }
});

test('守护：表里每个键都能经硬映射解析，且解析结果就是表的值', () => {
  for (const [from, to] of Object.entries(MODEL_ALIASES)) {
    const hit = findAnyVendor(from);
    assert.ok(hit, `${from} 在表里却整体解析失败`);
    assert.equal(hit.via, '硬映射',
      `${from} 实际经「${hit.via}」命中 —— 键已能原样/软命中说明这条是冗余，命中不了说明这条是坏的`);
    assert.equal(hit.id, to);
  }
});

/* ── 回归：ubt 网关的真实怪 id ─────────────────────────────── */

test('回归：ubt 网关在服的四个 id 全部配上正确档位', () => {
  const r = planGatewayRoute('ubt', {
    baseURL: 'http://x/v1',
    models: [
      { id: 'kimi/kimi-k3' },
      { id: 'deepseek-v4-pro-0813' },
      { id: 'deepseek-v4-flash-0731' },
      { id: 'ZHIPU/GLM-5.3' },
    ],
  }, { fetchOk: false, ids: [] }, {});
  const by = Object.fromEntries(r.profile.models.map((m) => [m.id, m]));
  // 此前这批 id 里有三个会变成 reasoningEfforts: false（配不上）
  assert.equal(by['kimi/kimi-k3'].reasoningEfforts.max, 'max');
  assert.equal(by['deepseek-v4-pro-0813'].reasoningEfforts.off, null);
  assert.equal(by['deepseek-v4-flash-0731'].reasoningEfforts.off, null);
  assert.equal(by['ZHIPU/GLM-5.3'].reasoningEfforts.low, 'low');
  for (const m of r.profile.models) {
    assert.notEqual(m.reasoningEfforts, false, `${m.id} 没配上档位`);
  }
  assert.equal(r.profile.models.length, 4, '模型被静默丢掉了');
});

test('回归：gemini 3.8flash 各类写法均能命中真值库', () => {
  const ids = ['gemini-3.8-flash', 'gemini-3.8flash', 'gemini 3.8flash', 'gemini-3.8-flash-high'];
  for (const id of ids) {
    const hit = findAnyVendor(id);
    assert.ok(hit, `${id} 应该能命中真值库`);
    assert.equal(hit.vendor.id, 'google');
    assert.equal(hit.spec.efforts.minimal, 'minimal');
    assert.equal(hit.spec.efforts.high, 'high');
  }
});
