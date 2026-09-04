/**
 * 厂商真值库 —— 从各厂商官方文档逐条抄录（2026-08 口径）。
 *
 * 重要简化：dsh 的 reasoningEfforts 只需要「档位 → wire 拼写」。
 * 字段落点（reasoning_effort / reasoning.effort / output_config.effort）
 * 由 provider 的 `api` + `compat.thinkingFormat` 决定，不由这里表达。
 * 所以每个模型只需一张 efforts 表，跨协议复用。
 *
 * efforts 值语义（与 dsh PiAiReasoningEfforts 对齐）：
 *   null   —— 仅 off 可用：「支持该档，但什么都不发」。
 *             写成 YAML 就是 `off:`（空值）。这正是修复 #1580 截断 bug 的关键。
 *   string —— 发送该字面量。
 *   档位不出现在表里 = 不提供该档。
 *
 * collapses —— 传进去不报错、但被服务端改写成别的档。这些档位一律不写入配置，
 *              否则用户会看到一个「选了没用」的假档位。
 * constraints —— 违反会 4xx 的硬约束，仅用于 CLI 提示，不进 YAML。
 */
import { resolveModelCandidates } from './match.mjs';

export const VENDORS = [
  {
    id: 'deepseek', catalogProviders: ['deepseek'], label: 'DeepSeek 官方',
    match: [/api\.deepseek\.com/i], api: 'openai-completions',
    thinkingFormat: 'deepseek',
    source: 'https://api-docs.deepseek.com/guides/thinking_mode/',
    models: [
      { match: /^deepseek-v4-pro$/i, name: 'DeepSeek V4 Pro',
        contextWindow: 1000000, maxTokens: 384000, input: ['text'],
        efforts: { off: null, low: 'low', high: 'high', max: 'max' },
        collapses: { medium: 'high', xhigh: 'high' },
        note: 'pi-ai 内置目录缺 off 键且未给 low —— 官方三档为 low/high/max' },
      { match: /^deepseek-v4-flash$/i, name: 'DeepSeek V4 Flash',
        contextWindow: 1000000, maxTokens: 384000, input: ['text'],
        efforts: { off: null, low: 'low', high: 'high', max: 'max' },
        collapses: { medium: 'high', xhigh: 'high' },
        note: 'pi-ai 内置目录缺 off 键 —— 触发 #1580 的 8192 截断' },
      { match: /^deepseek-v4-flash-vision/i, name: 'DeepSeek V4 Flash Vision',
        contextWindow: 1000000, maxTokens: 384000, input: ['text', 'image'],
        efforts: { off: null, low: 'low', high: 'high', max: 'max' },
        collapses: { medium: 'high', xhigh: 'high' } },
      // ── 旧别名：2026-04-24 起指向 V4-Flash，官方公告 2026-07-24 停用，
      //    但变更日志显示仍在映射。留在真值库里是为了「认得出 + 给出警告」，
      //    而不是让用户配了个空档位表还不知道为什么。
      { match: /^deepseek-chat$/i, name: 'DeepSeek Chat（旧别名 → V4-Flash 非思考模式）',
        contextWindow: 1000000, maxTokens: 384000, input: ['text'],
        efforts: {},
        constraints: ['这是 V4-Flash 的「非思考」入口，本身没有思考档位；要思考请改用 deepseek-v4-flash'],
        note: '旧别名，官方已宣布停用（公告日 2026-04-24，停用日 2026-07-24），建议改用 deepseek-v4-flash' },
      { match: /^deepseek-reasoner$/i,
        forcedThinking: '这是 V4-Flash 的思考入口，恒开思考', name: 'DeepSeek Reasoner（旧别名 → V4-Flash 思考模式）',
        contextWindow: 1000000, maxTokens: 384000, input: ['text'],
        efforts: { low: 'low', high: 'high', max: 'max' },
        collapses: { medium: 'high', xhigh: 'high' },
        constraints: ['这是 V4-Flash 的「思考」入口，恒开思考，没有 off 档'],
        note: '旧别名，官方已宣布停用（公告日 2026-04-24，停用日 2026-07-24），建议改用 deepseek-v4-flash 并用 off 档控制思考开关' },
    ],
  },
  {
    id: 'openai', catalogProviders: ['openai'], label: 'OpenAI 官方',
    match: [/api\.openai\.com/i], api: 'openai-responses',
    thinkingFormat: 'openai',
    source: 'https://developers.openai.com/api/docs/guides/reasoning',
    models: [
      { match: /^gpt-5\.6(-|$)/i, contextWindow: 1050000, maxTokens: 128000,
        input: ['text', 'image'],
        efforts: { off: 'none', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
        note: 'gpt-5.6 Sol/Terra/Luna 档位一致；none 走 off 档（pi-ai 无 none 档位名）' },
      { match: /^gpt-5\.5(-|$)/i, contextWindow: 1050000, maxTokens: 128000,
        input: ['text', 'image'],
        efforts: { off: 'none', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' },
        note: '封顶到 xhigh，无 max' },
      { match: /^gpt-5\.[1-4](-|$)/i, contextWindow: 400000, maxTokens: 128000,
        input: ['text', 'image'],
        efforts: { off: 'none', low: 'low', medium: 'medium', high: 'high' },
        note: '5.1 起用 none，且不再支持 minimal' },
      { match: /^gpt-5(-|$)/i,
        forcedThinking: '初代 gpt-5 的 reasoning_effort 只有 minimal/low/medium/high，没有 none；minimal 仍会推理。none 是 5.1 才引入的', contextWindow: 400000, maxTokens: 128000,
        input: ['text', 'image'],
        efforts: { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' },
        note: '初代 gpt-5 有 minimal 但没有 none/off —— 与 5.1+ 是代际替换，不可合并' },
    ],
  },
  {
    id: 'openai-codex', catalogProviders: ['openai-codex'], label: 'OpenAI Codex',
    match: [/codex/i], api: 'openai-responses', thinkingFormat: 'openai',
    source: 'https://github.com/openai/codex/blob/main/codex-rs/protocol/src/openai_models.rs',
    models: [
      { match: /codex/i, contextWindow: 1050000, maxTokens: 128000, input: ['text', 'image'],
        efforts: { off: 'none', minimal: 'minimal', low: 'low', medium: 'medium',
                   high: 'high', xhigh: 'xhigh', max: 'max' },
        note: 'Codex 另有 ultra 档（并行子代理，非思考深度），pi-ai 无对应档位名；枚举含 Custom(String)，不可做封闭校验' },
    ],
  },
  {
    id: 'anthropic', catalogProviders: ['anthropic'], label: 'Anthropic 官方',
    match: [/api\.anthropic\.com/i], api: 'anthropic-messages',
    source: 'https://platform.claude.com/docs/en/build-with-claude/effort',
    models: [
      { match: /^claude-(opus|sonnet|fable|mythos)-5/i, contextWindow: 1000000, maxTokens: 128000,
        input: ['text', 'image'],
        efforts: { off: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
        constraints: ['Opus 5 在 xhigh/max 下不允许 thinking disabled，会 400'],
        note: 'effort 默认 high；5 系思考默认开启' },
      { match: /^claude-(opus|sonnet)-4[.-][678]/i, contextWindow: 200000, maxTokens: 64000,
        input: ['text', 'image'],
        efforts: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' },
        note: '4.6 起 thinking.type: enabled 已弃用，4.7+ 传 enabled 直接 400；应使用 adaptive' },
      { match: /^claude-haiku-4[.-]5/i, contextWindow: 200000, maxTokens: 64000,
        input: ['text', 'image'],
        efforts: { off: null, low: 'low', medium: 'medium', high: 'high' } },
    ],
  },
  {
    id: 'zai', catalogProviders: ['zai', 'zai-coding-cn'], label: '智谱 GLM / Z.ai',
    match: [/api\.z\.ai/i, /open\.bigmodel\.cn/i], api: 'openai-completions',
    thinkingFormat: 'zai',
    source: 'https://docs.z.ai/api-reference/llm/chat-completion',
    models: [
      { match: /^glm-5v/i, contextWindow: 200000, maxTokens: 131072, input: ['text', 'image'],
        efforts: { off: null, high: 'high' },
        note: 'GLM-5V 视觉；必须排在 glm-5 通配之前，否则会被当成纯文本' },
      { match: /^glm-4\.[56]v/i, contextWindow: 200000, maxTokens: 32000, input: ['text', 'image'],
        efforts: { off: null, high: 'high' },
        note: 'GLM-4.5V / 4.6V；必须排在 glm-4.5 通配之前' },
      { match: /^glm-5\.3/i,
        forcedThinking: 'GLM-5.3 的 thinking.type 只接受 enabled', contextWindow: 1000000, maxTokens: 128000, input: ['text'],
        efforts: { low: 'low', high: 'high', max: 'max' },
        constraints: ['GLM-5.3 强制思考：thinking.type 只接受 enabled，不可关闭 —— 故不提供 off 档'],
        note: '官方明确提示原本用 disabled 的应用改为 enabled + reasoning_effort:low' },
      { match: /^glm-5\.[12]/i, contextWindow: 1000000, maxTokens: 128000, input: ['text'],
        efforts: { off: 'none', minimal: 'minimal', low: 'low', medium: 'medium',
                   high: 'high', xhigh: 'xhigh', max: 'max' },
        note: 'GLM-5.2+ 支持 7 档，默认 max' },
      { match: /^glm-(5|4\.[567])/i, contextWindow: 200000, maxTokens: 128000, input: ['text'],
        efforts: { off: null, high: 'high' },
        note: '5.2 以下只有 thinking 开关，无离散档位' },
    ],
  },
  {
    id: 'qwen', catalogProviders: ['qwen-token-plan', 'qwen-token-plan-cn'], label: '通义千问 Qwen',
    match: [/dashscope.*aliyuncs\.com/i, /qwencloud\.com/i], api: 'openai-completions',
    thinkingFormat: 'qwen',
    source: 'https://docs.qwencloud.com/developer-guides/text-generation/thinking',
    models: [
      { match: /^qwen.*-(vl|omni)/i, contextWindow: 262144, maxTokens: 32768, input: ['text', 'image'],
        efforts: { off: null, high: 'high' },
        note: '视觉/全模态必须排在 qwen3.8-max 通配之前，否则 qwen3.8-max-vl 会被当成纯文本' },
      { match: /^qwen3\.8-max/i, contextWindow: 1000000, maxTokens: 131072, input: ['text'],
        efforts: { off: null, low: 'low', medium: 'medium', xhigh: 'xhigh' },
        note: '仅 qwen3.8-max 有离散档位（low/medium/xhigh，默认 xhigh）；与 thinking_budget 互斥' },
      { match: /^qwen3\.[567]-(max|plus)/i, contextWindow: 1000000, maxTokens: 131072, input: ['text'],
        efforts: { off: null, high: 'high' },
        note: '只有 enable_thinking 开关 + thinking_budget(1–32768)，无离散档位' },
    ],
    warn: '开启思考时 max_tokens 被限 32768，长输出需改用 max_completion_tokens',
  },
  {
    id: 'moonshot', catalogProviders: ['moonshotai', 'moonshotai-cn', 'kimi-coding'], label: '月之暗面 Kimi',
    match: [/api\.moonshot\./i, /platform\.kimi\.com/i], api: 'openai-completions',
    source: 'https://platform.kimi.com/docs/guide/use-thinking-models',
    models: [
      { match: /^kimi-k3/i,
        forcedThinking: 'K3 恒开 Preserved Thinking，官方文档明示不可关闭；档位 low/high/max，没有 medium', contextWindow: 1000000, maxTokens: 131072, input: ['text'],
        efforts: { low: 'low', high: 'high', max: 'max' },
        note: 'k3 用顶层 reasoning_effort，无 thinking 对象；默认 max' },
      { match: /^kimi-k2\.7-code/i,
        forcedThinking: 'k2.7-code 的 thinking.type 只接受 enabled，且不支持 reasoning_effort', contextWindow: 262144, maxTokens: 131072, input: ['text'],
        efforts: { high: 'high' },
        constraints: ['k2.7-code 的 thinking.type 只接受 enabled，且不支持 reasoning_effort'] },
      { match: /^kimi-k2\.[56]/i, contextWindow: 262144, maxTokens: 131072, input: ['text'],
        efforts: { off: null, high: 'high' } },
    ],
  },
  {
    id: 'minimax', catalogProviders: ['minimax', 'minimax-cn'], label: 'MiniMax',
    match: [/api\.minimax\./i], api: 'openai-completions',
    source: 'https://platform.minimax.io/docs/api-reference/text-openai-api',
    models: [
      { match: /^MiniMax-M3/i, contextWindow: 1000000, maxTokens: 131072, input: ['text'],
        efforts: { off: 'disabled', high: 'adaptive' },
        note: 'thinking.type 只有 adaptive / disabled —— 没有 enabled 这个值' },
      { match: /^MiniMax-M2/i,
        forcedThinking: 'M2.x 传 disabled 也仍会思考', contextWindow: 204800, maxTokens: 131072, input: ['text'],
        efforts: { high: 'adaptive' },
        constraints: ['M2.x 无法关闭思考，传 disabled 也仍会思考 —— 故不提供 off 档'] },
    ],
  },
  {
    id: 'xai', catalogProviders: ['xai'], label: 'xAI Grok',
    match: [/api\.x\.ai/i], api: 'openai-completions', thinkingFormat: 'reasoning_effort',
    source: 'https://docs.x.ai/docs/guides/reasoning',
    models: [
      { match: /^grok-4\.[6-9]/i,
        forcedThinking: 'xAI 文档原文「Reasoning cannot be disabled.」', contextWindow: 500000, maxTokens: 128000, input: ['text', 'image'],
        efforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' },
        note: '推理不可关闭，无 off/none 档；默认 high' },
      { match: /^grok-4\.5/i,
        forcedThinking: 'xAI 文档原文「Reasoning cannot be disabled.」', contextWindow: 256000, maxTokens: 64000, input: ['text', 'image'],
        efforts: { low: 'low', medium: 'medium', high: 'high' },
        // 4.5 接受 xhigh 但静默当成 high —— 是假档位，故不暴露
        collapses: { xhigh: 'high' },
        note: 'grok-4.5 把 xhigh 静默降级为 high —— 故不暴露 xhigh' },
    ],
  },
  {
    id: 'groq', catalogProviders: ['groq'], label: 'Groq',
    match: [/api\.groq\.com/i], api: 'openai-completions', thinkingFormat: 'reasoning_effort',
    source: 'https://console.groq.com/docs/reasoning',
    models: [
      { match: /gpt-oss/i,
        forcedThinking: 'Groq 上 gpt-oss 只接受 low/medium/high；none 仅对 Qwen 3.6/3.8 有效。include_reasoning:false 只是不回传思考内容，模型照样思考照样计费', contextWindow: 131072, maxTokens: 65536, input: ['text'],
        efforts: { low: 'low', medium: 'medium', high: 'high' } },
      { match: /^qwen\//i, contextWindow: 131072, maxTokens: 65536, input: ['text'],
        efforts: { off: 'none', high: 'default' },
        note: 'Qwen 族用 none/default 两值，与 gpt-oss 族的 low/medium/high 不通用' },
    ],
    warn: 'tool calling 或 JSON mode 下 reasoning_format 必须设为 parsed 或 hidden',
  },
  {
    id: 'openrouter', catalogProviders: ['openrouter'], label: 'OpenRouter',
    match: [/openrouter\.ai\/api/i], api: 'openai-completions', thinkingFormat: 'openrouter',
    source: 'https://openrouter.ai/docs/guides/best-practices/reasoning-tokens',
    stripIdPrefix: true,
    models: [
      { match: /.*/, contextWindow: null, maxTokens: null, input: ['text'],
        efforts: { off: 'none', minimal: 'minimal', low: 'low', medium: 'medium',
                   high: 'high', xhigh: 'xhigh', max: 'max' },
        note: '统一层，7 档；对 Gemini 3 会把 xhigh 压平为 high。上下文以 /models 自报的 context_length 为准' },
    ],
  },
  {
    id: 'google', catalogProviders: ['google', 'google-vertex'], label: 'Google Gemini',
    match: [/generativelanguage\.googleapis\.com/i], api: 'google-generative-ai',
    source: 'https://ai.google.dev/gemini-api/docs/thinking',
    models: [
      { match: /^gemini-3(\.\d+)?-?flash/i,
        forcedThinking: 'Gemini 3 系列 thinking_level 的地板是 minimal，官方明示「minimal does not guarantee that thinking is off」', contextWindow: 1048576, maxTokens: 65536,
        input: ['text', 'image'],
        efforts: { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' },
        note: 'Gemini 3.x 思考不可关闭 —— 无 off 档' },
      { match: /^gemini-3/i,
        forcedThinking: 'Gemini 3 系列 thinking_level 的地板是 minimal，不保证完全不思考；thinking_budget:0 在 3 系列上没有被文档承认为关闭路径', contextWindow: 1048576, maxTokens: 65536, input: ['text', 'image'],
        efforts: { low: 'low', medium: 'medium', high: 'high' } },
      { match: /^gemini-2\.5-pro/i,
        forcedThinking: 'Gemini 2.5 Pro 的 thinkingBudget 范围是 128–32768，官方表格该列直接写「N/A: Cannot disable thinking」', contextWindow: 1048576, maxTokens: 65536, input: ['text', 'image'],
        efforts: { low: 'low', medium: 'medium', high: 'high' },
        note: '2.5 Pro 思考不可关闭（预算区间 128–32768）' },
      { match: /^gemini-2\.5/i, contextWindow: 1048576, maxTokens: 65536, input: ['text', 'image'],
        efforts: { off: 'none', low: 'low', medium: 'medium', high: 'high' } },
    ],
  },
];

/** 按 baseURL 猜厂商。 */
export function vendorForUrl(url) {
  if (!url) return null;
  return VENDORS.find((v) => v.match.some((re) => re.test(url))) ?? null;
}

export function vendorById(id) {
  return VENDORS.find((v) => v.id === id) ?? null;
}

/** pi-ai 内置目录的 provider 名（route 命中这些就走 modelOverrides，禁止写 models[]）。 */
export function catalogRouteNames() {
  return new Set(VENDORS.flatMap((v) => v.catalogProviders ?? []));
}

/** 在某厂商下按 model id 找条目；stripIdPrefix 处理 openrouter 的 `vendor/model` 形式。 */
export function modelSpec(vendor, modelId) {
  if (!vendor) return null;
  const id = vendor.stripIdPrefix ? String(modelId).replace(/^[^/]+\//, '') : String(modelId);
  return vendor.models.find((m) => m.match.test(id)) ?? null;
}

/** 中转站常写成 vendor/model 或 org/vendor/model。查找时原样、去前缀都试。 */
export function modelIdCandidates(modelId) {
  const raw = String(modelId);
  const out = [raw];
  if (raw.includes('/')) {
    const rest = raw.slice(raw.indexOf('/') + 1);
    if (rest && !out.includes(rest)) out.push(rest);
    const last = raw.split('/').pop();
    if (last && !out.includes(last)) out.push(last);
  }
  return out;
}

/**
 * 中转站的 baseURL 匹配不到任何厂商时，直接按 model id 在全部厂商里找。
 * 这是中转/聚合网关的主路径：URL 认不出，但模型名认得出。
 *
 * 匹配分两层（见 src/match.mjs）：硬映射表（src/aliases.mjs）+ 软匹配
 * （去日期/量化/档位后缀、分隔符归一）。返回实际命中的候选 id 和解析路径，
 * 调用方据此写日志；发给网关的 id 永远保持原样，不由这里改。
 */
export function findAnyVendor(modelId) {
  const candidates = resolveModelCandidates(modelId);
  for (const { id, via } of candidates) {
    for (const v of VENDORS) {
      if (v.id === 'openrouter') continue;        // 通配规则，不参与自动匹配
      const spec = modelSpec(v, id);
      if (spec) return { vendor: v, spec, id, via };
    }
  }
  return null;
}
