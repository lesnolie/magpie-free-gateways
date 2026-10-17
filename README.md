# Magpie Free Gateways

一个 Magpie 插件包，提供两个互不冲突的供应商：OpenCode Zen 免费模型和 Kilo Gateway 零价模型。模型列表取自各网关的实时 `/models`，新增和下架无需更新插件版本。此仓库尚未发布到 npm，建议从 GitHub 或本地目录安装。

## 安装和登录

> ⚠️ **OpenCode Zen `public` 免费通道：代理出口 IP 可能被封禁。** 使用 VPN、网络代理或云服务器中转（尤其 AWS 等数据中心出口 IP）访问时，Zen / Cloudflare 等上游风控可能直接拦截该**出口 IP**，返回 HTTP 403 等拒绝响应。**即使只有一个人在使用该 IP、调用量很少，也不能据此认为不会被拦截。** 建议在服务支持的地区**关闭代理，优先使用本地网络直连**，并确认 Magpie 实际使用的出口网络，而不只是浏览器的网络设置。是否封禁、封禁范围及具体判定规则由上游决定，目前不能确认「所有 AWS IP 必然封禁」；直连也不保证解除既有限制。切勿通过频繁更换 IP 绕过服务端限制。

```sh
magpie plugin add github:lesnolie/magpie-free-gateways
magpie plugin login zen-free-all
magpie plugin login kilo-free-all
```

也可下载仓库后运行 `magpie plugin add ./magpie-free-gateways`。Zen 登录界面填 `public`，插件只接受公开凭据。Kilo 选择“匿名免费访问”并填 `anonymous`；插件不会把这个占位值发给 Kilo。Kilo 也可选择自己的 API Key，插件只允许实时目录中所有价格字段为零的模型通过。密钥由 Magpie 管理，插件不写入日志。

两个供应商分别是 `zen-free-all/<模型 ID>` 和 `kilo-free-all/<模型 ID>`。它们不会覆盖已有的 `opencode-zen-free` 供应商。安装后可用 `magpie plugin --json` 查看加载状态、模型和登录方式；模型是否显示在某个代理的选择器中，还取决于该代理在 Magpie 的可见模型设置。

## OpenCode Zen

2026-10-16 的实时目录列出以下 11 个免费模型。模型 ID 以实时目录为准，列表可变。

| 模型 ID | 接口 |
| --- | --- |
| `big-pickle` | Chat Completions |
| `cat-jam-free` | Chat Completions |
| `mimo-v2.6-flash-free` | Chat Completions |
| `muse-spark-1.2-contributor-free` | Responses |
| `muse-spark-1.3-contributor-free` | Responses |
| `nemotron-3.5-super-vl-free` | Chat Completions |
| `nemotron-3.5-lightning-free` | Chat Completions |
| `jev-1.13-free` | System One 决策 |
| `longcat-2.5-preview-free` | Chat Completions |
| `deepseek-v4.1-flash-free` | Chat Completions |
| `space-bunny-free` | Chat Completions |

Zen 的实时模型目录仍列出 Muse Spark 1.2，虽然补充元数据标为 `deprecated`。本插件以实时目录为准，把这个仍在目录内的免费模型呈给 Magpie；上游若移除它，插件随刷新移除。`big-pickle` 没有 `-free` 后缀，但补充目录确认输入、输出及缓存价格为零，所以允许它。

### 使用 Jev

Jev 是 TypeSafe 的 **System One 结构化判断模型**。Magpie 原生支持分类器：本插件为 Zen 设置 `decide: true`，为 Jev 设置 `decides: true`。它可以在 Magpie 的智能路由组中充当分类器；Magpie 会将它从普通代理聊天模型中隐藏，并向插件的 `/systemone` 发送 `{model, state, questions}`。插件再转发到 OpenCode 的 System One 接口。

一次最小的判断请求长这样：

```json
{
  "model": "jev-1.13-free",
  "state": "The item arrived broken. Please send a replacement.",
  "questions": {
    "replacement": {
      "type": "noul",
      "instructions": "Does the customer request a replacement?"
    }
  }
}
```

返回的是 `answers.replacement.noul` 概率。例如 `0.98` 表示对“顾客要求换货”的肯定概率约为 98%。Jev 不生成自由文本、代码或普通多轮聊天，也没有聊天工具调用；插件会拒绝把 Jev 发往聊天接口。[Magpie 插件与决策 API 文档](https://usemagpie.ai/docs/zh/plugins)、[TypeSafe API](https://docs.typesafe.ai/api)。

## Kilo Gateway

2026-10-16 的实时 `/models` 中有 17 个价格字段全部为零的 ID，其中包括 `kilo-auto/free` 和 `openrouter/free` 两个自动路由模型：

| 模型 ID | 模型 ID |
| --- | --- |
| `kilo-auto/free` | `openrouter/free` |
| `nvidia/nemotron-3.5-super-vl:free` | `nvidia/nemotron-3.5-lightning:free` |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | `nvidia/nemotron-3-super-120b-a12b:free` |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | `nvidia/nemotron-3.5-content-safety:free` |
| `dots-studio/dots-3-note-preview:free` | `liquid/lfm-2.5-2.6b:free` |
| `thinkingmachines/inkling-small:free` | `poolside/laguna-s-2.1:free` |
| `poolside/laguna-xs-2.1:free` | `cohere/north-mini-code:free` |
| `stealth/glyph-cluster` | `google/lyria-3-pro-preview` |
| `google/lyria-3-clip-preview` | |

三个 NVIDIA 模型的完整 ID 比常见简称更长；请复制表中实时目录给出的完整 ID。`stealth/glyph-cluster` 和两个 Lyria 音乐模型的 ID 不带 `:free`，但实时价格字段均为零，所以也在列表内。**两个 Lyria 匿名请求均返回 401，提示需要登录**；使用它们须通过插件可选的 Kilo 个人 API Key 登录。我们未用个人密钥验证 Lyria 的实际生成或 Magpie 音频展示。内容安全模型没有工具调用能力，插件按上游元数据标识。

Kilo 官方说明免费模型允许匿名访问，按 IP 每小时 200 次请求。`kilo-auto/free` 的实际目标会在服务端变化；它及 NVIDIA 免费端点可能由上游记录输入与输出，使用时请留意其[官方数据处理说明](https://kilo.ai/docs/gateway/models-and-providers)。

## 发现、请求与限制

已登录供应商的 `provider.models` 钩子被 Magpie 调用时，插件读取实时目录。根据 [Magpie 当前的刷新实现](https://github.com/yetone/magpie/blob/a15e576564cb90d4d027e8b8cb7821472de0a3fc/internal/provider/plugin_relist.go#L22-L67)，运行中的网关约在启动 1 分钟后首次重新读取插件目录，之后每小时读取一次；登录、插件变更或手动刷新也会触发读取。插件缓存 30 秒，用于合并密集的目录查询和推理前核验，**不是每 30 秒主动刷新界面**。自动重列由 [Magpie 网关启动的后台任务](https://github.com/yetone/magpie/blob/a15e576564cb90d4d027e8b8cb7821472de0a3fc/internal/gateway/gateway.go#L560)完成；代理的模型选择器仍受 Magpie 可见模型设置和刷新时机影响。

目录请求超时 8 秒，同时触发的刷新合并为一次请求。成功读取空目录表示当前没有符合条件的免费模型，插件会清空所列模型。请求失败时，Magpie 可继续展示上次列表或仓库内 2026-10-16 的离线快照；**发送推理请求前必须成功读取近期实时目录**。某个模型已移除、变为收费，或目录无法确认时，插件拒绝转发请求。即使 Magpie 保留了已选模型，插件也不会把未经核验的请求发往上游。离线快照只用于启动展示，不作为付费安全判断。

Zen 的实时模型 ID 列表是是否开放免费模型的依据；补充目录提供价格、能力、上下文长度和接口协议。带 `-free` 的新普通模型在补充目录暂时不可用时按 Zen 默认的 Chat Completions 接口接入；明确标注其他不支持接口的模型不会错送到聊天接口。新 Jev 模型需有明确的 System One 接口信息才能接入。已确认非零价的模型持续被拒绝，直到补充目录明确恢复零价；`big-pickle` 等无 `-free` 后缀的模型每次刷新都需要当次零价证据。Kilo 同时检查输入、输出、请求、图片、缓存、联网和其他可见收费字段；任一非零就排除。动态列表只代表网关当前声明的免费可用性，**不保证每个上游推理请求都成功**，也不保证未来不变。模型自身的限流、服务错误或接口能力差异仍会影响请求。

本插件在 Magpie 插件宿主内通过 `fetch` 发请求，不启动外部程序或绕过 TLS 校验。Zen 的聊天、Responses 协议保留现有社区插件的工具与流处理；Kilo 使用 Chat Completions 原样透传。未经测试的输出形式和上游能力不作保证。

2026-10-16 的逐模型实测状态、匿名认证与流式请求结果见 [验证报告](VERIFICATION.md)。

## 开发与许可

```sh
npm test
```

项目使用 MIT 许可。[NOTICE.md](NOTICE.md) 记录从 `@magpie-community/opencode-zen-free-auth` 0.1.9 复用的代码和原作者版权。
