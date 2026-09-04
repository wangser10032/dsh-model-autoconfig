# AGENTS.md — dsh-model-autoconfig

给改这个仓库的 agent 用。职责以源码为准；`test/layout.test.mjs` 核对本文件列出的路径都存在，且 `THINKING_FORMATS` / `HOST_APIS` / `COMPAT_GATES` 与代码导出一致。

## 模块表

| 路径 | 职责 |
|---|---|
| `src/dsh/plugin.mjs` | Cordis 插件：监视 `llm-pi-ai`，describe/replace/mutate 写入 |
| `src/dsh/sync.mjs` | 规划器：catalog vs gateway、合并、平台叠层、用户 compat 优先 |
| `src/dsh/host.mjs` | 从 `describe().schema` 抽枚举，写入前 `trimProviders` |
| `src/dsh/catalog.mjs` | 定位并加载 pi-ai `dist/providers/data`，跳过 `.manifest.json` |
| `src/dsh/discover.mjs` | GET `/models`、协议探测（Google 域名写 openai-completions） |
| `src/dsh/settings.mjs` | CLI 用 settings.yaml 定位/读写/备份 |
| `src/dsh/levels.mjs` | 档位全集、`THINKING_FORMATS`、`HOST_APIS` |
| `src/dsh/modalities.mjs` | input 归一（只认 text/image） |
| `src/dsh/diff.mjs` | CLI dry-run 行级 diff |
| `src/truth/vendors.mjs` | 厂商真值库（档位/视觉/协议），每条带出处 |
| `src/truth/compile.mjs` | 真值 → dsh 条目；按 `COMPAT_GATES` 写 compat |
| `src/truth/platforms.mjs` | URL 平台覆盖：火山/硅基/百炼 |
| `src/match/id.mjs` | 软匹配候选：日期、量化、分隔符、-↔.、点号厂商前缀 |
| `src/match/aliases.mjs` | 硬映射表（键小写，值必须原样命中真值库） |
| `src/index.mjs` | `dsh-model-autoconfig/lib` 聚合导出 |
| `src/*.mjs`（根） | 兼容 re-export，勿在此写逻辑 |
| `bin/dsh-mac.mjs` | 维护者 CLI |
| `test/host-schema.test.mjs` | 编译产物必须过真实宿主 `new Config`（禁止 skip） |
| `test/coverage.test.mjs` | pi-ai 目录覆盖率：核心 100%、全目录 ≥80% |

## 宿主契约（dsh 0.1.2，以 `Config.toJSON()` / lib/index.js 为准）

- 手写路由 `api` ∈ `openai-completions` \| `openai-responses` \| `anthropic-messages`
- `thinkingFormat` 11 值：openai / deepseek / openrouter / together / baseten / zai / qwen / chat-template / qwen-chat-template / string-thinking / ant-ling。**没有 `reasoning_effort`**
- `input` ∈ text \| image；档位键 ∈ off \| minimal \| low \| medium \| high \| xhigh \| max
- 模型级 compat 按协议门控（`COMPAT_GATES`）：openai-completions 17 字段、openai-responses 3、anthropic-messages 7（含 `forceAdaptiveThinking`）。写错字段会被 `resolveModelCompat` 整段拒绝
- 拿不到 `describe().schema` 时按 0.1.2 全集裁剪

## 数据流

```
settings.describe(llm-pi-ai)
  → classifyRoute（catalog 无 models[] / gateway 有 baseURL 或 models[]）
  → findVendorModel(id, preferredVendor)   # 硬映射 + 软匹配
  → compileModel                           # 真值 → 条目 + 协议门控 compat
  → applyPlatform(baseURL)                 # 火山/硅基/百炼覆盖；用户 compat 不覆盖
  → trimProviders(capsFromDescriptor)      # 按宿主 schema 裁剪
  → settings.replace / mutate(expectedRevision)
```

自定义网关写 `models[]`；官方目录 route 只写 `modelOverrides`。两者并存会被宿主拒绝。

## 变更联动清单

| 你改了 | 必须同时 |
|---|---|
| `THINKING_FORMATS` / `HOST_APIS` | `test/host-schema.test.mjs` 与宿主 `Config.toJSON()` 对齐；禁止加 `reasoning_effort` |
| `COMPAT_GATES` | 对照宿主 lib/index.js；`test/host.test.mjs` |
| `src/truth/vendors.mjs` 新规则 | 带官方 URL 或 pi-ai 目录出处；`off` 或 `forcedThinking`；`npm test`（含 coverage / host-schema） |
| `src/match/aliases.mjs` | 键小写；值能被真值库**原样**命中；键本身不能已原样命中 |
| `src/truth/platforms.mjs` | 每条带 `source` URL；用户手改 compat 不覆盖 |
| 模块搬家 / 改文件名 | 更新本表 + `src/index.mjs` 兼容导出 + `test/layout.test.mjs` |
| 写入 settings 的字段 | `test/host-schema.test.mjs` 全绿，不得 skip |

不要改 `/home/ubt/.dsh/settings.yaml`，不要重启 dsh web。测试：`npm test`。
