/**
 * discover.mjs —— pingModels 缓存。
 *
 * 插件每个事件都跑一轮同步；pingModels 不缓存的话，每个「还没配模型
 * 的网关路由」每轮都吃 2 个未认证探测请求（根路径 + /v1）。
 * 事件（settings/updated、adapters-updated）可以高频触发。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listModels, pingModels } from '../src/discover.mjs';

test('pingModels：同一 URL 在 TTL 内只发一次请求', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('{}', { status: 404 }); };
  try {
    const a = await pingModels('http://gw.example', undefined);
    const b = await pingModels('http://gw.example', undefined);
    assert.equal(a, 404);
    assert.equal(b, 404);
    assert.equal(calls, 1, '第二次应命中缓存，不再打网关');
    // ttlMs=0 绕过缓存
    await pingModels('http://gw.example', undefined, 0);
    assert.equal(calls, 2);
    // key 有无是不同的缓存槽（401-with-key 与 404-no-key 状态不同）
    await pingModels('http://gw.example', 'sk-1');
    assert.equal(calls, 3);
    await pingModels('http://gw.example', 'sk-1');
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('pingModels：网络失败返回 0 且同样被缓存', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('boom'); };
  try {
    const a = await pingModels('http://down.example', undefined, 0);
    const b = await pingModels('http://down.example', undefined);
    assert.equal(a, 0);
    assert.equal(b, 0);
    assert.equal(calls, 1, '失败结果也缓存 —— 挂掉的网关不该每轮都重试拖慢同步');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('listModels：捡走 architecture.input_modalities，丢掉 schema 不认的 audio', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: [{
      id: 'foo-vl',
      architecture: { input_modalities: ['text', 'image', 'audio'] },
      context_length: 128000,
    }],
  }), { status: 200 });
  try {
    const rows = await listModels('http://or.example/v1', 'k');
    assert.equal(rows[0].id, 'foo-vl');
    assert.deepEqual(rows[0].declared.input, ['text', 'image']);
    assert.equal(rows[0].declared.contextWindow, 128000);
  } finally {
    globalThis.fetch = realFetch;
  }
});
