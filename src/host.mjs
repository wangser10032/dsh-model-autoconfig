/**
 * 宿主能力自适配：从 settings.describe().schema（{uid,refs}）抽枚举/字段集，
 * 写入前裁剪，适配 dsh 0.0.1-rc.1 ~ 0.1.2。
 *
 * 拿不到 descriptor.schema 时退回 0.1.2 全集（与 levels.THINKING_FORMATS /
 * HOST_APIS 及本文件 COMPAT_GATES 一致）。
 */
import { HOST_APIS, THINKING_FORMATS } from './levels.mjs';

/** 与宿主 0.1.2 lib/index.js COMPAT_GATES 的 offer 字段一致。 */
export const COMPAT_GATES = {
  'openai-completions': [
    'supportsStore', 'supportsDeveloperRole', 'supportsReasoningEffort',
    'supportsUsageInStreaming', 'supportsFinishReason', 'maxTokensField',
    'requiresToolResultName', 'requiresAssistantAfterToolResult',
    'requiresThinkingAsText', 'requiresReasoningContentOnAssistantMessages',
    'thinkingFormat', 'chatTemplateKwargs', 'chatTemplateArgs',
    'supportsThinkingTokenBudget', 'supportsStrictMode', 'cacheControlFormat',
    'supportsLongCacheRetention',
  ],
  'openai-responses': [
    'supportsDeveloperRole', 'supportsStrictMode', 'supportsLongCacheRetention',
  ],
  'anthropic-messages': [
    'supportsEagerToolInputStreaming', 'supportsLongCacheRetention',
    'supportsCacheControlOnTools', 'supportsTemperature',
    'forceAdaptiveThinking', 'allowEmptySignature', 'supportsStrictTools',
  ],
};

const FALLBACK_CAPS = {
  apis: [...HOST_APIS],
  thinkingFormats: [...THINKING_FORMATS],
  input: ['text', 'image'],
  levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  compatFields: [...new Set(Object.values(COMPAT_GATES).flat())],
  modelFields: ['id', 'name', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts', 'compat'],
};

function constValues(node, refs) {
  if (node == null) return [];
  const schema = typeof node === 'number' ? refs[node] : node;
  if (!schema) return [];
  if (schema.type === 'const' && typeof schema.value === 'string') return [schema.value];
  if (schema.type === 'union') return (schema.list ?? []).flatMap((id) => constValues(id, refs));
  return [];
}

function fieldEnum(refs, field) {
  for (const node of Object.values(refs ?? {})) {
    if (node?.dict && field in node.dict) {
      const values = constValues(node.dict[field], refs);
      if (values.length) return values;
    }
  }
  return [];
}

function dictKeys(refs, pred) {
  for (const node of Object.values(refs ?? {})) {
    if (node?.dict && pred(node.dict)) return Object.keys(node.dict);
  }
  return [];
}

/** 从 schemastery {uid,refs} 抽出宿主当前认识的枚举与字段集。 */
export function capsFromSchema(schema) {
  const refs = schema?.refs;
  if (!refs) return { ...FALLBACK_CAPS, source: 'fallback' };
  const apis = fieldEnum(refs, 'api');
  const thinkingFormats = fieldEnum(refs, 'thinkingFormat');
  const input = fieldEnum(refs, 'input');
  const levels = fieldEnum(refs, 'reasoning') ;
  const compatFields = dictKeys(refs, (d) => 'thinkingFormat' in d);
  const modelFields = dictKeys(refs, (d) => 'reasoningEfforts' in d && !('api' in d));
  return {
    apis: apis.length ? apis : FALLBACK_CAPS.apis,
    thinkingFormats: thinkingFormats.length ? thinkingFormats : FALLBACK_CAPS.thinkingFormats,
    input: input.length ? input : FALLBACK_CAPS.input,
    levels: levels.length ? levels : FALLBACK_CAPS.levels,
    compatFields: compatFields.length ? compatFields : FALLBACK_CAPS.compatFields,
    modelFields: modelFields.length ? modelFields : FALLBACK_CAPS.modelFields,
    source: 'schema',
  };
}

export function fallbackCaps() {
  return { ...FALLBACK_CAPS, source: 'fallback' };
}

function gateCompat(compat, api, caps) {
  if (!compat || typeof compat !== 'object') return undefined;
  const offered = new Set(COMPAT_GATES[api] ?? []);
  const known = new Set(caps.compatFields ?? []);
  const formats = new Set(caps.thinkingFormats ?? []);
  const out = {};
  for (const [k, v] of Object.entries(compat)) {
    if (v == null) continue;
    if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) continue;
    if (offered.size && !offered.has(k)) continue;
    if (known.size && !known.has(k)) continue;
    if (k === 'thinkingFormat' && formats.size && !formats.has(v)) continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function trimEntry(entry, api, caps) {
  if (!entry || typeof entry !== 'object') return entry;
  const fields = new Set(caps.modelFields ?? FALLBACK_CAPS.modelFields);
  const out = {};
  for (const [k, v] of Object.entries(entry)) {
    if (k === 'id' || fields.has(k)) out[k] = v;
  }
  if (!fields.has('input')) delete out.input;
  if (Array.isArray(out.input)) {
    const allow = new Set(caps.input ?? ['text', 'image']);
    out.input = out.input.filter((m) => allow.has(m));
    if (!out.input.length) delete out.input;
  }
  if (out.reasoningEfforts && out.reasoningEfforts !== false) {
    const allow = new Set(caps.levels ?? FALLBACK_CAPS.levels);
    const next = {};
    for (const [lv, wire] of Object.entries(out.reasoningEfforts)) {
      if (allow.has(lv)) next[lv] = wire;
    }
    out.reasoningEfforts = Object.keys(next).length ? next : false;
  }
  const compat = gateCompat(out.compat, api, caps);
  if (compat) out.compat = compat;
  else delete out.compat;
  return out;
}

/** 按协议门控 + 宿主 schema 裁剪一条 route 的 providers 值。 */
export function trimProfile(profile, caps = fallbackCaps()) {
  if (!profile || typeof profile !== 'object') return profile;
  const next = { ...profile };
  if (next.api && caps.apis?.length && !caps.apis.includes(next.api)) {
    next.api = caps.apis.includes('openai-completions') ? 'openai-completions' : caps.apis[0];
  }
  const resolvedApi = next.api;
  if (Array.isArray(next.models)) {
    next.models = next.models.map((m) => trimEntry(m, resolvedApi, caps));
  }
  if (next.modelOverrides && typeof next.modelOverrides === 'object') {
    const ov = {};
    for (const [id, v] of Object.entries(next.modelOverrides)) {
      ov[id] = trimEntry({ ...v, id }, resolvedApi, caps);
      delete ov[id].id;
    }
    next.modelOverrides = ov;
  }
  const routeCompat = gateCompat(next.compat, resolvedApi, caps);
  if (routeCompat) next.compat = routeCompat;
  else delete next.compat;
  return next;
}

export function trimProviders(providers, caps = fallbackCaps()) {
  const out = {};
  for (const [route, profile] of Object.entries(providers ?? {})) {
    out[route] = trimProfile(profile, caps);
  }
  return out;
}

/** 从 settings.describe() 的一条 descriptor 抽 schema。 */
export function capsFromDescriptor(hit) {
  const schema = hit?.schema ?? hit?.value?.schema;
  if (schema?.refs) return capsFromSchema(schema);
  return fallbackCaps();
}
