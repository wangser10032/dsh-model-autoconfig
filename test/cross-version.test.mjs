/**
 * 跨版本：同一 planSync 产物经 trimForHost 后能过
 * /tmp/pi-ai-versions 里 0.0.1-rc.1 / 0.0.1-rc.5 / 0.1.0-rc.8 / 0.1.1-rc.2 / 0.1.2 的 Config。
 *
 * 旧包可能因 peer 版本漂移无法直接 import（CallId 等 named export 已改名）。
 * 那时从该版本 lib/index.js 抽出 schema 片段，用当前 schemastery 重建 Config。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileModel } from '../src/compile.mjs';
import { capsFromSchema, fallbackCaps, trimProviders } from '../src/host.mjs';
import { HOST_APIS } from '../src/levels.mjs';
import { planSync } from '../src/sync.mjs';
import { VENDORS, vendorById } from '../src/vendors.mjs';

const VERSIONS = [
  '0.0.1-rc.1',
  '0.0.1-rc.5',
  '0.1.0-rc.8',
  '0.1.1-rc.2',
  '0.1.2-alpha.5',
];

const ROOT = '/tmp/pi-ai-versions';

function objectKeysBlock(src, name) {
  const re = new RegExp(`(?:const|let)\\s+${name}\\s*=\\s*Object\\.keys\\(\\{([\\s\\S]*?)\\}\\)`);
  const m = src.match(re);
  if (!m) return [];
  return [...m[1].matchAll(/["']([^"']+)["']\s*:/g)].map((x) => x[1]);
}

function compatFieldNames(src) {
  const i = src.indexOf('const compatProfile = z.object({');
  if (i < 0) return [];
  const slice = src.slice(i, i + 1800);
  const end = slice.indexOf('});');
  const body = slice.slice(0, end >= 0 ? end : 1800);
  return [...body.matchAll(/^\s{1,2}([A-Za-z]+):/gm)].map((x) => x[1]);
}

function hasInputField(src) {
  return /modelFields\s*=\s*\{[\s\S]*?\binput:\s*z\.array/.test(src);
}

function loadSchemastery() {
  const req = createRequire(join(homedir(), '.dsh', 'profiles', 'web', 'package.json'));
  const href = pathToFileURL(req.resolve('@deepseek-ai/schemastery')).href;
  return import(href);
}

async function reconstructConfig(version) {
  const file = join(ROOT, version, 'package/lib/index.js');
  const src = readFileSync(file, 'utf8');
  const formats = objectKeysBlock(src, 'SUPPORTED_THINKING_FORMATS');
  const levels = objectKeysBlock(src, 'THINKING_LEVELS');
  const modalities = objectKeysBlock(src, 'MODALITIES');
  const apis = ['openai-completions', 'openai-responses', 'anthropic-messages'];
  const compatFields = compatFieldNames(src);
  const input = hasInputField(src);
  const zMod = await loadSchemastery();
  const z = zMod.default ?? zMod;

  const thinking = z.union(formats.length ? formats : ['openai']);
  const levelUnion = z.union(levels.length ? levels : ['off', 'high']);
  const compatDict = Object.fromEntries(compatFields.map((k) => {
    if (k === 'thinkingFormat') return [k, thinking];
    if (k === 'maxTokensField') return [k, z.union(['max_completion_tokens', 'max_tokens'])];
    if (k === 'cacheControlFormat') return [k, z.union(['anthropic'])];
    if (k === 'chatTemplateKwargs' || k === 'chatTemplateArgs') return [k, z.dict(z.union([z.string(), z.number(), z.boolean(), z.const(null)]))];
    return [k, z.boolean()];
  }));
  const compatProfile = z.object(compatDict);
  const modelFields = {
    name: z.string(),
    contextWindow: z.number(),
    maxTokens: z.number(),
    reasoningEfforts: z.union([z.const(false), z.dict(z.union([z.string(), z.const(null)]), levelUnion)]),
    compat: compatProfile,
    ...(input ? { input: z.array(z.union(modalities.length ? modalities : ['text', 'image'])) } : {}),
  };
  const modelProfile = z.object({ id: z.string().required(), ...modelFields });
  const profile = z.object({
    api: z.union(apis),
    baseURL: z.string(),
    models: z.array(modelProfile),
    modelOverrides: z.dict(z.object(modelFields)),
    compat: compatProfile,
    reasoning: levelUnion,
  });
  const Config = z.object({ providers: z.dict(profile).default({}) });
  return {
    Config,
    caps: {
      apis,
      thinkingFormats: formats,
      input: input ? (modalities.length ? modalities : ['text', 'image']) : [],
      levels,
      compatFields,
      modelFields: ['id', 'name', 'contextWindow', 'maxTokens', 'reasoningEfforts', 'compat', ...(input ? ['input'] : [])],
      source: `reconstruct:${version}`,
    },
  };
}

async function loadVersion(version) {
  const file = join(ROOT, version, 'package/lib/index.js');
  assert.equal(existsSync(file), true, `缺少 ${file}`);
  try {
    const href = pathToFileURL(file).href;
    const mod = await import(href);
    if (typeof mod.Config === 'function' && typeof mod.Config.toJSON === 'function') {
      return { Config: mod.Config, caps: capsFromSchema(mod.Config.toJSON()), source: 'import' };
    }
  } catch { /* peer 漂移，走重建 */ }
  const rebuilt = await reconstructConfig(version);
  return { ...rebuilt, source: 'reconstruct' };
}

function sampleProviders() {
  const models = [];
  for (const id of ['deepseek-v4-flash', 'grok-4.6', 'claude-opus-5', 'qwen3.8-max', 'gemini-3.8-flash']) {
    const hit = VENDORS.map((v) => ({ v, spec: v.models.find((m) => m.match.test(id)) })).find((x) => x.spec);
    if (!hit) continue;
    const api = hit.v.api === 'anthropic-messages' ? 'anthropic-messages' : 'openai-completions';
    const { entry } = compileModel({ vendor: hit.v, modelId: id, api, spec: hit.spec, includeIO: true });
    models.push({ api, entry });
  }
  const providers = {
    gw: {
      api: 'openai-completions',
      baseURL: 'https://example.test/v1',
      models: models.filter((m) => m.api !== 'anthropic-messages').map((m) => m.entry),
    },
    claude: {
      api: 'anthropic-messages',
      baseURL: 'https://api.anthropic.com',
      models: models.filter((m) => m.api === 'anthropic-messages').map((m) => m.entry),
    },
  };
  return planSync({ providers, state: {}, catalogEntries: [], gateways: {} }).providers;
}

test('planSync 产物经 trimForHost 后能过各历史版本 Config', async () => {
  const raw = sampleProviders();
  assert.ok(raw.gw?.models?.length);
  for (const version of VERSIONS) {
    const { Config, caps, source } = await loadVersion(version);
    const trimmed = trimProviders(raw, caps);
    try {
      new Config({ providers: trimmed });
    } catch (e) {
      throw new Error(`${version} (${source}) 拒绝 trim 后产物：${e.message}`);
    }
    // 负例：未裁剪的 reasoning_effort 仍应被该版本拒绝（枚举里从来没有它）
    const bad = {
      t: {
        api: 'openai-completions',
        baseURL: 'https://x',
        models: [{ id: 'm', reasoningEfforts: { high: 'high' }, compat: { thinkingFormat: 'reasoning_effort' } }],
      },
    };
    let threw = false;
    try { new Config({ providers: bad }); } catch { threw = true; }
    assert.equal(threw, true, `${version} 应拒绝 reasoning_effort`);
  }
  assert.ok(HOST_APIS.length === 3);
  assert.equal(fallbackCaps().thinkingFormats.includes('baseten'), true);
});
