import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRoute, decideBaseURL, normalizeEndpoint, planGatewayRoute, planCatalogRoute, planSync,
} from '../src/sync.mjs';
import { catalogRouteNames, findAnyVendor } from '../src/vendors.mjs';
import { sharedReasoningEfforts, pickRouteEffort } from '../src/levels.mjs';

const names = catalogRouteNames();

test('classify：目录名无列表 → catalog；有 models → gateway', () => {
  assert.equal(classifyRoute('deepseek', { apiKeyEnv: 'K' }, names), 'catalog');
  assert.equal(classifyRoute('deepseek', { baseURL: 'http://x', apiKeyEnv: 'K' }, names), 'gateway');
  assert.equal(classifyRoute('deepseek', { models: [{ id: 'x' }] }, names), 'gateway');
  assert.equal(classifyRoute('deepseek', { models: [] }, names), 'catalog');
});

test('classify：自定义 URL → gateway；什么都没有 → skip', () => {
  assert.equal(classifyRoute('cpa', { baseURL: 'http://x:8317' }, names), 'gateway');
  assert.equal(classifyRoute('cpa', {}, names), 'skip');
});

test('decideBaseURL：根 404 且 /v1 401 或缺 key → 补 /v1', () => {
  const d = decideBaseURL('http://8.138.254.173:8317', 404, 401);
  assert.equal(d.changed, true);
  assert.equal(d.baseURL, 'http://8.138.254.173:8317/v1');
  assert.equal(decideBaseURL('http://x/v1', 404, 401).changed, false);
  assert.equal(decideBaseURL('http://x', 401, 401).changed, false);
});

test('normalizeEndpoint：剥掉 Cherry Studio 预览路径', () => {
  assert.equal(
    normalizeEndpoint('http://8.138.254.173:8317/v1/chat/completions'),
    'http://8.138.254.173:8317/v1',
  );
  assert.equal(
    normalizeEndpoint('http://8.138.254.173:8317/chat/completions'),
    'http://8.138.254.173:8317',
  );
  const d = decideBaseURL('http://host:1/v1/chat/completions', 0, 0);
  assert.equal(d.baseURL, 'http://host:1/v1');
  assert.equal(d.changed, true);
});

test('目录路由只写 modelOverrides.reasoningEfforts，绝不写 models[]', () => {
  const r = planCatalogRoute('deepseek', { apiKeyEnv: 'DEEPSEEK_API_KEY' }, [
    { provider: 'deepseek', id: 'deepseek-v4-flash' },
    { provider: 'deepseek', id: 'not-in-truth-table-xyz' },
  ]);
  assert.equal(r.profile.models, undefined);
  const ov = r.profile.modelOverrides['deepseek-v4-flash'];
  assert.ok(ov.reasoningEfforts);
  assert.equal(ov.reasoningEfforts.off, null);
  assert.ok(ov.reasoningEfforts.high);
  assert.ok(!('medium' in ov.reasoningEfforts));
  assert.ok(!('contextWindow' in ov));
  assert.equal(r.profile.modelOverrides['not-in-truth-table-xyz'], undefined);
  // 路由默认档不凭空写：请求路径不会 clamp，写错比不写糟
  assert.equal(r.profile.reasoning, undefined);
});

test('目录路由空 models[] 会被删掉，避免覆盖内置目录', () => {
  const r = planCatalogRoute('deepseek', { models: [], apiKeyEnv: 'K' }, [
    { provider: 'deepseek', id: 'deepseek-v4-flash' },
  ]);
  assert.ok(!('models' in r.profile) || r.profile.models === undefined);
});

test('目录路由保留用户在 override 里手改的上下文，只覆盖档位', () => {
  const r = planCatalogRoute('deepseek', {
    modelOverrides: { 'deepseek-v4-flash': { contextWindow: 123, reasoningEfforts: { high: 'high' } } },
  }, [{ provider: 'deepseek', id: 'deepseek-v4-flash' }]);
  const ov = r.profile.modelOverrides['deepseek-v4-flash'];
  assert.equal(ov.contextWindow, 123);
  assert.equal(ov.reasoningEfforts.off, null);
  assert.ok('low' in ov.reasoningEfforts);
});

test('网关：拉取到的未知 id 不上架；认得的写入完整字段', () => {
  const r = planGatewayRoute('cpa', {
    baseURL: 'http://x/v1', apiKeyEnv: 'K',
  }, {
    fetchOk: true,
    ids: ['deepseek-v4-flash', 'totally-unknown-model'],
    declared: {},
    baseURL: 'http://x/v1',
  }, {});
  const ids = r.profile.models.map((m) => m.id);
  assert.deepEqual(ids, ['deepseek-v4-flash']);
  const m = r.profile.models[0];
  assert.equal(m.reasoningEfforts.off, null);
  assert.ok(m.contextWindow);
  assert.deepEqual(m.input, ['text']);
  assert.ok(!('medium' in m.reasoningEfforts));
});

test('网关：视觉模型写入 input:[text,image]；手改过的文本+图不降级', () => {
  const a = planGatewayRoute('cpa', {
    baseURL: 'http://x/v1',
    models: [{ id: 'deepseek-v4-flash-vision' }],
  }, { fetchOk: false, ids: [] }, {});
  assert.deepEqual(a.profile.models[0].input, ['text', 'image']);

  const b = planGatewayRoute('cpa', {
    baseURL: 'http://x/v1',
    models: [{ id: 'deepseek-v4-flash', input: ['text', 'image'] }],
  }, { fetchOk: false, ids: [] }, {});
  assert.deepEqual(b.profile.models[0].input, ['text', 'image'],
    '用户已经勾了视觉，真值库是纯文本也不能剥掉');
});

test('网关：includeIO=false 不补视觉', () => {
  const r = planGatewayRoute('cpa', {
    baseURL: 'http://x/v1',
    models: [{ id: 'deepseek-v4-flash-vision' }, { id: 'my-qwen-vl' }],
  }, { fetchOk: false, ids: [] }, {}, undefined, false);
  assert.ok(!('input' in r.profile.models[0]));
  assert.ok(!('input' in r.profile.models[1]));
});

test('网关：未知 id 按名字补视觉，不编档位', () => {
  const r = planGatewayRoute('cpa', {
    baseURL: 'http://x/v1',
    models: [{ id: 'my-qwen-vl-plus', contextWindow: 99 }],
  }, { fetchOk: false, ids: [] }, { modelIds: ['my-qwen-vl-plus'] });
  assert.equal('reasoningEfforts' in r.profile.models[0], false);
  assert.deepEqual(r.profile.models[0].input, ['text', 'image']);
  assert.equal(r.profile.models[0].contextWindow, 99);
});

test('网关：/models 自报视觉会并进真值库条目', () => {
  const r = planGatewayRoute('cpa', { baseURL: 'http://x/v1' }, {
    fetchOk: true,
    ids: ['deepseek-v4-flash'],
    declared: { 'deepseek-v4-flash': { input: ['text', 'image'] } },
  }, {});
  assert.deepEqual(r.profile.models[0].input, ['text', 'image']);
});

test('目录：视觉只在目录没声明时写入 override.input', () => {
  const r = planCatalogRoute('deepseek', { apiKeyEnv: 'K' }, [
    { provider: 'deepseek', id: 'deepseek-v4-flash', model: { input: ['text'] } },
    { provider: 'deepseek', id: 'deepseek-v4-flash-vision', model: { input: ['text'] } },
  ]);
  const flash = r.profile.modelOverrides['deepseek-v4-flash'];
  const vis = r.profile.modelOverrides['deepseek-v4-flash-vision'];
  assert.ok(!('input' in flash), '目录已是文本、真值库也是文本，不写冗余 input');
  assert.deepEqual(vis.input, ['text', 'image']);
  assert.ok(vis.reasoningEfforts);
  assert.ok(r.notes.some((n) => n.includes('deepseek-v4-flash-vision') && n.includes('视觉')));
});

test('目录：目录本身已声明视觉则不写 input override', () => {
  const r = planCatalogRoute('anthropic', { apiKeyEnv: 'K' }, [
    { provider: 'anthropic', id: 'claude-opus-5', model: { input: ['text', 'image'] } },
  ]);
  assert.ok(!('input' in r.profile.modelOverrides['claude-opus-5']));
});

test('主干：Settings 里已有模型时不拉 /models 也能配档位', () => {
  const r = planGatewayRoute('cpa', {
    baseURL: 'http://x/v1',
    models: [
      { id: 'deepseek-v4-flash' },
      { id: 'claude-opus-5' },
    ],
  }, { fetchOk: false, ids: [] }, {});
  const flash = r.profile.models.find((m) => m.id === 'deepseek-v4-flash');
  const opus = r.profile.models.find((m) => m.id === 'claude-opus-5');
  assert.equal(flash.reasoningEfforts.off, null);
  assert.ok(flash.reasoningEfforts.high);
  assert.ok('off' in opus.reasoningEfforts);
  assert.equal(r.profile.models.length, 2);
});

test('主干：vendor/model 前缀仍能撞上真值库，发给网关的 id 不变', () => {
  assert.equal(findAnyVendor('deepseek/deepseek-v4-flash').vendor.id, 'deepseek');
  assert.equal(findAnyVendor('openai/gpt-5.6-sol').vendor.id, 'openai');
  assert.equal(findAnyVendor('anthropic/claude-opus-5').vendor.id, 'anthropic');
  const r = planGatewayRoute('cpa', {
    baseURL: 'http://x/v1',
    models: [{ id: 'deepseek/deepseek-v4-flash' }],
  }, { fetchOk: false, ids: [] }, {});
  assert.equal(r.profile.models[0].id, 'deepseek/deepseek-v4-flash');
  assert.equal(r.profile.models[0].reasoningEfforts.off, null);
});

test('网关：用户手加的未知 id 原样保留，不编造 false', () => {
  // reasoningEfforts: false 是「该模型不支持思考」的断言 —— 对真值库不认识的
  // id 这是在替网关瞎说，早期版本这么写过。现在识别不到就不动这条。
  const r = planGatewayRoute('cpa', {
    baseURL: 'http://x/v1',
    models: [{ id: 'my-custom-slot', contextWindow: 99 }],
  }, { fetchOk: true, ids: [], declared: {} }, { modelIds: ['my-custom-slot'] });
  assert.equal(r.profile.models.length, 1);
  assert.equal(r.profile.models[0].id, 'my-custom-slot');
  assert.equal('reasoningEfforts' in r.profile.models[0], false,
    '不应出现 reasoningEfforts 键 —— 识别不到就不改');
  assert.equal(r.profile.models[0].contextWindow, 99, '其余字段原样保留');
});

test('网关：删除名单里的模型即使 /models 还有也不加回', () => {
  const r = planGatewayRoute('cpa', {
    baseURL: 'http://x/v1',
    models: [{ id: 'deepseek-v4-flash', reasoningEfforts: { off: null, high: 'high' } }],
  }, {
    fetchOk: true,
    ids: ['deepseek-v4-flash', 'grok-4.6'],
    declared: {},
  }, { modelIds: ['deepseek-v4-flash', 'grok-4.6'], deletedIds: [] });
  // 当前列表没有 grok → 记入删除；fetch 有 grok 也不加
  assert.ok(r.stateSlice.deletedIds.includes('grok-4.6'));
  assert.ok(!r.profile.models.some((m) => m.id === 'grok-4.6'));
});

test('网关：fetch 失败不清空已有模型', () => {
  const r = planGatewayRoute('cpa', {
    baseURL: 'http://x/v1',
    models: [{ id: 'deepseek-v4-flash', contextWindow: 99 }],
  }, { fetchOk: false, ids: [] }, { modelIds: ['deepseek-v4-flash'] });
  assert.equal(r.profile.models.length, 1);
  assert.equal(r.profile.models[0].id, 'deepseek-v4-flash');
  assert.equal(r.profile.models[0].contextWindow, 99);
  assert.equal(r.profile.models[0].reasoningEfforts.off, null);
});

test('网关：手改的 contextWindow 保留，档位表覆盖', () => {
  const r = planGatewayRoute('cpa', {
    baseURL: 'http://x/v1',
    models: [{
      id: 'deepseek-v4-flash',
      contextWindow: 111,
      reasoningEfforts: { high: 'high', medium: 'medium' },
    }],
  }, { fetchOk: true, ids: ['deepseek-v4-flash'], declared: {} }, { modelIds: ['deepseek-v4-flash'] });
  const m = r.profile.models[0];
  assert.equal(m.contextWindow, 111);
  assert.ok(!('medium' in m.reasoningEfforts));
  assert.equal(m.reasoningEfforts.off, null);
});

test('网关：空 reasoning 不凭空写；已有合法值不覆盖', () => {
  const a = planGatewayRoute('cpa', { baseURL: 'http://x/v1' }, { fetchOk: false, ids: [] }, {});
  assert.equal(a.profile.reasoning, undefined,
    '请求路径不 clamp 路由默认档 —— 凭空写 medium 会在用户没选档时直接 UNSUPPORTED_REASONING_EFFORT');
  assert.equal(a.profile.models, undefined);
  const b = planGatewayRoute('cpa', {
    baseURL: 'http://x/v1', reasoning: 'low',
    models: [{ id: 'deepseek-v4-flash' }],
  }, { fetchOk: false, ids: [] }, {});
  assert.equal(b.profile.reasoning, 'low', 'low 在全体模型档位表里，保留');
});

test('网关：已有 models 时删掉并存的 modelOverrides', () => {
  const r = planGatewayRoute('cpa', {
    baseURL: 'http://x/v1',
    models: [{ id: 'deepseek-v4-flash' }],
    modelOverrides: { 'deepseek-v4-flash': { reasoningEfforts: { high: 'high' } } },
  }, { fetchOk: false, ids: [] }, { modelIds: ['deepseek-v4-flash'] });
  assert.equal(r.profile.modelOverrides, undefined);
});

/* ── 路由默认档收敛：请求路径不 clamp，写错比不写糟 ───────────── */

test('sharedReasoningEfforts：交集 / 无共有 / 没有推理模型', () => {
  const e = (efforts) => ({ reasoningEfforts: efforts });
  // deepseek(off/low/high/max) ∩ kimi-k3(low/high/max) = low/high/max
  assert.deepEqual(
    Object.keys(sharedReasoningEfforts([e({ off: null, low: 'low', high: 'high', max: 'max' }), e({ low: 'low', high: 'high', max: 'max' })])),
    ['low', 'high', 'max'],
  );
  // 完全不相交 → false
  assert.equal(sharedReasoningEfforts([e({ low: 'low' }), e({ high: 'high' })]), false);
  // 全是非推理模型 / 空 → null
  assert.equal(sharedReasoningEfforts([e(false), { reasoningEfforts: false }]), null);
  assert.equal(sharedReasoningEfforts([]), null);
  // 没有 reasoningEfforts 键的条目不算推理模型
  assert.equal(sharedReasoningEfforts([{ id: 'x' }]), null);
});

test('pickRouteEffort：合法保留 / 收敛 / 删掉 / 不凭空加', () => {
  const ds = [{ reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } }];
  assert.equal(pickRouteEffort('low', ds), 'low', '在共有档里，保留');
  assert.equal(pickRouteEffort('medium', ds), 'high', '不在表里，先向上收敛');
  assert.equal(pickRouteEffort('xhigh', ds), 'max', 'xhigh 向上到 max');
  assert.equal(pickRouteEffort('medium', [{ reasoningEfforts: false }]), undefined, '没有推理模型 → 删');
  assert.equal(pickRouteEffort(null, ds), undefined, '没有现成值 → 不凭空加');
});

test('Grok / Gemini 3.6 没有 off 档', () => {
  const r = planGatewayRoute('cpa', { baseURL: 'http://x/v1' }, {
    fetchOk: true,
    ids: ['grok-4.6', 'gemini-3.6-flash-high'],
    declared: {},
  }, {});
  const grok = r.profile.models.find((m) => m.id === 'grok-4.6');
  const gem = r.profile.models.find((m) => m.id === 'gemini-3.6-flash-high');
  assert.ok(grok && !('off' in grok.reasoningEfforts));
  assert.ok(gem && !('off' in gem.reasoningEfforts));
});

test('Gemini 3.8 Flash 支持（含 minimal 档位，无 off 档，支持视觉）', () => {
  const r = planGatewayRoute('cpa', { baseURL: 'http://x/v1' }, {
    fetchOk: true,
    ids: ['gemini-3.8-flash', 'gemini-3.8-flash-high', 'gemini-3.8flash', 'gemini 3.8flash'],
    declared: {},
  }, {});
  for (const id of ['gemini-3.8-flash', 'gemini-3.8-flash-high', 'gemini-3.8flash', 'gemini 3.8flash']) {
    const m = r.profile.models.find((item) => item.id === id);
    assert.ok(m, `${id} 应该被匹配并加入 models 列表`);
    assert.ok(!('off' in m.reasoningEfforts), `${id} 不应包含 off 档`);
    assert.equal(m.reasoningEfforts.minimal, 'minimal');
    assert.equal(m.reasoningEfforts.low, 'low');
    assert.equal(m.reasoningEfforts.medium, 'medium');
    assert.equal(m.reasoningEfforts.high, 'high');
    assert.deepEqual(m.input, ['text', 'image']);
    assert.equal(m.contextWindow, 1048576);
    assert.equal(m.maxTokens, 65536);
  }
});

test('路由默认档会收敛到全体模型的共有档（请求路径不 clamp，写错直接报错）', () => {
  // DeepSeek 只有 off/low/high/max，medium 不在表里。
  // 旧版直接写 medium：用户没显式选档时 `reasoningEffort ?? profile.reasoning`
  // 落到 medium → UNSUPPORTED_REASONING_EFFORT。必须收敛成 high 才能写。
  const r = planGatewayRoute('cpa', {
    baseURL: 'http://x/v1', reasoning: 'medium',
    models: [{ id: 'deepseek-v4-flash' }],
  }, { fetchOk: false, ids: [] }, {});
  assert.equal(r.profile.reasoning, 'high');
  assert.ok(r.notes.some((n) => n.includes('medium → high')));
});

test('路由默认档没有任何模型能接受时，宁可删掉', () => {
  // deepseek-chat 是非思考入口（编译为 reasoningEfforts: false），
  // 路由上没有可服务的默认档 → 删掉 reasoning，让请求走各自的默认
  const r = planGatewayRoute('cpa', {
    baseURL: 'http://x/v1', reasoning: 'medium',
    models: [{ id: 'deepseek-chat' }],
  }, { fetchOk: false, ids: [] }, {});
  assert.equal('reasoning' in r.profile, false, '应删除路由默认档');
  assert.ok(r.notes.some((n) => n.includes('去掉路由默认档')));
});

test('syncOnce：没有 providers 或 skip 路由时不写 settings', async () => {
  const { syncOnce } = await import('../src/plugin.mjs');
  const ops = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    settings: {
      get: () => ({ providers: { waiting: {} } }),
      mutate: async (_ns, o) => { ops.push(o); },
    },
  };
  const r = await syncOnce(ctx, {}, 'test');
  assert.equal(r.changed, false);
  assert.equal(ops.length, 0);
});

test('planSync 同时管目录和网关，互不写错形态', () => {
  const out = planSync({
    providers: {
      deepseek: { apiKeyEnv: 'D' },
      cpa: { baseURL: 'http://gw/v1', apiKeyEnv: 'C' },
    },
    state: { version: 1, managed: {} },
    catalogEntries: [{ provider: 'deepseek', id: 'deepseek-v4-pro' }],
    gateways: {
      cpa: { fetchOk: true, ids: ['claude-opus-5'], declared: {}, baseURL: 'http://gw/v1' },
    },
  });
  assert.equal(out.providers.deepseek.models, undefined);
  assert.ok(out.providers.deepseek.modelOverrides['deepseek-v4-pro'].reasoningEfforts);
  assert.ok(Array.isArray(out.providers.cpa.models));
  assert.equal(out.providers.cpa.models[0].id, 'claude-opus-5');
  assert.ok(!out.providers.cpa.modelOverrides);
  assert.equal(out.changed, true);
});

/* ── state 分键：CLI 的合并基线与插件的同步状态互不冲掉 ──────────
 *
 * 两者共用 managed[route] 槽位。早期版本都直接写这个槽位本身，谁后写
 * 谁覆盖对方 —— CLI 的基线没了，threeWay 的 base 变 undefined，
 * 于是「用户手改的字段永远不被覆盖」这条承诺静默失效。
 * 分成 models / sync 两个键之后不再冲突。
 */

const gatewayState = (state) => planSync({
  providers: { cpa: { baseURL: 'http://gw/v1', apiKeyEnv: 'C' } },
  state,
  catalogNames: names,
  catalogEntries: null,
  gateways: { cpa: { fetchOk: false, ids: [] } },
});

test('插件跑一轮后，CLI 的三方合并基线仍然在', async () => {
  const S = await import('../src/settings.mjs');
  const base = S.withMergeBase({ version: 2, managed: {} }, 'cpa', {
    'glm-5.3': { id: 'glm-5.3', contextWindow: 1000 },
  });

  const out = gatewayState(base);

  assert.ok(S.mergeBase(out.state, 'cpa')['glm-5.3'],
    '基线被冲掉的话，下次 CLI 会把用户手改的字段当成「没改过」直接覆盖');
  assert.equal(out.state.managed.cpa.sync.kind, 'gateway',
    '插件的同步状态应写在 .sync 下');
});

test('CLI 写基线后，插件的删除名单仍然在', async () => {
  const S = await import('../src/settings.mjs');
  const slice = { kind: 'gateway', modelIds: ['a'], deletedIds: ['b'], at: 't' };

  const next = S.withMergeBase({ version: 2, managed: { cpa: { sync: slice } } }, 'cpa', { a: { id: 'a' } });

  assert.deepEqual(next.managed.cpa.sync, slice,
    '删除名单被冲掉的话，用户删掉的模型会被 /models 再拉回来');
  assert.ok(next.managed.cpa.models.a);
});

test('旧形状的文件（slice 直接写在 managed[route] 上）不崩，按空重建', () => {
  const out = gatewayState({
    version: 1,
    managed: { cpa: { kind: 'gateway', modelIds: ['x'], deletedIds: [], at: 't' } },
  });

  assert.equal(out.state.managed.cpa.sync.kind, 'gateway',
    '旧数据的 slice 读不到，按空处理并在本轮重建');
});

/* ── 空 models[] 守卫：空表 = dsh 上这条 route 一个模型都不显示 ──── */

test('网关：/models 全是认不出的 id 时不写空 models[]', () => {
  const r = planGatewayRoute('gw', { baseURL: 'http://x/v1', apiKeyEnv: 'K' }, {
    fetchOk: true, ids: ['totally-unknown-1', 'totally-unknown-2'], declared: {},
  }, {});
  assert.equal(r.profile.models, undefined,
    '写入空 models[] 会让 dsh 上这条 route 一个模型都不显示 —— CLI 同场景直接拒绝');
  assert.ok(r.notes.some((n) => n.includes('不写空 models[]')));
});

test('网关：拉到的 id 全在删除名单里时同样不写空表', () => {
  const r = planGatewayRoute('gw', { baseURL: 'http://x/v1' }, {
    fetchOk: true, ids: ['deepseek-v4-flash'], declared: {},
  }, { modelIds: ['deepseek-v4-flash'], deletedIds: ['deepseek-v4-flash'] });
  assert.equal(r.profile.models, undefined);
});

test('网关：拉到的 id 有认得出的仍正常写表（守卫不误伤）', () => {
  const r = planGatewayRoute('gw', { baseURL: 'http://x/v1' }, {
    fetchOk: true, ids: ['deepseek-v4-flash', 'totally-unknown'], declared: {},
  }, {});
  assert.deepEqual(r.profile.models.map((m) => m.id), ['deepseek-v4-flash']);
});

/* ── 协议兜底值：写入要留痕（apiGuessed），认出端点后能自愈 ───────── */

test('协议兜底值会留 apiGuessed 标记；URL 后来命中真值库时自动修正', () => {
  // 第一轮：认不出端点 → 写兜底 openai-completions，并在 sync slice 留标记。
  // 不留标记的话，gatewayApi 里 profile.api 永远排第一，兜底值写死无法修正。
  const r1 = planGatewayRoute('gw', { baseURL: 'http://relay.example/v1' }, { fetchOk: false, ids: [] }, {});
  assert.equal(r1.profile.api, 'openai-completions');
  assert.equal(r1.stateSlice.apiGuessed, true);

  // 第二轮：settings 里已有兜底值，baseURL 换成官方端点 → 修正，标记清除
  const r2 = planGatewayRoute('gw', {
    baseURL: 'https://api.anthropic.com', api: 'openai-completions',
  }, { fetchOk: false, ids: [] }, r1.stateSlice);
  assert.equal(r2.profile.api, 'anthropic-messages');
  assert.equal(r2.stateSlice.apiGuessed, undefined);
  assert.ok(r2.notes.some((n) => n.includes('修正上一轮的未验证兜底值')));
});

test('用户把协议改成了别的值 → 不覆盖，兜底标记自动失效', () => {
  const r = planGatewayRoute('gw', {
    baseURL: 'https://api.anthropic.com', api: 'openai-responses',
  }, { fetchOk: false, ids: [] }, { kind: 'gateway', modelIds: [], deletedIds: [], apiGuessed: true, at: 't' });
  assert.equal(r.profile.api, 'openai-responses', '值 ≠ 兜底值说明是用户的手改，必须保留');
  assert.equal(r.stateSlice.apiGuessed, undefined);
});

test('URL 一开始就命中真值库 → 直接写真值库协议，不留兜底标记', () => {
  const r = planGatewayRoute('gw', { baseURL: 'https://api.deepseek.com' }, { fetchOk: false, ids: [] }, {});
  assert.equal(r.profile.api, 'openai-completions');
  assert.equal(r.stateSlice.apiGuessed, undefined);
  assert.ok(r.notes.some((n) => n.includes('真值库 deepseek')));
});

test('用户设定的协议（无兜底标记）永远优先', () => {
  const r = planGatewayRoute('gw', {
    baseURL: 'https://api.anthropic.com', api: 'openai-responses',
  }, { fetchOk: false, ids: [] }, {});
  assert.equal(r.profile.api, 'openai-responses');
});

test('OpenRouter URL 优先采用平台七档和 thinkingFormat', () => {
  const r = planGatewayRoute('or', {
    baseURL: 'https://openrouter.ai/api/v1',
    models: [{ id: 'anthropic/claude-opus-5', compat: { custom: true } }],
  }, { fetchOk: false, ids: [] }, {});
  const m = r.profile.models[0];
  assert.equal(m.reasoningEfforts.off, 'none');
  assert.equal(m.reasoningEfforts.minimal, 'minimal');
  assert.equal(m.compat.thinkingFormat, 'openrouter');
  assert.equal(m.compat.custom, true, '宿主已有 compat 字段必须保留');
});

test('Groq URL 能启用 platformOnly 的 Qwen 规则', () => {
  const r = planGatewayRoute('groq-relay', {
    baseURL: 'https://api.groq.com/openai/v1',
    models: [{ id: 'qwen/qwen3-32b' }],
  }, { fetchOk: false, ids: [] }, {});
  assert.deepEqual(r.profile.models[0].reasoningEfforts, { off: 'none', high: 'default' });
});

test('OpenRouter catalog 使用平台规则而不是底层厂商规则', () => {
  const r = planCatalogRoute('openrouter', {}, [
    { provider: 'openrouter', id: 'anthropic/claude-opus-5', model: { input: ['text', 'image'] } },
  ]);
  const efforts = r.profile.modelOverrides['anthropic/claude-opus-5'].reasoningEfforts;
  assert.equal(efforts.off, 'none');
  assert.equal(efforts.minimal, 'minimal');
});

test('端点自报不支持推理时，不按平台通配规则写假档位', () => {
  // OpenRouter 的 /.*/ 通配层会把七档配给所有模型 —— 实测 427 个模型里有
  // 128 个 supported_parameters 不含 reasoning（翻译、音乐、OCR 等）。
  const r = planGatewayRoute('or', {
    baseURL: 'https://openrouter.ai/api/v1',
  }, {
    fetchOk: true,
    ids: ['tencent/hy-mt2-7b', 'anthropic/claude-opus-5'],
    declared: {
      'tencent/hy-mt2-7b': { supportsReasoning: false },
      'anthropic/claude-opus-5': { supportsReasoning: true },
    },
  }, {});
  const mt = r.profile.models.find((m) => m.id === 'tencent/hy-mt2-7b');
  const opus = r.profile.models.find((m) => m.id === 'anthropic/claude-opus-5');
  assert.equal(mt.reasoningEfforts, false, '端点明说没有推理参数，不能配七档');
  assert.equal(mt.compat.supportsReasoningEffort, false);
  assert.equal(opus.reasoningEfforts.off, 'none', '端点说支持的仍按平台规则配满');
});

test('端点未声明推理支持时不做否定推断', () => {
  const r = planGatewayRoute('or', {
    baseURL: 'https://openrouter.ai/api/v1',
  }, {
    fetchOk: true,
    ids: ['anthropic/claude-opus-5'],
    declared: { 'anthropic/claude-opus-5': { supportsReasoning: null } },
  }, {});
  assert.equal(r.profile.models[0].reasoningEfforts.off, 'none',
    'supportsReasoning 为 null 是「没报」，不是「不支持」');
});

test('火山方舟 URL 走平台 compat；用户手改的 compat 不覆盖', () => {
  const r = planGatewayRoute('ark', {
    baseURL: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    models: [{ id: 'deepseek-v4-pro', maxTokens: 393216, compat: { supportsDeveloperRole: true } }],
  }, { fetchOk: false, ids: [] }, {});
  const m = r.profile.models[0];
  assert.equal(m.maxTokens, 128000, 'coding 端点夹紧');
  assert.equal(m.compat.supportsDeveloperRole, true, '用户手改优先于平台 false');
  assert.equal(m.compat.requiresReasoningContentOnAssistantMessages, true);
});

test('catalog 只清理 state 证明由插件管理的失效 override', () => {
  const r = planCatalogRoute('deepseek', {
    modelOverrides: {
      'deepseek-v4-flash': { reasoningEfforts: { high: 'high' } },
      'removed-by-catalog': { reasoningEfforts: { high: 'high' } },
      'user-custom': { contextWindow: 123 },
    },
  }, [{ provider: 'deepseek', id: 'deepseek-v4-flash', model: { input: ['text'] } }],
  undefined, true, { managedIds: ['deepseek-v4-flash', 'removed-by-catalog'] });
  assert.ok(r.profile.modelOverrides['deepseek-v4-flash']);
  assert.equal(r.profile.modelOverrides['removed-by-catalog'], undefined);
  assert.equal(r.profile.modelOverrides['user-custom'].contextWindow, 123);
  assert.deepEqual(r.stateSlice.managedIds, ['deepseek-v4-flash']);
});
