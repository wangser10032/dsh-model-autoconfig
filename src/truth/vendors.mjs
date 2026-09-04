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
import { resolveModelCandidates } from '../match/id.mjs';

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
      // 出处：pi-ai qwen-token-plan.json deepseek-v3.2（reasoning:true，无 thinkingLevelMap，
      // supportsReasoningEffort:false）—— 开关式思考，无离散档。
      { match: /^deepseek-v3\.2/i, contextWindow: 131072, maxTokens: 65536, input: ['text'],
        efforts: { off: null, high: 'high' },
        note: 'pi-ai 目录：百炼 token-plan 条目无 reasoning_effort，仅 enable_thinking 开关' },
    ],
  },
  {
    id: 'openai', catalogProviders: ['openai'], label: 'OpenAI 官方',
    match: [/api\.openai\.com/i], api: 'openai-responses',
    thinkingFormat: 'openai',
    source: 'https://developers.openai.com/api/docs/guides/reasoning',
    models: [
      { match: /^gpt-5\.6(-|$)/i, exclude: /codex/i, contextWindow: 1050000, maxTokens: 128000,
        input: ['text', 'image'],
        efforts: { off: 'none', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
        note: 'gpt-5.6 Sol/Terra/Luna 档位一致；none 走 off 档（pi-ai 无 none 档位名）' },
      { match: /^gpt-5\.5(-|$)/i, exclude: /codex/i, contextWindow: 1050000, maxTokens: 128000,
        input: ['text', 'image'],
        efforts: { off: 'none', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' },
        note: '封顶到 xhigh，无 max' },
      { match: /^gpt-5\.[1-4](-|$)/i, exclude: /codex/i, contextWindow: 400000, maxTokens: 128000,
        input: ['text', 'image'],
        efforts: { off: 'none', low: 'low', medium: 'medium', high: 'high' },
        note: '5.1 起用 none，且不再支持 minimal' },
      { match: /^gpt-5-(mini|nano)/i, exclude: /codex/i,
        forcedThinking: 'pi-ai openai.json gpt-5-mini thinkingLevelMap.off=null，有 minimal/low/medium/high',
        contextWindow: 400000, maxTokens: 128000,
        input: ['text', 'image'],
        efforts: { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' },
        note: 'pi-ai openai.json：gpt-5-mini 与初代 gpt-5 同型（有 minimal、无 off）' },
      { match: /^gpt-realtime/i,
        forcedThinking: 'pi-ai openai.json gpt-realtime-2.1 thinkingLevelMap.off=null',
        contextWindow: 128000, maxTokens: 32000, input: ['text', 'image'],
        efforts: { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' },
        note: 'pi-ai openai.json：realtime 2.1 档位含 xhigh，无 off/max' },
      { match: /^gpt-5(?!-\d)(-|$)/i, exclude: /codex/i,
        forcedThinking: '初代 gpt-5 的 reasoning_effort 只有 minimal/low/medium/high，没有 none；minimal 仍会推理。none 是 5.1 才引入的', contextWindow: 400000, maxTokens: 128000,
        input: ['text', 'image'],
        efforts: { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' },
        note: '初代 gpt-5 有 minimal 但没有 none/off —— 与 5.1+ 是代际替换，不可合并' },
      // 官方别名 chat-latest（OpenRouter 写作 gpt-chat-latest）：Instant 非推理模型
      { match: /^(gpt-)?chat-latest$/i, contextWindow: 400000, maxTokens: 128000, input: ['text', 'image'],
        efforts: {},
        note: '官方目录：指向 ChatGPT 当前 Instant 非推理模型、底层快照定期更新；无 reasoning 控制、图像仅输入' },
      // 出处：pi-ai openai.json thinkingLevelMap（o1/o3/o4-mini 均为 off:null + low/medium/high）
      // + developers.openai.com reasoning 文档。o 系列思考不可关。
      { match: /^o3-mini$/i,
        forcedThinking: 'o3-mini reasoning_effort 无 none；pi-ai 目录 off:null',
        contextWindow: 200000, maxTokens: 100000, input: ['text'],
        efforts: { low: 'low', medium: 'medium', high: 'high' },
        note: '目录 input 仅 text，与 o3/o4-mini 含视觉不同' },
      { match: /^o[134](-mini|-pro)?$/i,
        forcedThinking: 'o1/o3/o4 系列 reasoning_effort 无 none；pi-ai 目录 off:null',
        contextWindow: 200000, maxTokens: 100000, input: ['text', 'image'],
        efforts: { low: 'low', medium: 'medium', high: 'high' },
        note: '档位三档与 pi-ai openai.json thinkingLevelMap 一致' },
      // 非推理 GPT-4.x / 4o：pi-ai openai.json reasoning:false
      { match: /^gpt-4o/i, contextWindow: 128000, maxTokens: 16384, input: ['text', 'image'],
        efforts: {},
        note: 'pi-ai openai.json：gpt-4o 系 reasoning:false，无思考档' },
      { match: /^gpt-4\.1/i, contextWindow: 1047576, maxTokens: 32768, input: ['text', 'image'],
        efforts: {},
        note: 'pi-ai openai.json：gpt-4.1 系 reasoning:false；1M 上下文' },
      { match: /^gpt-4-turbo/i, contextWindow: 128000, maxTokens: 4096, input: ['text', 'image'],
        efforts: {},
        note: 'pi-ai openai.json：gpt-4-turbo reasoning:false，含视觉' },
      { match: /^gpt-4(-|$)/i, contextWindow: 8192, maxTokens: 8192, input: ['text'],
        efforts: {},
        note: 'pi-ai openai.json：初代 gpt-4 reasoning:false' },
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
      // 必须排在 claude-*-5 通配之前：claude-sonnet-4-5 会被 /claude-sonnet-5/ 误吃。
      // 出处：pi-ai anthropic.json（无 thinkingLevelMap、无 forceAdaptiveThinking；ctx 1M / 64k）
      { match: /^claude-sonnet-4[.-]5/i, contextWindow: 1000000, maxTokens: 64000,
        input: ['text', 'image'],
        efforts: { off: null, low: 'low', medium: 'medium', high: 'high' },
        note: 'Sonnet 4.5：pi-ai 目录无 xhigh/max、无 forceAdaptiveThinking（与 4.6+/5 系不同）' },
      { match: /^claude-(opus|sonnet|fable|mythos)-5/i, contextWindow: 1000000, maxTokens: 128000,
        input: ['text', 'image'],
        efforts: { off: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
        constraints: ['Opus 5 在 xhigh/max 下不允许 thinking disabled，会 400'],
        note: 'effort 默认 high；5 系思考默认开启' },
      { match: /^claude-opus-4[.-]5/i,
        forcedThinking: '官方 effort 页：Opus 4.5 是唯一的 extended-thinking-only 模型，思考始终开启', contextWindow: 200000, maxTokens: 64000,
        input: ['text', 'image'],
        efforts: { low: 'low', medium: 'medium', high: 'high' },
        constraints: ['extended-thinking-only：effort 与 budget_tokens 并存，先设 effort 再设思考预算；无 xhigh/max（4.6 起才有）'],
        note: 'Opus 4.5 只有 low/medium/high 三档；上下文 200k（4.6 起 Opus 才扩到 1M）' },
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
      { match: /^glm-(5(?![._-]?\d)|4\.[567])/i, contextWindow: 200000, maxTokens: 128000, input: ['text'],
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
      // flash 系列与 plus 同为开关式（无 reasoning_effort），但输出上限按代际不同：
      // 3.8-flash 131072，3.5/3.6/3.7-flash 均为 65536（2026-09-04 /models 自报）
      { match: /^qwen3\.8-flash/i, contextWindow: 1000000, maxTokens: 131072, input: ['text', 'image'],
        efforts: { off: null, high: 'high' },
        note: '只有 enable_thinking 开关，无离散档位；百炼 qwen3.5+ 支持图片输入' },
      { match: /^qwen3\.[567]-flash/i, contextWindow: 1000000, maxTokens: 65536, input: ['text', 'image'],
        efforts: { off: null, high: 'high' },
        note: '只有 enable_thinking 开关，无离散档位' },
      { match: /^qwen3\.[567]-(max|plus)/i, contextWindow: 1000000, maxTokens: 131072, input: ['text'],
        efforts: { off: null, high: 'high' },
        note: '只有 enable_thinking 开关 + thinking_budget(1–32768)，无离散档位' },
      { match: /^qwen-plus/i, contextWindow: 1000000, maxTokens: 131072, input: ['text'],
        efforts: { off: null, high: 'high' },
        note: '百炼兼容短 id qwen-plus：与 qwen3 plus 同为 enable_thinking 开关' },
      // ── 开源权重版（HuggingFace 官方卡，2026-09-05 核对）────────
      { match: /^qwen3\.8-27b/i, contextWindow: 1000000, maxTokens: 131072, input: ['text', 'image'],
        efforts: { off: null, low: 'low', medium: 'medium', xhigh: 'xhigh' },
        note: '开源版 effort 枚举只有 low/medium/xhigh（默认 xhigh），枚举本身无 off/none 值 —— 关思考走 enable_thinking（thinkingFormat: qwen）；视觉为开源版新增' },
      { match: /^qwen3\.8-2\.4t/i, contextWindow: 1010000, maxTokens: 262144, input: ['text'],
        forcedThinking: '官方卡原文 requires thinking mode for all interactions —— 开源版连 enable_thinking=False 都不支持',
        efforts: { low: 'low', medium: 'medium', xhigh: 'xhigh' },
        note: 'Qwen3.8-2.4T-A95B（Qwen3.8-Max 开源版，95B 激活）；视觉输入与非思考模式是官方 API 版独有' },
      { match: /^qwen3\.[56]-\d/i, contextWindow: 1010000, maxTokens: null, input: ['text', 'image'],
        efforts: { off: null, high: 'high' },
        note: '3.5/3.6 开源尺寸版（9b/27b/35b-a3b 等）：无 reasoning_effort，仅 enable_thinking 开关（默认开）；262k 原生、YaRN 扩到 101 万；输出无官方硬上限，以端点自报为准' },
      // 开源 Qwen3（无小数点代际）：pi-ai huggingface/vercel 条目。
      { match: /^qwen3-.*(instruct|coder)/i, contextWindow: 262144, maxTokens: 32768, input: ['text'],
        efforts: {},
        note: 'pi-ai huggingface.json：Qwen3-*-Instruct / Coder reasoning:false' },
      { match: /^qwen3-/i, contextWindow: 262144, maxTokens: 32768, input: ['text'],
        efforts: { off: null, high: 'high' },
        note: 'pi-ai huggingface.json：Qwen3-32B/30B/235B 等 reasoning:true、无 thinkingLevelMap（enable_thinking 开关）' },
      { match: /^qwen-3-/i, contextWindow: 262144, maxTokens: 32768, input: ['text'],
        efforts: { off: null, high: 'high' },
        note: 'Vercel 网关短 id qwen-3-14b 等，与开源 Qwen3 同为开关式' },
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
      // 出处：pi-ai moonshotai.json。thinking 变体 reasoning:true 且无 thinkingLevelMap /
      // supportsReasoningEffort:false —— 开关式、thinkingFormat deepseek。
      { match: /^kimi-k2-thinking/i,
        forcedThinking: 'pi-ai 目录 kimi-k2-thinking 无 off 键、supportsReasoningEffort:false',
        contextWindow: 262144, maxTokens: 262144, input: ['text'],
        efforts: { high: 'high' },
        note: 'K2 thinking / thinking-turbo：目录未给离散档，只声明可思考' },
      { match: /^kimi-k2-(0711|0905|turbo)/i, contextWindow: 262144, maxTokens: 262144, input: ['text'],
        efforts: {},
        note: 'pi-ai moonshotai.json：k2-0711/0905/turbo-preview reasoning:false' },
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
    match: [/api\.x\.ai/i], api: 'openai-completions', thinkingFormat: 'openai',
    source: 'https://docs.x.ai/docs/guides/reasoning',
    models: [
      { match: /^grok-4\.20-multi-agent/i,
        forcedThinking: 'xAI 文档原文「Reasoning cannot be disabled.」', contextWindow: 2000000, maxTokens: 1800000, input: ['text', 'image'],
        efforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' },
        note: '特殊语义：此模型上 reasoning.effort 控制的是协作 agent 数量（对应 4/16 个 agent）而非思考深度 —— 档位有真实效果，但含义与普通模型不同' },
      // grok-4.3 推理可关闭（注册表 effort 枚举含 none），与 4.5/4.6 相反
      { match: /^grok-4\.3(-|$)/i, contextWindow: 1000000, maxTokens: null, input: ['text', 'image'],
        efforts: { off: 'none', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' },
        note: '官方模型注册表 reasoningEffortOptions = none/low/medium/high/xhigh，默认 low；输出上限官方未公布，以端点自报为准。普通版 grok-4.20 无 effort 参数（开关靠选模型变体），不编码' },
      // 出处：pi-ai xai.json grok-build-0.1 thinkingLevelMap 仅 off:null / minimal:null。
      // 没有可用离散档，按开关式编码（off 空值 + high 占位），不编造 extra 档。
      { match: /^grok-build/i, contextWindow: 256000, maxTokens: 256000, input: ['text', 'image'],
        efforts: { off: null, high: 'high' },
        note: 'pi-ai xai.json：grok-build-0.1 无有效 effort 枚举，仅声明 reasoning:true' },
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
    match: [/api\.groq\.com/i], api: 'openai-completions', thinkingFormat: 'openai',
    source: 'https://console.groq.com/docs/reasoning',
    models: [
      { match: /gpt-oss/i,
        forcedThinking: 'Groq 上 gpt-oss 只接受 low/medium/high；none 仅对 Qwen 3.6/3.8 有效。include_reasoning:false 只是不回传思考内容，模型照样思考照样计费', contextWindow: 131072, maxTokens: 65536, input: ['text'],
        efforts: { low: 'low', medium: 'medium', high: 'high' } },
      // platformOnly：qwen/ 前缀是 Groq 自己的命名空间，不做全局匹配 ——
      // 会与 ModelScope / 硅基流动 / 百炼的 org/model 前缀 id（Qwen/Qwen3-…）
      // 冲突，把 Groq 专属 wire 拼写（none/default）配给别家平台。
      // gpt-oss 是跨平台开源模型、档位与官方一致，不设此标记。
      { match: /^qwen\//i, platformOnly: true, contextWindow: 131072, maxTokens: 65536, input: ['text'],
        efforts: { off: 'none', high: 'default' },
        note: 'Qwen 族用 none/default 两值，与 gpt-oss 族的 low/medium/high 不通用' },
      { match: /^llama-3\.1/i, contextWindow: 131072, maxTokens: 131072, input: ['text'],
        efforts: {},
        note: 'pi-ai groq.json：llama-3.1-8b-instant reasoning:false' },
      { match: /^llama-3\.3/i, contextWindow: 131072, maxTokens: 32768, input: ['text'],
        efforts: {},
        note: 'pi-ai groq.json：llama-3.3-70b-versatile reasoning:false' },
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
    // 宿主手写路由只接受 openai-completions|openai-responses|anthropic-messages，
    // google-generative-ai 仅内置目录可用。自定义 URL 走 Gemini 的 OpenAI 兼容层
    // （/v1beta/openai），档位 wire 值仍是 thinking_level / reasoning_effort 那套。
    match: [/generativelanguage\.googleapis\.com/i], api: 'openai-completions',
    thinkingFormat: 'openai',
    source: 'https://ai.google.dev/gemini-api/docs/openai',
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
      // 滚动别名：pi-ai google.json thinkingLevelMap.off=null（可关），不能落到 3.x flash 强制思考规则。
      { match: /^gemini-flash-lite-latest$/i, contextWindow: 1048576, maxTokens: 65536, input: ['text', 'image'],
        efforts: { off: 'none', low: 'low', medium: 'medium', high: 'high' },
        note: 'pi-ai google.json：gemini-flash-lite-latest 与 2.5-flash-lite 同规格，off:null' },
      { match: /^(deep-research|gemini-robotics)/i, contextWindow: 131072, maxTokens: 65536, input: ['text', 'image'],
        efforts: { off: null, high: 'high' },
        note: 'pi-ai google.json：deep-research / robotics 条目 reasoning:true、无 thinkingLevelMap（开关式）' },
      // Gemma 4：模板级 enable_thinking 开关，默认关闭思考（不发即关），无 effort 档位
      { match: /^gemma-4-/i, contextWindow: 262144, maxTokens: null, input: ['text', 'image'],
        efforts: { off: null, high: 'high' },
        note: '官方 thinking 文档：enable_thinking 模板开关、无 effort 参数，默认关；256k 上下文；输出上限官方未公布，以端点自报为准' },
    ],
  },
  {
    id: 'tencent', catalogProviders: [], label: '腾讯混元',
    match: [/api\.hunyuan\.cloud\.tencent\.com/i], api: 'openai-completions',
    source: 'https://cloud.tencent.com/document/product/1823/131208',
    models: [
      { match: /^hy3(-|$)/i, contextWindow: 262144, maxTokens: 128000, input: ['text'],
        efforts: { off: 'none', low: 'low', high: 'high' },
        note: 'TokenHub：reasoning_effort 三档 low/medium/high、hy3 默认 high；官方端点自报支持 none/low/high（medium 是否独立存在未确认，不暴露）；thinking.type 可开关；输出上限取官方端点自报' },
      { match: /^hy4/i, contextWindow: 1048576, maxTokens: 64000, input: ['text'],
        efforts: { off: 'none', high: 'high' },
        note: 'TokenHub 表格：默认 high，官方列 none/high（端点另报 low，官方表未列，不暴露）；1M 上下文' },
    ],
  },
  {
    id: 'mistral', catalogProviders: [], label: 'Mistral',
    match: [/api\.mistral\.ai/i], api: 'openai-completions',
    source: 'https://huggingface.co/mistralai/Mistral-Medium-3.5-128B',
    models: [
      { match: /^mistral-medium-3-5/i, contextWindow: 256000, maxTokens: null, input: ['text', 'image'],
        efforts: { off: 'none', high: 'high' },
        note: '官方卡示例代码强制校验 REASONING_EFFORT ∈ {none, high}；API 默认档与输出上限未公布，以端点自报为准' },
    ],
  },
  {
    id: 'nvidia', catalogProviders: [], label: 'NVIDIA Nemotron',
    match: [/integrate\.api\.nvidia\.com/i], api: 'openai-completions',
    source: 'https://build.nvidia.com/nvidia/nemotron-3-super-120b-a12b/modelcard',
    models: [
      { match: /^nemotron-3\.5-lightning/i, contextWindow: 1000000, maxTokens: null, input: ['text'],
        efforts: { off: null, high: 'high' },
        note: '官方卡：enable_thinking 模板开关（默认开）、无 effort 档位；1M 上下文、无视觉；输出上限未公布' },
      { match: /^nemotron-3-ultra/i, contextWindow: 1000000, maxTokens: null, input: ['text'],
        efforts: { off: null, high: 'high' },
        note: '同 3.5-Lightning：仅 enable_thinking 开关（默认开）' },
      { match: /^nemotron-3-super/i, contextWindow: 1000000, maxTokens: null, input: ['text'],
        efforts: { off: null, high: 'high' },
        note: 'build 卡明示 enable_thinking 默认 True；上下文取家族 1M（该尺寸未单独公布）' },
    ],
  },
  {
    // 美团 LongCat：官方 API 主机未在文档中公布，match 留空 = 仅按模型 id 全局匹配
    id: 'meituan', catalogProviders: [], label: '美团 LongCat',
    match: [], api: 'openai-completions',
    source: 'https://longcat.chat/platform/docs',
    models: [
      { match: /^longcat-2\.0/i, contextWindow: 1000000, maxTokens: 131072, input: ['text'],
        efforts: { off: null, high: 'high' },
        note: '官方文档：thinking.type = enabled/disabled 开关（无中间档、无 effort 参数），off 走 disabled；1M 上下文、128K 输出；无视觉声明' },
    ],
  },
  {
    // 火山方舟：所有模型接受全部 7 档取值，但部分档位被服务端静默映射（官方映射表
    // 2026-09-05 原文核对，行对齐按表格单元格分组确认）。真实档位按映射结果收录，
    // 被映射的档位进 collapses，绝不作为可选档写出。
    id: 'doubao', catalogProviders: [], label: '火山方舟 豆包/Seed',
    match: [/ark\.cn-[a-z-]+\.volces\.com/i], api: 'openai-completions',
    source: 'https://www.volcengine.com/docs/82379/1449737',
    models: [
      // 组A：minimal 关思考、none→minimal；xhigh/max→high。真实档 low/medium/high，默认 high
      { match: /^doubao-seed-(evolving|2-1-pro)/i, contextWindow: 1048576, maxTokens: 262144, input: ['text', 'image'],
        efforts: { off: 'minimal', low: 'low', medium: 'medium', high: 'high' },
        collapses: { xhigh: 'high', max: 'high' },
        note: '方舟映射表：off 发 minimal（关思考）；xhigh/max 服务端映射为 high —— 假档位不暴露；1M 上下文/256k 回答，支持视觉' },
      // 组A 同映射：turbo 为 256k 上下文
      { match: /^doubao-seed-2-1-turbo/i, contextWindow: 262144, maxTokens: 262144, input: ['text', 'image'],
        efforts: { off: 'minimal', low: 'low', medium: 'medium', high: 'high' },
        collapses: { xhigh: 'high', max: 'high' },
        note: '同 evolving/2-1-pro 映射；256k 上下文、256k 回答' },
      // 组B（2-0 系）：映射与组A相同，默认 medium。lite 的最大回答两处来源不一致
      // （32k 与 128k），输出上限留 null 以端点自报为准
      { match: /^doubao-seed-2-0/i, contextWindow: 262144, maxTokens: null, input: ['text', 'image'],
        efforts: { off: 'minimal', low: 'low', medium: 'medium', high: 'high' },
        collapses: { xhigh: 'high', max: 'high' },
        note: '2-0 lite/mini/pro/code-preview：映射同组A（默认 medium）；256k 上下文；输出上限官方口径不一致，以端点自报为准' },
      // 组C：glm-5-2 方舟版 —— none/minimal 关思考、low/medium→high、xhigh→max。真实档 off/high/max，默认 high
      { match: /^glm-5-2/i, contextWindow: null, maxTokens: null, input: ['text'],
        efforts: { off: 'none', high: 'high', max: 'max' },
        collapses: { minimal: 'off', low: 'high', medium: 'high', xhigh: 'max' },
        note: '方舟版 glm-5-2-260617 与智谱官方档位不同：上下文/输出官方页两处口径不一致，以端点自报为准' },
      // 组D：ga 版 —— none/minimal 关思考、medium→low、xhigh→high。真实档 off/low/high，默认 high
      { match: /^deepseek-v4-(pro|flash)-ga/i, contextWindow: 1048576, maxTokens: 393216, input: ['text'],
        efforts: { off: 'none', low: 'low', high: 'high' },
        collapses: { minimal: 'off', medium: 'low', xhigh: 'high' },
        note: '方舟 ga 版映射：medium 静默降为 low、xhigh 静默压为 high；1M 上下文/384k 回答，纯文本' },
      // 组E：260425 版 —— minimal 关思考、none→minimal、low/medium→high、xhigh→max。真实档 off/high/max，默认 high
      { match: /^deepseek-v4-(pro|flash)-260425/i, contextWindow: 1048576, maxTokens: 393216, input: ['text'],
        efforts: { off: 'minimal', high: 'high', max: 'max' },
        collapses: { low: 'high', medium: 'high', xhigh: 'max' },
        note: '方舟 260425 版映射：与 ga 版真实档不同（off/high/max）；deepseek 官方直连档位见 deepseek 厂商' },
      { match: /^doubao-seed-2\.0/i, contextWindow: 262144, maxTokens: null, input: ['text', 'image'],
        efforts: { off: 'minimal', low: 'low', medium: 'medium', high: 'high' },
        collapses: { xhigh: 'high', max: 'high' },
        note: '点号写法 doubao-seed-2.0-* 与组B（2-0 系）同映射' },
    ],
  },
  {
    id: 'ant-ling', catalogProviders: ['ant-ling'], label: '蚂蚁 Ling/Ring',
    match: [/api\.ant-ling\.com/i], api: 'openai-completions',
    thinkingFormat: 'ant-ling',
    source: 'https://www.ant-ling.com/',
    models: [
      { match: /^Ling-2\.6/i, contextWindow: 262144, maxTokens: 65536, input: ['text'],
        efforts: {},
        note: 'pi-ai ant-ling.json：Ling-2.6 系 reasoning:false' },
      { match: /^Ring-2\.6/i,
        forcedThinking: 'pi-ai 目录 Ring-2.6-1T 的 thinkingLevelMap 无 off 有效值（off:null）',
        contextWindow: 262144, maxTokens: 65536, input: ['text'],
        efforts: { high: 'high', xhigh: 'xhigh' },
        note: 'pi-ai ant-ling.json thinkingLevelMap：high/xhigh' },
    ],
  },
  {
    id: 'xiaomi', catalogProviders: ['xiaomi', 'xiaomi-token-plan-cn', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-sgp'],
    label: '小米 MiMo',
    match: [/api\.xiaomimimo\.com/i, /token-plan.*xiaomimimo\.com/i], api: 'openai-completions',
    thinkingFormat: 'deepseek',
    source: 'https://platform.xiaomimimo.com/',
    models: [
      { match: /^mimo-v2\.5-pro/i, contextWindow: 1048576, maxTokens: 131072, input: ['text'],
        efforts: { off: null, high: 'high' },
        note: 'pi-ai xiaomi.json：reasoning:true、thinkingFormat deepseek、无 thinkingLevelMap（开关式）' },
      { match: /^mimo-v2\.5/i, contextWindow: 1048576, maxTokens: 131072, input: ['text', 'image'],
        efforts: { off: null, high: 'high' },
        note: 'pi-ai xiaomi.json：mimo-v2.5 含视觉；pro 纯文本' },
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

/** 按 pi-ai 内置目录的 provider 名反查厂商。 */
export function vendorForCatalogRoute(route) {
  return VENDORS.find((v) => v.catalogProviders?.includes(route)) ?? null;
}

/** pi-ai 内置目录的 provider 名（route 命中这些就走 modelOverrides，禁止写 models[]）。 */
export function catalogRouteNames() {
  return new Set(VENDORS.flatMap((v) => v.catalogProviders ?? []));
}

/** 在某厂商下按 model id 找条目；stripIdPrefix 处理 openrouter 的 `vendor/model` 形式。 */
export function modelSpec(vendor, modelId) {
  if (!vendor) return null;
  const id = vendor.stripIdPrefix ? String(modelId).replace(/^[^/]+\//, '') : String(modelId);
  return vendor.models.find((m) => m.match.test(id) && !m.exclude?.test(id)) ?? null;
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
function losesDeclaredVision(modelId, spec, via) {
  if (via !== '去尾段') return false;
  if (!/(^|[-_/.])(vision|visual|vl|omni|image)([-_/.]|$)/i.test(String(modelId))) return false;
  return !spec.input?.includes('image');
}

function findInVendor(modelId, vendor) {
  for (const { id, via } of resolveModelCandidates(modelId)) {
    const spec = modelSpec(vendor, id);
    if (!spec || losesDeclaredVision(modelId, spec, via)) continue;
    return { vendor, spec, id, via };
  }
  return null;
}

/**
 * 明确知道 URL/catalog 厂商时先按平台语义匹配；失败后再走聚合网关的全局兜底。
 * OpenRouter 通配和 platformOnly 规则只能从 preferredVendor 入口进入。
 */
export function findVendorModel(modelId, preferredVendor = null) {
  const vendor = typeof preferredVendor === 'string'
    ? vendorById(preferredVendor)
    : preferredVendor;
  if (!vendor) return findAnyVendor(modelId);
  return findInVendor(modelId, vendor) ?? findAnyVendor(modelId);
}

export function findAnyVendor(modelId) {
  const candidates = resolveModelCandidates(modelId);
  for (const { id, via } of candidates) {
    for (const v of VENDORS) {
      if (v.id === 'openrouter') continue;        // 通配规则，不参与自动匹配
      const spec = modelSpec(v, id);
      // 平台专属命名（如 Groq 的 qwen/ 前缀）不参与全局匹配：其命名空间
      // 与第三方平台的 org/model 前缀冲突，只该在 URL 命中该平台时使用。
      if (!spec || spec.platformOnly || losesDeclaredVision(modelId, spec, via)) continue;
      return { vendor: v, spec, id, via };
    }
  }
  return null;
}
