/**
 * 平台覆盖层：按自定义路由的 baseURL 叠在厂商真值之上。
 * 档位折叠、compat 开关、maxTokens 夹紧都在这里；厂商真值库不写平台特例。
 *
 * 每条覆盖带 source URL。火山方舟的档位映射表已在 vendors.mjs doubao 厂商，
 * 这里只补 URL 级 wire 开关（coding 端点 / developer 角色 / 工具 strict 等）。
 */
import { LEVELS } from './levels.mjs';

export const PLATFORMS = [
  {
    id: 'volcengine-ark',
    label: '火山方舟',
    match: [/ark\.[^/]*volces\.com/i],
    source: 'https://www.volcengine.com/docs/82379/1449737',
    thinkingFormat: 'openai',
    // coding 端点 max_tokens>128000 直接 400；/api/v3 不夹。
    maxTokensCap: { when: /\/api\/coding(\/|$)/i, cap: 128000 },
    compat: {
      supportsDeveloperRole: false,          // coding 端点拒绝 developer 角色
      requiresReasoningContentOnAssistantMessages: true, // deepseek 系
      // 不要设 supportsStrictMode:false —— 方舟要求工具带 strict 字段
    },
  },
  {
    id: 'siliconflow',
    label: '硅基流动',
    match: [/api\.siliconflow\.cn/i],
    source: 'https://docs.siliconflow.cn/cn/api-reference/chat-completions/chat-completions',
    thinkingFormat: 'openai',
    // reasoning_effort 仅 Pro/deepseek-ai/DeepSeek-V4、DeepSeek-V4-Flash、
    // Pro/zai-org/GLM-5.2 接受 high|max；其余走 enable_thinking。
    effortRemap: {
      when: /(DeepSeek-V4|GLM-5\.2)/i,
      map: { low: 'high', medium: 'high', xhigh: 'max' },
      keep: ['off', 'high', 'max'],
    },
  },
  {
    id: 'dashscope',
    label: '阿里百炼 compatible-mode',
    match: [/dashscope\.[^/]*aliyuncs\.com/i],
    source: 'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope',
    thinkingFormat: 'qwen',
    compat: {
      supportsDeveloperRole: false,
      supportsStore: false,
    },
  },
];

export function platformForUrl(url) {
  if (!url) return null;
  return PLATFORMS.find((p) => p.match.some((re) => re.test(url))) ?? null;
}

function remapEfforts(efforts, remap) {
  if (!efforts || efforts === false || !remap) return efforts;
  const keep = new Set(remap.keep ?? LEVELS);
  const map = remap.map ?? {};
  const out = {};
  for (const lv of LEVELS) {
    if (!(lv in efforts)) continue;
    if (lv in map) continue;            // 被折叠的档不暴露
    if (!keep.has(lv) && lv !== 'off') continue;
    out[lv] = efforts[lv];
  }
  if (Object.keys(out).length === 0) return false;
  return out;
}

/**
 * 把平台覆盖叠进 compile overlay / 已编译条目。
 * @param {object} compiled compileModel 产物 {entry, notes, dropped}
 * @param {object|null} platform
 * @param {{baseURL?:string, modelId?:string}} ctx
 */
export function applyPlatform(compiled, platform, ctx = {}) {
  if (!compiled?.entry || !platform) return compiled;
  const notes = [...(compiled.notes ?? [])];
  const entry = { ...compiled.entry };
  const url = ctx.baseURL ?? '';

  if (platform.thinkingFormat) {
    entry.compat = { ...(entry.compat ?? {}), thinkingFormat: platform.thinkingFormat };
  }
  if (platform.compat) {
    entry.compat = { ...(entry.compat ?? {}), ...platform.compat };
  }

  if (platform.maxTokensCap) {
    const { when, cap } = platform.maxTokensCap;
    if (!when || when.test(url)) {
      if (entry.maxTokens == null || entry.maxTokens > cap) {
        if (entry.maxTokens != null) notes.push(`${platform.label}：maxTokens ${entry.maxTokens} → ${cap}（${platform.source}）`);
        entry.maxTokens = cap;
      }
    }
  }

  if (platform.effortRemap && platform.effortRemap.when?.test(ctx.modelId ?? entry.id ?? '')) {
    const prev = entry.reasoningEfforts;
    entry.reasoningEfforts = remapEfforts(prev, platform.effortRemap);
    if (prev && prev !== false && entry.reasoningEfforts !== prev) {
      notes.push(`${platform.label}：档位按平台表重映射（${platform.source}）`);
    }
  }

  return { ...compiled, entry, notes };
}
