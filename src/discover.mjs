/** 模型发现与协议探测。全部可失败——失败就走手动添加，不阻塞主流程。 */
import { parseDeclaredInput } from './modalities.mjs';

const UA = { 'user-agent': 'dsh-model-autoconfig/0.6' };

async function req(url, key, init = {}) {
  const headers = { ...UA, ...(init.headers ?? {}) };
  if (key) headers.authorization = `Bearer ${key}`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), init.timeoutMs ?? 12000);
  try { return await fetch(url, { ...init, headers, signal: ctl.signal }); }
  finally { clearTimeout(t); }
}

/** GET {base}/models 的 HTTP 状态；网络失败返回 0。用来判断要不要补 /v1。
 *  结果按 URL 缓存 45s：插件每个事件都跑同步，不缓存会对每个网关路由
 *  反复打两个未认证探测请求（根路径 + /v1）。ttlMs=0 跳过缓存（测试用）。 */
const PING_TTL_MS = 45_000;
const pingCache = new Map();

export async function pingModels(baseURL, key, ttlMs = PING_TTL_MS) {
  const url = `${String(baseURL).replace(/\/+$/, '')}/models`;
  const ck = `${url}\0${key ? '1' : '0'}`;
  const cached = pingCache.get(ck);
  if (cached && ttlMs > 0 && Date.now() - cached.at < ttlMs) return cached.status;
  let status;
  try {
    const r = await req(url, key, { timeoutMs: 8000 });
    status = r.status;
  } catch {
    status = 0;
  }
  pingCache.set(ck, { at: Date.now(), status });
  return status;
}

const listCache = new Map();
const LIST_TTL_MS = 45_000;

/** GET {baseURL}/models —— 顺便捡走网关自报的能力字段。 */
export async function listModels(baseURL, key) {
  const url = `${String(baseURL).replace(/\/+$/, '')}/models`;
  const ck = `${url}\0${key ? '1' : '0'}`;
  const cached = listCache.get(ck);
  if (cached && Date.now() - cached.at < LIST_TTL_MS) return cached.rows;
  const r = await req(url, key, { timeoutMs: 12000 });
  if (!r.ok) throw new Error(`GET /models -> ${r.status} ${r.statusText}`);
  const body = await r.json();
  const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
  const out = rows.map((m) => ({
    id: m.id ?? m.model ?? m.name,
    declared: {
      contextWindow: m.context_length ?? m.context_window ?? m.max_context_length ?? null,
      maxTokens: m.top_provider?.max_completion_tokens ?? m.max_output_tokens ?? null,
      input: parseDeclaredInput(m),
      supportsReasoning: Array.isArray(m.supported_parameters)
        ? m.supported_parameters.includes('reasoning') || m.supported_parameters.includes('reasoning_effort')
        : null,
    },
  })).filter((m) => m.id);
  listCache.set(ck, { at: Date.now(), rows: out });
  return out;
}

/**
 * 判定 respond 还是 chat。
 * 关键：404 有两种含义，必须靠 error.code 区分「路由不存在」和「模型不存在」。
 */
export async function probeProtocol(baseURL, key, sampleModel) {
  const base = baseURL.replace(/\/+$/, '');
  if (/\/anthropic\/?$/i.test(base)) return { api: 'anthropic-messages', how: 'URL 以 /anthropic 结尾' };
  if (/generativelanguage\.googleapis\.com/i.test(base)) return { api: 'google-generative-ai', how: 'Google 端点' };
  if (!sampleModel) return { api: null, how: '无样本模型，无法探测', uncertain: true };

  try {
    const r = await req(`${base}/responses`, key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: sampleModel, input: 'x', max_output_tokens: 1 }),
      timeoutMs: 20000,
    });
    // 401/403 是「没过鉴权」，根本没走到路由分发，什么都证明不了。
    if (r.status === 401 || r.status === 403) {
      return { api: null, how: `POST /responses 返回 ${r.status}（鉴权失败，探测无效）`, uncertain: true };
    }
    // 429 / 5xx 同理：网关层就挡回来了
    if (r.status === 429 || r.status >= 500) {
      return { api: null, how: `POST /responses 返回 ${r.status}（网关层拦截，探测无效）`, uncertain: true };
    }
    if (r.status === 404 || r.status === 405) {
      const txt = await r.text().catch(() => '');
      let code = '';
      try { code = JSON.parse(txt)?.error?.code ?? JSON.parse(txt)?.error?.type ?? ''; } catch { /* 非 JSON */ }
      if (/model.*not.*found|model_not_found|unknown_model/i.test(code + txt)) {
        return { api: 'openai-responses', how: `POST /responses 返回 ${r.status} 但报的是「模型不存在」→ 路由存在` };
      }
      return { api: 'openai-completions', how: `POST /responses 返回 ${r.status}，路由不存在` };
    }
    return { api: 'openai-responses', how: `POST /responses 返回 ${r.status}（参数级响应即代表路由存在）` };
  } catch (e) {
    return { api: null, how: `网络探测失败（${e.message}）`, uncertain: true };
  }
}
