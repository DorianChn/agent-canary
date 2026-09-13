# 参与贡献

## 报告问题

开 issue 时请附上 `agent-canary doctor` 的输出（可脱敏），能省一轮往返。

## 加代码

    git clone https://github.com/DorianChn/agent-canary && cd agent-canary
    npm install && npm run build && npm test

提交前测试必须全绿（当前 32 个）。

## 加诱饵工具

`src/decoys.ts` 里每个诱饵约 30 行：名字、描述（要写得让被劫持的 agent 心动）、
JSON Schema、伪造返回。硬性规则见 [SECURITY.md](SECURITY.md)：

- 诱饵永不执行真实操作，处理器只返回捏造的文本
- 返回内容里必须内嵌一次性追踪令牌（`token` 参数）

改完跑 `npm test`，其中有一条专门测试"诱饵永不执行真实操作"。

## 赞助网关（sponsor/）

改 `sponsor/server.mjs` 后运行：

    cd sponsor && node smoke.mjs

14 项断言全过再提交。签名密钥（license-keys.json）、订阅数据（subscribers.json）
永远不要提交进仓库。

## 提交信息

一行说清"做了什么"，正文补充"为什么"。
