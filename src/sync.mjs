/**
 * 监视 llm-pi-ai 后的规划器：纯函数（除 fetch 辅助），可单测。
 *
 * 自定义网关 → models[]；官方目录 → 只写 modelOverrides
 * （档位表必覆盖；视觉等 input 只在目录没声明时补）。
 * 写反会把官方目录整表替换掉。
 */
import { LEVEL_LABEL, DEFAULT_ROUTE_EFFORT, clampThinkingLevel, pickRouteEffort } from './levels.mjs';
import { coversInput, hasVision, inferInput, unionInput } from './modalities.mjs';
import { applyPlatform, platformForUrl } from './platforms.mjs';
import {
  findVendorModel, vendorForUrl, vendorForCatalogRoute, catalogRouteNames,
} from './vendors.mjs';
import { compileModel, CompileError } from './compile.mjs';

export const NS = 'llm-pi-ai';
export const TAG = '[model-autoconfig]';

/** 认不出端点时的协议兜底值。写进 settings 前会在 sync slice 里留 apiGuessed 标记，
 *  以便后续出现更可信的来源（URL 命中真值库）时自动修正，而不是写死。 */
const FALLBACK_API = 'openai-completions';

export function jsonEq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function clone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

/** 空 models[] 不算「已经切成列表」——那会把官方目录替换成零个模型。 */
export function classifyRoute(route, profile, catalogNames = catalogRouteNames()) {
  const models = profile?.models;
  if (Array.isArray(models) && models.length > 0) return 'gateway';
  if (profile?.baseURL) return 'gateway';
  if (catalogNames.has(route)) return 'catalog';
  return 'skip';
}

/**
 * 用户常把 Cherry Studio 预览地址整段贴进来。
 * 剥掉 /chat/completions、/completions、/responses，保留可能存在的 /v1。
 */
export function normalizeEndpoint(url) {
  let u = String(url ?? '').trim();
  if (!u) return '';
  u = u.replace(/\/+$/, '');
  u = u.replace(/\/v1\/chat\/completions$/i, '/v1');
  u = u.replace(/\/chat\/completions$/i, '');
  u = u.replace(/\/v1\/completions$/i, '/v1');
  u = u.replace(/\/completions$/i, '');
  u = u.replace(/\/responses$/i, '');
  return u.replace(/\/+$/, '');
}

/**
 * Cherry Studio 只填根地址；dsh 的 openai-completions 需要 …/v1。
 * v1 像真接口（200 或 401 缺 key）且根路径 404/失败 → 补 /v1。
 */
export function decideBaseURL(current, rootStatus, v1Status) {
  const root = normalizeEndpoint(current);
  if (!root) return { baseURL: root, changed: false };
  if (/\/v1$/i.test(root)) {
    const orig = String(current ?? '').trim().replace(/\/+$/, '');
    return { baseURL: root, changed: root !== orig };
  }
  const v1Real = v1Status === 200 || v1Status === 401;
  const rootMiss = rootStatus === 404 || rootStatus === 405 || rootStatus === 0;
  if (v1Real && rootMiss) return { baseURL: `${root}/v1`, changed: true };
  const orig = String(current ?? '').trim().replace(/\/+$/, '');
  return { baseURL: root, changed: root !== orig };
}

function compileKnown(modelId, api, overlay, includeIO, preferredVendor = null, baseURL = '') {
  const hit = findVendorModel(modelId, preferredVendor);
  if (!hit) return null;
  try {
    let r = compileModel({
      vendor: hit.vendor, modelId, api, spec: hit.spec, overlay, includeIO,
    });
    r = applyPlatform(r, platformForUrl(baseURL), { baseURL, modelId });
    // 非原样命中（硬映射/软匹配/去前缀）时把解析路径暴露给规划器写日志。
    // entry.id 仍是网关原始 id —— 真值只决定档位表长什么样。
    if (hit.id !== modelId) r.resolved = { id: hit.id, via: hit.via };
    return r;
  } catch (e) {
    if (e instanceof CompileError) return null;
    throw e;
  }
}

function resolvedNote(modelId, compiled) {
  if (!compiled?.resolved) return null;
  return `${modelId}: 按「${compiled.resolved.id}」配档位与能力（${compiled.resolved.via}）；发给网关的 id 不变`;
}

function mergeEntry(existing, compiled) {
  if (!existing) return { ...compiled.entry };
  const out = { ...existing };
  for (const [k, v] of Object.entries(compiled.entry)) {
    if (k === 'id') continue;
    if (k === 'reasoningEfforts') { out[k] = v; continue; }
    if (k === 'input') {
      const merged = unionInput(out[k], v);
      if (merged) out[k] = merged;
      continue;
    }
    if (k === 'compat') {
      // 用户手改的 compat 键优先：平台/真值只填空缺，不覆盖已有开关。
      out[k] = { ...v, ...(out[k] ?? {}) };
      continue;
    }
    if (k === 'maxTokens') {
      // 平台硬上限（方舟 coding 400）必须夹紧，即使用户/真值写了更大的值。
      if (out[k] == null || (typeof v === 'number' && v < out[k])) out[k] = v;
      continue;
    }
    if (out[k] === undefined) out[k] = v;
  }
  return out;
}

function overlayFromDeclared(d) {
  if (!d) return null;
  const overlay = {};
  if (d.contextWindow != null) overlay.contextWindow = d.contextWindow;
  if (d.maxTokens != null) overlay.maxTokens = d.maxTokens;
  if (d.input) overlay.input = d.input;
  // 端点明说这个模型没有推理参数时，不能按真值库写档位表 —— 平台通配规则
  // （OpenRouter 的 /.*/）会把七档配给翻译/音乐等根本不思考的模型。
  // 只认显式 false：多数网关不报 supported_parameters，那是 null，不能当否定。
  if (d.supportsReasoning === false) overlay.expose = [];
  return Object.keys(overlay).length ? overlay : null;
}

function unknownKeep(existing, overlay) {
  // 识别不到就不编 reasoningEfforts:false（那是在替网关断言
  // 「该模型不支持思考」）。视觉可以按端点自报或 id 里的 vl/vision 补。
  const out = { ...existing };
  const inferred = inferInput(existing?.id, overlay?.input ?? existing?.input);
  if (inferred) out.input = unionInput(out.input, inferred);
  return out;
}

/** 不凭空写路由级 reasoning；只修正已经写了、但会 UNSUPPORTED_REASONING_EFFORT 的值。 */
function applyRouteEffort(route, next, entries, notes, fallback) {
  const prev = next.reasoning;
  if (prev == null || prev === '') return;
  const got = pickRouteEffort(prev, entries, fallback);
  if (got === undefined) {
    delete next.reasoning;
    notes.push(`${route}: 去掉路由默认档 ${prev}（识别不到共有档，不另加）`);
    return;
  }
  if (got !== prev) {
    next.reasoning = got;
    notes.push(`${route}: 默认思考档位 ${prev} → ${got}`);
  }
  for (const e of entries ?? []) {
    const cn = clampNote(got, e.reasoningEfforts, e.id);
    if (cn) notes.push(cn);
  }
}

export function clampNote(routeEffort, efforts, modelId) {
  if (efforts === false) return `${modelId}: 不支持思考`;
  const got = clampThinkingLevel(routeEffort, efforts);
  if (!got) return `${modelId}: 无可用档位`;
  if (got === routeEffort) return null;
  return `${modelId}: 默认 ${LEVEL_LABEL[routeEffort] ?? routeEffort} 收敛到 ${LEVEL_LABEL[got] ?? got}`;
}

function gatewayApi(profile, fetchHint) {
  if (profile.api) return { api: profile.api, how: '已有 api', source: 'profile' };
  const v = verifiedApi(profile, fetchHint);
  if (v) return { ...v, source: 'verified' };
  return { api: FALLBACK_API, how: '兜底 openai-completions', source: 'fallback' };
}

/** URL 命中真值库 / 探测给出的「已验证」协议来源；没有则 null。 */
function verifiedApi(profile, fetchHint) {
  const fromUrl = vendorForUrl(profile.baseURL ?? '');
  if (fromUrl?.api) return { api: fromUrl.api, how: `真值库 ${fromUrl.id}` };
  if (fetchHint?.api) return { api: fetchHint.api, how: fetchHint.how ?? '探测' };
  return null;
}

/**
 * @param {object} gw
 * @param {boolean} gw.fetchOk
 * @param {string[]} gw.ids
 * @param {Record<string, object>} gw.declared
 * @param {string} [gw.baseURL]  可能已经补过 /v1
 * @param {string} [gw.api]
 * @param {string} [gw.how]
 * @param {object} [stateSlice]  上轮的 sync slice；apiGuessed=true 表示
 *   profile.api 是我们写入的未验证兜底值，允许被更可信的来源修正
 */
export function planGatewayRoute(route, profile, gw, stateSlice, defaultEffort = DEFAULT_ROUTE_EFFORT, includeIO = true) {
  const notes = [];
  const next = clone(profile) ?? {};
  const apiInfo = gatewayApi(next, gw);
  let apiGuessed = false;
  if (!next.api) {
    next.api = apiInfo.api;
    apiGuessed = apiInfo.source === 'fallback';
    notes.push(`${route}: 协议 ${next.api}（${apiInfo.how}）`);
  } else if (stateSlice?.apiGuessed && next.api === FALLBACK_API) {
    // 上一轮写的是兜底值：有已验证来源就修正；用户改成了别的协议则不碰
    //（值 ≠ 兜底值时走不到这里，标记自动失效）。
    const v = verifiedApi(next, gw);
    if (v && v.api !== next.api) {
      notes.push(`${route}: 协议 ${next.api} → ${v.api}（${v.how}；修正上一轮的未验证兜底值）`);
      next.api = v.api;
    } else if (v) {
      notes.push(`${route}: 协议 ${next.api}（${v.how}，兜底值已确认）`);
    } else {
      apiGuessed = true;
      notes.push(`${route}: 协议 ${next.api} 是未验证的兜底值 —— 若实际不是 openai-completions 请手改 api`);
    }
  }
  if (gw?.baseURL && gw.baseURL !== next.baseURL) {
    next.baseURL = gw.baseURL;
    notes.push(`${route}: baseURL → ${gw.baseURL}`);
  }

  const current = Array.isArray(profile.models) ? profile.models : [];
  const currentIds = current.map((m) => m.id).filter(Boolean);
  const prevIds = stateSlice?.modelIds ?? [];
  const deleted = new Set(stateSlice?.deletedIds ?? []);
  for (const id of prevIds) if (!currentIds.includes(id)) deleted.add(id);

  const api = next.api;
  const preferredVendor = vendorForUrl(next.baseURL ?? '');
  const nextModels = [];
  const seen = new Set();

  for (const m of current) {
    if (!m?.id || seen.has(m.id)) continue;
    seen.add(m.id);
    const overlay = overlayFromDeclared(gw?.declared?.[m.id]);
    const compiled = compileKnown(m.id, api, overlay, includeIO, preferredVendor, next.baseURL ?? '');
    if (compiled) {
      const merged = mergeEntry(m, compiled);
      nextModels.push(merged);
      const rn = resolvedNote(m.id, compiled);
      if (rn) notes.push(rn);
      if (hasVision(merged.input) && !hasVision(m.input)) {
        notes.push(`${m.id}: 补视觉能力 ${merged.input.join(' + ')}`);
      }
    } else {
      const kept = includeIO ? unknownKeep(m, overlay) : { ...m };
      nextModels.push(kept);
      notes.push(`${m.id}: 真值库没有，保留条目、不编档位`);
      if (hasVision(kept.input) && !hasVision(m.input)) {
        notes.push(`${m.id}: 按名字/端点自报补视觉 ${kept.input.join(' + ')}`);
      }
    }
  }

  if (gw?.fetchOk) {
    for (const id of gw.ids ?? []) {
      if (!id || seen.has(id) || deleted.has(id)) continue;
      const overlay = overlayFromDeclared(gw.declared?.[id]);
      const compiled = compileKnown(id, api, overlay, includeIO, preferredVendor, next.baseURL ?? '');
      if (!compiled) continue;
      const entry = mergeEntry(null, compiled);
      nextModels.push(entry);
      seen.add(id);
      notes.push(`${id}: 从 /models 写入`);
      const rn = resolvedNote(id, compiled);
      if (rn) notes.push(rn);
      if (hasVision(entry.input)) notes.push(`${id}: 视觉 ${entry.input.join(' + ')}`);
    }
  } else if (!current.length) {
    notes.push(`${route}: 拉模型列表失败或没有密钥，不改已有配置`);
  }

  if (!current.length && gw?.fetchOk && nextModels.length === 0) {
    // 写空 models[] = dsh 上这条 route 一个模型都不显示（CLI 在同场景直接拒绝，
    // 见 bin 的「写入空的 models[] 会让 dsh 上这条 route 一个模型都不显示」）。
    // 保持「没写」状态：用户手动加的模型永远保留，补了真值库规则后下一轮自动补全。
    delete next.models;
    notes.push(`${route}: /models 拉到 ${gw.ids?.length ?? 0} 个 id，没有可写入的（真值库不认得或在删除名单里）—— 不写空 models[]，可手动添加或补 src/vendors.mjs 规则`);
  } else if (gw?.fetchOk || current.length) {
    next.models = nextModels;
  } else {
    delete next.models;
  }
  if (next.modelOverrides) {
    delete next.modelOverrides;
    notes.push(`${route}: 已有 models[]，去掉 modelOverrides（并存会被拒）`);
  }
  applyRouteEffort(route, next, nextModels, notes, defaultEffort);

  const modelIds = nextModels.map((m) => m.id);
  const nextSlice = {
    kind: 'gateway',
    modelIds,
    deletedIds: [...deleted],
    ...(apiGuessed ? { apiGuessed: true } : {}),
    at: new Date().toISOString(),
  };
  return { profile: next, notes, stateSlice: nextSlice };
}

export function planCatalogRoute(
  route, profile, catalogEntries, defaultEffort = DEFAULT_ROUTE_EFFORT, writeInput = true, stateSlice = null,
) {
  const notes = [];
  const next = clone(profile) ?? {};
  if (Array.isArray(next.models) && next.models.length === 0) {
    delete next.models;
    notes.push(`${route}: 去掉空的 models[]，避免覆盖内置目录`);
  }
  const api = next.api || 'openai-completions';
  const preferredVendor = vendorForCatalogRoute(route);
  const overrides = { ...(next.modelOverrides ?? {}) };
  const managedIds = new Set();
  let n = 0;
  let nInput = 0;
  for (const e of catalogEntries ?? []) {
    if (e.provider !== route) continue;
    const compiled = compileKnown(e.id, api, null, writeInput, preferredVendor);
    if (!compiled) continue;
    managedIds.add(e.id);
    const prev = overrides[e.id];
    const only = { reasoningEfforts: compiled.entry.reasoningEfforts };
    const wantInput = writeInput ? unionInput(compiled.entry.input, prev?.input) : null;
    if (wantInput && !coversInput(e.model?.input, wantInput)) {
      only.input = wantInput;
      if (hasVision(wantInput) && !hasVision(prev?.input) && !hasVision(e.model?.input)) {
        nInput++;
        notes.push(`${e.id}: 补视觉能力 ${wantInput.join(' + ')}（目录未声明）`);
      }
    }
    const merged = prev ? { ...prev, ...only } : only;
    if (!jsonEq(prev, merged)) n++;
    overrides[e.id] = merged;
  }
  let removed = 0;
  for (const id of stateSlice?.managedIds ?? []) {
    if (managedIds.has(id) || !Object.hasOwn(overrides, id)) continue;
    delete overrides[id];
    removed++;
  }
  next.modelOverrides = overrides;
  if (n) notes.push(`${route}: 更新 ${n} 条 modelOverrides${nInput ? `（含 ${nInput} 条视觉）` : ' 档位表'}`);
  if (removed) notes.push(`${route}: 清理 ${removed} 条目录中已失效的插件 override`);
  // override 值本身没有 id 字段，补上让 clampNote 能指名道姓
  applyRouteEffort(route, next,
    Object.entries(overrides).map(([id, v]) => ({ id, ...v })), notes, defaultEffort);
  return {
    profile: next,
    notes,
    stateSlice: {
      kind: 'catalog', modelIds: Object.keys(overrides), managedIds: [...managedIds], at: new Date().toISOString(),
    },
  };
}

/**
 * @param {object} args
 * @param {Record<string, object>} args.providers
 * @param {object} args.state  .dsh-model-autoconfig.json
 * @param {Set<string>} [args.catalogNames]
 * @param {object[]|null} args.catalogEntries  null = 目录不可用
 * @param {Record<string, object>} args.gateways  route → fetch 结果
 * @param {string} [args.defaultEffort]  路由级默认档位，未配置时用它
 * @param {boolean} [args.writeInput]  是否写 models[].input / 目录缺视觉时的 override
 */
export function planSync({
  providers,
  state,
  catalogNames = catalogRouteNames(),
  catalogEntries,
  gateways = {},
  defaultEffort = DEFAULT_ROUTE_EFFORT,
  writeInput = true,
}) {
  const logs = [];
  const nextProviders = { ...(providers ?? {}) };
  const managed = { ...(state?.managed ?? {}) };
  let changed = false;
  let stateChanged = false;
  const core = (s) => {
    if (!s) return s;
    const { at, ...rest } = s;
    return rest;
  };

  /**
   * 插件的同步状态写在 managed[route].sync 下，与 CLI 三方合并的基线
   * （managed[route].models）分开。两者共用一个 route 槽位但各占各的键：
   * 合并写会互相冲掉，进而让「用户手改的字段不被覆盖」静默失效。
   */
  const keepSlice = (route, slice) => {
    if (jsonEq(core(managed[route]?.sync), core(slice))) return;
    managed[route] = { ...(managed[route] ?? {}), sync: slice };
    stateChanged = true;
  };

  for (const [route, profile] of Object.entries(providers ?? {})) {
    const kind = classifyRoute(route, profile, catalogNames);
    if (kind === 'skip') {
      logs.push({ level: 'debug', msg: `${route}: 没有 baseURL、也不是目录路由，跳过` });
      continue;
    }
    if (kind === 'catalog') {
      if (!catalogEntries) {
        logs.push({ level: 'warn', msg: `${route}: 找不到 pi-ai 内置目录，官方路由跳过` });
        continue;
      }
      const r = planCatalogRoute(
        route, profile, catalogEntries, defaultEffort, writeInput, managed[route]?.sync,
      );
      for (const n of r.notes) logs.push({ level: 'info', msg: n });
      if (!jsonEq(r.profile, profile)) {
        nextProviders[route] = r.profile;
        changed = true;
      }
      keepSlice(route, r.stateSlice);
      continue;
    }

    const r = planGatewayRoute(
      route, profile, gateways[route] ?? { fetchOk: false, ids: [] },
      managed[route]?.sync, defaultEffort, writeInput,
    );
    for (const n of r.notes) logs.push({ level: 'info', msg: n });
    if (!jsonEq(r.profile, profile)) {
      nextProviders[route] = r.profile;
      changed = true;
    }
    keepSlice(route, r.stateSlice);
  }

  return {
    providers: nextProviders,
    state: { version: 2, managed },
    logs,
    changed,
    stateChanged,
  };
}

