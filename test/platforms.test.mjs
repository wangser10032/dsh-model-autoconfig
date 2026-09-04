import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileModel } from '../src/compile.mjs';
import { applyPlatform, platformForUrl } from '../src/platforms.mjs';
import { planGatewayRoute } from '../src/sync.mjs';
import { vendorById } from '../src/vendors.mjs';

test('URL 命中火山/硅基/百炼平台覆盖', () => {
  assert.equal(platformForUrl('https://ark.cn-beijing.volces.com/api/v3')?.id, 'volcengine-ark');
  assert.equal(platformForUrl('https://ark.cn-beijing.volces.com/api/coding/v3')?.id, 'volcengine-ark');
  assert.equal(platformForUrl('https://api.siliconflow.cn/v1')?.id, 'siliconflow');
  assert.equal(platformForUrl('https://dashscope.aliyuncs.com/compatible-mode/v1')?.id, 'dashscope');
  assert.equal(platformForUrl('https://openrouter.ai/api/v1'), null);
});

test('火山 coding 端点夹紧 maxTokens，v3 不夹；compat 关 developer', () => {
  const v = vendorById('deepseek');
  const compiled = compileModel({ vendor: v, modelId: 'deepseek-v4-pro', api: 'openai-completions' });
  const coding = applyPlatform(compiled, platformForUrl('https://ark.cn-beijing.volces.com/api/coding/v3'), {
    baseURL: 'https://ark.cn-beijing.volces.com/api/coding/v3', modelId: 'deepseek-v4-pro',
  });
  assert.equal(coding.entry.maxTokens, 128000);
  assert.equal(coding.entry.compat.supportsDeveloperRole, false);
  assert.equal(coding.entry.compat.requiresReasoningContentOnAssistantMessages, true);
  assert.equal(coding.entry.compat.supportsStrictMode, undefined);

  const v3 = applyPlatform(compiled, platformForUrl('https://ark.cn-beijing.volces.com/api/v3'), {
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3', modelId: 'deepseek-v4-pro',
  });
  assert.equal(v3.entry.maxTokens, 384000);
});

test('硅基流动 DeepSeek-V4 档位 low/medium→high、xhigh→max', () => {
  const v = vendorById('deepseek');
  const compiled = compileModel({ vendor: v, modelId: 'deepseek-v4-flash', api: 'openai-completions' });
  const r = applyPlatform(compiled, platformForUrl('https://api.siliconflow.cn/v1'), {
    baseURL: 'https://api.siliconflow.cn/v1', modelId: 'deepseek-ai/DeepSeek-V4-Flash',
  });
  assert.deepEqual(Object.keys(r.entry.reasoningEfforts), ['off', 'high', 'max']);
});

test('百炼 compatible-mode 覆盖 thinkingFormat=qwen 且关 developer/store', () => {
  const r = planGatewayRoute('bailian', {
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [{ id: 'qwen3.8-max' }],
  }, { fetchOk: false, ids: [] }, {});
  const m = r.profile.models[0];
  assert.equal(m.compat.thinkingFormat, 'qwen');
  assert.equal(m.compat.supportsDeveloperRole, false);
  assert.equal(m.compat.supportsStore, false);
});

test('用户手改的 compat 不被平台覆盖', () => {
  const r = planGatewayRoute('sf', {
    baseURL: 'https://api.siliconflow.cn/v1',
    models: [{ id: 'deepseek-ai/DeepSeek-V4-Flash', compat: { thinkingFormat: 'deepseek', custom: true } }],
  }, { fetchOk: false, ids: [] }, {});
  const m = r.profile.models[0];
  assert.equal(m.compat.thinkingFormat, 'deepseek', '用户手改优先');
  assert.equal(m.compat.custom, true);
});
