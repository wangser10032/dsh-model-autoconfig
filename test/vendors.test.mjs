/**
 * 真值库（src/vendors.mjs）的结构校验。
 *
 * 真值库是本工具的核心资产：34 条规则每条都对着官方文档抄录，
 * 而「档位表算得对不对」完全取决于这里的数据是否完整。
 *
 * 这里的每一条断言都对应一个已经发生过、或很容易发生的静默错误：
 *   - 字段被误写进注释里 → 编译产物悄悄少几个字段，测试却全绿
 *   - efforts 里写了 collapses 声明过的档位 → 那一档永远被跳过，是死声明
 *   - 非 off 档位值为空 → dsh 整段拒绝配置（settings-rejected）
 *
 * 这些错误都不会抛异常，只会让用户的配置悄悄是错的。所以必须有人守着。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VENDORS, modelSpec } from '../src/vendors.mjs';
import { LEVELS, THINKING_FORMATS, KNOWN_APIS } from '../src/levels.mjs';
import { compileModel } from '../src/compile.mjs';

/** 遍历全部厂商规则；label 用于让失败信息指到具体那一条。 */
function eachModel(fn) {
  for (const v of VENDORS) {
    for (const m of v.models) fn(v, m, `${v.id} / ${String(m.match)}`);
  }
}

test('每条模型规则都显式声明了上下文三件套', () => {
  eachModel((v, m, label) => {
    for (const f of ['contextWindow', 'maxTokens', 'input']) {
      // 允许显式 null（openrouter 用 null 表示「以 /models 自报为准」），
      // 但不允许字段整个消失 —— 那几乎总是漏写，且不会有任何地方报错。
      assert.ok(f in m,
        `${label} 缺 ${f}。显式写 null 表示「由端点自报」，字段消失则是漏写`);
    }
  });
});

test('input 字段是数组或显式 null', () => {
  eachModel((v, m, label) => {
    assert.ok(m.input === null || Array.isArray(m.input),
      `${label} 的 input 应该是数组或 null，收到 ${JSON.stringify(m.input)}`);
  });
});

test('efforts 的键必须是 dsh 认识的档位', () => {
  eachModel((v, m, label) => {
    for (const lv of Object.keys(m.efforts ?? {})) {
      assert.ok(LEVELS.includes(lv),
        `${label} 声明了未知档位 "${lv}"，合法值：${LEVELS.join(' / ')}`);
    }
  });
});

test('除 off 外的档位必须给 wire 拼写（dsh 只允许 off 留空）', () => {
  eachModel((v, m, label) => {
    for (const [lv, wire] of Object.entries(m.efforts ?? {})) {
      if (lv === 'off') continue;
      assert.ok(wire != null && wire !== '',
        `${label} 的档位 ${lv} 是空值 —— 会被 assertServiceable 以 settings-rejected 整段拒绝`);
    }
  });
});

test('collapses 声明的档位不出现在 efforts 里（否则那一档是死声明）', () => {
  eachModel((v, m, label) => {
    for (const lv of Object.keys(m.collapses ?? {})) {
      assert.ok(LEVELS.includes(lv),
        `${label} 的 collapses 声明了未知档位 "${lv}"`);
      assert.ok(!(lv in (m.efforts ?? {})),
        `${label} 的 ${lv} 同时在 efforts 和 collapses 里 —— compileModel 会跳过它，efforts 里那条是死声明`);
      assert.ok(m.collapses[lv] != null,
        `${label} 的 collapses.${lv} 没有写塌缩目标`);
    }
  });
});

test('声明了 forcedThinking 的规则不能同时提供 off 档', () => {
  eachModel((v, m, label) => {
    if (!m.forcedThinking) return;
    assert.ok(!('off' in (m.efforts ?? {})),
      `${label} 同时声明了「思考不可关闭」和 off 档，两者语义矛盾`);
  });
});

test('厂商的 api 与 thinkingFormat 取值合法', () => {
  for (const v of VENDORS) {
    assert.ok(KNOWN_APIS.includes(v.api),
      `${v.id} 的 api "${v.api}" 不在 pi-ai KnownApi 全集里`);
    if (v.thinkingFormat != null) {
      assert.ok(THINKING_FORMATS.includes(v.thinkingFormat),
        `${v.id} 的 thinkingFormat "${v.thinkingFormat}" 不在 dsh 允许的集合里`);
    }
  }
});

test('每条规则都能命中自己（match 正则对样例 id 有效）', () => {
  eachModel((v, m, label) => {
    // openrouter 的 /.*/ 是通配中转规则，不参与自动匹配，跳过
    if (v.stripIdPrefix) return;
    assert.equal(modelSpec(v, 'probe') !== null, /probe/.test(String(m.match)),
      `${label} 的 match 正则与 modelSpec 的判定不一致`);
  });
});

test('视觉规则排在同族通配之前：glm-5v / glm-4.5v / qwen-*-vl 不被当成纯文本', () => {
  const glm5v = modelSpec(VENDORS.find((v) => v.id === 'zai'), 'glm-5v-turbo');
  assert.ok(glm5v.input.includes('image'), 'glm-5v-turbo 必须命中视觉规则，不能落到 glm-5 通配');
  const glm45v = modelSpec(VENDORS.find((v) => v.id === 'zai'), 'glm-4.5v');
  assert.ok(glm45v.input.includes('image'));
  const qvl = modelSpec(VENDORS.find((v) => v.id === 'qwen'), 'qwen3.8-max-vl');
  assert.ok(qvl.input.includes('image'), 'qwen3.8-max-vl 必须命中 vl 规则，不能落到 qwen3.8-max');
});

test('每条规则都能编译，且产物带上官方上下文', () => {
  eachModel((v, m, label) => {
    const { entry } = compileModel({
      vendor: v, modelId: 'probe', api: v.api, spec: m, includeIO: true,
    });
    for (const f of ['contextWindow', 'maxTokens', 'input']) {
      // 显式 null = 该厂商的规格由端点自报，产物本就不该有这个字段
      if (m[f] === null) continue;
      //
      // 必须用 `f in entry` 判断存在性，不能写值比较。
      // 源数据缺字段时编译产物同样缺，值比较会变成 undefined === undefined
      // ——「相等」通过，坏数据就这么溜过去。
      // 这正是 #1580 截断 bug 的成因：上游写的是
      // `if (model.thinkingLevelMap?.off !== null)`，而 undefined !== null 恒真。
      // 本项目里 undefined 和 null 必须严格区分，判存在一律用 in。
      assert.ok(f in entry,
        `${label} 的产物缺 ${f} —— 源数据有值却没写进条目，用户的模型会缺规格`);
      if (f === 'input') assert.deepEqual(entry[f], m[f], `${label} 的 ${f} 与源数据不一致`);
      else assert.equal(entry[f], m[f], `${label} 的 ${f} 与源数据不一致`);
    }
  });
});
