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
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { LEVELS } from './levels.mjs';
import { hasVision } from './modalities.mjs';
import { findAnyVendor } from './vendors.mjs';

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
    join(dsh, 'profiles', 'web'),
    process.env.APPDATA && join(process.env.APPDATA, 'npm'),
    join(h, 'AppData', 'Roaming', 'npm'),
    '/usr/lib/node_modules',
    '/usr/local/lib/node_modules',
    join(h, '.npm-global', 'lib', 'node_modules'),
  ].filter(Boolean);
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

/** 找到内置目录数据目录；找不到返回 null。结果按进程缓存，避免每次同步都 exec npm。 */
export function findCatalogDir(extra) {
  if (extra) return look([extra, ...candidates(extra).slice(1)]);
  if (cachedDir !== undefined) return cachedDir;
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
    if (!f.endsWith('.json')) continue;
    const provider = f.slice(0, -5);
    let data;
    try { data = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
    for (const [api, models] of Object.entries(data)) {
      if (!models || typeof models !== 'object') continue;
      for (const [id, m] of Object.entries(models)) {
        if (!m || typeof m !== 'object') continue;
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
