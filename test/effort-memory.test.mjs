import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const clientFile = fileURLToPath(new URL('../lib/client.js', import.meta.url));

async function loadClient(storage = new Map()) {
  let definition;
  const localStorage = {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, String(value)); },
  };
  const window = {
    __ModuleLoader__: {
      load(value) { definition = value; },
    },
  };
  const source = await readFile(clientFile, 'utf8');
  runInNewContext(source, { window, localStorage, JSON, Map, Object, Array, String, Error });
  assert.ok(definition, 'client bundle 应注册到 ModuleLoader');
  return { exports: definition.factory(() => { throw new Error('client 不应依赖未声明模块'); }), storage };
}

function directoryFixture() {
  const state = {
    current: { provider: 'cpa', model: 'grok-4.6', reasoningEffort: 'high' },
    groups: [{
      id: 'cpa',
      models: [
        { id: 'grok-4.6', reasoning: { defaultEffort: 'high', efforts: [{ id: 'low' }, { id: 'high' }, { id: 'xhigh' }] } },
        { id: 'gpt-5.6-sol', reasoning: { defaultEffort: 'medium', efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }] } },
        { id: 'plain-model' },
      ],
    }],
  };
  const accepted = [];
  const directory = {
    store: { getSnapshot: () => state },
    async select(selection) {
      accepted.push({ ...selection });
      state.current = { ...selection };
    },
  };
  return { directory, state, accepted };
}

function install(client, directory) {
  const resolver = {
    live: { directories: new Map([['session-1', directory]]) },
    directoryFor() { return directory; },
  };
  let dispose;
  client.apply({
    inject(names, callback) {
      assert.deepEqual([...names], ['modelDirectories']);
      dispose = callback({ modelDirectories: resolver });
    },
  });
  return { resolver, dispose };
}

test('按 provider+model 记住成功选择的档位，切回模型时恢复', async () => {
  const { exports: client, storage } = await loadClient();
  const { directory, state, accepted } = directoryFixture();
  install(client, directory);

  await directory.select({ provider: 'cpa', model: 'grok-4.6', reasoningEffort: 'xhigh' });
  state.current = { provider: 'cpa', model: 'gpt-5.6-sol', reasoningEffort: 'medium' };
  await directory.select({ provider: 'cpa', model: 'grok-4.6' });

  assert.deepEqual(accepted, [
    { provider: 'cpa', model: 'grok-4.6', reasoningEffort: 'xhigh' },
    { provider: 'cpa', model: 'grok-4.6', reasoningEffort: 'xhigh' },
  ]);
  const memory = JSON.parse(storage.get(client.STORAGE_KEY));
  assert.equal(memory.version, 1);
  assert.equal(memory.efforts[JSON.stringify(['cpa', 'grok-4.6'])], 'xhigh');
});

test('模型不再支持已记忆档位时清除旧值并回退模型默认', async () => {
  const key = 'dsh-model-autoconfig.effort-memory.v1';
  const modelKey = JSON.stringify(['cpa', 'grok-4.6']);
  const storage = new Map([[key, JSON.stringify({ version: 1, efforts: { [modelKey]: 'max' } })]]);
  const { exports: client } = await loadClient(storage);
  const { directory, state, accepted } = directoryFixture();
  install(client, directory);

  state.current = { provider: 'cpa', model: 'gpt-5.6-sol', reasoningEffort: 'medium' };
  await directory.select({ provider: 'cpa', model: 'grok-4.6' });

  assert.deepEqual(accepted[0], { provider: 'cpa', model: 'grok-4.6' }, '失效记忆不应覆盖模型默认选择');
  const memory = JSON.parse(storage.get(client.STORAGE_KEY));
  assert.equal(memory.efforts[modelKey], 'high', '宿主省略档位时按模型默认 high 重新记忆');
});

test('非推理模型不保留档位，损坏 JSON 与存储失败都静默降级', async () => {
  const storage = new Map([['dsh-model-autoconfig.effort-memory.v1', '{bad-json']]);
  const { exports: client } = await loadClient(storage);
  const { directory, state, accepted } = directoryFixture();
  install(client, directory);

  state.current = { provider: 'cpa', model: 'grok-4.6', reasoningEffort: 'high' };
  await directory.select({ provider: 'cpa', model: 'plain-model' });
  assert.deepEqual(accepted[0], { provider: 'cpa', model: 'plain-model' });

  const throwing = await loadClient();
  throwing.storage.set = () => { throw new Error('quota'); };
  const next = directoryFixture();
  assert.doesNotThrow(() => install(throwing.exports, next.directory));
  await assert.doesNotReject(() => next.directory.select({ provider: 'cpa', model: 'grok-4.6', reasoningEffort: 'low' }));
});

test('dispose 恢复 resolver 与 directory 原方法', async () => {
  const { exports: client } = await loadClient();
  const { directory } = directoryFixture();
  const originalSelect = directory.select;
  const { resolver, dispose } = install(client, directory);
  const wrappedDirectoryFor = resolver.directoryFor;
  assert.notEqual(directory.select, originalSelect);
  dispose();
  assert.equal(directory.select, originalSelect);
  assert.notEqual(resolver.directoryFor, wrappedDirectoryFor, 'dispose 后应恢复原 directoryFor');
  assert.equal(resolver.directoryFor(), directory);
});
