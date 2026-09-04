/**
 * 请求模态（视觉等能力）—— 与思考档位同级的补全对象。
 *
 * dsh 0.1.1-rc.2 的 PiAiModality 只有 text / image。没有「是不是视觉模型」
 * 的布尔开关：input 含 image 即视觉。audio 等网关自报值一律丢掉（schema 不认）。
 *
 * 补全策略是只增不减：真值库、/models 自报、已有配置三者取并集。
 * 少报会在挂图前被拒（UNSUPPORTED_CONTENT）；多报才会在请求中途被端点打回。
 */
export const MODALITIES = ['text', 'image'];

const ALIASES = {
  text: 'text', txt: 'text',
  image: 'image', images: 'image', vision: 'image',
  photo: 'image', picture: 'image',
};

function canonical(value) {
  return ALIASES[String(value ?? '').trim().toLowerCase()] ?? null;
}

/**
 * 压成 dsh 认识的模态数组；空 / 非数组 / 全是未知值 → null（表示「没有声明」）。
 * 顺序固定为 text, image，便于 jsonEq 和 YAML 稳定。
 */
export function normalizeInput(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const set = new Set();
  for (const item of list) {
    const hit = canonical(item);
    if (hit) set.add(hit);
  }
  if (set.size === 0) return null;
  // text 是地板（dsh DEFAULT_INPUT）：只报了 image 的声明按 [text, image] 补。
  if (set.has('image')) set.add('text');
  return MODALITIES.filter((m) => set.has(m));
}

/** 若干声明取并集。全都没有声明 → null。 */
export function unionInput(...lists) {
  const set = new Set();
  for (const list of lists) {
    const n = normalizeInput(list);
    if (n) for (const m of n) set.add(m);
  }
  if (set.size === 0) return null;
  return MODALITIES.filter((m) => set.has(m));
}

/**
 * 已有声明是否覆盖想要的模态。
 * 目录缺省 input 时 dsh 当成 [text]（DEFAULT_INPUT），所以 catalogInput 缺失
 * 按 [text] 算，避免给每个纯文本模型都写一条冗余 override。
 */
export function coversInput(have, wanted) {
  const need = normalizeInput(wanted);
  if (!need) return true;
  const got = normalizeInput(have) ?? ['text'];
  return need.every((m) => got.includes(m));
}

export function hasVision(list) {
  return normalizeInput(list)?.includes('image') === true;
}

/** 网关 /models 行上可能出现的模态声明。 */
export function parseDeclaredInput(row) {
  if (!row || typeof row !== 'object') return null;
  const bags = [
    row.architecture?.input_modalities,
    row.input_modalities,
    row.modalities?.input,
    Array.isArray(row.input) ? row.input : null,
  ];
  const fromList = unionInput(...bags);
  if (fromList) return fromList;

  const tokens = [];
  const strings = [
    typeof row.architecture?.input_modalities === 'string' ? row.architecture.input_modalities : null,
    row.architecture?.modality,
    row.architecture?.input_modality,
    typeof row.modalities === 'string' ? row.modalities : null,
  ];
  for (const s of strings) {
    if (!s) continue;
    const lower = String(s).toLowerCase();
    if (/multi|vision|image/.test(lower)) tokens.push('text', 'image');
    else if (/text/.test(lower)) tokens.push('text');
  }
  if (row.architecture?.vision === true || row.supports_vision === true || row.capabilities?.vision === true) {
    tokens.push('text', 'image');
  }
  return unionInput(tokens);
}

/**
 * 真值库不认识的 id：用端点自报，再用名字里的 vl / vision / omni / 5v 推断。
 * 宁可不写，也不要把 gpt-4o 这种靠名字猜不出来的模型标错。
 */
const VISION_TOKEN = /(?:^|[-_/.])(?:vl|vlm|omni|vision|visual|multimodal)(?:[-_/.]|$)/i;
const VISION_DIGIT_V = /(?:^|[-_])(?:\d+(?:\.\d+)*)v(?:[-_.]|$)/i;

export function inferInputFromId(modelId) {
  const id = String(modelId ?? '');
  if (VISION_TOKEN.test(id) || VISION_DIGIT_V.test(id) || /vision/i.test(id)) {
    return ['text', 'image'];
  }
  return null;
}

/** 端点自报 ∪ 名字启发式。已有纯文本声明不会挡住 vl/vision 这种名字。 */
export function inferInput(modelId, declared) {
  return unionInput(declared, inferInputFromId(modelId));
}
