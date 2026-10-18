/**
 * 读取 pi-ai 随包附带的内置模型目录，并审计思考档位。
 *
 * 目录位置：<pi-ai>/dist/providers/data/<provider>.json
 * 形状：{ [api]: { [modelId]: { id,name,api,baseUrl,provider,reasoning,input,
 *                              contextWindow,maxTokens,compat,thinkingLevelMap } } }
 *
 * 关键事实（dsh Discussion #1580）：目录里大量模型的 thinkingLevelMap **没有 off 键**。
 * 上游判断写的是 `if (model.thinkingLevelMap?.off !== null)`，
 * 而 `undefined !== null` 恒真 —— 于是思考被无条件关闭，输出被静默截断。
 * 显式写入 `off: null` 即可绕过。
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { LEVELS } from './levels.mjs';
import { hasVision } from './modalities.mjs';
import { findAnyVendor } from '../truth/vendors.mjs';

const REL = join('dist', 'providers', 'data');
let cachedDir;

function pushPiAi(out, root) {
  if (!root) return;
  out.push(join(root, 'node_modules', '@earendil-works', 'pi-ai', REL));
  out.push(join(root, '@earendil-works', 'pi-ai', REL));
  out.push(join(root, 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai',
                 'node_modules', '@earendil-works', 'pi-ai', REL));
}

function fastRoots() {
  const h = homedir();
  const dsh = process.env.DSH_HOME || join(h, '.dsh');
  return [
    process.cwd(),
    dsh,
    join(dsh, 'profiles'),
    join(dsh, 'profiles', 'web'),
    ...electronRoots(),
    process.env.APPDATA && join(process.env.APPDATA, 'npm'),
    join(h, 'AppData', 'Roaming', 'npm'),
    '/usr/lib/node_modules',
    '/usr/local/lib/node_modules',
    join(h, '.npm-global', 'lib', 'node_modules'),
  ].filter(Boolean);
}

/**
 * 0.2.x 桌面版把 dsh 运行时和 pi-ai 一起打进 app.asar。
 * 插件跑在 Electron 主进程里，Electron 给 fs 打了 asar 补丁，
 * 所以这些路径可以像普通目录一样 readdir/readFile（纯 Node 下会自然跳过）。
 */
function electronRoots() {
  const roots = [];
  const resources = process.resourcesPath;
  if (typeof resources === 'string' && resources) {
    roots.push(join(resources, 'app.asar', 'dsh'));
    roots.push(join(resources, 'app.asar.unpacked', 'dsh'));
  }
  const exeDir = process.execPath ? dirname(process.execPath) : '';
  if (exeDir) roots.push(join(exeDir, 'resources', 'app.asar', 'dsh'));
  return roots;
}

function candidates(extra) {
  const out = [];
  if (extra) out.push(extra);
  for (const r of fastRoots()) pushPiAi(out, r);
  return out;
}

function look(paths) {
  for (const p of paths) {
    try { if (existsSync(p) && statSync(p).isDirectory()) return p; } catch { /* ignore */ }
  }
  return null;
}

/** ESM 入口 dist/index.js → dist/providers/data；package.json → 同相对路径。 */
function dirFromResolved(resolved) {
  if (!resolved) return null;
  const path = String(resolved).startsWith('file:')
    ? fileURLToPath(resolved)
    : String(resolved);
  if (path.endsWith(`${sep}package.json`)) return join(dirname(path), REL);
  return join(dirname(path), 'providers', 'data');
}

function dirFromResolveError(error) {
  const msg = String(error?.message ?? '');
  const m = msg.match(/([A-Za-z]:)?[/\\][^\s'"]*@earendil-works[/\\]pi-ai[/\\]package\.json/);
  return m ? dirFromResolved(m[0]) : null;
}

/** CJS resolve：exports 只有 import 条件时会抛 ERR_PACKAGE_PATH_NOT_EXPORTED，路径仍在报错里。 */
function requirePiAiDir(parent) {
  try {
    const req = createRequire(parent);
    try {
      return look([dirFromResolved(req.resolve('@earendil-works/pi-ai'))]);
    } catch (error) {
      const fromErr = look([dirFromResolveError(error)]);
      if (fromErr) return fromErr;
      try {
        return requirePiAiDir(req.resolve('@deepseek-ai/dsh-llm-pi-ai'));
      } catch {
        return null;
      }
    }
  } catch {
    return null;
  }
}

/**
 * 真实 dsh 安装里 pi-ai 常被 pnpm 提升到 profiles/ 层（不是 profiles/web/）。
 * 插件以 file: 链到工作区时 import.meta.url 不在 profile 模块图里，
 * import.meta.resolve 会找不到包 —— 再按宿主 profile 的 package.json createRequire。
 */
function resolveInstalledDir() {
  try {
    const href = import.meta.resolve('@earendil-works/pi-ai');
    const dir = look([dirFromResolved(href)]);
    if (dir) return dir;
  } catch (error) {
    const dir = look([dirFromResolveError(error)]);
    if (dir) return dir;
  }

  const homes = new Set([
    process.env.DSH_HOME,
    join(homedir(), '.dsh'),
  ].filter(Boolean));
  const parents = [];
  for (const dsh of homes) {
    parents.push(
      join(dsh, 'profiles', 'web', 'package.json'),
      join(dsh, 'profiles', 'web', 'dummy.js'),
      join(dsh, 'package.json'),
    );
  }
  // Electron 桌面版：从 app.asar 里的 dsh 运行时解析 pi-ai。
  for (const root of electronRoots()) parents.push(join(root, 'package.json'));
  parents.push(join(process.cwd(), 'package.json'));
  for (const parent of parents) {
    const dir = requirePiAiDir(parent);
    if (dir) return dir;
  }
  return null;
}

/** 找到内置目录数据目录；找不到返回 null。结果按进程缓存，避免每次同步都 exec npm。 */
export function findCatalogDir(extra) {
  if (extra) return look([extra, ...candidates(extra).slice(1)]);
  if (cachedDir !== undefined) return cachedDir;
  const resolved = resolveInstalledDir();
  if (resolved) { cachedDir = resolved; return resolved; }
  const hit = look(candidates());
  if (hit) { cachedDir = hit; return hit; }
  try {
    const g = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 1500 }).trim();
    const fromNpm = g ? look([
      join(g, '@earendil-works', 'pi-ai', REL),
      join(g, '@deepseek-ai', 'dsh-llm-pi-ai', 'node_modules', '@earendil-works', 'pi-ai', REL),
    ]) : null;
    cachedDir = fromNpm;
    return fromNpm;
  } catch {
    cachedDir = null;
    return null;
  }
}

/** 载入全部内置目录，返回扁平模型数组。
 *
 *  0.2.x（pi-ai 1.3+）把目录键改成带类别前缀的 `chat:<id>` /
 *  `classifier:<id>`，真实模型 id 在 `m.id`。插件只关心可对话的 chat 条目：
 *  旧版目录键就是裸 id，没有前缀。
 *
 *  结果按目录路径缓存 45s（进程内）：插件每个事件都会跑一轮同步，
 *  每轮都 readdir + readFileSync + JSON.parse 会阻塞 dsh web 进程的事件循环。
 *  ttlMs=0 跳过缓存（CLI 一次性进程与测试用）。 */
const CATALOG_TTL_MS = 45_000;
let catalogCache = null; // { dir, at, entries }

export function loadCatalog(dir, ttlMs = CATALOG_TTL_MS) {
  if (catalogCache && catalogCache.dir === dir
      && ttlMs > 0 && Date.now() - catalogCache.at < ttlMs) {
    return catalogCache.entries;
  }
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json') || f.startsWith('.')) continue;
    const provider = f.slice(0, -5);
    let data;
    try { data = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
    for (const [api, models] of Object.entries(data)) {
      if (!models || typeof models !== 'object') continue;
      for (const [key, m] of Object.entries(models)) {
        if (!m || typeof m !== 'object') continue;
        const kind = /^([a-z-]+):/.exec(key)?.[1];
        if (kind && kind !== 'chat') continue; // 分类器 / embedding 不是可对话模型
        const id = typeof m.id === 'string' && m.id ? m.id : key.replace(/^[a-z-]+:/, '');
        out.push({ provider, api, id, model: m });
      }
    }
  }
  catalogCache = { dir, at: Date.now(), entries: out };
  return out;
}

/** 审计一批目录模型的思考档位和视觉能力。 */
export function audit(entries) {
  const missingOff = [], noLevels = [], nullLevels = [], missingVision = [];
  for (const e of entries) {
    const lm = e.model.thinkingLevelMap;
    if (e.model.reasoning && !lm) noLevels.push(e);
    else if (lm) {
      if (!('off' in lm)) missingOff.push(e);
      const nulls = LEVELS.filter((l) => l !== 'off' && l in lm && lm[l] == null);
      if (nulls.length) nullLevels.push({ ...e, nulls });
    }
    const hit = findAnyVendor(e.id);
    if (hit && hasVision(hit.spec.input) && !hasVision(e.model?.input)) missingVision.push(e);
  }
  return { total: entries.length, withLevels: entries.filter((e) => e.model.thinkingLevelMap).length,
           missingOff, noLevels, nullLevels, missingVision };
}

/** 目录里某 provider 的模型 id 集合 —— 用于判断 modelOverrides 是否合法。 */
export function catalogModelIds(entries, provider) {
  return new Set(entries.filter((e) => e.provider === provider).map((e) => e.id));
}

export function catalogProviders(entries) {
  return [...new Set(entries.map((e) => e.provider))].sort();
}
