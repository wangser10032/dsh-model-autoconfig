import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPAT_GATES, capsFromSchema, fallbackCaps, trimProfile, trimProviders } from '../src/host.mjs';
import { HOST_APIS, THINKING_FORMATS } from '../src/levels.mjs';

test('COMPAT_GATES 与宿主 0.1.2 offer 字段集一致', () => {
  assert.equal(COMPAT_GATES['openai-completions'].length, 17);
  assert.deepEqual(COMPAT_GATES['openai-responses'], [
    'supportsDeveloperRole', 'supportsStrictMode', 'supportsLongCacheRetention',
  ]);
  assert.ok(COMPAT_GATES['anthropic-messages'].includes('forceAdaptiveThinking'));
  assert.equal(COMPAT_GATES['anthropic-messages'].length, 7);
});

test('trimProfile 按协议丢掉不该出现的 compat 字段', () => {
  const caps = fallbackCaps();
  const oc = trimProfile({
    api: 'openai-completions',
    models: [{ id: 'm', compat: { thinkingFormat: 'openai', forceAdaptiveThinking: true } }],
  }, caps);
  assert.equal(oc.models[0].compat.thinkingFormat, 'openai');
  assert.equal(oc.models[0].compat.forceAdaptiveThinking, undefined);

  const am = trimProfile({
    api: 'anthropic-messages',
    models: [{ id: 'm', compat: { thinkingFormat: 'openai', forceAdaptiveThinking: true } }],
  }, caps);
  assert.equal(am.models[0].compat.thinkingFormat, undefined);
  assert.equal(am.models[0].compat.forceAdaptiveThinking, true);
});

test('trimProfile 按宿主 schema 丢掉未知 thinkingFormat / input', () => {
  const caps = {
    ...fallbackCaps(),
    thinkingFormats: ['openai', 'deepseek'],
    modelFields: ['id', 'name', 'contextWindow', 'maxTokens', 'reasoningEfforts', 'compat'],
    compatFields: ['thinkingFormat', 'supportsReasoningEffort'],
    source: 'schema',
  };
  const r = trimProfile({
    api: 'openai-completions',
    models: [{
      id: 'm',
      input: ['text', 'image'],
      reasoningEfforts: { high: 'high' },
      compat: { thinkingFormat: 'baseten', supportsStore: false, supportsReasoningEffort: true },
    }],
  }, caps);
  assert.equal(r.models[0].input, undefined, '0.0.1-rc.1 没有 input 字段');
  assert.equal(r.models[0].compat.thinkingFormat, undefined, 'baseten 不在旧枚举');
  assert.equal(r.models[0].compat.supportsStore, undefined);
  assert.equal(r.models[0].compat.supportsReasoningEffort, true);
});

test('capsFromSchema 从 Config.toJSON 抽出枚举', async () => {
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const { join } = await import('node:path');
  const { homedir } = await import('node:os');
  const req = createRequire(join(homedir(), '.dsh', 'profiles', 'web', 'package.json'));
  const { Config } = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-llm-pi-ai')).href);
  const caps = capsFromSchema(Config.toJSON());
  assert.deepEqual(caps.apis, [...HOST_APIS]);
  assert.deepEqual(caps.thinkingFormats, [...THINKING_FORMATS]);
  assert.ok(caps.compatFields.includes('thinkingFormat'));
  assert.ok(caps.modelFields.includes('input'));
});

test('trimProviders 非法 api 收敛到 openai-completions', () => {
  const r = trimProviders({
    g: { api: 'google-generative-ai', models: [{ id: 'm' }] },
  }, fallbackCaps());
  assert.equal(r.g.api, 'openai-completions');
});
