/**
 * 模型 id 解析 —— 「硬映射 + 软匹配」的候选生成器。
 *
 * 输入网关给的原始 id，输出一串按优先级排序、去重后的候选 [{ id, via }]。
 * 调用方（vendors.mjs 的 findAnyVendor）拿这些候选逐个撞真值库，
 * 首个命中即停，并把 via 透传出去写进日志。
 *
 * 排序即语义，改动前三思：
 *   1. 原样          —— 永远第一。qwen3.8-max 本名带档位词，
 *                        若先剥 -max 会得到错误结果；先原样命中就轮不到软变换
 *   2. 硬映射        —— 人工确认过的等价关系，比任何规律都可信
 *   3. 去前缀        —— vendor/model、org/vendor/model（原有的 modelIdCandidates 逻辑）
 *   4. 去前缀+硬映射 —— deepseek/deepseek-v4-pro-0813 这种组合
 *   5. 软变换        —— 只生成候选，不产生结论；命中与否完全由真值库裁决，
 *                        所以「剥错了」的代价只是多试一次，不会写出错误配置
 *
 * 软变换按「精确 → 通用」排序，最后一条是从右往左剥尾段的通用截断兜底；
 * 变换之间不做组合爆炸：现实里的怪 id 基本只怪在一个点上。
 */
import { MODEL_ALIASES } from './aliases.mjs';

/** 日期快照后缀：-0813 / -20251001 / -2025-10-01 / -2025.10.01 / -2507（YYMM）/ -250828（YYMMDD，火山方舟形式） */
const DATE_SUFFIXES = [
  /-(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/i,                 // MMDD
  /-20\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/i,          // YYYYMMDD
  /-20\d{2}[-.](0[1-9]|1[0-2])[-.](0[1-9]|[12]\d|3[01])$/i,  // YYYY-MM-DD / YYYY.MM.DD
  /-2\d(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/i,              // YYMMDD（doubao-seed-1-6-flash-250828 风格）
  /-2\d(0[1-9]|1[0-2])$/i,                                   // YYMM（kimi-k2-0905 风格）
];

/** 量化/推理变体后缀：-fp8、-int4、-awq…… */
const QUANT_SUFFIX = /-(fp8|fp16|bf16|fp4|int4|int8|awq|gptq|gguf|mlx)$/i;

/**
 * 档位变体后缀：gemini-3.6-flash-high 这种把思考档焊进 id 的。
 * 保护：本名以档位词结尾的规则（qwen3.8-max）会先被「原样」命中，轮不到这里。
 */
const EFFORT_SUFFIX = /-(minimal|low|medium|high|xhigh|max)$/i;

/** 硬映射查找：键统一小写。 */
export function aliasForModel(id) {
  return MODEL_ALIASES[String(id).toLowerCase()] ?? null;
}

/** 去前缀候选：vendor/model → model；org/vendor/model → vendor/model 和 model。 */
function prefixStripped(raw) {
  const out = [];
  if (!raw.includes('/')) return out;
  const rest = raw.slice(raw.indexOf('/') + 1);
  if (rest) out.push(rest);
  const last = raw.split('/').pop();
  if (last && last !== rest) out.push(last);
  return out;
}

/**
 * 软变换表：按序尝试。每个变换返回候选 id 数组（含单项）或 null（不适用）。
 * 最后一条是通用截断兜底：结构化模式没覆盖的任意尾段（-preview / -latest /
 * -exp……）靠从右往左剥 -/_ 解决，剥出来的每个词干都是候选。
 * 靠后 = 风险高（词干可能落到同厂商另一条规则上），所以放在所有
 * 更精确的变换之后，且单个词干命中与否仍由真值库裁决。
 */
const SOFT_TRANSFORMS = [
  // 平台变体标记：OpenRouter 用 `:batch` / `:free` 标同一模型的不同履约方式
  // （实测 427 个模型里 85 个带这类后缀）。多数规则是前缀匹配、顺带就命中了，
  // 但带结尾锚的规则（gpt-5.5(-|$)）会被冒号挡住 —— openai/gpt-5.x:batch 全失配。
  ['去平台变体后缀', (id) => {
    const i = id.indexOf(':');
    return i > 0 ? [id.slice(0, i)] : null;
  }],
  // Bedrock / 部分网关写成 anthropic.claude-…（点号厂商前缀，不是 /）。
  ['去点号厂商前缀', (id) => {
    const m = id.match(/^(anthropic|amazon|meta|mistral|cohere|ai21|stability)\.(.+)$/i);
    return m ? [m[2]] : null;
  }],
  ['去日期后缀', (id) => {
    for (const re of DATE_SUFFIXES) {
      const stripped = id.replace(re, '');
      if (stripped !== id) return [stripped];
    }
    return null;
  }],
  ['去量化后缀', (id) => {
    const stripped = id.replace(QUANT_SUFFIX, '');
    return stripped !== id ? [stripped] : null;
  }],
  ['去档位后缀', (id) => {
    const stripped = id.replace(EFFORT_SUFFIX, '');
    return stripped !== id ? [stripped] : null;
  }],
  // 分隔符归一（单次变换内完成两步，混合形式 glm-5_3 一步到位）：
  //   _ / 空格 → -，数字间的 - → .（gpt-5-6-sol → gpt-5.6-sol）
  // (\d)-(\d) 不会误伤 deepseek-v4-pro（4 后面是字母 p）。
  ['分隔符归一', (id) => {
    const dashToDot = id.replace(/[_\s]+/g, '-').replace(/(\d)-(\d)/g, '$1.$2');
    const dotToDash = id.replace(/[_\s]+/g, '-').replace(/(\d)\.(\d)/g, '$1-$2');
    const out = [];
    if (dashToDot !== id) out.push(dashToDot);
    if (dotToDash !== id && dotToDash !== dashToDot) out.push(dotToDash);
    return out.length ? out : null;
  }],
  // 通用截断：从右往左剥 -/_，全部词干按长到短作为候选。
  ['去尾段', (id) => {
    const out = [];
    let cur = id;
    for (;;) {
      const cut = Math.max(cur.lastIndexOf('-'), cur.lastIndexOf('_'));
      if (cut <= 0) break;
      cur = cur.slice(0, cut);
      out.push(cur);
    }
    return out.length ? out : null;
  }],
];

/**
 * 生成 ranked + deduped 候选列表。
 * @param {string} modelId 网关给的原始 id
 * @returns {Array<{id: string, via: string}>}
 */
export function resolveModelCandidates(modelId) {
  const raw = String(modelId);
  const out = [];
  const seen = new Set();
  const push = (id, via) => {
    const key = id.toLowerCase();
    if (!id || seen.has(key)) return;
    seen.add(key);
    out.push({ id, via });
  };

  push(raw, '原样');
  const directAlias = aliasForModel(raw);
  if (directAlias) push(directAlias, '硬映射');

  const bases = [raw];
  for (const p of prefixStripped(raw)) {
    push(p, '去前缀');
    bases.push(p);
    const pa = aliasForModel(p);
    if (pa) push(pa, '硬映射');
  }

  for (const [via, fn] of SOFT_TRANSFORMS) {
    for (const base of bases) {
      const out = fn(base);
      if (out) for (const t of out) push(t, via);
    }
  }

  return out;
}
