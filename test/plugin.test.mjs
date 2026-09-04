import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply, name } from '../src/plugin.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeoutMs = 1000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (check()) return;
    await sleep(5);
  }
  throw new Error('等待条件超时');
}

function fakeContext(settings) {
  const handlers = new Map();
  const logs = [];
  return {
    settings,
    handlers,
    logs,
    logger(loggerName) {
      assert.equal(loggerName, 'model-autoconfig');
      return {
        info: (message) => logs.push(['info', message]),
        warn: (message) => logs.push(['warn', message]),
        error: (message) => logs.push(['error', message]),
      };
    },
    on(event, handler) { handlers.set(event, handler); },
  };
}

test('apply 无需等待 ready 即按 user/revision 注入 DSH settings', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-mac-plugin-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const replacements = [];
  const profile = {
    baseURL: 'http://relay.example/v1',
    models: [{ id: 'deepseek-v4-flash' }],
  };
  const settings = {
    describe: () => [{
      ns: 'llm-pi-ai',
      value: { providers: { cpa: profile } },
      user: { marker: 'keep', providers: { cpa: profile } },
      revision: 7,
    }],
    replace: async (...args) => { replacements.push(args); },
  };
  const ctx = fakeContext(settings);
  try {
    apply(ctx, {});
    await waitFor(() => replacements.length === 1);
    const [ns, nextUser, revision] = replacements[0];
    assert.equal(ns, 'llm-pi-ai');
    assert.equal(revision, 7);
    assert.equal(nextUser.marker, 'keep');
    assert.equal(nextUser.providers.cpa.models[0].reasoningEfforts.off, null);
    assert.ok(ctx.logs.some(([level, message]) => level === 'info' && message.includes('已加载')));
  } finally {
    ctx.handlers.get('dispose')?.();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test('dispose 后已排队的同步不能写 settings', async () => {
  let releaseDescribe;
  let describeStarted = false;
  let replacements = 0;
  const descriptor = {
    ns: 'llm-pi-ai',
    value: {
      providers: {
        cpa: { baseURL: 'http://relay.example/v1', models: [{ id: 'deepseek-v4-flash' }] },
      },
    },
    user: { providers: {} },
    revision: 1,
  };
  const settings = {
    describe: () => {
      describeStarted = true;
      return new Promise((resolve) => { releaseDescribe = () => resolve([descriptor]); });
    },
    replace: async () => { replacements++; },
  };
  const ctx = fakeContext(settings);
  apply(ctx, {});
  await waitFor(() => describeStarted);
  ctx.handlers.get('dispose')?.();
  releaseDescribe();
  await sleep(30);
  assert.equal(replacements, 0);
});

test('无 replace 时 mutate 携带 expectedRevision（0.1.2 契约）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-mac-plugin-mutate-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const mutations = [];
  const profile = {
    baseURL: 'http://relay.example/v1',
    models: [{ id: 'deepseek-v4-flash' }],
  };
  const settings = {
    describe: () => [{
      ns: 'llm-pi-ai',
      value: { providers: { cpa: profile } },
      user: { providers: { cpa: profile } },
      revision: 11,
    }],
    mutate: async (...args) => { mutations.push(args); },
  };
  const ctx = fakeContext(settings);
  try {
    apply(ctx, {});
    await waitFor(() => mutations.length === 1);
    const [ns, ops, revision] = mutations[0];
    assert.equal(ns, 'llm-pi-ai');
    assert.equal(revision, 11);
    assert.equal(ops[0].op, 'set');
    assert.deepEqual(ops[0].path, ['providers', 'cpa']);
    assert.equal(ops[0].value.models[0].reasoningEfforts.off, null);
  } finally {
    ctx.handlers.get('dispose')?.();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test('发布入口、bundle patch 与插件名称保持一致', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8');
  assert.equal(pkg.main, './src/plugin.mjs');
  assert.equal(pkg.exports['.'], './src/plugin.mjs');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(pkg.version, '0.9.0');
  assert.equal(name, 'model-autoconfig');
  assert.match(patch, /id:\s*model-autoconfig/);
  assert.match(patch, /name:\s*dsh-model-autoconfig/);
});
