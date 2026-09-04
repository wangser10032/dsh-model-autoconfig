/**
 * 守护：编译产物必须通过真实宿主 Config schema。
 *
 * 非法 thinkingFormat / 非法 api 会被 schemastery 整段拒绝，而不是忽略。
 * 本文件禁止 skip：宿主包解析不到或 settings.yaml 读不到都是硬失败。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
const WEB_PKG = join(homedir(), '.dsh', 'profiles', 'web', 'package.json');

async function loadHost() {
  const errors = [];
  try {
    const href = pathToFileURL(createRequire(WEB_PKG).resolve('@deepseek-ai/dsh-llm-pi-ai')).href;
    return await import(href);
  } catch (e) {
    errors.push(`web profile: ${e.message.split('\n')[0]}`);
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

test('真实 settings.yaml 只读副本经 planSync 后过宿主 Config', () => {
  assert.equal(existsSync(SETTINGS), true, `需要可读的 ${SETTINGS}（不要改原文件）`);
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mac-host-schema-'));
  const copy = join(dir, 'settings.yaml');
  try {
    copyFileSync(SETTINGS, copy);
    const raw = YAML.parse(readFileSync(copy, 'utf8'));
    const providers = raw?.['llm-pi-ai']?.providers;
    assert.ok(providers && typeof providers === 'object', '副本里没有 llm-pi-ai.providers');
    const planned = planSync({
      providers,
      state: {},
      catalogEntries: [],
      gateways: {},
    });
    accept(planned.providers, 'planSync(settings.yaml 副本)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
