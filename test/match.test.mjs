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
import { findAnyVendor, findVendorModel, modelSpec, vendorForUrl } from '../src/vendors.mjs';
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

test('软匹配：分隔符归一 —— 数字点换横杠（doubao-seed-2.0-pro）', () => {
  const hit = findAnyVendor('doubao-seed-2.0-pro');
  assert.equal(hit?.vendor.id, 'doubao');
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
  const q = findAnyVendor('Qwen/Qwen3-235B-A22B');
  assert.equal(q?.vendor.id, 'qwen');
  assert.notEqual(q.spec.efforts.high, 'default');
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

test('平台上下文优先，且不会放宽全局 platformOnly 防线', () => {
  const openrouter = findVendorModel('anthropic/claude-opus-5', 'openrouter');
  assert.equal(openrouter.vendor.id, 'openrouter');
  assert.equal(openrouter.spec.efforts.off, 'none');
  const groq = findVendorModel('qwen/qwen3-32b', 'groq');
  assert.equal(groq.vendor.id, 'groq');
  assert.equal(groq.spec.efforts.high, 'default');
  const globalQwen = findAnyVendor('qwen/qwen3-32b');
  assert.equal(globalQwen.vendor.id, 'qwen');
  assert.notEqual(globalQwen.spec.efforts.high, 'default');
});

test('Codex 与数字分隔符变体不会被宽规则提前吞掉', () => {
  assert.equal(findAnyVendor('gpt-5-codex').vendor.id, 'openai-codex');
  assert.equal(findAnyVendor('gpt-5.6-codex').vendor.id, 'openai-codex');
  const gpt = findAnyVendor('gpt-5-6-sol');
  assert.equal(gpt.vendor.id, 'openai');
  assert.equal(gpt.id, 'gpt-5.6-sol');
  assert.equal(gpt.via, '分隔符归一');
  const glm = findAnyVendor('glm-5_3');
  assert.equal(glm.vendor.id, 'zai');
  assert.equal(glm.id, 'glm-5.3');
  assert.equal(glm.via, '分隔符归一');
  assert.equal(glm.spec.forcedThinking != null, true);
});

test('去尾段不能把明确视觉模型降级成纯文本规则', () => {
  assert.equal(findAnyVendor('deepseek-v4-pro-vision'), null);
  assert.equal(findAnyVendor('deepseek-v4-pro-vl'), null);
});

/* ── 平台变体后缀：OpenRouter 的 :batch / :free ─────────────────
 * 依据 2026-09-04 openrouter.ai/api/v1/models 实测：427 个模型中
 * 67 个带 :batch、18 个带 :free。前缀型规则顺带就命中了，但带结尾锚的
 * OpenAI 规则（gpt-5.5(-|$)）会被冒号挡住，是唯一真正失配的一批。
 */

test('平台变体后缀：带结尾锚的规则不再被 :batch 挡住', () => {
  const hit = findAnyVendor('openai/gpt-5.5:batch');
  assert.equal(hit?.vendor.id, 'openai');
  assert.equal(hit.id, 'gpt-5.5');
  assert.equal(hit.via, '去平台变体后缀');
  assert.equal(findAnyVendor('openai/gpt-5:batch')?.vendor.id, 'openai');
});

test('平台变体后缀：前缀型规则维持原有命中路径，不被新变换抢走', () => {
  assert.equal(findAnyVendor('z-ai/glm-5.3:batch')?.via, '去前缀');
  assert.equal(findAnyVendor('anthropic/claude-opus-5:batch')?.via, '去前缀');
});

/* ── 百炼 / OpenRouter 在服的 Qwen flash 系列 ──────────────────
 * 依据同一次 /models 实测：3.5–3.8 flash 均 supported_parameters 含
 * reasoning 但不含 reasoning_effort —— 即开关式思考，与 plus 同型。
 */

test('Qwen flash 系列按开关式思考配档，输出上限区分代际', () => {
  const f38 = findAnyVendor('qwen3.8-flash');
  assert.equal(f38.vendor.id, 'qwen');
  assert.deepEqual(f38.spec.efforts, { off: null, high: 'high' });
  assert.equal(f38.spec.maxTokens, 131072);
  const f37 = findAnyVendor('qwen/qwen3.7-flash');
  assert.equal(f37.vendor.id, 'qwen');
  assert.equal(f37.spec.maxTokens, 65536);
  assert.equal(findAnyVendor('qwen3.6-flash')?.spec.maxTokens, 65536);
  // 3.8-max 有离散档位，不能被 flash 规则波及
  assert.equal(findAnyVendor('qwen3.8-max').spec.efforts.xhigh, 'xhigh');
});

/* ── 近半年新出且使用较多的模型（2026-09-05 按官方文档核对）──────
 * 依据：HuggingFace 官方 model card（Qwen3.8/3.6/3.5、Mistral、Nemotron）、
 * docs.x.ai 官方模型注册表（grok-4.3）、腾讯云 TokenHub 文档（混元）、
 * developers.openai.com 模型目录（chat-latest）、ai.google.dev（Gemma 4）。
 */

test('Qwen 开源版档位与官方 API 版不同：无 none 值、2.4T 强制思考', () => {
  const q27 = findAnyVendor('qwen/qwen3.8-27b');
  assert.equal(q27.vendor.id, 'qwen');
  assert.deepEqual(Object.keys(q27.spec.efforts), ['off', 'low', 'medium', 'xhigh']);
  assert.equal(q27.spec.efforts.off, null, '开源枚举无 off 值，off 走 enable_thinking 开关');
  assert.deepEqual(q27.spec.input, ['text', 'image']);

  const qm = findAnyVendor('qwen/qwen3.8-2.4t-a95b');
  assert.ok(qm.spec.forcedThinking, '2.4T-A95B 强制思考');
  assert.ok(!('off' in qm.spec.efforts));
  assert.deepEqual(qm.spec.input, ['text']);

  const q36 = findAnyVendor('qwen/qwen3.6-27b');
  assert.deepEqual(q36.spec.efforts, { off: null, high: 'high' });
  assert.equal(findAnyVendor('qwen3.5-9b')?.vendor.id, 'qwen');
  // API 版 3.8-max 的 off 同样是 dsh off 档（不发 wire 值，由 thinkingFormat 开关）
  assert.equal(findAnyVendor('qwen3.8-max').spec.efforts.off, null);
});

test('grok-4.3 推理可关闭（与 4.5/4.6 相反），档位来自官方注册表', () => {
  const g = findAnyVendor('x-ai/grok-4.3');
  assert.equal(g.vendor.id, 'xai');
  assert.deepEqual(
    Object.keys(g.spec.efforts), ['off', 'low', 'medium', 'high', 'xhigh'],
  );
  assert.equal(g.spec.efforts.off, 'none');
});

test('混元 hy3/hy4：none/low/high 与 none/high，medium 不暴露', () => {
  const hy3 = findAnyVendor('tencent/hy3');
  assert.equal(hy3.vendor.id, 'tencent');
  assert.deepEqual(Object.keys(hy3.spec.efforts), ['off', 'low', 'high']);
  assert.equal(findAnyVendor('tencent/hy3-preview')?.vendor.id, 'tencent');
  const hy4 = findAnyVendor('tencent/hy4-preview');
  assert.deepEqual(Object.keys(hy4.spec.efforts), ['off', 'high']);
});

test('Mistral Medium 3.5 只有 none/high 两档', () => {
  const m = findAnyVendor('mistralai/mistral-medium-3-5');
  assert.equal(m.vendor.id, 'mistral');
  assert.deepEqual(Object.keys(m.spec.efforts), ['off', 'high']);
});

test('Nemotron 与 Gemma 4 是开关式：off 缺省即不发', () => {
  const n = findAnyVendor('nvidia/nemotron-3.5-lightning');
  assert.equal(n.vendor.id, 'nvidia');
  assert.deepEqual(n.spec.efforts, { off: null, high: 'high' });
  assert.equal(findAnyVendor('nvidia/nemotron-3-ultra-550b-a55b')?.vendor.id, 'nvidia');
  assert.equal(findAnyVendor('nvidia/nemotron-3-super-120b-a12b')?.vendor.id, 'nvidia');
  const gemma = findAnyVendor('google/gemma-4-31b-it');
  assert.equal(gemma.vendor.id, 'google');
  assert.deepEqual(gemma.spec.efforts, { off: null, high: 'high' });
});

test('chat-latest 是非推理 Instant 模型，编译为 reasoningEfforts: false', async () => {
  const hit = findAnyVendor('openai/gpt-chat-latest');
  assert.equal(hit.vendor.id, 'openai');
  const { compileModel } = await import('../src/compile.mjs');
  const { entry } = compileModel({
    vendor: hit.vendor, modelId: 'gpt-chat-latest', api: hit.vendor.api, spec: hit.spec, includeIO: true,
  });
  assert.equal(entry.reasoningEfforts, false);
  assert.deepEqual(entry.input, ['text', 'image']);
});

test('已调研但档位语义不满足安全编码的模型保持未命中', () => {
  // 这些模型官方文档没有可确证的 off 表达（或无 effort 参数），
  // 写进真值库会违反「要么有 off 档，要么声明不可关闭」的硬约束：
  // meta/muse-*（枚举不完整）、thinkingmachines/inkling（effort 是连续标量）、
  // grok-4.20 普通版（无 effort 参数）、step-3.7-flash（无 off 且未声明强制思考）。
  assert.equal(findAnyVendor('meta/muse-spark-1.2'), null);
  assert.equal(findAnyVendor('thinkingmachines/inkling'), null);
  assert.equal(findAnyVendor('x-ai/grok-4.20'), null);
  assert.equal(findAnyVendor('stepfun/step-3.7-flash'), null);
});

/* ── 硅基流动在服对话模型（www.siliconflow.cn/models，2026-09-05 抓取）──
 * 硅基流动是聚合平台：URL 不该命中任何厂商，按模型 id 全局匹配（org/model
 * 前缀经去前缀命中）。Pro/ 前缀靠「去前缀两次」（Pro/org/Model → org/Model
 * → Model）覆盖，不需要单独规则。
 */

test('硅基流动在服的对话模型全部命中正确厂商与档位', () => {
  const cases = [
    // [id, vendor, 断言]
    ['zai-org/GLM-5.3', 'zai', (h) => assert.ok(h.spec.forcedThinking)],
    ['zai-org/GLM-5.2', 'zai', (h) => assert.equal(h.spec.efforts.off, 'none')],
    ['Pro/zai-org/GLM-5.1', 'zai', (h) => assert.equal(h.id, 'GLM-5.1')],
    ['zai-org/GLM-4.7', 'zai', null],
    ['deepseek-ai/DeepSeek-V4-Flash', 'deepseek', (h) => assert.equal(h.spec.efforts.off, null)],
    ['deepseek-ai/DeepSeek-V4-Pro', 'deepseek', null],
    ['moonshotai/Kimi-K2.7-Code', 'moonshot', (h) => assert.ok(h.spec.forcedThinking)],
    ['Pro/moonshotai/Kimi-K2.6', 'moonshot', (h) => assert.equal(h.id, 'Kimi-K2.6')],
    ['Qwen/Qwen3.6-27B', 'qwen', (h) => assert.deepEqual(h.spec.efforts, { off: null, high: 'high' })],
    ['Qwen/Qwen3.6-35B-A3B', 'qwen', null],
    ['Qwen/Qwen3-VL-32B-Instruct', 'qwen', (h) => assert.ok(h.spec.input.includes('image'))],
    ['MiniMaxAI/MiniMax-M2.5', 'minimax',
      (h) => {
        // M2.5 官方确认与 M2 同为强制思考（disabled 接受但无效）——现有 M2 规则正确覆盖
        assert.ok(h.spec.forcedThinking);
        assert.deepEqual(h.spec.efforts, { high: 'adaptive' });
      }],
    ['meituan-longcat/LongCat-2.0', 'meituan', (h) => assert.equal(h.spec.efforts.off, null)],
  ];
  for (const [id, vendor, extra] of cases) {
    const h = findAnyVendor(id);
    assert.ok(h, `${id} 应命中真值库`);
    assert.equal(h.vendor.id, vendor, `${id} 厂商不符`);
    if (extra) extra(h);
  }
});

test('硅基流动 URL 不命中任何厂商（聚合平台按模型 id 匹配）', () => {
  assert.equal(vendorForUrl('https://api.siliconflow.cn/v1'), null);
});

/* ── 火山方舟 doubao/Seed（官方映射表 2026-09-05 原文核对）─────────
 * 全部 7 档被接受但部分静默映射，真值库只收真实档：
 *   组A evolving/2-1：off 发 minimal、none→minimal、xhigh/max→high
 *   组B 2-0 系：同组A，默认 medium
 *   组C glm-5-2：none/minimal 关思考、low/medium→high、xhigh→max
 *   组D ga 版：medium→low、xhigh→high
 *   组E 260425 版：low/medium→high、xhigh→max
 */

test('方舟组A：off 发 minimal，xhigh/max 不暴露', () => {
  const a = findAnyVendor('doubao-seed-2-1-pro-260628');
  assert.equal(a.vendor.id, 'doubao');
  assert.deepEqual(a.spec.efforts, { off: 'minimal', low: 'low', medium: 'medium', high: 'high' });
  assert.equal(a.spec.contextWindow, 1048576);
  assert.ok(a.spec.input.includes('image'));
  const turbo = findAnyVendor('doubao-seed-2-1-turbo-260628');
  assert.equal(turbo.spec.contextWindow, 262144);
  assert.deepEqual(turbo.spec.efforts, a.spec.efforts);
  const b = findAnyVendor('doubao-seed-2-0-lite-260428');
  assert.deepEqual(b.spec.efforts, a.spec.efforts, '2-0 系映射与组A相同');
  assert.equal(b.spec.maxTokens, null, 'lite 输出上限官方口径不一致，以端点自报为准');
});

test('方舟组C/D/E：三套不同的真实档位', () => {
  const glm = findAnyVendor('glm-5-2-260617');
  assert.equal(glm.vendor.id, 'doubao', '方舟托管的 glm-5-2 按方舟映射表配档');
  assert.deepEqual(glm.spec.efforts, { off: 'none', high: 'high', max: 'max' });

  const ga = findAnyVendor('deepseek-v4-pro-ga-260813');
  assert.deepEqual(ga.spec.efforts, { off: 'none', low: 'low', high: 'high' });
  assert.equal(ga.spec.maxTokens, 393216);

  const e = findAnyVendor('deepseek-v4-flash-260425');
  assert.deepEqual(e.spec.efforts, { off: 'minimal', high: 'high', max: 'max' });
});

test('方舟 URL 命中 doubao 厂商；官方 deepseek 直连 id 不被方舟规则遮蔽', async () => {
  assert.equal(vendorForUrl('https://ark.cn-beijing.volces.com/api/v3')?.id, 'doubao');
  // 带方舟后缀的变体按方舟档位；官方直连 id 仍走 deepseek 真值
  const { compileModel } = await import('../src/compile.mjs');
  const ark = findVendorModel('deepseek-v4-pro-260425', 'doubao');
  assert.equal(ark.vendor.id, 'doubao');
  const plain = findVendorModel('deepseek-v4-pro', 'doubao');
  assert.equal(plain.vendor.id, 'deepseek', '无方舟后缀的官方 id 落回 deepseek 全局真值');
});

test('OpenRouter bytedance-seed 前缀经硬映射命中方舟规则', () => {
  const h = findAnyVendor('bytedance-seed/seed-2-1-turbo');
  assert.equal(h.vendor.id, 'doubao');
  assert.equal(h.via, '硬映射');
  assert.equal(h.id, 'doubao-seed-2-1-turbo-260628');
  assert.equal(h.spec.efforts.off, 'minimal');
  assert.equal(findAnyVendor('bytedance-seed/seed-2.0-code')?.spec.efforts.off, 'minimal',
    '2.0-code 属组B（2-0 系），映射与组A相同');
  assert.equal(findAnyVendor('bytedance-seed/seed-2.0-lite')?.vendor.id, 'doubao');
});
