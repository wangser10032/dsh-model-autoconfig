import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  coversInput, inferInput, normalizeInput, parseDeclaredInput, unionInput,
} from '../src/modalities.mjs';

test('normalizeInput：只保留 dsh 认识的 text/image，顺序稳定', () => {
  assert.deepEqual(normalizeInput(['image', 'text', 'audio', 'VISION']), ['text', 'image']);
  assert.deepEqual(normalizeInput(['image']), ['text', 'image'], '只报 image 也要补上 text 地板');
  assert.equal(normalizeInput([]), null);
  assert.equal(normalizeInput(['audio']), null);
  assert.equal(normalizeInput(null), null);
});

test('unionInput：只增不减', () => {
  assert.deepEqual(unionInput(['text'], ['image']), ['text', 'image']);
  assert.deepEqual(unionInput(['text', 'image'], ['text']), ['text', 'image']);
  assert.equal(unionInput(null, undefined, []), null);
});

test('coversInput：目录缺省按纯文本算', () => {
  assert.equal(coversInput(undefined, ['text']), true);
  assert.equal(coversInput(['text'], ['text', 'image']), false);
  assert.equal(coversInput(['text', 'image'], ['text', 'image']), true);
  assert.equal(coversInput(undefined, ['text', 'image']), false);
});

test('inferInput：名字里的 vl / vision / 5v 才推断，不瞎猜 gpt-4o', () => {
  assert.deepEqual(inferInput('qwen3-vl-plus'), ['text', 'image']);
  assert.deepEqual(inferInput('deepseek-v4-flash-vision'), ['text', 'image']);
  assert.deepEqual(inferInput('glm-5v-turbo'), ['text', 'image']);
  assert.deepEqual(inferInput('llama-4-omni'), ['text', 'image']);
  assert.equal(inferInput('gpt-4o'), null);
  assert.equal(inferInput('deepseek-v4-flash'), null);
  assert.deepEqual(inferInput('mystery', ['vision']), ['text', 'image']);
  assert.deepEqual(inferInput('qwen-vl', ['text']), ['text', 'image'],
    '已有纯文本声明不能挡住名字里的 vl');
});

test('parseDeclaredInput：OpenRouter architecture 与布尔开关', () => {
  assert.deepEqual(parseDeclaredInput({
    architecture: { input_modalities: ['text', 'image', 'audio'] },
  }), ['text', 'image']);
  assert.deepEqual(parseDeclaredInput({ architecture: { modality: 'text+image' } }), ['text', 'image']);
  assert.deepEqual(parseDeclaredInput({ supports_vision: true }), ['text', 'image']);
  assert.equal(parseDeclaredInput({ architecture: { input_modalities: ['audio'] } }), null);
});
