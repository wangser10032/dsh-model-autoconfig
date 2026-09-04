/**
 * pi-ai 的 ModelThinkingLevel 全集，取自
 * @earendil-works/pi-ai dist/types.d.ts:
 *   type ThinkingLevel      = "minimal"|"low"|"medium"|"high"|"xhigh"|"max"
 *   type ModelThinkingLevel = "off" | ThinkingLevel
 * 顺序 = 升级顺序，UI 下拉按此排序。
 */
export const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** dsh Web UI 的渲染文案。xhigh→"Extra high" 已由界面截图确认。 */
export const LEVEL_LABEL = {
  off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium',
  high: 'High', xhigh: 'Extra high', max: 'Max',
};

/**
 * dsh 0.1.2 llm-pi-ai Config 允许的 compat.thinkingFormat 取值。
 * 与宿主 lib/index.js SUPPORTED_THINKING_FORMATS 逐字一致。
 * 没有 reasoning_effort —— 那是 pi-ai 的 wire 字段名，写进 settings 会被
 * schemastery 整段拒绝。xAI / Groq 的顶层 reasoning_effort 走 'openai'。
 */
export const THINKING_FORMATS = [
  'openai', 'deepseek', 'openrouter', 'together', 'baseten', 'zai', 'qwen',
  'chat-template', 'qwen-chat-template', 'string-thinking', 'ant-ling',
];

/** pi-ai KnownApi 全集（含宿主手写路由不能用的协议，仅作对照）。 */
export const KNOWN_APIS = [
  'openai-completions', 'openai-responses', 'anthropic-messages',
  'google-generative-ai', 'mistral-conversations', 'pi-messages',
  'azure-openai-responses', 'openai-codex-responses',
  'bedrock-converse-stream', 'google-vertex',
];

/**
 * 宿主 dsh 0.1.2 手写路由允许的协议 = supportedProtocols()。
 * google-generative-ai 等只存在于 pi-ai 内置目录，自定义 URL 写进去会被拒。
 */
export const HOST_APIS = [
  'openai-completions', 'openai-responses', 'anthropic-messages',
];

/**
 * 自动探测的协议集合 —— 与宿主手写路由允许的三个协议一致。
 * 不带 --api 时只会在这三个里判定。
 */
export const SELF_DESCRIBING_APIS = [...HOST_APIS];

/**
 * 本工具会写入 settings 的协议。自定义路由只能用 HOST_APIS；
 * Gemini 官方端点改走 OpenAI 兼容口径（openai-completions）。
 */
export const SUPPORTED_APIS = [...HOST_APIS];

/**
 * 路由级思考默认档位的「愿望值」。dsh 请求路径不会 clamp：
 * `options.reasoningEffort ?? profile.reasoning` 不在该模型档位表里就直接
 * UNSUPPORTED_REASONING_EFFORT。所以写入 settings 前必须收敛到该路由
 * 所有推理模型的共有档（见 pickRouteEffort）。medium 只是愿望：对
 * DeepSeek 的 off/low/high/max 会落到 high，不能原样写进路由。
 */
export const DEFAULT_ROUTE_EFFORT = 'medium';

/**
 * 复刻 pi-ai clampThinkingLevel：先向上找，再向下找。
 * @returns {string|null} 实际会落到的档；reasoningEfforts:false 时返回 null
 */
export function clampThinkingLevel(want, efforts) {
  if (!want || efforts === false || efforts == null) return null;
  const has = Object.keys(efforts);
  if (has.includes(want)) return want;
  const i = LEVELS.indexOf(want);
  if (i < 0) return has[0] ?? null;
  return LEVELS.slice(i + 1).find((l) => has.includes(l))
      ?? [...LEVELS.slice(0, i)].reverse().find((l) => has.includes(l))
      ?? null;
}

/** 一组模型档位表的交集。没有推理模型 → null；有但没有共有档 → false。 */
export function sharedReasoningEfforts(entries) {
  const tables = [];
  for (const e of entries ?? []) {
    const efforts = e?.reasoningEfforts;
    if (efforts && efforts !== false && typeof efforts === 'object') tables.push(efforts);
  }
  if (tables.length === 0) return null;
  const keys = Object.keys(tables[0]).filter((k) => tables.every((t) => k in t));
  if (keys.length === 0) return false;
  return Object.fromEntries(keys.map((k) => [k, k]));
}

/**
 * 只处理「已经写了」的路由默认档：能被所有推理模型接受则保留，
 * 否则收敛到共有档。没有现成值时返回 undefined —— 不凭空加 reasoning。
 */
export function pickRouteEffort(current, entries, fallback = DEFAULT_ROUTE_EFFORT) {
  if (current == null || current === '') return undefined;
  const shared = sharedReasoningEfforts(entries);
  if (shared == null || shared === false) return undefined;
  return clampThinkingLevel(current, shared) ?? clampThinkingLevel(fallback, shared) ?? undefined;
}
