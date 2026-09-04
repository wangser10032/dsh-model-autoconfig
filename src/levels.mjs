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
 * dsh 的 llm-pi-ai config 允许的 compat.thinkingFormat 取值。
 * = pi-ai 的 PiThinkingFormat 减去 chat-template / qwen-chat-template
 * （后两者走 chatTemplateKwargs，配置层不暴露）。
 */
export const THINKING_FORMATS = [
  'reasoning_effort', 'openai', 'openrouter', 'deepseek',
  'together', 'baseten', 'zai', 'qwen', 'string-thinking', 'ant-ling',
];

/** pi-ai KnownApi 全集。 */
export const KNOWN_APIS = [
  'openai-completions', 'openai-responses', 'anthropic-messages',
  'google-generative-ai', 'mistral-conversations', 'pi-messages',
  'azure-openai-responses', 'openai-codex-responses',
  'bedrock-converse-stream', 'google-vertex',
];

/**
 * 自动探测的协议集合 —— 最常见的三个，覆盖绝大多数官方端点和中转站。
 * 不带 --api 时只会在这三个里判定。
 */
export const SELF_DESCRIBING_APIS = [
  'openai-completions', 'openai-responses', 'anthropic-messages',
];

/**
 * 探测集之外、但仍然能配的协议：真值库按 URL 认出厂商时会直接采用，
 * 也可以用 --api 显式指定。google-generative-ai 留在这里而不是探测集里，
 * 是因为 Gemini 端点靠域名就能认出来，不需要发探测请求。
 */
export const SUPPORTED_APIS = [...SELF_DESCRIBING_APIS, 'google-generative-ai'];

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
