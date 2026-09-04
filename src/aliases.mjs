/**
 * 硬映射表 —— 已知第三方网关的模型 id → 真值库认得的规范 id。
 *
 * 这是「硬映射 + 软匹配」两层匹配的第一层，收两类条目：
 *   1. 真实网关上观察到、且确认指向某个官方模型的怪 id —— 一条一个出处
 *   2. 聚合平台的滚动别名（-latest）：指向随厂商发版漂移，按自报规格
 *      比对确定当前指向；厂商发新版后过期，改表即可、不动档位逻辑
 * 软匹配（src/match.mjs）负责一般规律（日期快照、量化后缀、档位变体……），
 * 能靠规律解决的不要堆进这张表。
 *
 * 维护规则（test/match.test.mjs 有守护断言）：
 *   - 键一律小写（查找前先规范化，大小写不敏感）
 *   - 值必须能被真值库原样命中（写一个不存在的规范 id 等于没配）
 *   - 键本身不能已经能原样命中真值库（那是死条目，删掉）
 */
export const MODEL_ALIASES = {
  // ── DeepSeek 官方快照 id：中转站按日期checkpoint上架 ──────────────
  'deepseek-v4-pro-0813': 'deepseek-v4-pro',     // ubt 网关实际在服
  'deepseek-v4-flash-0731': 'deepseek-v4-flash', // ubt 网关实际在服

  // ── OpenRouter 滚动别名：按 2026-09-04 /models 自报的上下文/输出上限比对 ──
  'kimi-latest': 'kimi-k3',                      // 1048576/943718 与 k3 完全一致
  'claude-opus-latest': 'claude-opus-5',
  'claude-sonnet-latest': 'claude-sonnet-5',
  'claude-haiku-latest': 'claude-haiku-4.5',
  'claude-fable-latest': 'claude-fable-5.1',
  'grok-latest': 'grok-4.6',                     // 500k/450k：4.5 与 4.6 同规格，取最新
  'gpt-latest': 'gpt-5.6',
  'gpt-mini-latest': 'gpt-5-mini',
  'glm-latest': 'glm-5.3',
  'glm-flash-latest': 'glm-5.3-flash',
  'gemini-pro-latest': 'gemini-3.1-pro-preview',
  'gemini-flash-latest': 'gemini-3.8-flash',

  // ── OpenRouter bytedance-seed 前缀 → 火山方舟在服模型 id ─────────
  //（档位来自方舟映射表，见 vendors.mjs doubao 厂商）
  'seed-2-1-turbo': 'doubao-seed-2-1-turbo-260628',
  'seed-2.0-code': 'doubao-seed-2-0-code-preview-260215',
  'seed-2.0-lite': 'doubao-seed-2-0-lite-260428',
};
