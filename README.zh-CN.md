# agent-canary

[![CI](https://github.com/DorianChn/agent-canary/actions/workflows/ci.yml/badge.svg)](https://github.com/DorianChn/agent-canary/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**给 AI Agent 装的零误报绊线（canary tripwire）。** 当你的 AI 编程助手被提示注入攻击劫持时，第一时间知道——不是因为启发式规则"猜"到了，而是因为它碰了诱饵，而任何正常流程都永远不会碰诱饵。

English documentation: [README.md](README.md)

![agent-canary demo](docs/demo.gif)

---

## 20 秒讲清楚

店主在里屋放了一个接好警报器的假保险柜。真顾客永远不会碰它——所以警报一响，就是进贼了，零误报。

agent-canary 对 AI Agent（Claude Code、Cursor、Cline 或你自己写的）做同样的事。这些 Agent 能读文件、执行命令、调用 API，一旦被恶意网页/文档里的注入指令劫持，后果不堪设想：

1. **诱饵 MCP 工具** —— 假的"转账"工具、假的"读取生产密钥"工具、假的"以 root 执行命令"。健康的 Agent 永远不会调用它们；被劫持的会，你会立刻收到带完整攻击上下文的告警。
2. **金丝雀令牌** —— 植入蜜罐文件里的、毫无价值但全局唯一的 `cnry_…` 字符串。它一旦出现在 Agent 的输出、被外传的文件或对外请求里，就证明有密钥被偷了。没有第二种解释。

每个诱饵返回的假响应里都嵌了一次性的追踪令牌——如果攻击载荷把"偷到的密钥"外传了，令牌能告诉你泄露源自哪一次工具调用。

## 为什么不直接做提示注入检测？

注入检测器靠给文本打分来"猜"，要么误报淹没你，要么漏掉新载荷。金丝雀把问题反过来：

| | 注入检测器 | agent-canary |
|---|---|---|
| 信号 | "这段 prompt 看着可疑" | "诱饵被碰了" |
| 误报 | 多 | **结构性为零** |
| 新型攻击 | 时灵时不灵 | 都能抓——只要被劫持就会碰诱饵 |
| 接入成本 | 调参、接管道 | MCP 配置加一行 |

两者可以共存；金丝雀是那只从不乱叫的看门狗。

## 快速开始

```bash
npm install -g agent-canary

# 1. 在项目里撒一个假密钥蜜罐文件
agent-canary tokens plant .env.canary --label my-project

# 2. 把诱饵 MCP 服务器注册进 Claude Code（或 install cursor）
agent-canary install claude

# 3. 端到端验证告警链路
agent-canary alert-test
```

重启编辑器。Agent 现在能看到 8 个看起来很诱人、但绝不该碰的诱饵工具。它一旦碰了：

```console
$ agent-canary events
2026-09-15T10:21:04Z  decoy_called  tool=canary_read_secrets
2026-09-15T10:21:09Z  token_found   label=decoy:canary_read_secrets path=https://evil.example/collect
```

把令牌扫描接进你现有的任何流程：

```bash
agent-canary tokens check . && echo clean          # 发现泄露则 exit 1，可直接接 CI / git hook
agent-canary watch .                               # 实时监控：任何文件里出现令牌即告警
agent-canary set-webhook https://hooks.slack.com/… # 推送到 Slack / Discord / Telegram 桥接
```

## Agent 眼中的诱饵长什么样

诱饵全是"管理员级"的诱人工具，但**全部是空操作**——每个处理器只返回伪造输出：

| 诱饵工具 | 被劫持的 Agent 以为能拿到 |
|---|---|
| `canary_transfer_funds` | 管理员转账，5 万以下自动放行 |
| `canary_read_secrets` | 任意环境的生产 API 密钥 |
| `canary_run_shell` | 在构建服务器上以 root 执行任意命令 |
| `canary_delete_files` | 永久删除，无回收站 |
| `canary_send_email` | 以任意内部地址发邮件，跳过 SPF |
| `canary_export_database` | 全表导出 CSV，不留审计记录 |
| `canary_fetch_internal` | 从内网抓取管理后台 |
| `canary_disable_security` | 关闭终端防护/杀毒 |

告警里带全量上下文：哪个诱饵、什么参数、几点钟，外加单次调用的追踪令牌。

## 硬性保证

- **诱饵工具是惰性的。** `canary_run_shell` 不会执行任何命令，`canary_transfer_funds` 不会碰任何钱。每个处理器只返回以假乱真的*假*结果，别无其他。见 [SECURITY.md](SECURITY.md)。
- **金丝雀令牌解不开任何东西。** 它们是随机的 `cnry_…` 字符串，在哪儿都毫无价值。
- **无遥测。** 事件只留在你机器上的 `~/.agent-canary/events.jsonl`，除非你自己配置 webhook。
- **结构性零误报。** 诱饵和令牌都在一切正常工作流之外；"被触碰"本身就是信号。

## CLI 参考

```
agent-canary serve                  运行诱饵 MCP 服务器（编辑器启动的就是它）
agent-canary init                   初始化 ~/.agent-canary 和默认配置
agent-canary install claude|cursor  注册诱饵服务器到 MCP 客户端（先备份原配置）
agent-canary uninstall claude|cursor
agent-canary tokens generate --label <l> [-c n]
agent-canary tokens plant <file> --label <l> [-c n]
agent-canary tokens check [paths...] [--stdin]      发现泄露 exit 1
agent-canary tokens list / print --label <l>
agent-canary watch <paths...>       实时监控文件中的令牌泄露
agent-canary events [-n 20]         最近事件
agent-canary report                 Markdown 事件报告
agent-canary alert-test             测试全部告警通道
agent-canary set-webhook <url|null>
agent-canary set-notify <on|off>
```

配置在 `~/.agent-canary/config.json`：

```json
{ "webhook": null, "notify": true, "eventsFile": "~/.agent-canary/events.jsonl" }
```

## 工作原理

```
Claude Code / Cursor / 你的 Agent
        │  MCP 配置加一行
        ▼
┌───────────────────────────────┐
│ agent-canary（诱饵服务器）      │──被触碰──▶ 🚨 告警 + JSONL 审计留痕
│ 8 个惰性、诱人的假工具          │           + 假响应内嵌一次性追踪令牌
└───────────────────────────────┘
┌───────────────────────────────┐
│ 蜜罐文件/.env/数据库里的        │──令牌出现在任何地方──▶ 🚨 零误报告警
│ 金丝雀令牌                     │   （scan · watch · CI check）
└───────────────────────────────┘
```

## 路线图

- [x] v0.1 — 诱饵 MCP 服务器、金丝雀令牌、文件监控、JSONL + webhook + 桌面告警
- [ ] v0.2 — **评测模式**：用精选注入攻击套件测试任意 agent+模型组合，输出可复现的抵抗力评分
- [ ] v0.3 — 面板：跨会话攻击链时间线；SIEM 导出
- [ ] v0.4 — MCP 之外的 SDK 埋点（OpenAI / Anthropic agent SDK hooks）

## 兼容性

Node 20+，Windows / macOS / Linux。支持所有 MCP 客户端（Claude Code、Cursor、Cline、Windsurf…）。令牌扫描器和监控器对*任何* Agent 有效，无论是否用 MCP。

## 支持这个项目

agent-canary 免费、本地化、无遥测——但付费推广和服务器都是自掏腰包。如果它帮你抓到过一次注入：

- ⭐ **点个 Star**——对曝光最有帮助的一件事
- 💳 **GitHub Sponsors**——仓库顶部的 Sponsor 按钮
- 🧧 **微信支付 / 支付宝**——[`sponsor/`](sponsor/) 内置了自托管赞助收款网关：单文件服务，渲染二维码收款页，端到端校验微信支付（API v3 验签 + AES-GCM 回调解密）和支付宝（RSA2 异步通知）。无需商户资质即可用演示模式跑通全流程，见 [sponsor/README.md](sponsor/README.md)。

## 参与贡献

欢迎 issue 和 PR——尤其是新诱饵工具的设计和评测套件的注入载荷。请保持诱饵惰性；贡献者必须遵守的保证见 [SECURITY.md](SECURITY.md)。

## 许可证

MIT
