# dsh-model-autoconfig

DeepSeek Harness **web 插件**：在 Settings → Models 里填 URL 和密钥之后，自动把思考档位、视觉能力、协议、上下文写对。

**0.9.0 适配 Harness 0.1.2**：`settings.describe` / `replace` 仍是主写入路径；`mutate` 补传 `expectedRevision`（与 0.1.2 冲突检测契约对齐），旧宿主忽略第三参。

```bash
dsh plugin --profile web add dsh-model-autoconfig
```

然后打开 **Settings → Models**。自定义网关保存 URL + 密钥即可；官方 `deepseek` / `openai` 等只补档位和缺的视觉、不替换内置目录。不想自动写时在 `cordis.patch.yml` 设 `autoFill: false`。

用户入口就是原生 Models 页，没有单独的插件设置页。维护者仍可用下面的 CLI 和真值库。

## 它解决什么

dsh 原生的「Edit model settings」能填上下文、最大输出、输入/输出类型——**唯独没有思考强度那一栏**。
档位只能去 `settings.yaml` 手写 `reasoningEfforts`：没有表单、没有可选值提示、没有校验。
唯一没有 UI 的那一项，就是唯一总出错的那一项。

更糟的是内置目录本身就有洞。扫一遍 pi-ai 随包附带的模型目录：

```
模型总数            1312
声明了档位表         440
缺 off 键            195   ← 44%
```

`off` 键缺失会触发一个具体的 bug：上游判断写的是 `if (model.thinkingLevelMap?.off !== null)`，
而 `undefined !== null` 恒真 —— 于是思考被**无条件关闭**，长输出被静默截断在 8192 tokens
（dsh Discussion #1580）。显式写入 `off:`（空值）即可绕过。

本工具做四件事：

1. **审计并修复**内置目录里缺 `off` 的模型
2. 用**预先从各厂商官方文档抄录的真值库**，一条命令配好中转站/自定义网关
3. **补全视觉等 input 能力**（`input: [text, image]`）：自定义网关整条写上，官方目录只在内置条目没声明 image 时写入 override
4. **体检**现有配置，指出哪些档位是假的、哪些视觉漏标、哪些写法会被 dsh 拒绝

## 最短用法：厂商 + key

配一个官方厂商，**URL 和模型清单都不用填**：

```bash
dsh-mac add --id deepseek --vendor deepseek --key sk-xxxxx --apply
```

写进 settings.yaml 的是这样：

```yaml
llm-pi-ai:
  providers:
    deepseek:
      apiKeyEnv: DEEPSEEK_API_KEY
      modelOverrides:
        deepseek-v4-flash:
          reasoningEfforts:
            "off":
            "low": low
            "high": high
            "max": max
        deepseek-v4-pro:
          reasoningEfforts:
            "off":
            "low": low
            "high": high
            "max": max
```

为什么这么短：route 名 `deepseek` 正好是 pi-ai 内置目录里的 provider 名，
**端点、协议、模型目录全部自动继承**，只有档位表是坏的、需要纠正。
官方类型注释原话：*"correct one model, keep the other thirty-seven is a three-line edit"*。

### 模型 id 从哪来

**不是我硬编码在真值库里的** —— 那种清单三个月就过期。是从你本机 pi-ai 的
目录数据（`@earendil-works/pi-ai/dist/providers/data/*.json`）里读出来的，
所以永远跟你装的版本同步。真值库只负责一件事：**把每个 id 的档位表算对**。

### 认不出原名怎么办：硬映射 + 软匹配

中转站爱改模型名：日期快照（`deepseek-v4-pro-0813`）、量化后缀（`-fp8`）、
档位变体（`deepseek-v4-flash-high`）、分隔符乱写（`glm-5_3` / `kimi-k2-5`）、
任意尾段（`-preview`）。匹配分两层，按序尝试、**首个命中即停**；
发给网关的 id 永远保持原样，真值只决定档位表长什么样：

1. **硬映射**（`src/aliases.mjs`）：一张人工维护的表，已知第三方 id → 规范 id，
   键一律小写。宁缺毋滥 —— 软匹配能靠规律解决的不要堆进表。表有自己的守护测试：
   值必须被真值库**原样**命中、键必须小写、每条都必须能经硬映射解析。
2. **软匹配**（`src/match.mjs`）：原样 → 去前缀（`vendor/model`）→ 软变换。
   软变换按「精确 → 通用」排序：去日期后缀（`-0813` / `-20251001` / `-2025-10-01`）→
   去量化后缀 → 去档位后缀 → 分隔符归一（`_`→`-`、数字间 `-`→`.`）→
   从右往左剥尾段兜底。**原样永远排第一**：`qwen3.8-max` 这种本名以档位词结尾的 id，
   先原样命中就轮不到剥后缀，不会被配错。
   解析路径会写进日志：`deepseek-v4-pro-0813: 按「deepseek-v4-pro」配档位（硬映射）`。

### 中转站怎么办

中转站 pi-ai 目录里没有，必须给 URL；但模型清单仍然可以不填：

```bash
# 认得出厂商 → 自动上该厂商全部模型
dsh-mac add --id cpa --url https://gw.example/v1 --vendor deepseek --key sk-xxx --apply

# 网关有 /models 接口 → 拉下来逐个匹配真值库
dsh-mac add --id cpa --url https://gw.example/v1 --key sk-xxx --fetch --apply

# 都不行 → 手动列（一等公民路径，很多网关本来就没有 /models）
dsh-mac add --id cpa --url https://gw.example/v1 --models a,b,c --key sk-xxx --apply
```

三条路平权。区别只在「模型 id 从哪来」，档位表一律由真值库算。

## 关于 dsh 网页设置页

**dsh 自带的 Settings → Models 页面就是编辑入口**，本工具不抢这个活。

分工是这样的：

| 谁 | 干什么 |
| --- | --- |
| 本工具 | 把 `settings.yaml` 里的档位表**一次性填对** |
| dsh 网页 Settings → Models | 你在上面**看和改**，改完立刻生效（`applies: live`） |

本工具写完之后，网页那个 "Edit model settings" 弹窗里的 effort 下拉框
就会显示正确的档位，而不是缺档位或者点了不生效。

**为什么不做成网页里的一个配置页**：dsh 的设置页不是「有 schema 就自动渲染表单」，
而是插件往 `settings.section` 这类槽位里**塞自己的 UI 组件**（见
`@deepseek-ai/dsh-client-ui-settings` 的 README）。那需要写一个浏览器侧插件、
接客户端构建链，并且没跑起 `dsh web` 就没法验证渲染对不对。
真要做是能做的，但那是另一个量级的工程，不该混在这个工具里悄悄夹带。

## 先跑这个：`dsh-mac scan`

任何时候，如果某条命令说「没找到 llm-pi-ai provider 配置」，**先跑 scan**，
它会一次性告诉你：配置文件在哪、长什么形状、本工具认不认得。

```bash
dsh-mac scan
dsh-mac scan --dump          # 顺便打印文件原文
```

输出分四节：

1. **配置文件在哪** —— 把 Windows / Linux / macOS 上所有可能的落点都列出来，打勾的是真实存在的
2. **正在分析** —— 实际读的是哪个文件、顶层有哪些键
3. **本工具认识的形状** —— A / B / C 三种形状命中了哪个
4. **全树深搜** —— 就算三种形状都没命中，也会把文件里所有「像 provider 的配置」（带 baseURL / models / apiKeyEnv 的节点）挖出来，告诉你它在哪条路径上

### 三种结局

| scan 的结论 | 含义 | 怎么办 |
| --- | --- | --- |
| 「配置是干净的，你还没加过任何自定义网关」 | **这不是错误**。你的模型全部走 pi-ai 内置目录 | 跑 `audit` 修内置目录，或跑 `add` 配自己的网关 |
| 「形状正常，N 个 provider 可被本工具管理」 | 一切正常 | 跑 `doctor` 体检 |
| 「用了本工具还不认识的配置形状」 | 你的 dsh 版本把 providers 放在别处 | 用 `--at <路径>` 手工指定，路径就是 scan 第 4 节打印的那个 |

`--at` 对所有命令通用：

```bash
dsh-mac doctor --at llm.providers
dsh-mac add --at llm.providers --id cpa --url ... --models ...
```

一句话：**`doctor` 说「没有配置」，九成是你确实还没配过，不是工具坏了。`scan` 会替你确认这一点。**

## 安装

用户：

```bash
# dsh plugin 依赖 pnpm（Windows 上可用：npm install -g pnpm）
dsh plugin --profile web add dsh-model-autoconfig
```

维护者（真值库 / 单测 / CLI）：

```bash
git clone <repo> && cd dsh-model-autoconfig
npm install          # 只有一个依赖：yaml
npm test
node bin/dsh-mac.mjs --help
```

> **默认一律 dry-run**，只打印将要写入的 YAML。加 `--apply` 才落盘，落盘前自动备份到 `$DSH_HOME/backups/`。

## 用法

### 1. 审计内置目录

```bash
dsh-mac audit                      # 全量
dsh-mac audit --provider deepseek  # 只看某个 provider
```

### 2. 修 off 缺失（输出被截断就是它）

```bash
dsh-mac fix-off --provider deepseek           # 预览
dsh-mac fix-off --provider deepseek --apply   # 落盘
```

写出来是这样——`"off":` 空值就是修复本身：

```yaml
llm-pi-ai:
  providers:
    deepseek:
      modelOverrides:
        deepseek-v4-flash:
          reasoningEfforts:
            "off":
            "low": low
            "high": high
            "max": max
```

### 3. 配一个中转站

```bash
dsh-mac add --id cpa --url https://gw.example.com/v1 \
  --models deepseek-v4-flash,glm-5.3,grok-4.6,claude-opus-5 \
  --max-tokens 128000 --key sk-xxx --apply
```

URL 认不出厂商没关系——工具会**按 model id 逐个在真值库里匹配**，这正是中转站的正常路径。

```
编译结果 4 个模型
  deepseek-v4-flash    deepseek    1000000 ctx  128000 out  Off · Low · High · Max
  glm-5.3              zai         1000000 ctx  128000 out  Low · High · Max
  grok-4.6             xai          500000 ctx  128000 out  Low · Medium · High · Extra high
  claude-opus-5        anthropic   1000000 ctx  128000 out  Off · Low · Medium · High · Extra high · Max

提示
  deepseek-v4-flash: 输出上限被端点裁剪：官方 384000 → 端点 128000
  deepseek-v4-flash: 已写入显式 off:（空值）—— 这是修复思考被强制关闭 / 输出被截断的关键
  glm-5.3: 约束：GLM-5.3 强制思考，thinking.type 只接受 enabled —— 故不提供 off 档
  grok-4.6: 推理不可关闭，无 off/none 档；默认 high
  claude-opus-5: 约束：Opus 5 在 xhigh/max 下不允许 thinking disabled，会 400
```

没有 `/models` 接口的网关，`--models` 手动列出就是**一等公民路径**；有的话可以改用 `--fetch`。

### 4. 体检

```bash
dsh-mac doctor
```

```
cpa openai-completions https://api.deepseek.com
  ✗ deepseek-v4-flash
      缺 off 档 → 思考会被无条件关闭、长输出可能被截断（真值库：该模型可关闭思考）
      比真值库(deepseek)少了档位 max
      档位 medium 会被服务端静默塌缩成 high —— 是假档位，建议删掉
```

## 真值库覆盖

12 家厂商 / 37 条模型规则，每条都带官方文档出处：

| 厂商 | 关键陷阱 |
|---|---|
| DeepSeek | 只有 low/high/max 三档，**medium 与 xhigh 会被静默塌缩成 high** |
| OpenAI | `minimal` 与 `none` 是**代际替换**：gpt-5 有 minimal 无 none，5.1+ 反之 |
| OpenAI Codex | 多一档 `ultra`（并行子代理，非思考深度）；枚举含 `Custom(String)`，不可做封闭校验 |
| Anthropic | `effort` 与 `thinking` 正交；`thinking.type: enabled` 在 4.7+ 直接 400；Opus 5 在 xhigh/max 下禁 disabled |
| 智谱 GLM / Z.ai | **GLM-5.3 强制思考**，只有 low/high/max，传 disabled 请求失败 |
| Qwen | 仅 qwen3.8-max 有离散档位；effort 与 thinking_budget 互斥 |
| Kimi | k3 用顶层 reasoning_effort；k2.7-code 只接受 enabled 且不支持 effort |
| MiniMax | `thinking.type` **没有 enabled 这个值**，只有 adaptive/disabled；M2.x 不可关 |
| xAI Grok | 推理不可关闭，**无 off 档**；grok-4.5 把 xhigh 静默降级为 high |
| Groq | 按模型族分裂：gpt-oss 用 low/medium/high，qwen 用 none/default |
| Gemini | 3.x 思考不可关闭；兼容层的 `none` 只对 2.5 有效 |
| OpenRouter | 7 档统一层；对 Gemini 3 把 xhigh 压平为 high |

补一家很简单：往 `src/vendors.mjs` 加一条规则，`npm test` 跑快照。

## 工具遵守的 dsh 硬约束

这些来自 `@deepseek-ai/dsh-llm-pi-ai@0.0.1-rc.1` 的类型定义。违反会被 `assertServiceable`
以 `settings-rejected` **整段拒绝**，而不是被忽略：

1. `reasoningEfforts` 里**只有 `off` 允许空值**，其余每个声明的档位必须给 wire 拼写
2. 模型级 `compat` 只有 `thinkingFormat` / `supportsReasoningEffort` 两个字段，
   且 pi-ai 只在 `OpenAICompletionsCompat` 上定义它们 —— **只能出现在 `api: openai-completions` 的 route 上**
3. `modelOverrides` 只在「内置目录 route + 没有 `models` 列表」时有效，
   且不能命名目录里不存在的模型 —— 所以自定义网关**必须**用 `models`
4. `off` 在 YAML 1.1 里是布尔字面量，工具一律输出 `"off":` 带引号，避免被解析成 `false`

另有一条请求路径的坑（不是 schema，是运行时）：路由级 `reasoning:` 默认档
**不会被 clamp** —— `options.reasoningEffort ?? profile.reasoning` 不在该模型
档位表里就直接 `UNSUPPORTED_REASONING_EFFORT`。所以写入前必须收敛到该路由
所有推理模型的**共有档**（`pickRouteEffort`）：DeepSeek 路由的 medium 写成 high，
没有共有档就不写。CLI 和插件走同一条规则，两条入口不会写出不一样的值。

## 已知限制

- **视觉能力靠 `input` 数组，没有单独的 vision 开关。** dsh 0.1.1-rc.2 合法值只有 `text` / `image`；
  写 `input: [text, image]` 即视觉模型。适配器会读配置里的 `input`（自定义网关没有目录条目，
  不写就会被当成纯文本，发图报 `UNSUPPORTED_CONTENT`）。本工具默认写；`--no-io` 可关。
  `output` 官方类型没有，从不写。Settings → Models 的模型编辑表单目前没有 Input types 勾选框，
  模态只能靠本插件或 YAML 写入。声明是对端点的断言，dsh 不探测网关。
  补全策略是**只增不减**：真值库、`/models` 自报、已有配置、id 里的 `vl`/`vision`/`omni` 取并集，
  不把用户已经声明的 image 剥掉。真值库不认识、名字也看不出的模型不动。
- **API Key 走 `apiKeyEnv`。** rc.1 的 schema 只有 `apiKeyEnv`（环境变量**名**），
  没有内联明文 `apiKey`。所以工具生成 `apiKeyEnv: <ROUTE>_API_KEY` 并打印对应的 `export` 行，
  密钥本身不落任何文件。这是 schema 限制，不是安全设计。
- **删除是持久的。** 插件把用户从 `models[]` 里删掉的 id 记进 `.dsh-model-autoconfig.json` 的
  `sync.deletedIds`，之后 `/models` 再报出它也不会加回来。恢复方式：在 Settings → Models 手动
  把模型加回去（手加的永远保留），或删掉 state 文件里该 route 的 `deletedIds` 数组。
- **CLI 与插件的处理不对称。** 地址规范化（剥 `/chat/completions`、补 `/v1`）只在插件路径生效，
  CLI 写入你给的原始 URL；协议实测探测（POST `/responses`）只在 CLI 有。同一个网关走两条路
  可能得到不同的 `baseURL`/`api`。协议认不出端点时两边都按 `openai-completions` 兜底：
  CLI 会警告，插件只写一条 info 日志；URL 后来命中真值库时插件会自动修正，CLI 不会重跑。
- **CLI 的默认配置文件**：设了 `DSH_HOME` 就无条件用它（新建也建在那里）；未设时取
  「已存在的那个」（`~/.dsh` → `~/.config/dsh` → AppData……，顺序同 `dsh-mac scan` 第 1 节），
  都不存在时新建 `~/.dsh/settings.yaml`。
- **用户主路径是 web 插件**（`src/plugin.mjs`）：监视 `llm-pi-ai`，自定义网关写 `models[]`，官方目录只写 `modelOverrides`。不注册自己的设置页（第三方进不了 `WEB_SETTINGS_NAMESPACES`）。CLI 留给维护者。

## 目录结构

```
bin/dsh-mac.mjs      CLI 入口
src/levels.mjs       ModelThinkingLevel 全集 + UI 标签（xhigh → "Extra high"）
src/modalities.mjs   请求模态（text/image）归一、并集、名字启发式
src/vendors.mjs      厂商真值库 ← 核心资产，纯数据
src/aliases.mjs      硬映射表：已知第三方 id → 规范 id（纯数据）
src/match.mjs        软匹配候选生成：日期/量化/档位后缀、分隔符归一、截断兜底
src/compile.mjs      编译器：真值 → dsh 条目（纯函数，可快照测试）
src/catalog.mjs      读取并审计 pi-ai 内置目录
src/settings.mjs     settings.yaml 定位 / 读写 / 三方合并 / 备份
src/discover.mjs     GET /models + 协议探测
src/plugin.mjs       dsh web 插件（监视 llm-pi-ai）
src/sync.mjs         路由分类 + 写入规划（纯函数）
src/diff.mjs         CLI 落盘前的行级 diff 预览
src/index.mjs        公开 API 聚合（`dsh-model-autoconfig/lib` 子路径）
test/                node:test
```

## 安全网

如实按入口说（两条路的能力不一样）：

**CLI（`dsh-mac`）**
- 默认 dry-run，`--apply` 才落盘；落盘前备份到 `$DSH_HOME/backups/`，保留最近 10 份
- 三方合并**只保护 `models[]` 条目里的非档位字段**：`.dsh-model-autoconfig.json` 里存有上一次写入的基线时，你手改过的字段保留，本次计算值作为建议打印出来
- 不在保护范围内的：首次运行（没有基线）、`modelOverrides` 路径（官方目录 route 的档位表一律按真值库重算覆盖）、以及 `reasoningEfforts` 本身（档位表必覆盖——这是工具存在的意义）

**插件（web 主路径）**
- 事件触发即写，没有 dry-run、没有备份——它通过 dsh 的 settings 服务写入，不直接碰 `settings.yaml` 文件
- `reasoningEfforts` 档位表必覆盖；`input` 只增不减（漏标的视觉会补上，已声明的 image 不剥）；条目里其余字段（上下文、输出上限等）手改保留
- 写入回声抑制：自己刚写入的快照再次触发 `settings/updated` 时不会引起下一轮同步；写失败会打 error 日志
- 完全不想让它写：`cordis.patch.yml` 里 `autoFill: false`，只加载不写
