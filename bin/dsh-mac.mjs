#!/usr/bin/env node
/**
 * dsh-model-autoconfig —— DeepSeek Harness 模型配置工具
 *
 * 默认一律 dry-run，只打印将要写入的 YAML 差异；加 --apply 才落盘。
 * 落盘前自动备份到 $DSH_HOME/backups/。
 */
import { LEVELS, LEVEL_LABEL, SELF_DESCRIBING_APIS, SUPPORTED_APIS, DEFAULT_ROUTE_EFFORT, pickRouteEffort } from '../src/levels.mjs';
import { coversInput, hasVision, inferInput } from '../src/modalities.mjs';
import { vendorForUrl, vendorById, modelSpec, findAnyVendor } from '../src/vendors.mjs';
import { compileModel, offOnlyOverride, CompileError } from '../src/compile.mjs';
import { findCatalogDir, loadCatalog, audit, catalogModelIds, catalogProviders } from '../src/catalog.mjs';
import * as S from '../src/settings.mjs';
import { listModels, probeProtocol } from '../src/discover.mjs';
import { existsSync } from 'node:fs';
import { lineDiff, collapse, hasChanges } from '../src/diff.mjs';
import { readFileSync } from 'node:fs';

const C = process.stdout.isTTY
  ? { d:'\x1b[2m', b:'\x1b[1m', g:'\x1b[32m', y:'\x1b[33m', r:'\x1b[31m', c:'\x1b[36m', x:'\x1b[0m' }
  : { d:'', b:'', g:'', y:'', r:'', c:'', x:'' };
const say = (...a) => console.log(...a);
const warn = (...a) => console.log(C.y + '!' + C.x, ...a);
const err  = (m) => { console.error(C.r + '错误：' + C.x + m); process.exit(1); };

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      out[k] = v !== undefined ? v : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
    } else out._.push(a);
  }
  return out;
}

const HELP = `${C.b}dsh-model-autoconfig${C.x} —— 维护者 CLI（用户请装 web 插件：dsh plugin --profile web add dsh-model-autoconfig）

  ${C.c}dsh-mac audit${C.x}                   审计 pi-ai 内置目录的思考档位和视觉能力
  ${C.c}dsh-mac fix-off${C.x} --provider X    给内置目录里缺 off 的模型补 off 档（修输出被截断）
  ${C.c}dsh-mac add${C.x} --id R --url U      配置一个中转/自定义网关（不带 --models 就自动上全部模型）
  ${C.c}dsh-mac doctor${C.x}                  检查现有 settings.yaml 与真值库是否一致
  ${C.c}dsh-mac scan${C.x}                    找出 settings.yaml 在哪、里面是什么形状（配置认不出来时先跑这个）

通用选项
  --apply                写入 settings.yaml（不加则只预览）
  --settings <path>      指定 settings.yaml（默认 $DSH_HOME/settings.yaml 或 ~/.dsh/settings.yaml）
  --pi-ai-data <dir>     指定 pi-ai 内置目录数据目录（自动查找失败时用）
  --at <path>            手工指定 providers 节点路径（dsh-mac scan 认不出形状时用），如 llm.providers

add 选项
  --id <route>           provider 路由名，例如 cpa
  --url <baseURL>        端点地址，例如 https://gw.example/v1
                         ${C.d}（配官方厂商时可省略：只给 --vendor，端点/协议/目录全部继承内置目录）${C.x}
  --key <secret>         API Key（会生成 apiKeyEnv 引用并打印 export 行）
  --key-env <NAME>       直接指定环境变量名，不传 --key 时用
  --api <protocol>       协议；不传则自动探测。探测集 = ${SELF_DESCRIBING_APIS.join(' / ')}
                         ${C.d}（Gemini 官方端点按 openai-completions 写，宿主不接受 google-generative-ai）${C.x}
  --default-effort <lv>  路由级默认思考档位，默认 ${DEFAULT_ROUTE_EFFORT}；--default-effort off 则默认不思考
  --vendor <id>          强制指定厂商真值（默认按 URL 猜；--models 里逐个也可用 id=vendor 形式）
  --models a,b,c         手动列出模型 id（网关没有 /models 接口时用）
  --fetch                从 GET /models 拉取
  ${C.d}（两个都不给 = 默认：用 pi-ai 内置目录里该厂商的全部模型，这就是「只填 url + key」）${C.x}
  --context N / --max-tokens N   端点裁剪值，覆盖官方规格
  --no-io                不写 input 字段（默认写：视觉等能力；output 官方类型没有，从不写）
`;

/* ────────────────────────────── audit ────────────────────────────── */
function cmdAudit(args) {
  const dir = findCatalogDir(args['pi-ai-data']);
  if (!dir) err('找不到 pi-ai 内置目录。用 --pi-ai-data <dir> 指定 .../@earendil-works/pi-ai/dist/providers/data');
  say(C.d + '目录：' + dir + C.x + '\n');
  const entries = loadCatalog(dir);
  const a = audit(entries);

  say(`${C.b}内置目录审计${C.x}`);
  say(`  模型总数            ${a.total}`);
  say(`  声明了档位表        ${a.withLevels}`);
  say(`  ${C.r}缺 off 键${C.x}           ${a.missingOff.length}   ← 这些模型的思考会被无条件关闭，长输出被静默截断`);
  say(`  声明推理但无档位表  ${a.noLevels.length}`);
  say(`  ${C.y}缺视觉能力${C.x}         ${a.missingVision.length}   ← 真值库认为可看图，目录没声明 image，发图会 UNSUPPORTED_CONTENT`);
  say('');

  const filter = args.provider;
  const rows = filter ? a.missingOff.filter((e) => e.provider === filter) : a.missingOff;
  const byProv = {};
  for (const e of rows) (byProv[e.provider] ??= []).push(e);

  for (const [p, list] of Object.entries(byProv).sort()) {
    say(`${C.y}${p}${C.x} (${list.length})`);
    for (const e of list.slice(0, args.all ? 1e9 : 6)) {
      say(`    ${e.id.padEnd(38)} ${C.d}已有档位: ${Object.keys(e.model.thinkingLevelMap).join(',')}${C.x}`);
    }
    if (!args.all && list.length > 6) say(`    ${C.d}… 还有 ${list.length - 6} 个（--all 全列）${C.x}`);
  }
  const vis = filter ? a.missingVision.filter((e) => e.provider === filter) : a.missingVision;
  if (vis.length) {
    say(`${C.y}缺视觉（真值库有 image，目录没有）${C.x}`);
    const byV = {};
    for (const e of vis) (byV[e.provider] ??= []).push(e);
    for (const [p, list] of Object.entries(byV).sort()) {
      say(`  ${p} (${list.length})`);
      for (const e of list.slice(0, args.all ? 1e9 : 6)) {
        say(`    ${e.id.padEnd(38)} ${C.d}目录 input: ${JSON.stringify(e.model.input ?? '(缺省=text)')}${C.x}`);
      }
      if (!args.all && list.length > 6) say(`    ${C.d}… 还有 ${list.length - 6} 个（--all 全列）${C.x}`);
    }
    say('');
  }
  say(`${C.d}修复档位：dsh-mac fix-off --provider <名字> --apply${C.x}`);
  say(`${C.d}修复视觉：装 web 插件后打开 Settings → Models，或 dsh-mac add --vendor <名字> --apply${C.x}`);
}

/* ───────────────────────────── fix-off ───────────────────────────── */
function cmdFixOff(args) {
  const dir = findCatalogDir(args['pi-ai-data']);
  if (!dir) err('找不到 pi-ai 内置目录，用 --pi-ai-data 指定');
  const provider = args.provider;
  if (!provider) err('必须指定 --provider（用 dsh-mac audit 看有哪些）。可选值：' +
    catalogProviders(loadCatalog(dir)).join(', '));

  const entries = loadCatalog(dir);
  const targets = audit(entries).missingOff.filter((e) => e.provider === provider);
  if (!targets.length) { say(`${C.g}✓${C.x} ${provider} 没有缺 off 的模型，无需修复`); return; }

  const file = args.settings ?? S.defaultSettingsFile();
  const doc = S.loadDoc(file);
  const overrides = {};
  say(`${C.b}将为 ${provider} 的 ${targets.length} 个模型补 off 档${C.x}\n`);
  for (const e of targets) {
    const efforts = offOnlyOverride(e.model.thinkingLevelMap, null);
    // 目录里 value 为 null 的非 off 档位在配置层非法（只有 off 允许空值）——一并剔除
    for (const lv of LEVELS) if (lv !== 'off' && lv in efforts && efforts[lv] == null) delete efforts[lv];
    overrides[e.id] = { reasoningEfforts: efforts };
    say(`  ${e.id.padEnd(36)} ${Object.entries(efforts).map(([k, v]) => v == null ? `${k}:∅` : `${k}:${v}`).join(' ')}`);
  }
  say('');
  try { S.setOverrides(doc, provider, overrides, args.at); }
  catch (e2) { err(e2.message + '\n提示：该 route 已有 models 列表，请改用 add 命令重写整张列表。'); }
  finish(args, file, doc, `已为 ${provider} 补齐 off 档`);
}

/* ─────────────────────────────── add ─────────────────────────────── */
async function cmdAdd(args) {
  const route = args.id;
  let url = args.url === true ? undefined : args.url;
  if (!route) err('add 需要 --id <route>');
  if (!url && !args.vendor) err(`add 需要 --url <baseURL>，或 --vendor <厂商id>（官方端点时 URL 可省）`);

  // --vendor 指定官方厂商时 URL 可以完全省掉：route 命中 pi-ai 内置目录的
  // provider 名，端点/协议/目录全部继承，settings.yaml 里连 baseURL 都不用写。
  const vendor = args.vendor ? vendorById(args.vendor) : vendorForUrl(url ?? '');
  if (args.vendor && !vendor) err(`未知 --vendor ${args.vendor}；厂商表见 README 或 src/vendors.mjs`);
  // P0：URL 或 --vendor 命中真值库时，官方协议是确定的，优先于网络探测
  const vendorPreset = vendor ?? null;
  say(`${C.b}厂商真值${C.x} ${vendor ? vendor.label + C.d + ' (' + vendor.id + ')' + C.x : C.y + 'URL 未匹配到厂商 → 将按 model id 逐个匹配（中转站的正常路径）' + C.x}`);

  const keyEnv = args['key-env'] ?? `${route.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
  const key = args.key === true ? undefined : args.key;

  // ── 模型清单：三条平权的路 ──
  //   1. --models a,b,c   手动列（网关没有 /models 接口时的一等公民路径）
  //   2. --fetch          从 GET /models 拉
  //   3. 都不给           ← 默认：直接用 pi-ai 内置目录里该厂商的全部模型
  //
  // 第 3 条是「内置了模型，只需要 url + key」的实现方式。注意 id 不是我硬编码在
  // 真值库里的（那种清单三个月就过期），而是从你本机 pi-ai 的目录数据里读出来的，
  // 所以永远跟你装的版本同步；真值库只负责把每个 id 的档位表算对。
  let ids = [], declared = {}, idSource = '';
  if (args.models && args.models !== true) {
    ids = String(args.models).split(',').map((s) => s.trim()).filter(Boolean);
    idSource = '--models 手动指定';
  } else if (args.fetch) {
    try {
      const rows = await listModels(url, key ?? process.env[keyEnv]);
      ids = rows.map((r) => r.id);
      for (const r of rows) declared[r.id] = r.declared;
      idSource = `GET /models 拉到 ${ids.length} 个`;
    } catch (e) { err(`拉取失败：${e.message}\n改用 --models a,b,c 手动列出，或直接不带 --models 用内置目录。`); }
  } else {
    if (!vendor) err(`没有 --models 时需要能认出厂商，但 URL ${url} 没匹配上真值库。
  三条路：
    1. ${C.c}--vendor <厂商id>${C.x}   强制指定（厂商表见 README 或 src/vendors.mjs）
    2. ${C.c}--fetch${C.x}            从 GET /models 拉清单
    3. ${C.c}--models a,b,c${C.x}     手动列`);
    const dir = findCatalogDir(args['pi-ai-data']);
    if (!dir) err(`找不到 pi-ai 内置目录，没法自动列模型。
  用 ${C.c}--models a,b,c${C.x} 手动列，或 ${C.c}--pi-ai-data <dir>${C.x} 指定目录位置。`);
    const entries = loadCatalog(dir);
    const provs = vendor.catalogProviders ?? [];
    const seen = new Set();
    for (const pv of provs) for (const id of catalogModelIds(entries, pv)) seen.add(id);
    // 只留真值库认得的（目录里有大量该厂商的历史/别名模型，全写进去是噪音）
    ids = [...seen].filter((id) => modelSpec(vendor, id)).sort();
    idSource = `pi-ai 内置目录 ${provs.join('+')} → 真值库认得 ${ids.length} 个`;
    if (!ids.length) err(`pi-ai 目录里 ${provs.join('+')} 的模型没有一个能匹配上真值库 ${vendor.id} 的规则。
  用 ${C.c}--models a,b,c${C.x} 手动列，或在 src/vendors.mjs 里补规则。`);
  }
  if (!ids.length) err('模型清单为空');
  say(`${C.b}模型清单${C.x} ${ids.length} 个 ${C.d}(${idSource})${C.x}`);

  // ── 协议 ──
  let api = args.api;
  if (api) {
    say(`${C.b}协议${C.x} ${api} ${C.d}(--api 手动指定)${C.x}`);
  } else if (!url) {
    api = vendorPreset?.api ?? 'openai-completions';
    say(`${C.b}协议${C.x} ${C.d}不写 —— 目录 route，每个模型沿用内置目录自己的协议${C.x}`);
  } else if (vendorPreset?.api) {
    // P0：真值库认得这个 URL，官方协议是确定的，不需要也不应该被探测覆盖
    api = vendorPreset.api;
    say(`${C.b}协议${C.x} ${api} ${C.d}(真值库 ${vendorPreset.id} 官方协议)${C.x}`);
  } else {
    const p = await probeProtocol(url ?? '', key ?? process.env[keyEnv], ids[0]);
    if (p.api) {
      api = p.api;
      say(`${C.b}协议${C.x} ${api} ${C.d}(${p.how})${C.x}`);
    } else {
      api = 'openai-completions';
      say(`${C.b}协议${C.x} ${api} ${C.d}(兜底值 —— ${p.how})${C.x}`);
      warn('协议没能实测确认。绝大多数中转站是 openai-completions，若档位不生效请用 --api openai-responses 重跑');
    }
  }
  if (!SUPPORTED_APIS.includes(api)) warn(`${api} 不在本工具支持的协议里（${SUPPORTED_APIS.join(' / ')}），可能还需要额外配置`);

  // ── 编译 ──
  const entries = [], allNotes = [], skipped = [];
  for (const raw of ids) {
    const [mid, vOverride] = raw.includes('=') ? raw.split('=') : [raw, null];
    let v = vOverride ? vendorById(vOverride) : (vendor ?? vendorForUrl(url ?? ''));
    let spec = modelSpec(v, mid);
    let resolved = null;               // 非原样命中时记录解析路径（硬映射/软匹配）
    if (!spec) {                       // URL 认不出厂商时，按 model id 全库匹配
      const hit = findAnyVendor(mid);
      if (hit) { v = hit.vendor; spec = hit.spec; if (hit.id !== mid) resolved = hit; }
    }
    if (!spec) { skipped.push(mid); continue; }
    const d = declared[mid] ?? {};
    const overlay = {
      contextWindow: args.context ? Number(args.context) : d.contextWindow ?? null,
      maxTokens: args['max-tokens'] ? Number(args['max-tokens']) : d.maxTokens ?? null,
      input: d.input ?? null,
    };
    try {
      const r = compileModel({ vendor: v, modelId: mid, api, spec, overlay, includeIO: !args['no-io'] });
      if (resolved) r.notes.unshift(`按「${resolved.id}」匹配真值库（${resolved.via}）；发给网关的 id 不变`);
      r.entry.__vendor = v.id;
      entries.push(r.entry);
      if (r.notes.length) allNotes.push([mid, r.notes]);
    } catch (e) {
      if (e instanceof CompileError) { skipped.push(`${mid} (${e.message})`); continue; }
      throw e;
    }
  }

  say(`\n${C.b}编译结果${C.x} ${entries.length} 个模型`);
  for (const e of entries) {
    const lv = e.reasoningEfforts === false ? C.d + '无思考档位' + C.x
      : Object.keys(e.reasoningEfforts).map((l) => LEVEL_LABEL[l]).join(' · ');
    const vis = hasVision(e.input) ? `${C.c}视觉${C.x}` : `${C.d}文本${C.x}`;
    say(`  ${e.id.padEnd(30)} ${C.d}${String(e.__vendor).padEnd(10)}${C.x} ${String(e.contextWindow ?? '—').padStart(8)} ctx ${String(e.maxTokens ?? '—').padStart(7)} out  ${vis}  ${lv}`);
  }
  for (const e of entries) delete e.__vendor;
  if (skipped.length) { say(''); warn(`真值库里没有，已跳过：${skipped.join(', ')}`); say(`  ${C.d}可用 --vendor 指定，或在 src/vendors.mjs 里补一条规则${C.x}`); }
  if (allNotes.length) {
    say(`\n${C.b}提示${C.x}`);
    for (const [m, ns] of allNotes) for (const n of ns) say(`  ${C.d}${m}:${C.x} ${n}`);
  }

  if (!entries.length) {
    say('');
    err(`一个模型都没编译出来，不写配置（写入空的 models[] 会让 dsh 上这条 route 一个模型都不显示）。
  三条路可选：
    1. 用真值库认识的 model id 重跑（见 README 厂商表或 src/vendors.mjs）
    2. ${C.c}--models 你的id=厂商id${C.x} 强制指定，如 --models my-gpt=openai
    3. 在 src/vendors.mjs 里补一条规则（照着现有条目抄即可）`);
  }

  const file = args.settings ?? S.defaultSettingsFile();
  const doc = S.loadDoc(file);

  // ── 三方合并：用户手改过的字段一律保留，本次计算值只作为建议 ──
  const state = S.loadState();
  const base = S.mergeBase(state, route);
  const current = Object.fromEntries(((S.getProviders(doc, args.at)[route]?.models) ?? []).map((m) => [m.id, m]));
  const kept = [];
  for (const e of entries) {
    const { merged, suggestions } = S.threeWay(base[e.id], current[e.id], e);
    for (const k of Object.keys(suggestions)) {
      kept.push(`${e.id}.${k}：保留你手改的 ${JSON.stringify(merged[k])}（本次建议 ${JSON.stringify(suggestions[k])}）`);
    }
    Object.assign(e, merged, { id: e.id });
  }
  if (kept.length) { say(''); warn('检测到你手工改过的字段，已保留不覆盖：'); for (const k of kept) say(`  ${C.d}${k}${C.x}`); }

  // ── 路由级默认思考档位 ────────────────────────────────
  // 二维事实压成一维之后，「思考开不开」这一维靠两件事表达：
  //   1. 档位表里有没有 off 这一档  → 用户能不能主动关
  //   2. 路由级 reasoning: 是什么     → 默认开在哪一档
  // 只做第 1 件事会出现「档位表配对了，但默认还是不思考」。所以两件都做。
  // 但请求路径不 clamp 路由默认档（`reasoningEffort ?? profile.reasoning` 不在
  // 档位表里直接 UNSUPPORTED_REASONING_EFFORT），写进去的必须是全体推理模型
  // 共有档里的值 —— pickRouteEffort 负责收敛，与插件侧 applyRouteEffort 同一条规则。
  const wantEffort = args['default-effort'] === true ? undefined : args['default-effort'];
  const routeEffort = wantEffort ?? DEFAULT_ROUTE_EFFORT;
  if (!LEVELS.includes(routeEffort))
    err(`--default-effort 只能是 ${LEVELS.join(' / ')}，收到 "${routeEffort}"`);
  const writtenEffort = pickRouteEffort(routeEffort, entries);

  const clampNote = [];
  for (const e of entries) {
    const re = e.reasoningEfforts;
    if (re === false) { clampNote.push([e.id, '不支持思考']); continue; }
    const has = Object.keys(re ?? {});
    if (!has.includes(routeEffort)) {
      // 复刻 pi-ai clampThinkingLevel() 的搜索顺序：先向上找，找不到再向下。
      // （models.js:404 —— 先 for(i=idx; i<len; i++) 再 for(i=idx-1; i>=0; i--)）
      // 方向搞反会把「收敛到 High」说成「收敛到 Low」，正好差一个数量级的思考量。
      const i = LEVELS.indexOf(routeEffort);
      let near = LEVELS.slice(i + 1).find((l) => has.includes(l))
             ?? [...LEVELS.slice(0, i)].reverse().find((l) => has.includes(l))
             ?? null;
      clampNote.push([e.id, near ? `收敛到 ${LEVEL_LABEL[near]}` : '无可用档位']);
    }
  }
  if (writtenEffort === undefined) {
    say(`\n${C.b}默认思考档位${C.x} ${LEVEL_LABEL[routeEffort]} ${C.y}→ 不写入（这些模型没有共有档，写了会在请求时报错）${C.x}`);
  } else {
    say(`\n${C.b}默认思考档位${C.x} ${LEVEL_LABEL[routeEffort]}` +
        (writtenEffort !== routeEffort ? ` ${C.y}→ 写 ${LEVEL_LABEL[writtenEffort]}（全体共有档）${C.x}` : ` ${C.d}（写进路由级 reasoning:）${C.x}`));
  }
  for (const [id, why] of clampNote) say(`  ${C.d}${id.padEnd(30)} ${why}${C.x}`);

  S.setRoute(doc, route, {
    displayName: args.name === true ? undefined : args.name,
    api: url ? api : undefined,          // 目录 route 不写 api：每个模型用目录里自己的协议
    baseURL: url || undefined,           // 目录 route 不写 baseURL：继承目录端点
    apiKeyEnv: keyEnv,
    reasoning: writtenEffort ?? null,   // ← 收敛后的值；没有共有档时删掉旧值（null=删除）
  }, args.at);
  if (url) {
    // 自定义网关：pi-ai 没有这条 route 的目录，必须整份声明 → models
    S.setModels(doc, route, entries, args.at);
  } else {
    // 目录 route：models 会【替换】整个内置目录，把没列到的模型全下掉。
    // 官方类型注释说得很直白 —— 这种情况要用 modelOverrides，
    // 「correct one model, keep the other thirty-seven is a three-line edit」。
    // 所以只写真正需要纠正的字段（档位表 + 目录缺的视觉），其余让目录继续服务。
    const ovs = {};
    const catalog = (() => {
      try {
        const dir = findCatalogDir(args['pi-ai-data']);
        return dir ? loadCatalog(dir) : [];
      } catch { return []; }
    })();
    const catalogById = Object.fromEntries(
      catalog.filter((e) => e.provider === route).map((e) => [e.id, e.model]),
    );
    for (const e of entries) {
      const o = {};
      if (e.reasoningEfforts !== undefined) o.reasoningEfforts = e.reasoningEfforts;
      if (!args['no-io'] && e.input && !coversInput(catalogById[e.id]?.input, e.input)) {
        o.input = e.input;
      }
      if (Object.keys(o).length) ovs[e.id] = o;
    }
    S.setOverrides(doc, route, ovs, args.at);
    say(`\n${C.d}目录 route → 只写 modelOverrides 纠正档位表和缺的视觉，其余字段继续走 pi-ai 内置目录${C.x}`);
  }

  if (args.apply) {
    S.saveState(S.withMergeBase(state, route, Object.fromEntries(entries.map((e) => [e.id, e]))));
  }

  say(`\n${C.b}密钥${C.x} apiKeyEnv: ${keyEnv}`);
  if (key) {
    say(`  ${C.c}export ${keyEnv}='${key}'${C.x}   ${C.d}← 加到 shell 配置里${C.x}`);
  } else say(`  ${C.d}未提供 --key，请自行 export ${keyEnv}=...${C.x}`);

  finish(args, file, doc, `已配置 provider "${route}"`);
}

/* ────────────────────────────── doctor ───────────────────────────── */
function cmdDoctor(args) {
  const file = args.settings ?? S.defaultSettingsFile();
  if (!existsSync(file)) err(`找不到 ${file}`);
  const doc = S.loadDoc(file);
  const provs = S.getProviders(doc, args.at);
  const names = Object.keys(provs);
  if (!names.length) {
    warn('这个 settings.yaml 里没有找到 llm-pi-ai 的 provider 配置');
    say(`  ${C.d}文件：${file}${C.x}`);
    const shape = S.detectShape(doc);
    const deep = S.deepFindProviders(doc);
    const top = Object.keys(doc.toJSON?.() ?? {});
    say(`  ${C.d}顶层键：${top.length ? top.join(', ') : '(空文件)'}${C.x}`);
    if (shape) say(`  ${C.y}命中形状 ${shape.shape} → ${shape.path}，但里面没有 provider 条目${C.x}`);
    if (deep.length) {
      say(`\n  ${C.y}但在别的位置发现了像 provider 的配置：${C.x}`);
      for (const d of deep) say(`    ${C.b}${d.parent}${C.x} ${C.d}(${d.count} 条: ${d.routes.slice(0, 6).join(', ')})${C.x}`);
      say(`  ${C.d}→ 跑 dsh-mac scan 看完整结构${C.x}`);
    } else {
      say(`\n  ${C.g}这是正常状态${C.x}：你还没有自定义任何网关，模型全部走 pi-ai 内置目录。`);
      say(`  下一步二选一：`);
      say(`    ${C.c}dsh-mac audit${C.x}                         看内置目录里哪些模型的思考档位是坏的`);
      say(`    ${C.c}dsh-mac add --id 名字 --url 地址 --models a,b${C.x}   配置你自己的网关`);
    }
    return;
  }

  say(`${C.d}${file}${C.x}\n`);
  let issues = 0;
  for (const [route, p] of Object.entries(provs)) {
    say(`${C.b}${route}${C.x} ${C.d}${p.api ?? '(继承目录协议)'} ${p.baseURL ?? ''}${C.x}`);
    const list = [
      ...(p.models ?? []).map((m) => [m.id, m]),
      ...Object.entries(p.modelOverrides ?? {}),
    ];
    if (!list.length) { say(`  ${C.d}未显式列出模型，全部继承内置目录${C.x}`); continue; }
    if (p.models && p.modelOverrides) { say(`  ${C.r}✗ models 与 modelOverrides 并存 —— dsh 会整段拒绝${C.x}`); issues++; }
    for (const [mid, m] of list) {
      const re = m.reasoningEfforts;
      const probs = [];
      // 真值库条目：URL 认不出就按 model id 全库匹配（中转站的正常情况）
      let v = vendorForUrl(p.baseURL ?? '');
      let spec = modelSpec(v, mid);
      if (!spec) { const hit = findAnyVendor(mid); if (hit) { v = hit.vendor; spec = hit.spec; } }

      if (re && re !== false) {
        for (const [lv, wire] of Object.entries(re)) {
          if (!LEVELS.includes(lv)) probs.push(`未知档位 "${lv}"（合法值 ${LEVELS.join('/')}）`);
          if (lv !== 'off' && (wire == null || wire === '')) probs.push(`${lv} 是空值 —— dsh 只允许 off 留空`);
        }
        if (spec) {
          // 有真值库条目就按它比对；模型本来就不能关思考的（GLM-5.3 / Grok / M2.x）不算问题
          const want = Object.keys(spec.efforts).filter((l) => !(spec.collapses ?? {})[l]);
          const got = Object.keys(re);
          const missing = want.filter((l) => !got.includes(l));
          const extra = got.filter((l) => !want.includes(l));
          if (missing.includes('off') && !spec.forcedThinking)
            probs.push(`缺 off 档 → 用户没法关闭思考（真值库：该模型是可以关的）`);
          const other = missing.filter((l) => l !== 'off');
          if (other.length) probs.push(`比真值库(${v.id})少了档位 ${other.join('/')}`);
          if (extra.length) {
            const col = extra.filter((l) => (spec.collapses ?? {})[l]);
            const unk = extra.filter((l) => !(spec.collapses ?? {})[l]);
            if (col.length) probs.push(`档位 ${col.join('/')} 会被服务端静默塌缩成 ${col.map((l) => spec.collapses[l]).join('/')} —— 是假档位，建议删掉`);
            if (unk.length) probs.push(`多出真值库(${v.id})没有的档位 ${unk.join('/')}`);
          }
        } else if (!('off' in re)) {
          probs.push('缺 off 档（真值库里没有该模型，无法确认它是否支持关闭思考）');
        }
      } else if (re === false && spec) {
        // 匹配层升级前配不上的模型会被旧版本写成 false 兜底；
        // 现在真值库能解析了，这个 false 就是过期声明，同步一轮可修复
        const want = Object.keys(spec.efforts).filter((l) => !(spec.collapses ?? {})[l]);
        if (want.length) {
          probs.push(`声明了 reasoningEfforts: false，但真值库(${v.id})认为该模型支持思考（${want.join('/')}）—— 过期的兜底值，重跑同步可修复`);
        }
      }
      if (m.compat && p.api && p.api !== 'openai-completions')
        probs.push(`api=${p.api} 上的模型级 compat 会被 dsh 拒绝（pi-ai 只在 OpenAICompletionsCompat 上定义）`);
      // 视觉：models[] 是完整声明，缺 input 就被当成纯文本。
      // modelOverrides 没写 input 表示沿用目录，不能当成「没视觉」。
      const declaredHere = Array.isArray(p.models) || 'input' in m;
      const wantInput = spec?.input ?? inferInput(mid, m.input);
      if (declaredHere && wantInput && hasVision(wantInput) && !hasVision(m.input)) {
        probs.push(`缺视觉能力：真值库/名字认为 ${wantInput.join(' + ')}，当前 ${m.input ? m.input.join(' + ') : '未声明（dsh 当纯文本）'} —— 发图会 UNSUPPORTED_CONTENT`);
      }
      issues += probs.length;
      say(probs.length
        ? `  ${C.r}✗${C.x} ${mid}\n${probs.map((x) => '      ' + x).join('\n')}`
        : `  ${C.g}✓${C.x} ${mid}`);
    }
    say('');
  }
  say(issues ? `${C.y}发现 ${issues} 个问题${C.x}` : `${C.g}✓ 全部通过${C.x}`);
  process.exitCode = issues ? 1 : 0;
}

/* ─────────────────────────────── scan ────────────────────────────── */
function cmdScan(args) {
  say(`${C.b}1. 配置文件在哪${C.x}`);
  const cands = S.candidateFiles();
  const found = cands.filter((c) => c.exists);
  for (const c of cands) {
    say(`  ${c.exists ? C.g + '✓' + C.x : C.d + '·' + C.x} ${c.exists ? '' : C.d}${c.file}${c.exists ? '' : C.x}`);
  }
  if (args.settings) say(`  ${C.c}→${C.x} 命令行指定了 --settings ${args.settings}`);
  if (!args.settings && !found.length) {
    say(`\n  ${C.r}一个都没找到。${C.x}用 --settings <完整路径> 指定，或先启动一次 dsh 让它生成。`);
    say(`  ${C.d}Windows 上 dsh 的配置通常在 C:\\Users\\你的用户名\\.dsh\\settings.yaml${C.x}`);
    return;
  }
  const file = args.settings ?? S.defaultSettingsFile();
  if (!existsSync(file)) err(`找不到 ${file}`);
  say(`\n${C.b}2. 正在分析${C.x} ${file}`);
  let doc;
  try { doc = S.loadDoc(file); } catch (e) { err(`YAML 解析失败：${e.message}`); }
  const json = doc.toJSON?.() ?? {};
  const top = Array.isArray(json) ? `(顶层是列表，${json.length} 项)` : Object.keys(json).join(', ');
  say(`  ${C.d}顶层：${top || '(空)'}${C.x}`);

  const shape = S.detectShape(doc);
  say(`\n${C.b}3. 本工具认识的形状${C.x}`);
  if (shape) say(`  ${C.g}✓${C.x} 形状 ${shape.shape} → ${C.c}${shape.path}${C.x}`);
  else say(`  ${C.y}✗ 三种已知形状都没命中${C.x} ${C.d}(A: llm-pi-ai.providers / B: "llm-pi-ai.providers" / C: 插件数组)${C.x}`);

  const provs = S.getProviders(doc, args.at);
  const names = Object.keys(provs);
  say(`  已解析出的 provider：${names.length ? C.b + names.join(', ') + C.x : C.d + '无' + C.x}`);

  say(`\n${C.b}4. 全树深搜「像 provider 的配置」${C.x}`);
  const deep = S.deepFindProviders(doc);
  if (!deep.length) say(`  ${C.d}没有。文件里没有任何带 baseURL / models / apiKeyEnv 的条目。${C.x}`);
  for (const d of deep) {
    say(`  ${C.b}${d.parent}${C.x}`);
    say(`    ${d.count} 条: ${d.routes.join(', ')}`);
    say(`    ${C.d}字段: ${d.fields.join(', ')}${C.x}`);
  }

  if (deep.length && !names.length) {
    say(`\n  ${C.y}结论${C.x} 你的 dsh 用了本工具还不认识的配置形状。`);
    say(`  把上面第 3、4 节贴出来，或直接跑：`);
    say(`    ${C.c}node -e "console.log(require('fs').readFileSync(String.raw\`${file}\`,'utf8'))"${C.x}`);
  } else if (!deep.length && !names.length) {
    say(`\n  ${C.g}结论${C.x} 配置是干净的，你还没加过任何自定义网关 —— 这不是错误。`);
    say(`  想配模型：${C.c}dsh-mac add --id 名字 --url 地址 --models a,b${C.x}`);
    say(`  想修内置目录的思考档位：${C.c}dsh-mac audit${C.x}`);
  } else {
    say(`\n  ${C.g}结论${C.x} 形状正常，${names.length} 个 provider 可被本工具管理。跑 ${C.c}dsh-mac doctor${C.x} 体检。`);
  }

  if (args.dump) {
    say(`\n${C.b}5. 原文${C.x}`);
    say(readFileSync(file, 'utf8'));
  } else {
    say(`\n  ${C.d}加 --dump 打印文件原文${C.x}`);
  }
}

/* ────────────────────────────── 落盘 ─────────────────────────────── */
function finish(args, file, doc, msg) {
  const yaml = S.render(doc);
  const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (!args.apply) {
    const rows = lineDiff(before, yaml);
    if (!hasChanges(rows)) { say(`\n${C.g}✓${C.x} 当前配置已经是目标状态，无需改动`); return; }
    say(`\n${C.b}${file}${C.x} ${C.d}的改动预览（加 --apply 才落盘）${C.x}\n`);
    for (const [sign, line] of collapse(rows)) {
      if (sign === '+') say(`  ${C.g}+ ${line}${C.x}`);
      else if (sign === '-') say(`  ${C.r}- ${line}${C.x}`);
      else if (sign === '~') say(`  ${C.d}${line}${C.x}`);
      else say(`    ${C.d}${line}${C.x}`);
    }
    const add = rows.filter((r) => r[0] === '+').length, del = rows.filter((r) => r[0] === '-').length;
    say(`\n  ${C.g}+${add}${C.x} ${C.r}-${del}${C.x}${before ? '' : C.d + '（新文件）' + C.x}`);
    if (del) say(`  ${C.y}注意${C.x} 有 ${del} 行被删除/替换 —— 落盘前会自动备份，可随时还原`);
    return;
  }
  const bak = S.backup(file);
  S.save(file, doc);
  say(`\n${C.g}✓${C.x} ${msg}`);
  say(`  写入 ${file}`);
  if (bak) say(`  ${C.d}备份 ${bak}${C.x}`);
  say(`  ${C.d}重启 dsh（或 dsh web）后生效${C.x}`);
}

/* ─────────────────────────────── main ────────────────────────────── */
const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
try {
  if (!cmd || args.help || args.h) say(HELP);
  else if (cmd === 'audit') cmdAudit(args);
  else if (cmd === 'fix-off') cmdFixOff(args);
  else if (cmd === 'add') await cmdAdd(args);
  else if (cmd === 'doctor') cmdDoctor(args);
  else if (cmd === 'scan') cmdScan(args);
  else err(`未知命令 "${cmd}"\n${HELP}`);
} catch (e) { err(e.stack ?? e.message); }
