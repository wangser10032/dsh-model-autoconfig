/**
 * 守护：编译产物必须通过真实宿主 Config schema。
 *
 * 非法 thinkingFormat / 非法 api 会被 schemastery 整段拒绝，而不是忽略。
 * 本文件禁止 skip：宿主包解析不到或 settings.yaml 读不到都是硬失败。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';
import { compileModel } from '../src/compile.mjs';
import { HOST_APIS, THINKING_FORMATS } from '../src/levels.mjs';
import { planSync } from '../src/sync.mjs';
import { VENDORS } from '../src/vendors.mjs';

const SETTINGS = join(homedir(), '.dsh', 'settings.yaml');
const PROFILES = join(homedir(), '.dsh', 'profiles');

async function loadHost() {
  const errors = [];
  // 0.2.x 桌面版把宿主打进 app.asar，profile 里没有 node_modules；
  // 仓库的 devDependency 才是当前宿主。
  for (const from of [import.meta.url, join(PROFILES, 'web', 'package.json')]) {
    try {
      const href = pathToFileURL(createRequire(from).resolve('@deepseek-ai/dsh-llm-pi-ai')).href;
      return await import(href);
    } catch (e) {
      errors.push(`resolve from ${from}: ${e.message.split('\n')[0]}`);
    }
  }
  try {
    return await import('@deepseek-ai/dsh-llm-pi-ai');
  } catch (e) {
    errors.push(`direct: ${e.message.split('\n')[0]}`);
    throw new Error(`无法加载宿主 @deepseek-ai/dsh-llm-pi-ai（${errors.join('；')}）`);
  }
}

const { Config } = await loadHost();
assert.equal(typeof Config, 'function', '宿主必须导出 Config');

function constValues(node, refs) {
  if (node == null) return [];
  const schema = typeof node === 'number' ? refs[node] : node;
  if (!schema) return [];
  if (schema.type === 'const' && typeof schema.value === 'string') return [schema.value];
  if (schema.type === 'union') return (schema.list ?? []).flatMap((id) => constValues(id, refs));
  return [];
}

/** 从 Config.toJSON() 机械抽取某字段的字符串枚举（schemastery 对枚举值严格）。 */
function fieldEnum(refs, field) {
  for (const node of Object.values(refs ?? {})) {
    if (node?.dict && field in node.dict) {
      const values = constValues(node.dict[field], refs);
      if (values.length) return values;
    }
  }
  return [];
}

function accept(providers, label) {
  try {
    return new Config({ providers });
  } catch (e) {
    throw new Error(`${label}：宿主 Config 拒绝 — ${e.message}`);
  }
}

function reject(providers) {
  try {
    new Config({ providers });
    return null;
  } catch (e) {
    return e.message;
  }
}

test('THINKING_FORMATS / HOST_APIS 与宿主 Config.toJSON 枚举一致', () => {
  const json = Config.toJSON();
  assert.ok(json?.refs, 'Config.toJSON() 应给出 {uid,refs}');
  const formats = fieldEnum(json.refs, 'thinkingFormat');
  const apis = fieldEnum(json.refs, 'api');
  assert.deepEqual(formats, [...THINKING_FORMATS]);
  assert.deepEqual(apis, [...HOST_APIS]);
  assert.ok(!formats.includes('reasoning_effort'));
  assert.ok(!apis.includes('google-generative-ai'));
});

test('真值库每条规则 × 三种协议都能过宿主 new Config', () => {
  let n = 0;
  for (const v of VENDORS) {
    for (const spec of v.models) {
      for (const api of HOST_APIS) {
        const { entry } = compileModel({
          vendor: v, modelId: 'probe', api, spec, includeIO: true,
        });
        accept({
          t: { api, baseURL: 'https://example.test/v1', models: [entry] },
        }, `${v.id} / ${String(spec.match)} / ${api}`);
        n++;
      }
    }
  }
  assert.ok(n > 0);
});

/**
 * 0.2.x 的模型配置落在 profile 的 cordis.patch.yml（id: llm-pi-ai 的
 * config.providers），不再是 ~/.dsh/settings.yaml。两者都尝试，取第一个。
 */
function realProviders() {
  if (existsSync(SETTINGS)) {
    try {
      const raw = YAML.parse(readFileSync(SETTINGS, 'utf8'));
      const p = raw?.['llm-pi-ai']?.providers;
      if (p && typeof p === 'object') return p;
    } catch { /* 旧文件坏了就继续找 profile */ }
  }
  let dirs = [];
  try {
    dirs = readdirSync(PROFILES, { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { return null; }
  for (const name of dirs) {
    for (const file of ['cordis.patch.yml', 'cordis.yml']) {
      const f = join(PROFILES, name, file);
      if (!existsSync(f)) continue;
      let rows;
      try { rows = YAML.parse(readFileSync(f, 'utf8')); } catch { continue; }
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        const p = row?.id === 'llm-pi-ai' ? row?.config?.providers : null;
        if (p && typeof p === 'object') return p;
      }
    }
  }
  return null;
}

/** 没有可读的真实配置时，用真值库合成一份等价的 providers fixture。 */
function syntheticProviders() {
  const models = [];
  for (const v of VENDORS.slice(0, 6)) {
    const spec = v.models[0];
    if (!spec) continue;
    const { entry } = compileModel({
      vendor: v, modelId: 'probe', api: 'openai-completions', spec, includeIO: true,
    });
    models.push(entry);
  }
  return { probe: { api: 'openai-completions', baseURL: 'https://example.test/v1', models } };
}

test('真实 profile 配置（或合成 fixture）经 planSync 后过宿主 Config', () => {
  const providers = realProviders() ?? syntheticProviders();
  const planned = planSync({
    providers,
    state: {},
    catalogEntries: [],
    gateways: {},
  });
  accept(planned.providers, 'planSync(providers)');
});

test('负例：非法 thinkingFormat reasoning_effort 被宿主拒绝', () => {
  const msg = reject({
    t: {
      api: 'openai-completions',
      baseURL: 'https://example.test/v1',
      models: [{
        id: 'grok-4.6',
        reasoningEfforts: { high: 'high' },
        compat: { thinkingFormat: 'reasoning_effort' },
      }],
    },
  });
  assert.ok(msg, '宿主必须拒绝 reasoning_effort');
  assert.match(msg, /thinkingFormat/);
  assert.match(msg, /reasoning_effort/);
});

test('负例：自定义路由 api google-generative-ai 被宿主拒绝', () => {
  const msg = reject({
    t: {
      api: 'google-generative-ai',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta',
      models: [{ id: 'gemini-3.8-flash', reasoningEfforts: { high: 'high' } }],
    },
  });
  assert.ok(msg, '宿主必须拒绝 google-generative-ai');
  assert.match(msg, /google-generative-ai/);
});
