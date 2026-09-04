import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileModel, offOnlyOverride, CompileError } from '../src/compile.mjs';
import { vendorById, vendorForUrl, modelSpec, findAnyVendor } from '../src/vendors.mjs';
import { LEVELS } from '../src/levels.mjs';
import * as S from '../src/settings.mjs';
import YAML from 'yaml';
import { probeProtocol } from '../src/discover.mjs';

const api = 'openai-completions';

test('DeepSeek：写出显式 off 空值（修 #1580 截断）', () => {
  const v = vendorById('deepseek');
  const { entry } = compileModel({ vendor: v, modelId: 'deepseek-v4-flash', api });
  assert.equal(entry.reasoningEfforts.off, null);
  assert.ok('off' in entry.reasoningEfforts);
});

test('DeepSeek：静默塌缩的 medium/xhigh 不写入', () => {
  const v = vendorById('deepseek');
  const { entry, dropped } = compileModel({ vendor: v, modelId: 'deepseek-v4-pro', api });
  assert.deepEqual(Object.keys(entry.reasoningEfforts), ['off', 'low', 'high', 'max']);
  assert.deepEqual(dropped.collapsed.sort(), ['medium', 'xhigh']);
});

test('GLM-5.3 强制思考：不产生 off 档', () => {
  const v = vendorById('zai');
  const { entry, notes } = compileModel({ vendor: v, modelId: 'glm-5.3', api });
  assert.ok(!('off' in entry.reasoningEfforts));
  assert.ok(notes.some((n) => n.includes('强制思考')));
});

test('Grok 4.5：xhigh 会被降级，故不暴露', () => {
  const { entry } = compileModel({ vendor: vendorById('xai'), modelId: 'grok-4.5', api });
  assert.ok(!('xhigh' in entry.reasoningEfforts));
});

test('OpenAI 代际差异：gpt-5 有 minimal 无 off，gpt-5.6 反之', () => {
  const v = vendorById('openai');
  const a = compileModel({ vendor: v, modelId: 'gpt-5', api }).entry.reasoningEfforts;
  const b = compileModel({ vendor: v, modelId: 'gpt-5.6-sol', api }).entry.reasoningEfforts;
  assert.ok('minimal' in a && !('off' in a));
  assert.ok('off' in b && b.off === 'none' && !('minimal' in b));
});

test('非 openai-completions 协议不写模型级 compat（Z.ai 的 /api/anthropic 端点）', () => {
  const v = vendorById('zai');           // 有 thinkingFormat: 'zai'
  const { entry, notes } = compileModel({ vendor: v, modelId: 'glm-5.2', api: 'anthropic-messages' });
  assert.equal(entry.compat, undefined);
  assert.ok(notes.some((n) => n.includes('不接受模型级 compat')));
});

test('Anthropic 官方本就无 thinkingFormat，不产生多余提示', () => {
  const { entry, notes } = compileModel({
    vendor: vendorById('anthropic'), modelId: 'claude-opus-5', api: 'anthropic-messages' });
  assert.equal(entry.compat, undefined);
  assert.ok(!notes.some((n) => n.includes('不接受模型级 compat')));
});

test('端点裁剪覆盖官方规格并留下说明', () => {
  const v = vendorById('deepseek');
  const { entry, notes } = compileModel({
    vendor: v, modelId: 'deepseek-v4-flash', api,
    overlay: { contextWindow: 1048576, maxTokens: 128000 },
  });
  assert.equal(entry.contextWindow, 1048576);
  assert.equal(entry.maxTokens, 128000);
  assert.ok(notes.some((n) => n.includes('裁剪')));
});

test('只有 off 允许空值，其余空值应报错', () => {
  const spec = { efforts: { low: null }, };
  assert.throws(() => compileModel({ vendor: vendorById('deepseek'), modelId: 'x', api, spec }), CompileError);
});

test('无任何档位 → reasoningEfforts: false', () => {
  const spec = { efforts: {} };
  const { entry } = compileModel({ vendor: vendorById('deepseek'), modelId: 'x', api, spec });
  assert.equal(entry.reasoningEfforts, false);
  assert.equal(entry.compat.supportsReasoningEffort, false);
});

test('中转站：URL 认不出厂商时按 model id 匹配', () => {
  assert.equal(vendorForUrl('https://gw.example.com/v1'), null);
  assert.equal(findAnyVendor('glm-5.3').vendor.id, 'zai');
  assert.equal(findAnyVendor('claude-opus-5').vendor.id, 'anthropic');
  assert.equal(findAnyVendor('nope-nope'), null);
});

test('offOnlyOverride 只补 off，其余原样并按档位顺序排列', () => {
  const out = offOnlyOverride({ high: 'high', low: 'low' });
  assert.deepEqual(Object.keys(out), ['off', 'low', 'high']);
  assert.equal(out.off, null);
});

test('YAML 往返：off 键被引号保护，空值回读为 null', () => {
  const doc = S.loadDoc('/nonexistent');
  S.setRoute(doc, 'r', { api, baseURL: 'https://x/v1' });
  S.setModels(doc, 'r', [{ id: 'm', reasoningEfforts: { off: null, high: 'high' } }]);
  const text = S.render(doc);
  assert.match(text, /"off":\s*$/m);              // YAML 1.1 里 off 是布尔，必须加引号
  const back = YAML.parse(text)['llm-pi-ai'].providers.r.models[0].reasoningEfforts;
  assert.deepEqual(back, { off: null, high: 'high' });
});

test('models 与 modelOverrides 并存会被拒（dsh 的硬约束）', () => {
  const doc = S.loadDoc('/nonexistent');
  S.setModels(doc, 'r', [{ id: 'm' }]);
  assert.throws(() => S.setOverrides(doc, 'r', { m: {} }), /settings-rejected/);
});

test('三方合并：用户手改的字段不被覆盖', () => {
  const r = S.threeWay({ a: 1, b: 2 }, { a: 1, b: 99 }, { a: 5, b: 7 });
  assert.equal(r.merged.a, 5);     // 用户没动 → 采用新值
  assert.equal(r.merged.b, 99);    // 用户手改过 → 保留
  assert.equal(r.suggestions.b, 7);
});

/* ── 本轮新增：真实运行里暴露的问题 ─────────────────────── */

test('鉴权失败(401/403)不能当成「/responses 路由存在」', async () => {
  const orig = globalThis.fetch;
  for (const code of [401, 403, 429, 502]) {
    globalThis.fetch = async () => new Response('{}', { status: code });
    const r = await probeProtocol('https://gw.example/v1', 'k', 'm');
    assert.equal(r.api, null, `${code} 应判定为「探测无效」而不是猜一个协议`);
    assert.equal(r.uncertain, true);
  }
  globalThis.fetch = orig;
});

test('404 且报「模型不存在」→ 路由确实存在', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { code: 'model_not_found' } }), { status: 404 });
  const r = await probeProtocol('https://gw.example/v1', 'k', 'm');
  assert.equal(r.api, 'openai-responses');
  globalThis.fetch = orig;
});

test('deepseek 旧别名：chat 无档位、reasoner 有档位且无 off', () => {
  const v = vendorById('deepseek');
  const chat = compileModel({ vendor: v, modelId: 'deepseek-chat', api: v.api,
    spec: modelSpec(v, 'deepseek-chat'), overlay: {}, includeIO: true });
  assert.equal(chat.entry.reasoningEfforts, false);

  const rea = compileModel({ vendor: v, modelId: 'deepseek-reasoner', api: v.api,
    spec: modelSpec(v, 'deepseek-reasoner'), overlay: {}, includeIO: true });
  assert.deepEqual(Object.keys(rea.entry.reasoningEfforts), ['low', 'high', 'max']);
  assert.ok(!('off' in rea.entry.reasoningEfforts), 'reasoner 恒开思考，不该有 off');
  // 塌缩档位不能出现
  assert.ok(!('medium' in rea.entry.reasoningEfforts));
  assert.ok(!('xhigh' in rea.entry.reasoningEfforts));
});

test('deepseek-v4-flash-vision-exp 能被 vision 规则匹配上', () => {
  const v = vendorById('deepseek');
  const spec = modelSpec(v, 'deepseek-v4-flash-vision-exp');
  assert.ok(spec, '带 -exp 后缀的实验模型也要认得出来');
  assert.ok(spec.input.includes('image'));
});

test('detectShape 认得三种形状，认不出的返回 null', () => {
  const A = S.loadDoc0('llm-pi-ai:\n  providers:\n    x:\n      baseURL: u\n');
  assert.equal(S.detectShape(A).shape, 'A');
  const B = S.loadDoc0('"llm-pi-ai.providers":\n  x:\n    baseURL: u\n');
  assert.equal(S.detectShape(B).shape, 'B');
  const unknown = S.loadDoc0('llm:\n  providers:\n    x:\n      baseURL: u\n');
  assert.equal(S.detectShape(unknown), null);
});

test('deepFindProviders 能在未知形状里找出 provider 容器', () => {
  const doc = S.loadDoc0('llm:\n  providers:\n    cpa:\n      baseURL: u\n      apiKeyEnv: K\n');
  const hits = S.deepFindProviders(doc);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].parent, 'llm.providers');
  assert.deepEqual(hits[0].routes, ['cpa']);
});

test('--at 指定路径后，未知形状也能读写', () => {
  const doc = S.loadDoc0('llm:\n  providers:\n    cpa:\n      baseURL: u\n');
  assert.deepEqual(Object.keys(S.getProviders(doc, 'llm.providers')), ['cpa']);
  S.setRoute(doc, 'cpa', { api: 'openai-completions' }, 'llm.providers');
  assert.match(S.render(doc), /api: openai-completions/);
});

/* ── 「只填 url + key」路径 ─────────────────────────────── */

test('每个厂商都显式声明了 pi-ai 内置目录映射（可空 = 不参与目录路由）', async () => {
  const { VENDORS } = await import('../src/vendors.mjs');
  for (const v of VENDORS) {
    // 显式 [] 表示「未确认该厂商在 pi-ai 内置目录中的 provider 名」（tencent/mistral/nvidia），
    // 目录路由不会用到它；缺字段或类型写错仍然要报错。
    assert.ok(Array.isArray(v.catalogProviders),
      `${v.id} 缺 catalogProviders —— 不带 --models 时就没法自动列模型`);
  }
});

test('不写 output 字段：官方 PiAiModelProfile 里没有它', () => {
  const v = vendorById('deepseek');
  const r = compileModel({ vendor: v, modelId: 'deepseek-v4-pro', api: v.api,
    spec: modelSpec(v, 'deepseek-v4-pro'), overlay: {} });
  assert.ok(!('output' in r.entry), 'output 不是合法字段，写了有被整段拒绝的风险');
  assert.deepEqual(r.entry.input, ['text'], 'input 默认写入（与思考档位同级）');
});

test('includeIO:false 不写 input', () => {
  const v = vendorById('deepseek');
  const r = compileModel({ vendor: v, modelId: 'deepseek-v4-flash-vision', api: v.api,
    spec: modelSpec(v, 'deepseek-v4-flash-vision'), includeIO: false });
  assert.ok(!('input' in r.entry));
});

test('视觉：真值库与端点自报取并集，不因端点漏报而降级', () => {
  const v = vendorById('deepseek');
  const spec = modelSpec(v, 'deepseek-v4-flash-vision');
  const a = compileModel({ vendor: v, modelId: 'deepseek-v4-flash-vision', api: v.api, spec,
    overlay: { input: ['text'] } });
  assert.deepEqual(a.entry.input, ['text', 'image']);
  assert.ok(a.notes.some((n) => n.includes('端点未报视觉')));

  const b = compileModel({ vendor: v, modelId: 'deepseek-v4-flash', api: v.api,
    spec: modelSpec(v, 'deepseek-v4-flash'), overlay: { input: ['text', 'image'] } });
  assert.deepEqual(b.entry.input, ['text', 'image']);
  assert.ok(b.notes.some((n) => n.includes('视觉能力来自端点自报')));
});

test('目录 route 的 modelOverrides 只带档位表，不覆盖目录其它字段', () => {
  const doc = S.loadDoc0('');
  S.setOverrides(doc, 'deepseek', {
    'deepseek-v4-pro': { reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } },
  });
  const out = S.render(doc);
  assert.match(out, /modelOverrides:/);
  assert.match(out, /"off":\s*$/m, 'off 必须是带引号的空值');
  assert.ok(!/contextWindow/.test(out), '目录 route 不该覆盖 contextWindow');
  assert.ok(!/\bmodels:/.test(out), 'models 与 modelOverrides 不能并存');
  // 回读确认 off 是 null 而不是 YAML 1.1 的 false
  const back = YAML.parse(out);
  const re = back['llm-pi-ai'].providers.deepseek.modelOverrides['deepseek-v4-pro'].reasoningEfforts;
  assert.equal(re.off, null);
  assert.equal(re.max, 'max');
});

/* ── 路由级默认档位 与 适配器硬约束 ─────────────────────── */

test('clamp 方向与 pi-ai 一致：先向上找，再向下找', () => {
  // pi-ai models.js:404 clampThinkingLevel —— DeepSeek 只有 low/high/max，
  // 请求 medium 应该收敛到 high（向上），不是 low（向下）。
  const has = ['low', 'high', 'max'];
  const i = LEVELS.indexOf('medium');
  const near = LEVELS.slice(i + 1).find((l) => has.includes(l))
           ?? [...LEVELS.slice(0, i)].reverse().find((l) => has.includes(l));
  assert.equal(near, 'high');
  // 请求 minimal 时上面没有 low 以下的档，向上找到 low
  const j = LEVELS.indexOf('minimal');
  const near2 = LEVELS.slice(j + 1).find((l) => has.includes(l));
  assert.equal(near2, 'low');
});

test('只剩 off 一档时改写成 false —— 适配器会拒绝 off-only 档位表', () => {
  const spec = { efforts: { off: null }, contextWindow: 1000, maxTokens: 100 };
  const r = compileModel({ vendor: { id: 't', api: 'openai-completions' },
    modelId: 'm', api: 'openai-completions', spec, overlay: {}, includeIO: false });
  assert.equal(r.entry.reasoningEfforts, false);
});

test('真值库里没有 off-only 的档位表', async () => {
  const { VENDORS } = await import('../src/vendors.mjs');
  for (const v of VENDORS) for (const m of v.models) {
    const ks = Object.keys(m.efforts ?? {});
    if (ks.length) assert.ok(ks.some((l) => l !== 'off'),
      `${v.id} 的 ${m.match} 只有 off 一档，适配器会整段拒绝`);
  }
});

test('每条规则要么有 off 档，要么白纸黑字声明了不可关闭', async () => {
  const { VENDORS } = await import('../src/vendors.mjs');
  for (const v of VENDORS) for (const m of v.models) {
    const ks = Object.keys(m.efforts ?? {});
    if (!ks.length) continue;                 // 非推理模型，走 reasoningEfforts:false
    const hasOff = ks.includes('off');
    const forced = Boolean(m.forcedThinking);
    // 异或：不能两者都有（自相矛盾），也不能两者都无（漏了 off 还没人知道为什么）
    assert.notEqual(hasOff, forced,
      `${v.id} 的 ${m.match}：hasOff=${hasOff} forcedThinking=${forced}。` +
      `没有 off 档就必须写明 forcedThinking 的理由，否则分不清是「不能关」还是「漏配了」`);
    if (forced) assert.ok(m.forcedThinking.length > 8, `${v.id} 的 ${m.match} 的 forcedThinking 理由太短`);
  }
});

test('协议探测集收敛到宿主手写路由允许的三个', async () => {
  const { SELF_DESCRIBING_APIS, SUPPORTED_APIS, HOST_APIS, THINKING_FORMATS } = await import('../src/levels.mjs');
  assert.deepEqual(HOST_APIS,
    ['openai-completions', 'openai-responses', 'anthropic-messages']);
  assert.deepEqual(SELF_DESCRIBING_APIS, HOST_APIS);
  assert.deepEqual(SUPPORTED_APIS, HOST_APIS);
  assert.ok(!SUPPORTED_APIS.includes('google-generative-ai'),
    '自定义路由不能写 google-generative-ai，宿主会整段拒绝');
  assert.ok(!THINKING_FORMATS.includes('reasoning_effort'),
    'thinkingFormat 没有 reasoning_effort，那是 wire 字段名');
  assert.equal(THINKING_FORMATS.length, 11);
});

test('xAI / Groq 的 thinkingFormat 是 openai（不是非法的 reasoning_effort）', () => {
  for (const id of ['xai', 'groq']) {
    const v = vendorById(id);
    assert.equal(v.thinkingFormat, 'openai', `${id} 必须写宿主枚举值 openai`);
    const modelId = id === 'xai' ? 'grok-4.6' : 'openai/gpt-oss-120b';
    const { entry } = compileModel({ vendor: v, modelId, api });
    assert.equal(entry.compat.thinkingFormat, 'openai');
  }
});

test('Google 自定义路由走 openai-completions，档位 wire 仍是 thinking_level 那套', () => {
  const v = vendorById('google');
  assert.equal(v.api, 'openai-completions');
  assert.equal(v.thinkingFormat, 'openai');
  const { entry } = compileModel({ vendor: v, modelId: 'gemini-3.8-flash', api: v.api });
  assert.equal(entry.compat.thinkingFormat, 'openai');
  assert.equal(entry.reasoningEfforts.minimal, 'minimal');
  assert.equal(entry.reasoningEfforts.high, 'high');
});

test('Google 域名探测写 openai-completions 而不是 google-generative-ai', async () => {
  const r = await probeProtocol('https://generativelanguage.googleapis.com/v1beta/openai', 'k', 'gemini-3.8-flash');
  assert.equal(r.api, 'openai-completions');
  assert.ok(!String(r.api).includes('google-generative-ai'));
});
