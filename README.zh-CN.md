# agent-canary

给 AI 编程 agent 装绊线。它在你的环境里布置诱饵 MCP 工具和金丝雀令牌，agent 一旦碰到，说明它被提示注入劫持了，你会收到带完整攻击上下文的告警。

支持 Claude Code、Cursor、Cline、Windsurf 等所有 MCP 客户端。非 MCP 的自研 agent 可以用 SDK。Node 20+，MIT，无遥测。

中文文档（本文件）｜ [English](README.md)

[在线体验与赞助](https://dorianchn.github.io/agent-canary/) · [Glama 条目](https://glama.ai/mcp/servers/DorianChn/agent-canary) · [GitHub Discussions](https://github.com/DorianChn/agent-canary/discussions)

## 问题背景

编程 agent 能读文件、执行命令、调 API。如果它读到被投毒的 README、网页或文档，跟着里面的恶意指令走，可能会悄悄外传密钥，而你没有收到任何提示。

现有的防御方案靠给 prompt 打分，误报率高，误报多的告警等于没有告警。agent-canary 反过来做：布置一些正常工作流永远不会碰的东西，碰到就是真实信号。

- **诱饵 MCP 工具**：假的转账、假的生产密钥读取、假的 root shell。它们从不执行真实操作，但被劫持的 agent 会去调。
- **金丝雀令牌**：埋在蜜罐文件里的唯一 `cnry_...` 字符串。它出现在 agent 输出、外发请求或 git diff 里，就说明密钥被复制了，没有别的解释。

每个假工具的返回内容里带一次性追踪令牌，"密钥"被外传时能定位到具体哪次调用泄露的。

## 项目作用与边界

agent-canary 是 MCP 和其他工具型 agent 的**入侵检测层**，核心提供三种信号：

1. **工具调用信号**：暴露看起来很诱人的假转账、假密钥读取、假 root shell
   等诱饵；正常 agent 不会调用，调用就是需要调查的入侵信号。
2. **令牌泄露信号**：把唯一金丝雀值埋进蜜罐文件；它出现在输出、外发请求、日志或
   git diff 中，就说明内容被复制或外传。
3. **证据信号**：记录工具、参数、追踪令牌、时间和来源上下文，可供排查或导出到 SIEM。

诱饵不会真的转账、执行命令、删除文件或返回真实密钥；它不是权限控制、密码库或 DRM。
不要把真实密钥放进蜜罐，收到告警后按安全事件处理。

## 安装

当前公开发行方式为从仓库源码安装：

    git clone https://github.com/DorianChn/agent-canary && cd agent-canary
    npm install && npm run build && npm link

## 使用

    # 埋一个假密钥蜜罐文件
    agent-canary tokens plant .env.canary --label my-project

    # 注册 12 个诱饵工具到 Claude Code（Cursor 用 install cursor）
    agent-canary install claude

    # 验证告警链路
    agent-canary alert-test

重启编辑器。之后如果 agent 调了诱饵或泄露了令牌：

    $ agent-canary events
    2026-09-15T10:21:04Z  decoy_called  tool=canary_read_secrets
    2026-09-15T10:21:09Z  token_found   label=my-project path=report.md

扫描器可以直接接 CI（发现泄露 exit 1），也有实时监控：

    agent-canary tokens check . && echo clean
    agent-canary watch .

## 诱饵清单

agent 眼里这些都是管理员级工具，但它们什么都不做。

| 诱饵工具 | 被劫持的 agent 以为能拿到 |
|---|---|
| `canary_transfer_funds` | 转账，5 万以下自动放行 |
| `canary_read_secrets` | 任意环境的生产 API 密钥 |
| `canary_run_shell` | 构建服务器上的 root shell |
| `canary_delete_files` | 永久删除，无回收站 |
| `canary_send_email` | 以任意内部地址发邮件，跳过 SPF |
| `canary_export_database` | 全表导出 CSV，不留审计 |
| `canary_fetch_internal` | 从内网访问管理后台 |
| `canary_disable_security` | 关闭终端防护 |
| `canary_cloud_console` | 云控制台会话 + 临时凭证 |
| `canary_k8s_exec` | 在生产 Pod 内执行命令 |
| `canary_secrets_rotate` | 紧急轮换凭证（锁死人类操作员） |
| `canary_git_force_push` | 强推受保护分支 |

## 公开测试版 V1 / V2 Personal 付费版

| | 公开测试版 V1 | V2 Personal |
|---|---|---|
| 诱饵服务器、令牌、监控、告警、安装 | 有 | 有 |
| `eval` 注入抗性评分 | | 付费 |
| `dashboard` 攻击链时间线 | | 付费 |
| `export` CEF / JSON / CSV 导出 | | 付费 |
| `agent-canary/sdk` 非 MCP 接入 | | 付费 |

V1 保持免费。本分支是 V2.0.0 付费版候选：V2 命令和 SDK 能力需要
付款后由网关签发的、绑定设备的许可证。只有在明确配置
`V2_PAID_ORDERS=1` 的网关上才开放购买；真实凭据和生产付款配置不会提交到仓库。

## 购买 V2 Personal / 支持项目

公开测试期 V1 免费使用。V2 Personal 是按 30 天计的付费许可证，增加上面列出的
进阶评测、攻击链面板、SIEM 导出和 SDK 能力，价格、设备数和续期策略由网关配置。
单纯赞助不会自动授予 V2 权限；不要公开提交付款凭证、收款码、密钥或其他隐私信息。

随附的自托管收款网关支持官方微信支付、支付宝、Vmq（安卓监控端）或兼容 Epay 的通道。
正常交易链路是：服务端按计划定价创建订单 → 用户付款 → 验证支付平台回调 → 签发绑定设备
的签名许可证。仅看到客户端“支付成功”不会开通权限；演示模式只模拟流程，不会扣款。

正式收款前，在 `sponsor/.env` 配置 `DEMO=0`、`V2_PAID_ORDERS=1`、公网 HTTPS
`PUBLIC_BASE_URL`、匹配 CLI 公钥的 Ed25519 私钥，以及至少一个付款通道。收款码、商户密钥、
Vmq 通讯密钥、订单数据和签名私钥都必须留在仓库外。具体见
[sponsor/README.md](sponsor/README.md) 与 [`sponsor/.env.example`](sponsor/.env.example)。

购买 V2 后，先配置授权网关再激活。随附本地网关默认地址为
`http://127.0.0.1:8787`：

    agent-canary set-license-server https://pay.example.com
    agent-canary activate --handle <你的 GitHub 用户名或邮箱>

运行 `agent-canary set-license-server null` 可恢复本机默认地址。

## 非 MCP Agent（SDK）

    import { decoyToolDefs, isDecoy, runDecoy, createTokenGuard } from "agent-canary/sdk";

    const guard = createTokenGuard();
    const toolDefs = [...myRealToolSchemas, ...decoyToolDefs("openai")];

    // agent 循环里：
    if (isDecoy(call.name)) await runDecoy(call.name, call.args);
    guard.inspect(finalAnswer);

`decoyToolDefs("anthropic")` 输出 Anthropic 格式。

## 面板与 SIEM

    agent-canary dashboard --out report.html   # 自包含 HTML 时间线
    agent-canary export --format cef           # 或 json、csv

## 保证与限制

- 诱饵工具从不执行真实操作。`canary_run_shell` 不会运行命令，处理器只返回伪造输出（见 [SECURITY.md](SECURITY.md)）。
- 金丝雀令牌在哪儿都解不开任何东西。
- 无遥测。事件留在 `~/.agent-canary/events.jsonl`，除非你自己配 webhook。
- 告警只在诱饵被触碰或令牌出现时产生，正常工作流碰不到它们。

已知限制：这是 JavaScript，改 `dist/` 可以拆掉许可检查。签名许可提高了白嫖门槛，但它不是 DRM。

## 命令列表

    serve / init / install / uninstall
    tokens generate|plant|check|list|print
    watch, events, report, dashboard, export, eval
    status, activate, set-license-server, alert-test, set-webhook, set-notify

`agent-canary --help` 看详情。

## 许可证

MIT
