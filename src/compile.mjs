/**
 * 编译器：厂商真值 → dsh 的 PiAiModelProfile / PiAiModelOverride。
 * 纯函数，无 I/O，可快照测试。
 *
 * 三条硬约束来自 @deepseek-ai/dsh-llm-pi-ai 的类型定义，违反会被
 * assertServiceable 以 settings-rejected 拒绝，而不是被忽略：
 *
 *  1. 模型级 compat 按协议门控（宿主 COMPAT_GATES）：openai-completions 17 字段、
 *     openai-responses 3 字段、anthropic-messages 7 字段（含 forceAdaptiveThinking）。
 *     协议不接受的字段会被 resolveModelCompat 整段拒绝。
 *  2. reasoningEfforts 里只有 off 允许空值；其余每个声明的档位都必须给 wire 拼写。
 *  3. modelOverrides 只在「内置目录 route + 没有 models 列表」时有效，
 *     且不能命名目录里不存在的模型。
 *
 * 视觉等输入能力与思考档位同级：PiAiModelProfile.input 是合法字段
 * （text / image），缺省沿用目录再退到 route.defaultInput（[text]）。
 * 自定义网关没有目录条目，不写 input 就会被当成纯文本，发图报
 * UNSUPPORTED_CONTENT。真值库、/models 自报、已有配置三者只增不减。
 */
import { LEVELS } from './levels.mjs';
import { hasVision, unionInput } from './modalities.mjs';
import { COMPAT_GATES } from './host.mjs';
import { modelSpec } from './vendors.mjs';

export class CompileError extends Error {}

/**
 * 把一个模型的真值编译成 dsh 条目。
 * @returns {{entry:object, notes:string[], dropped:object}}
 */
export function compileModel({ vendor, modelId, api, spec, includeIO = true, overlay = null }) {
  const s = spec ?? modelSpec(vendor, modelId);
  if (!s) throw new CompileError(`真值库里没有 ${modelId}（厂商 ${vendor?.id ?? '未知'}）`);

  const notes = [];
  // 静默塌缩的档位：不论是否出现在 efforts 表里，都要如实报告「这些档位是假的」
  const dropped = { collapsed: Object.keys(s?.collapses ?? {}), notExposed: [] };
  const entry = { id: modelId };

  if (s.name) entry.name = s.name;
  if (s.contextWindow != null) entry.contextWindow = s.contextWindow;
  if (s.maxTokens != null) entry.maxTokens = s.maxTokens;

  // 端点裁剪（L2 覆盖层）：中转站常把上下文/输出上限压低
  if (overlay?.contextWindow != null) {
    if (entry.contextWindow != null && overlay.contextWindow !== entry.contextWindow)
      notes.push(`上下文被端点裁剪：官方 ${entry.contextWindow} → 端点 ${overlay.contextWindow}`);
    entry.contextWindow = overlay.contextWindow;
  }
  if (overlay?.maxTokens != null) {
    if (entry.maxTokens != null && overlay.maxTokens !== entry.maxTokens)
      notes.push(`输出上限被端点裁剪：官方 ${entry.maxTokens} → 端点 ${overlay.maxTokens}`);
    entry.maxTokens = overlay.maxTokens;
  }

  // input：0.1.1-rc.2 的 PiAiModelProfile 确实有这个字段。
  //   input?: PiAiModality[]  —— 缺省沿用内置目录，再退到 route 的 defaultInput（[text]）
  // 真值库与端点自报取并集：少报会在挂图前被拒，多报才是请求中途失败。
  // output：官方类型里没有，写进去有被 assertServiceable 整段拒绝的风险 —— 一律不写。
  if (includeIO) {
    const merged = unionInput(s.input, overlay?.input);
    if (merged) {
      entry.input = merged;
      if (hasVision(merged) && !hasVision(s.input) && hasVision(overlay?.input)) {
        notes.push(`视觉能力来自端点自报：${merged.join(' + ')}`);
      } else if (hasVision(s.input) && overlay?.input && !hasVision(overlay.input)) {
        notes.push(`端点未报视觉，按真值库保留 ${merged.join(' + ')}`);
      }
    }
  }

  // ── 思考档位 ────────────────────────────────────────────────
  const src = s.efforts ?? {};
  const expose = overlay?.expose ? new Set(overlay.expose) : null;
  const efforts = {};

  for (const lv of LEVELS) {
    if (!(lv in src)) continue;
    if (s.collapses && lv in s.collapses) continue;
    if (expose && !expose.has(lv)) { dropped.notExposed.push(lv); continue; }
    const wire = overlay?.rename?.[lv] ?? src[lv];
    if (lv !== 'off' && (wire == null || wire === '')) {
      throw new CompileError(`档位 ${lv} 缺 wire 拼写：dsh 只允许 off 留空`);
    }
    efforts[lv] = lv === 'off' ? (wire ?? null) : wire;
  }

  if (Object.keys(efforts).length === 0) {
    entry.reasoningEfforts = false;   // 显式声明为非推理模型
    notes.push('该模型在此端点不提供任何思考档位，已写 reasoningEfforts: false');
  } else if (!Object.keys(efforts).some((l) => l !== 'off')) {
    // 适配器硬约束（lib/index.js resolveModelReasoning）：
    //   if (!declared.some(([level]) => level !== "off")) invalid(...)
    // 只有 off 一档的档位表会被【整段拒绝】。这种模型的正确写法是 false。
    entry.reasoningEfforts = false;
    notes.push('档位表里只剩 off 一档 —— 适配器会拒绝这种写法，已改写成 reasoningEfforts: false');
  } else {
    entry.reasoningEfforts = efforts;
    if ('off' in efforts && efforts.off === null) {
      notes.push('已写入显式 off:（空值）—— 这是修复思考被强制关闭 / 输出被截断的关键');
    }
  }

  if (dropped.collapsed.length)
    notes.push(`丢弃静默塌缩档位 ${dropped.collapsed.join('/')}（服务端会改写成别的档，写了就是假档位）`);
  if (dropped.notExposed.length)
    notes.push(`端点未暴露档位 ${dropped.notExposed.join('/')}，已按覆盖层裁掉`);

  // ── compat：按协议门控，只写该 api 接受的字段 ────────────────
  const offered = new Set(COMPAT_GATES[api] ?? []);
  const tf = overlay?.thinkingFormat ?? vendor?.thinkingFormat;
  const adaptive = overlay?.forceAdaptiveThinking ?? specWantsAdaptive(s, vendor, modelId);
  const wanted = {
    ...(tf ? { thinkingFormat: tf } : {}),
    ...(entry.reasoningEfforts === false ? { supportsReasoningEffort: false } : {}),
    ...(adaptive ? { forceAdaptiveThinking: true } : {}),
    ...(overlay?.compat ?? {}),
    ...(s.compat ?? {}),
  };
  const compat = {};
  const skipped = [];
  for (const [k, v] of Object.entries(wanted)) {
    if (v == null) continue;
    if (!offered.has(k)) { skipped.push(k); continue; }
    compat[k] = v;
  }
  if (Object.keys(compat).length) entry.compat = compat;
  else if (skipped.length && (tf || adaptive)) {
    notes.push(`api=${api} 不接受 ${skipped.join('/')}（宿主 COMPAT_GATES），已跳过`);
  }

  if (s.forcedThinking) notes.push(`无 off 档（该模型不能关闭思考）：${s.forcedThinking}`);
  for (const c of s.constraints ?? []) notes.push(`约束：${c}`);
  if (s.note) notes.push(s.note);
  if (vendor?.warn) notes.push(vendor.warn);

  return { entry, notes, dropped };
}

/** Claude 4.6+ / 5 / fable / mythos 走 adaptive thinking（pi-ai 只在 forceAdaptiveThinking===true 时发 output_config.effort）。 */
function specWantsAdaptive(spec, vendor, modelId) {
  if (spec?.forceAdaptiveThinking === true) return true;
  if (vendor?.id !== 'anthropic') return false;
  const id = String(modelId ?? '');
  if (/claude-sonnet-4[.-]5/i.test(id)) return false;
  return /claude-(opus|sonnet|fable|mythos)-5/i.test(id)
    || /claude-(opus|sonnet)-4[.-][678]/i.test(id)
    || /claude-(fable|mythos)/i.test(id);
}

/** 只补 off 档，其余原样保留 —— 用于修内置目录缺 off 的模型。 */
export function offOnlyOverride(existingEfforts, offWire = null) {
  const out = { ...(existingEfforts ?? {}) };
  out.off = offWire;
  const ordered = {};
  for (const lv of LEVELS) if (lv in out) ordered[lv] = out[lv];
  return ordered;
}
