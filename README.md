# dsh-model-autoconfig

DeepSeek Harness **web 插件**：在 Settings → Models 填 URL 和密钥后，按厂商真值库自动写入思考档位、视觉 `input`、协议和上下文。

**0.10.0**：编译产物必须通过真实宿主 Config schema；火山/硅基/百炼平台覆盖；核心厂商目录覆盖 100%。

```bash
dsh plugin --profile web add dsh-model-autoconfig
```

打开 **Settings → Models**。自定义网关保存 URL + 密钥即可；官方 `deepseek` / `openai` 等只补档位和缺的视觉，不替换内置目录。不想自动写时在 `cordis.patch.yml` 设 `autoFill: false`。没有单独的插件设置页。

## 它做什么

dsh 原生模型表单没有思考强度。内置 pi-ai 目录大量条目缺 `off` 键，上游 `thinkingLevelMap?.off !== null` 会把思考无条件关掉、长输出截断（Discussion #1580）。本插件写入显式 `off:`（空值）以及各厂商真实档位。

自定义网关写 `models[]`；官方目录路由只写 `modelOverrides`。档位表覆盖；`input` 只增不减；用户手改的 `compat` 键不覆盖。

## 安装与运行

需要 dsh web（0.0.1-rc.1～0.1.2）。Node ≥ 20。

```bash
dsh plugin --profile web add dsh-model-autoconfig
```

维护者 CLI（默认 dry-run，`--apply` 才落盘）：

```bash
npx dsh-mac audit
npx dsh-mac add --id deepseek --vendor deepseek --key sk-… --apply
npx dsh-mac doctor
```

## 宿主硬约束（写错会被整段拒绝）

- 手写路由 `api` 只能是 `openai-completions` / `openai-responses` / `anthropic-messages`（不要写 `google-generative-ai`）
- `compat.thinkingFormat` 没有 `reasoning_effort`（那是 wire 字段名；xAI/Groq 用 `openai`）
- 模型级 compat 按协议门控：openai-completions 17 字段、responses 3、anthropic-messages 7
- `reasoningEfforts` 只有 `off` 允许空值；YAML 里必须写成 `"off":`

跨版本：运行时读 `settings.describe().schema` 裁剪字段；拿不到退回 0.1.2 全集。

## 平台覆盖

URL 命中时叠在真值之上（用户手改的 compat 优先）：

| 平台 | 行为 |
|---|---|
| 火山方舟 `ark.*.volces.com` | 档位用 doubao 真值；coding 端点 maxTokens 夹 128000；关 developer |
| 硅基流动 `api.siliconflow.cn` | DeepSeek-V4 / GLM-5.2：low/medium→high、xhigh→max |
| 阿里百炼 `dashscope.*.aliyuncs.com` | `thinkingFormat: qwen`，关 developer/store |

## 开发

```bash
npm test          # node --test test/*.test.mjs
```

源码三层：`src/dsh`（插件/同步/宿主）、`src/truth`（真值/编译/平台）、`src/match`（硬映射+软匹配）。根目录 `src/*.mjs` 是兼容 re-export。给 agent 的模块表与契约见 [AGENTS.md](AGENTS.md)。

加规则：`src/truth/vendors.mjs`，必须带官方 URL 或 pi-ai 目录出处；要么有 `off` 档，要么写 `forcedThinking`。不要编造档位。

## 限制

- 密钥只写 `apiKeyEnv` 名，不落明文
- 插件经 settings 服务写入，不直接改 `settings.yaml`；无 CLI 那种备份
- 用户从 `models[]` 删掉的 id 记在 `.dsh-model-autoconfig.json` 的 `deletedIds`，不会被 `/models` 加回
- 视觉靠 `input: [text, image]`，schema 不认 audio
