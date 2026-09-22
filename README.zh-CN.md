# agent-canary

给 AI 编程 agent 装绊线。它在你的环境里布置诱饵 MCP 工具和金丝雀令牌，并给 SDK 集成提供会话熔断器，在发现失陷信号后阻断下一次经过守卫的真实操作。

支持 Claude Code、Cursor、Cline、Windsurf 等所有 MCP 客户端。非 MCP 的自研 agent 可以用 SDK。Node 20+，MIT，无遥测。

中文文档（本文件）｜ [English](README.md)

[在线体验与赞助](https://dorianchn.github.io/shanchuanzhi-agent-canary/) · [Glama 条目](https://glama.ai/mcp/servers/DorianChn/shanchuanzhi-agent-canary) · [GitHub Discussions](https://github.com/DorianChn/shanchuanzhi-agent-canary/discussions)

![Agent Canary — AI Agent / MCP 安全](docs/agent-canary-cover-v2.png)

## V1.2.7：隔离状态会覆盖紧随其后的重试

V1.2.7 是免费公开版本线。它保留零误报检测模型和免费的 SDK 隔离能力，
新增 `createGuardedToolRouter()`，让诱饵和真实工具共用一条经过审查的分发路径；
同时保留完全离线的 `self-test` 和 JSONL / webhook 出口的统一审计脱敏；还会发布精简的 MCP server instructions，让目录和客户端在调用工具前明确知道诱饵无害，以及受守卫隔离的适用边界。使用短期、会话范围 vault 引用的宿主可以额外接入不含 secret 的 `credentialRevoker`，在隔离完成、告警发送前开始吊销；还可用显式共享状态仓库让同一已审查身份的新会话继承隔离状态：

| 层 | 作用 |
|---|---|
| 检测 | 不执行真实操作的诱饵 MCP 工具与已埋放的金丝雀令牌发现失陷信号。 |
| 隔离 | 同步执行 `SAFE → TRIPPED → QUARANTINED`；Router 把诱饵送入隔离，把真实工具送入失败闭合 guard。 |
| 告警 | 状态变更之后写入 JSONL 审计事件，并可发送 webhook / 桌面告警；工具参数和金丝雀值会脱敏。 |

```text
不可信内容 → 提示注入 → 触碰诱饵 / 发现令牌
                              ↓
                        SESSION TRIPPED
                              ↓
                         QUARANTINED
                              ↓
                     危险的受守卫工具调用
                              ↓
                           BLOCKED
                              ↓
                      告警 + 本地审计日志
```

完整 API 与边界见 [docs/containment.md](docs/containment.md)。
V2.x 付费功能单独维护和交付；V2.1 不从此分支公开上传。

## 问题背景

编程 agent 能读文件、执行命令、调 API。如果它读到被投毒的 README、网页或文档，跟着里面的恶意指令走，可能会悄悄外传密钥，而你没有收到任何提示。

现有的防御方案靠给 prompt 打分，误报率高，误报多的告警等于没有告警。agent-canary 反过来做：布置一些正常工作流永远不会碰的东西，碰到就是真实信号。

- **诱饵 MCP 工具**：假的转账、假的生产密钥读取、假的 root shell。它们从不执行真实操作，但被劫持的 agent 会去调。
- **金丝雀令牌**：埋在蜜罐文件里的唯一 `cnry_...` 字符串。它出现在 agent 输出、外发请求或 git diff 里，就说明密钥被复制了，没有别的解释。

每个假工具的返回内容里带一次性追踪令牌，"密钥"被外传时能定位到具体哪次调用泄露的。

## 安装免费 V1.2.7

要求：Node.js 20 或更高版本。公开源码构建包含免费 V1.2.7 基础能力：

    git clone https://github.com/DorianChn/shanchuanzhi-agent-canary && cd shanchuanzhi-agent-canary
    npm install && npm run build && npm link

执行 `agent-canary --help` 后，再运行离线隔离自检。公开仓库和公开安装包只
包含免费 V1 版本线；V2.x 在确认付款后单独私下交付，不从这个公开源码分支分发。

### 容器与 Glama 评测

仓库提供一个最小化、仅 stdio 的 Docker 镜像，供 Glama 等 MCP 目录构建免费 V1
服务并内省工具 schema；该过程不需要凭据、网络访问或 V2 交付包：

    docker build -t agent-canary .
    docker run --rm -i agent-canary

镜像启动的是 `agent-canary serve`，提供与本地 V1 CLI 相同的无害诱饵工具；其中不
包含真实工具执行、收款、许可证或客户数据。

## 使用

    # 埋一个假密钥蜜罐文件
    agent-canary tokens plant .env.canary --label my-project

    # 注册 12 个诱饵工具到 Claude Code（Cursor 用 install cursor）
    agent-canary install claude

    # 验证告警链路
    agent-canary alert-test

    # 在本地验证 SAFE → QUARANTINED → BLOCKED；不会访问网络或写入用户数据
    agent-canary self-test

重启编辑器。之后如果 agent 调了诱饵或泄露了令牌：

    $ agent-canary events
    2026-09-15T10:21:04Z  decoy_called  tool=canary_read_secrets
    2026-09-15T10:21:09Z  token_found   label=my-project path=report.md

扫描器可以直接接 CI（发现泄露 exit 1），也有实时监控：

    agent-canary tokens check . && echo clean
    agent-canary watch .

## 诱饵清单

agent 眼里这些都是管理员级工具，但它们什么都不做。

| 诱饵工具 | 被劫持的 agent 以为能拿到（仅模拟） |
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

本仓库只公开永久免费 V1 基础版。这里仅介绍 V2 Personal 的订阅权益；
V2 付费实现、签名私钥、客户记录和交付包不放入公开仓库。

| | 免费版（永久） | 个人版（¥72 / 30 天） |
|---|---|---|
| 诱饵服务器、令牌、监控、告警、安装 | 有 | 有 |
| `eval` 注入抗性评分 | | 有 |
| `dashboard` 攻击链时间线 | | 有 |
| `export` CEF / JSON / CSV 导出 | | 有 |
| V1.2.7 会话熔断器、共享身份隔离、可选凭据吊销、受守卫工具 Router、MCP 安全说明与离线 `self-test` | 有 | 有 |
| SDK 诱饵处理与金丝雀扫描 | 有 | 有 |

V2 Personal 目前采用**人工确认**的微信/支付宝付款流程。请查看公开的[付款说明](https://dorianchn.github.io/shanchuanzhi-agent-canary/pay.html)：其中包含二维码、价格和交付所需信息。作者核对实际到账后才发送安装与激活说明；不承诺自动交付或即时激活。

## 合作与集成

欢迎 MCP 客户端维护者、AI Agent/框架作者、AI 安全研究者和 DevSecOps 团队开展定向合作：

- 集成到 MCP 客户端、Agent 框架或安全模板；
- 运行可复现的 Prompt Injection 抗性评测并共同发布结果；
- 在受控开发环境或 CI 中试点告警与审计链路；
- 讨论付费集成、私有部署或安全评估支持。

请在 [GitHub Discussions](https://github.com/DorianChn/shanchuanzhi-agent-canary/discussions)
说明集成目标、范围和首选联系方式。不要提交 API 密钥、付款凭证、客户数据或未公开漏洞。

## 分发与合作渠道

项目已进入[官方 MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.DorianChn%2Fagent-canary)，
并保留 [Glama 展示页](https://glama.ai/mcp/servers/DorianChn/shanchuanzhi-agent-canary)。如果要和更大的安全平台做集成，
[Snyk Technology Alliance Partner Program](https://snyk.io/partners/tapp/) 是一个候选渠道；正式申请或商业条款必须先由维护者确认。
我们不会批量发帖或向陌生人发送骚扰式推广。

## 非 MCP Agent（V1.2.7 免费受守卫工具 Router）

每个 agent 会话创建一个 guard，然后交给一个 Router。Router 用
`guard.runDecoy()` 回答诱饵，并把所有非诱饵回调交给
`guard.executeToolCall()`。

```ts
import { CanaryBlockedError, createAgentGuard, createGuardedToolRouter, decoyToolDefs } from "agent-canary/sdk";

const guard = createAgentGuard({
  sessionId: "support-chat-42",
  // 仅精确列出经审查的安全操作；默认空 allowlist。
  quarantineAllow: ["read_file", "git_status"],
});
const toolDefs = [...myRealToolSchemas, ...decoyToolDefs("openai")];
const router = createGuardedToolRouter({
  guard,
  executeRealTool: realTool, // 由宿主实现真实回调
});

await router.dispatch({ name: "git_status", args: {} });              // SAFE：允许
await router.dispatch({ name: "canary_read_secrets", args: {} });     // trip → quarantine

try {
  await router.dispatch({ name: "http_post", args: { url: "https://example.invalid" } });
} catch (error) {
  if (error instanceof CanaryBlockedError) console.log(error.decision); // action_blocked
}

// 只能放在真人的事件响应控制面，不能注册成 MCP/LLM 工具。
guard.reset({ acknowledgedBy: "on-call-human" });
```

`guard.inspect(agentOutput, "final-answer")` 发现已埋令牌时，会 trip 同一个会话。

## 注入抗性评测

V2 Personal 包含可复现的 20 条攻击载荷评测。人工查看可使用文本输出，CI
可使用 JSON；模型/API 失败会按失败闭合处理，不会被错误计为“已抵抗”：

    agent-canary eval --provider openai --model gpt-4o --format json
    agent-canary eval --provider openai --model deepseek-chat \
      --base-url https://api.deepseek.com/v1 --format json --out eval.json

`decoyToolDefs("anthropic")` 输出 Anthropic 格式。

## 面板与 SIEM

    agent-canary dashboard --out report.html   # 自包含 HTML 时间线
    agent-canary export --format cef           # 或 json、csv

## 保证与限制

- 诱饵工具从不执行真实操作。`canary_run_shell` 不会运行命令，处理器只返回伪造输出（见 [SECURITY.md](SECURITY.md)）。
- 金丝雀令牌在哪儿都解不开任何东西。
- 无遥测。事件留在 `~/.agent-canary/events.jsonl`，除非你自己配 webhook。
- 告警只在诱饵被触碰或令牌出现时产生，正常工作流碰不到它们。
- **隔离只覆盖已集成的调用链。** 只有经过 `router.dispatch()`、
  `guard.executeToolCall()` / `guard.beforeToolCall()` 的真实工具调用可以被阻断。如果被劫持 agent 的第一个危险操作绕过这些路径，agent-canary 无法拦截它。诱饵本身无害；一旦先碰到诱饵，guard 就能在之后的受守卫操作前隔离该会话。
- 此版本没有声称支持任意上游 MCP server 的代理；下一阶段的可审计 MCP proxy 设计见 [docs/containment.md](docs/containment.md)。

已知限制：这是 JavaScript，改 `dist/` 可以拆掉许可检查。签名许可提高了白嫖门槛，但它不是 DRM。

## 命令列表

    serve / init / install / uninstall
    tokens generate|plant|check|list
    watch, events, report, dashboard, export, eval
    self-test
    status, activate, alert-test, set-webhook, set-notify

`agent-canary --help` 看详情。

## 许可证

MIT
