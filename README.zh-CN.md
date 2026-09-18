# agent-canary

给 AI 编程 agent 装绊线。它在你的环境里布置诱饵 MCP 工具和金丝雀令牌，agent 一旦碰到，说明它被提示注入劫持了，你会收到带完整攻击上下文的告警。

支持 Claude Code、Cursor、Cline、Windsurf 等所有 MCP 客户端。非 MCP 的自研 agent 可以用 SDK。Node 20+，MIT，无遥测。

中文文档（本文件）｜ [English](README.md)

## 问题背景

编程 agent 能读文件、执行命令、调 API。如果它读到被投毒的 README、网页或文档，跟着里面的恶意指令走，可能会悄悄外传密钥，而你没有收到任何提示。

现有的防御方案靠给 prompt 打分，误报率高，误报多的告警等于没有告警。agent-canary 反过来做：布置一些正常工作流永远不会碰的东西，碰到就是真实信号。

- **诱饵 MCP 工具**：假的转账、假的生产密钥读取、假的 root shell。它们从不执行真实操作，但被劫持的 agent 会去调。
- **金丝雀令牌**：埋在蜜罐文件里的唯一 `cnry_...` 字符串。它出现在 agent 输出、外发请求或 git diff 里，就说明密钥被复制了，没有别的解释。

每个假工具的返回内容里带一次性追踪令牌，"密钥"被外传时能定位到具体哪次调用泄露的。

## 安装

要求：Node.js 20 或更高版本。安装包是编译后的软件，不需要克隆私有 V2 源码。

下载安装包：

    https://github.com/DorianChn/agent-canary/releases/download/v2.0.0-personal/agent-canary-2.0.0.tgz

安装：

    npm install -g ./agent-canary-2.0.0.tgz
    agent-canary --help

Windows PowerShell 下载：

    Invoke-WebRequest -Uri https://github.com/DorianChn/agent-canary/releases/download/v2.0.0-personal/agent-canary-2.0.0.tgz -OutFile agent-canary-2.0.0.tgz
    npm install -g .\agent-canary-2.0.0.tgz

也可以从源码安装：

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

## 免费版与个人版

[下载 V2 Personal 软件包（GitHub Release）](https://github.com/DorianChn/agent-canary/releases/tag/v2.0.0-personal)

这是同一个 CLI 软件：未激活时使用永久免费 V1，激活成功后显示并解锁 V2 功能。

本仓库只公开永久免费 V1 基础版。这里仅介绍 V2 Personal 的订阅权益；
V2 付费实现、签名私钥、客户记录和交付包不放入公开仓库。

| | 免费版（永久） | 个人版（$10/月） |
|---|---|---|
| 诱饵服务器、令牌、监控、告警、安装 | 有 | 有 |
| `eval` 注入抗性评分 | | 有 |
| `dashboard` 攻击链时间线 | | 有 |
| `export` CEF / JSON / CSV 导出 | | 有 |
| `agent-canary/sdk` 非 MCP 接入 | | 有 |

付费功能由许可控制。在赞助页（微信/支付宝）订阅后：

    agent-canary activate --code <一次性 V2 激活码>

网关签发 30 天许可，绑定设备指纹（每个订阅最多 3 台机器），CLI 每次加载都验签。改许可文件、架假许可服务器、回拨系统时钟都会被识别。到期重跑同一条命令。

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
    status, activate, alert-test, set-webhook, set-notify

`agent-canary --help` 看详情。

## 许可证

MIT
