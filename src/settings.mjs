/**
 * settings.yaml 的定位、读取、合并与写回。
 *
 * 兼容三种可能的落点（不同 dsh 版本形状不同，逐一尝试）：
 *   A) 命名空间映射：  llm-pi-ai: { providers: {...} }
 *   B) 带点的扁平键：  "llm-pi-ai.providers": {...}
 *   C) cordis 插件数组：- name: '@deepseek-ai/dsh-llm-pi-ai' \n config: { providers: {...} }
 *
 * YAML 陷阱：`off` 在 YAML 1.1 里是布尔字面量。为避免被解析成 false，
 * 所有档位键一律强制双引号输出。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import YAML from 'yaml';

const NS = 'llm-pi-ai';
const PKG = '@deepseek-ai/dsh-llm-pi-ai';
const STATE = '.dsh-model-autoconfig.json';

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}
export function settingsPath(home = dshHome()) {
  return join(home, 'settings.yaml');
}

/** 直接从 YAML 字符串建文档（测试与 --dump 用）。 */
export function loadDoc0(text) {
  const doc = YAML.parseDocument(text, { keepSourceTokens: true });
  if (doc.contents && 'flow' in doc.contents) doc.contents.flow = false;
  return doc;
}

export function loadDoc(file) {
  const doc = existsSync(file)
    ? YAML.parseDocument(readFileSync(file, 'utf8'), { keepSourceTokens: true })
    : YAML.parseDocument('');            // 空文档 → setIn 自动建块状映射
  if (doc.contents && 'flow' in doc.contents) doc.contents.flow = false;
  return doc;
}

/** 'a.b.0.c' → ['a','b',0,'c']，供 --at 手工指定 providers 落点。 */
export function parsePath(str) {
  return String(str).split('.').filter(Boolean).map((s) => (/^\d+$/.test(s) ? Number(s) : s));
}

/** 定位 providers 节点的路径；没有就按形状 A 建一个。 */
export function providersPath(doc, { create = true, at = null } = {}) {
  if (at) return parsePath(at);
  if (doc.hasIn([NS, 'providers']) || doc.hasIn([NS])) return [NS, 'providers'];
  const flat = `${NS}.providers`;
  if (doc.has(flat)) return [flat];
  const root = doc.contents;
  if (YAML.isSeq(root)) {
    for (let i = 0; i < root.items.length; i++) {
      const nm = doc.getIn([i, 'name']);
      if (nm === PKG || nm === 'llm' || String(nm).endsWith('dsh-llm-pi-ai')) return [i, 'config', 'providers'];
    }
  }
  if (!create) return null;
  return [NS, 'providers'];
}

export function getProviders(doc, at = null) {
  const p = providersPath(doc, { create: false, at });
  if (!p) return {};
  return doc.getIn(p, true)?.toJSON?.() ?? doc.getIn(p) ?? {};
}

/** 档位映射 → 强制双引号键的 YAML 节点。 */
function effortsNode(doc, efforts) {
  if (efforts === false) return false;
  const map = doc.createNode({});
  for (const [k, v] of Object.entries(efforts)) {
    const key = doc.createNode(k); key.type = 'QUOTE_DOUBLE';
    const val = doc.createNode(v == null ? null : v);
    if (v == null) val.value = null;
    map.items.push(new YAML.Pair(key, val));
  }
  return map;
}

/** 把一个模型条目写进 doc（entry 含 id）。 */
function writeModelFields(doc, base, entry) {
  for (const [k, v] of Object.entries(entry)) {
    if (k === 'id') continue;
    if (k === 'reasoningEfforts') {
      doc.setIn([...base, k], effortsNode(doc, v));
    } else {
      doc.setIn([...base, k], doc.createNode(v));
    }
  }
}

/** 设置 provider 的 route 纯字段。undefined = 不碰，null = 删除该键。 */
export function setRoute(doc, provider, fields, at = null) {
  const pp = providersPath(doc, { at });
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (v === null) { doc.deleteIn?.([...pp, provider, k]); continue; }
    doc.setIn([...pp, provider, k], doc.createNode(v));
  }
}

/** 写 models 列表（自定义网关必须用这个）。 */
export function setModels(doc, provider, entries, at = null) {
  const pp = providersPath(doc, { at });
  doc.setIn([...pp, provider, 'models'], doc.createNode([]));
  entries.forEach((entry, i) => {
    const base = [...pp, provider, 'models', i];
    doc.setIn([...base, 'id'], doc.createNode(entry.id));
    writeModelFields(doc, base, entry);
  });
}

/** 写 modelOverrides（只对「内置目录 route + 无 models 列表」合法）。 */
export function setOverrides(doc, provider, overridesById, at = null) {
  const pp = providersPath(doc, { at });
  if (doc.hasIn([...pp, provider, 'models'])) {
    throw new Error(`provider "${provider}" 已有 models 列表；dsh 会拒绝并存的 modelOverrides（settings-rejected）`);
  }
  for (const [id, ov] of Object.entries(overridesById)) {
    writeModelFields(doc, [...pp, provider, 'modelOverrides', id], { id, ...ov });
  }
}

export function backup(file, keep = 10) {
  if (!existsSync(file)) return null;
  const dir = join(dirname(file), 'backups');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = join(dir, `settings-${stamp}.yaml`);
  copyFileSync(file, dest);
  const olds = readdirSync(dir).filter((f) => f.startsWith('settings-')).sort();
  while (olds.length > keep) { try { unlinkSync(join(dir, olds.shift())); } catch { /* ignore */ } }
  return dest;
}

/** 递归关闭 flow 样式，保证输出是可读的块状 YAML。 */
function blockify(node) {
  if (!node || typeof node !== 'object') return;
  if ('flow' in node) node.flow = false;
  if (Array.isArray(node.items)) for (const it of node.items) {
    if (it && it.key !== undefined) { blockify(it.value); } else blockify(it);
  }
}

export function render(doc) {
  blockify(doc.contents);
  // nullStr:'' → `"off":` 而不是 `"off": null`，与 dsh 文档的「留空」写法一致
  return doc.toString({ nullStr: '', lineWidth: 0, singleQuote: false });
}

export function save(file, doc) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, render(doc), 'utf8');
}

/* ── 三方合并用的状态存档 ───────────────────────────────── */

/**
 * .dsh-model-autoconfig.json 的形状：
 *   { version, managed: { <route>: { models?, sync?, at } } }
 *
 * 两个用途共用一个 route 槽位，但各写各的键，互不覆盖：
 *   models —— CLI 三方合并的基线快照：{ <modelId>: 上次写入的完整条目 }
 *   sync   —— 插件的同步状态：{ kind, modelIds, deletedIds, at }
 *
 * 早期版本两者都直接写 managed[route] 本身，谁后写谁冲掉对方。后果是
 * CLI 读不到基线 → threeWay 的 base 为 undefined → 直接用计算值覆盖
 * 用户手改过的字段，而 README 承诺的是「永远不被覆盖」。分成两个键后不再冲突。
 *
 * 旧文件读不到对应键时按空处理，两种数据都会在下一轮自动重建。
 */
export const STATE_VERSION = 2;

export function statePath(home = dshHome()) { return join(home, STATE); }
export function loadState(home = dshHome()) {
  const empty = { version: STATE_VERSION, managed: {} };
  const p = statePath(home);
  if (!existsSync(p)) return empty;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return empty; }
}
export function saveState(state, home = dshHome()) {
  mkdirSync(home, { recursive: true });
  writeFileSync(statePath(home), JSON.stringify(state, null, 2), 'utf8');
}

/**
 * 三方合并的基线：上次本工具为该 route 写入的条目。
 * base 缺失时 threeWay 会退化为「一律用计算值」，用户手改就不再被保护。
 */
export function mergeBase(state, route) {
  return state?.managed?.[route]?.models ?? {};
}

/** 写入基线快照，保留同 route 下的其它用途数据（插件的 sync slice）。 */
export function withMergeBase(state, route, entriesById) {
  const managed = { ...(state?.managed ?? {}) };
  managed[route] = {
    ...(managed[route] ?? {}),
    models: entriesById,
    at: new Date().toISOString(),
  };
  return { ...(state ?? {}), version: STATE_VERSION, managed };
}

/**
 * 三方合并：base=上次本工具写入值，current=文件现值，next=本次计算值。
 * current !== base 说明用户手改过 —— 保留用户的，把 next 放进 suggestions。
 */
export function threeWay(base, current, next) {
  const merged = {}, suggestions = {};
  const keys = new Set([...Object.keys(current ?? {}), ...Object.keys(next ?? {})]);
  for (const k of keys) {
    const b = base?.[k], c = current?.[k], n = next?.[k];
    const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
    if (c === undefined) { merged[k] = n; continue; }
    if (n === undefined) { merged[k] = c; continue; }
    if (eq(c, b) || b === undefined) merged[k] = n;
    else if (eq(c, n)) merged[k] = c;
    else { merged[k] = c; suggestions[k] = n; }
  }
  return { merged, suggestions };
}

/* ── 诊断：settings.yaml 到底长什么样 ─────────────────────── */

/** 所有可能的 dsh 配置落点（Windows / Linux / macOS 通吃）。 */
export function candidateHomes() {
  const h = homedir();
  const c = [
    process.env.DSH_HOME,
    join(h, '.dsh'),
    join(h, '.config', 'dsh'),
    process.env.APPDATA && join(process.env.APPDATA, 'dsh'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'dsh'),
    join(h, 'AppData', 'Roaming', 'dsh'),
    join(h, 'AppData', 'Local', 'dsh'),
    process.cwd(),
  ].filter(Boolean);
  return [...new Set(c)];
}

/** 每个落点是否存在 settings.yaml / settings.yml。 */
export function candidateFiles() {
  const out = [];
  for (const home of candidateHomes()) {
    for (const name of ['settings.yaml', 'settings.yml']) {
      const f = join(home, name);
      out.push({ home, file: f, exists: existsSync(f) });
    }
  }
  return out;
}

/**
 * CLI 各命令的默认 settings 文件。优先级：
 *   1. DSH_HOME 显式设置 → 无条件用它（哪怕该目录下还没有 settings.yaml，
 *      新建也建在那里 —— 显式覆盖不存在「落到别处」的选项，否则 add --apply
 *      会静默写到一个用户根本没指定的文件里）
 *   2. 否则取「已经存在」的那个（顺序同 candidateHomes：~/.dsh → ~/.config/dsh
 *      → AppData……，与 dsh-mac scan 第 1 节一致）—— dsh 实际用 ~/.config/dsh
 *      时，写 $DSH_HOME 会写到 dsh 不读的文件
 *   3. 都不存在 → ~/.dsh/settings.yaml（新建场景）
 */
export function defaultSettingsFile() {
  if (process.env.DSH_HOME) return settingsPath();
  const found = candidateFiles().filter((c) => c.exists);
  if (!found.length) return settingsPath();
  const canon = found.find((c) => c.file === settingsPath());
  return (canon ?? found[0]).file;
}

const PROVIDERISH = ['baseURL', 'baseUrl', 'apiKey', 'apiKeyEnv', 'models', 'modelOverrides', 'api'];

/**
 * 全树深搜「看起来像 provider 容器」的节点。
 * 判据：某个 map 的直接子节点里，有 map 带 baseURL / models / apiKeyEnv 之类的字段。
 * 用来发现本工具三种已知形状之外的落点。
 */
export function deepFindProviders(doc) {
  const root = doc.toJSON?.() ?? {};
  const hits = [];
  const seen = new Set();
  const walk = (node, path) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, [...path, i]));
      return;
    }
    const entries = Object.entries(node);
    // 自己就是一个 provider 条目？
    const selfHit = PROVIDERISH.filter((k) => k in node);
    if (selfHit.length >= 2 && path.length) {
      hits.push({ path: path.join('.'), kind: 'provider', fields: selfHit,
        parent: path.slice(0, -1).join('.') || '(root)' });
    }
    for (const [k, v] of entries) walk(v, [...path, k]);
  };
  walk(root, []);
  // 归并：同一个父节点下的多个 provider 条目算一处容器
  const byParent = {};
  for (const h of hits) (byParent[h.parent] ??= []).push(h);
  return Object.entries(byParent).map(([parent, list]) => ({
    parent, count: list.length, routes: list.map((x) => x.path.split('.').pop()),
    fields: [...new Set(list.flatMap((x) => x.fields))],
  }));
}

/** 已知的三种形状里，哪一种命中了。 */
export function detectShape(doc) {
  if (doc.hasIn([NS, 'providers'])) return { shape: 'A', path: `${NS}.providers` };
  if (doc.hasIn([NS]))              return { shape: 'A-partial', path: NS };
  if (doc.has(`${NS}.providers`))   return { shape: 'B', path: `"${NS}.providers"` };
  const root = doc.contents;
  if (YAML.isSeq(root)) {
    for (let i = 0; i < root.items.length; i++) {
      const nm = doc.getIn([i, 'name']);
      if (nm === PKG || String(nm).endsWith('dsh-llm-pi-ai')) return { shape: 'C', path: `[${i}].config.providers` };
    }
  }
  return null;
}
