# 验证记录（2026-10-16）

环境：Windows、Bun 1.4.3、Node.js、隔离的 Magpie 插件宿主。以下是从插件 `loader.fetch` 发出的实际 HTTP 请求结果，使用 `public` 和 Kilo 匿名模式，无个人 API Key。每个模型仅发送一条无敏感内容的极短请求，最多同时两条，单条超时 45 秒。目录和模型状态可能随时间变化。

隔离 Magpie 宿主从本地仓库加载出了 `zen-free-all` 11 个模型和 `kilo-free-all` 17 个模型；Jev 标有 `decides: true`，Muse Spark 1.2 保留在 Zen 列表。Node.js 自动化测试 8 项通过。

## OpenCode Zen

| 模型 ID | 结果 |
| --- | --- |
| `big-pickle` | 矩阵单次 45 秒超时；先前单独测试 HTTP 200，返回 `OK` |
| `cat-jam-free` | 200，有文本 |
| `mimo-v2.6-flash-free` | 200，有文本 |
| `muse-spark-1.2-contributor-free` | Responses 200，完成且有文本 |
| `muse-spark-1.3-contributor-free` | Responses 200，完成且有文本 |
| `nemotron-3.5-super-vl-free` | 200，有文本 |
| `nemotron-3.5-lightning-free` | 200，有文本 |
| `jev-1.13-free` | 原生 System One 200，有结构化判断 |
| `longcat-2.5-preview-free` | 200，有文本 |
| `deepseek-v4.1-flash-free` | 200，有文本 |
| `space-bunny-free` | 200，有文本 |

`cat-jam-free` 的流式请求返回 200、7 个 SSE 事件并以 `[DONE]` 结束。首次流式测试在刷新目录时发生一次 `ECONNRESET`，再次独立测试成功；未放宽失败时的目录核验。

## Kilo Gateway 匿名模式

| 模型 ID | 结果 |
| --- | --- |
| `kilo-auto/free` | 200，有文本，报告费用 0 |
| `nvidia/nemotron-3.5-super-vl:free` | 200，有文本，报告费用 0 |
| `stealth/glyph-cluster` | 200，但 128 token 内只有推理内容、无最终文本，`finish_reason: length` |
| `dots-studio/dots-3-note-preview:free` | 200，有文本，报告费用 0 |
| `liquid/lfm-2.5-2.6b:free` | 200，有文本，报告费用 0 |
| `nvidia/nemotron-3.5-lightning:free` | 200，有文本，报告费用 0 |
| `thinkingmachines/inkling-small:free` | 429，上游每日限额已满 |
| `poolside/laguna-s-2.1:free` | 200，有文本，报告费用 0 |
| `poolside/laguna-xs-2.1:free` | 429，上游返回限流或服务错误 |
| `cohere/north-mini-code:free` | 429，上游高需求限流 |
| `nvidia/nemotron-3.5-content-safety:free` | 200，有文本，报告费用 0 |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | 200，有文本，报告费用 0 |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | 200，有文本，报告费用 0 |
| `google/lyria-3-pro-preview` | 401，上游要求登录；个人 Key 未测试 |
| `google/lyria-3-clip-preview` | 401，上游要求登录；个人 Key 未测试 |
| `nvidia/nemotron-3-super-120b-a12b:free` | 200，有文本，报告费用 0 |
| `openrouter/free` | 200，有文本，报告费用 0 |

`dots-studio/dots-3-note-preview:free` 的流式请求返回 200、24 个 SSE 事件并以 `[DONE]` 结束。Kilo 默认匿名请求未发送 `Authorization` 头。已验证可选 Key 路径在本地测试中转发给上游；没有使用真实个人 Key 做外部请求。

自动化测试还验证：转付费或从实时目录移除的模型被拒绝，目录不可达时展示缓存但拒绝未经近期核验的推理，并发刷新合并，缓存到期再次刷新；Jev 请求不注入聊天工具或流参数，聊天请求会被拒绝。动态目录可列出模型，但上游限流、登录要求与实际生成能力由各网关决定。

## 0.1.1 自动同步增量验证

2026-10-16 使用可变的模拟上游和可控时钟，沿两个真实 `provider.models` 钩子及 `loader.fetch` 路径验证：新免费模型自动出现，移除与转收费后被拒绝；成功空目录清空列表；目录失败可回退展示但拒绝推理。Zen 补充元数据失败时，新普通 `-free` 模型仍可走默认 Chat Completions；明确的其他 SDK 和未知 Jev 不会错路由。已确认收费的模型即使后来元数据请求失败或成功响应漏掉该 ID，仍须等明确零价记录才恢复；无免费后缀模型不会沿用旧零价。`npm test` 共 10 项通过。

自动重列时机依据 Magpie 官方源码提交 [`a15e576`](https://github.com/yetone/magpie/commit/a15e576564cb90d4d027e8b8cb7821472de0a3fc)：[首次约 1 分钟、随后每小时](https://github.com/yetone/magpie/blob/a15e576564cb90d4d027e8b8cb7821472de0a3fc/internal/provider/plugin_relist.go#L22-L67)，由[网关后台任务](https://github.com/yetone/magpie/blob/a15e576564cb90d4d027e8b8cb7821472de0a3fc/internal/gateway/gateway.go#L560)执行。本次没有重跑 0.1.0 的逐模型在线请求；本节为本地端到端模拟验证，在线服务的即时状态未重新验证。
