/**
 * dsh web 插件：监视 llm-pi-ai，把思考档位和视觉能力写进 Settings → Models。
 * 不注册自己的设置页。随 dsh 漂移的调用只放在 dshApi() / resolveKey()。
 * 0.1.2：settings.describe/replace 仍是主路径；mutate 补 expectedRevision。
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { findCatalogDir, loadCatalog } from './catalog.mjs';
import { listModels, pingModels } from './discover.mjs';
import { DEFAULT_ROUTE_EFFORT } from './levels.mjs';
import { capsFromDescriptor, trimProviders } from './host.mjs';
import * as S from './settings.mjs';
import {
  TAG, NS, classifyRoute, decideBaseURL, normalizeEndpoint, planSync,
} from './sync.mjs';
import { catalogRouteNames } from './vendors.mjs';

export const name = 'model-autoconfig';
export const inject = ['settings'];

function trySchema() {
  for (const from of [join(process.cwd(), 'package.json'), import.meta.url]) {
    try {
      const mod = createRequire(from)('@deepseek-ai/schemastery');
      return mod.default ?? mod;
    } catch { /* 测试环境或解析不到 */ }
  }
  return null;
}

const Schema = trySchema();
/** Cordis 只接受 Standard Schema。普通对象当 Config 会在启动时崩。 */
export const Config = Schema?.object?.({
  autoFill: Schema.boolean().default(true)
    .description('监视 Settings → Models，自动写入思考档位和视觉能力'),
  piAiDataDir: Schema.string().default('')
    .description('pi-ai 目录数据路径；自动查找失败时再填'),
});

const DEFAULTS = { autoFill: true, piAiDataDir: '' };

function nsName(ns) {
  if (ns == null) return '';
  if (typeof ns === 'string') return ns;
  return ns.value ?? String(ns);
}

function namedLogger(ctx) {
  if (typeof ctx?.logger === 'function') return ctx.logger(name);
  return ctx?.logger ?? {};
}

function isRevisionConflict(error) {
  return /revision|conflict|stale/i.test(`${error?.code ?? ''} ${error?.name ?? ''} ${error?.message ?? ''}`);
}

function dshApi(ctx) {
  const descriptor = async (ns) => {
    if (typeof ctx.settings?.describe !== 'function') return null;
    const all = await ctx.settings.describe({ redactSecrets: true });
    return (Array.isArray(all) ? all : []).find((d) => nsName(d.ns) === ns) ?? null;
  };
  const replaceChanged = async (ns, changed) => {
    const hit = await descriptor(ns);
    if (!hit) return false;
    const user = hit.user && typeof hit.user === 'object' ? hit.user : {};
    const providers = { ...(user.providers ?? {}), ...changed };
    await ctx.settings.replace(ns, { ...user, providers }, hit.revision);
    return true;
  };
  return {
    hasSettings: !!ctx?.settings,
    async read(ns) {
      const hit = await descriptor(ns);
      if (hit) return hit.value ?? null;
      if (typeof ctx.settings?.get === 'function') return ctx.settings.get(ns);
      return null;
    },
    async describe(ns) {
      return descriptor(ns);
    },
    async writeProviders(ns, allProviders, changed) {
      if (typeof ctx.settings?.replace === 'function' && typeof ctx.settings?.describe === 'function') {
        try {
          if (await replaceChanged(ns, changed)) return;
        } catch (error) {
          if (!isRevisionConflict(error)) throw error;
          if (await replaceChanged(ns, changed)) return;
          throw error;
        }
      }
      const routes = Object.keys(changed);
      if (typeof ctx.settings?.mutate === 'function') {
        const ops = routes.map((route) => ({
          op: 'set', path: ['providers', route], value: changed[route],
        }));
        const hit = await descriptor(ns);
        // 0.1.2+ mutate 带 expectedRevision；旧宿主忽略第三参或只收两参。
        if (hit?.revision != null) {
          try {
            await ctx.settings.mutate(ns, ops, hit.revision);
            return;
          } catch (error) {
            if (isRevisionConflict(error)) {
              const retry = await descriptor(ns);
              if (retry?.revision != null) {
                await ctx.settings.mutate(ns, ops, retry.revision);
                return;
              }
            }
            try {
              await ctx.settings.mutate(ns, ops);
              return;
            } catch {
              throw error;
            }
          }
        }
        await ctx.settings.mutate(ns, ops);
        return;
      }
      if (typeof ctx.settings?.update === 'function') {
        await ctx.settings.update(ns, { providers: allProviders });
        return;
      }
      throw new Error('当前 dsh 版本未暴露 settings 写接口');
    },
  };
}

function guessKeyEnv(route, profile) {
  if (profile?.apiKeyEnv) return profile.apiKeyEnv;
  return `${String(route).toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
}

async function resolveKey(ctx, apiKeyEnv) {
  if (!apiKeyEnv) return undefined;
  let credentials = ctx.credentials;
  if (!credentials && typeof ctx.get === 'function') {
    try { credentials = ctx.get('credentials'); } catch { /* 服务未注册 */ }
  }
  if (credentials?.resolve) {
    try {
      let ref = apiKeyEnv;
      try {
        const cred = await import('@deepseek-ai/dsh-credentials');
        if (typeof cred.credentialRef === 'function') ref = cred.credentialRef(apiKeyEnv);
      } catch { /* 无此包则直接用名字 */ }
      const hit = await credentials.resolve(ref);
      if (hit?.value) return hit.value;
    } catch { /* 落到环境变量 */ }
  }
  return process.env[apiKeyEnv];
}

function loadCatalogEntries(piAiDataDir) {
  const dir = findCatalogDir(piAiDataDir || undefined);
  if (!dir) return { entries: null };
  try { return { entries: loadCatalog(dir) }; }
  catch { return { entries: null }; }
}

async function probeGateway(ctx, route, profile, log, signal) {
  const raw = String(profile.baseURL ?? '').trim();
  const existing = Array.isArray(profile.models) ? profile.models.filter((m) => m?.id) : [];
  const trimmed = raw ? normalizeEndpoint(raw) : '';
  const stripped = trimmed && trimmed !== raw.replace(/\/+$/, '');

  // 主干：Settings 里已经有模型 id（原生页拉过或手加）——只配档位，不联网。
  if (existing.length) {
    if (stripped) log('info', `${route}: 规范化地址 ${raw} → ${trimmed}`);
    return { fetchOk: false, ids: [], declared: {}, baseURL: stripped ? trimmed : raw };
  }

  if (!raw) return { fetchOk: false, ids: [], declared: {}, baseURL: raw };
  const keyEnv = guessKeyEnv(route, profile);
  const key = await resolveKey(ctx, keyEnv);
  let baseURL = trimmed;
  if (stripped) log('info', `${route}: 规范化地址 ${raw} → ${trimmed}`);
  if (!/\/v1$/i.test(trimmed)) {
    const [rootSt, v1St] = await Promise.all([
      pingModels(trimmed, key, undefined, signal),
      pingModels(`${trimmed}/v1`, key, undefined, signal),
    ]);
    const d = decideBaseURL(trimmed, rootSt, v1St);
    if (d.changed) log('info', `${route}: 补 /v1（根路径 ${rootSt || '失败'}，/v1 ${v1St || '失败'}）`);
    baseURL = d.baseURL;
  }
  if (!key) {
    log('warn', `${route}: 列表还是空的，且没有可用密钥（${keyEnv}）。在 Settings → Models 保存密钥或手动添加模型`);
    return { fetchOk: false, ids: [], declared: {}, baseURL };
  }
  try {
    const rows = await listModels(baseURL, key, signal);
    return {
      fetchOk: true,
      ids: rows.map((r) => r.id),
      declared: Object.fromEntries(rows.map((r) => [r.id, r.declared])),
      baseURL,
    };
  } catch (e) {
    if (signal?.aborted) throw e;
    log('error', `${route}: GET ${baseURL}/models 失败（${e.message}）。可在 Settings 里手动添加模型，档位仍会自动配`);
    return { fetchOk: false, ids: [], declared: {}, baseURL };
  }
}

function stopped(runtime) {
  return runtime?.signal?.aborted || runtime?.isDisposed?.();
}

export async function syncOnce(ctx, config, reason, api = dshApi(ctx), runtime = {}) {
  const logger = runtime.logger ?? namedLogger(ctx);
  const log = (level, msg) => {
    if (level === 'debug') return;
    logger?.[level]?.(`${TAG} ${msg}`);
  };
  const ns = NS;
  const section = await api.read(ns);
  if (stopped(runtime)) return { changed: false, aborted: true };
  const providers = section?.providers;
  const caps = capsFromDescriptor(typeof api.describe === 'function' ? await api.describe(ns) : null);
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) {
    if (reason === 'ready') log('info', '还没有自定义模型配置。在 Settings → Models 保存 URL 和密钥后会自动配档位');
    return { changed: false };
  }

  const catalogNames = catalogRouteNames();
  const kinds = Object.fromEntries(
    Object.entries(providers).map(([r, p]) => [r, classifyRoute(r, p, catalogNames)]),
  );
  const needCatalog = Object.values(kinds).includes('catalog');
  const { entries } = needCatalog
    ? loadCatalogEntries(config.piAiDataDir)
    : { entries: [] };
  if (needCatalog && !entries) log('warn', '找不到 pi-ai 内置目录，官方路由本轮跳过');

  const gatewayRoutes = Object.keys(providers).filter((r) => kinds[r] === 'gateway');
  const probed = await Promise.all(
    gatewayRoutes.map((route) => probeGateway(ctx, route, providers[route], log, runtime.signal)),
  );
  if (stopped(runtime)) return { changed: false, aborted: true };
  const gateways = Object.fromEntries(gatewayRoutes.map((r, i) => [r, probed[i]]));

  const state = S.loadState();
  const planned = planSync({
    providers,
    state,
    catalogNames,
    catalogEntries: entries,
    gateways,
    defaultEffort: DEFAULT_ROUTE_EFFORT,
  });

  const trimmed = trimProviders(planned.providers, caps);
  const written = {};
  for (const route of Object.keys(providers)) {
    if (!jsonEqSafe(trimmed[route], providers[route])) written[route] = trimmed[route];
  }
  const willWrite = Object.keys(written).length > 0;

  for (const line of planned.logs) {
    if (line.level === 'debug') continue;
    if (line.level === 'info' && !willWrite) continue;
    log(line.level === 'warn' ? 'warn' : line.level === 'error' ? 'error' : 'info', line.msg);
  }

  if (!willWrite) {
    if (planned.stateChanged && !stopped(runtime)) S.saveState(planned.state);
    return stopped(runtime) ? { changed: false, aborted: true } : { changed: false };
  }

  if (stopped(runtime)) return { changed: false, aborted: true };
  await api.writeProviders(ns, trimmed, written);
  if (stopped(runtime)) return { changed: true, aborted: true };
  S.saveState(planned.state);
  log('info', `已写入 ${Object.keys(written).join(', ')}（${reason}）`);
  return { changed: true, routes: Object.keys(written), snapshot: trimmed };
}

function jsonEqSafe(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function apply(ctx, config = {}) {
  const cfg = {
    ...DEFAULTS,
    ...config,
    autoFill: config.autoFill ?? config.autoFixMissingOff ?? DEFAULTS.autoFill,
  };
  const logger = namedLogger(ctx);
  if (!ctx?.settings) {
    logger.warn?.(`${TAG} 当前上下文没有 settings 服务，插件空转`);
    return;
  }
  if (!cfg.autoFill) {
    logger.info?.(`${TAG} autoFill=false，只加载不写`);
    return;
  }

  const api = dshApi(ctx);
  let serviceCtx = ctx;
  let busy = false;
  let pending = null;
  let timer;
  let lastWritten = null;
  let disposed = false;
  let activeController = null;

  if (typeof ctx.inject === 'function') {
    ctx.inject(['credentials'], (nextCtx) => {
      if (!disposed) serviceCtx = nextCtx;
    });
  }

  const kick = async (reason) => {
    if (disposed) return;
    if (busy) { pending = reason; return; }
    busy = true;
    try {
      do {
        const why = pending ?? reason;
        pending = null;
        activeController = new AbortController();
        const result = await syncOnce(serviceCtx, cfg, why, api, {
          logger,
          signal: activeController.signal,
          isDisposed: () => disposed,
        });
        if (result?.changed && result.snapshot) lastWritten = JSON.stringify(result.snapshot);
      } while (pending && !disposed);
    } catch (e) {
      if (!disposed && !activeController?.signal.aborted) {
        logger.error?.(`${TAG} ${e.stack ?? e.message ?? e}`);
      }
    } finally {
      activeController = null;
      busy = false;
    }
  };

  const run = (reason, immediate = false) => {
    if (disposed) return;
    clearTimeout(timer);
    if (immediate) queueMicrotask(() => {
      if (!disposed) kick(reason);
    });
    else timer = setTimeout(() => kick(reason), 250);
  };

  ctx.on?.('ready', () => run('ready', true));
  ctx.on?.('settings/updated', (ns, next) => {
    if (nsName(ns) !== NS) return;
    if (lastWritten && next?.providers && JSON.stringify(next.providers) === lastWritten) return;
    run('settings/updated');
  });
  ctx.on?.('llm/adapters-updated', () => run('adapters-updated'));
  ctx.on?.('dispose', () => {
    disposed = true;
    pending = null;
    clearTimeout(timer);
    activeController?.abort();
  });
  run('apply', true);
  logger.info?.(`${TAG} 已加载。在 Settings → Models 保存 URL/密钥后自动配档位和视觉能力`);
}

export { catalogRouteNames, classifyRoute };

const plugin = Config
  ? { name, inject, Config, apply }
  : { name, inject, apply };
export default plugin;
