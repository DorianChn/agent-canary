/**
 * 赞助网关冒烟测试（CI 用，demo 模式零依赖外部服务）。
 * 启动 server.m于随机端口，验证：页面渲染 / 下单 / QR 接口 / 订单轮询 / 手动登记 / 订阅状态。
 * 运行：node smoke.mjs（在 sponsor/ 目录）
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.AGENT_CANARY_HOME_DUMMY = "1"; // no-op, keeps intent obvious

const PORT = 8189;
const BASE = `http://127.0.0.1:${PORT}`;
// Never share persistence with the live gateway. The smoke server creates all
// order/subscription/license state below this disposable directory.
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agent-canary-sponsor-"));
const server = spawn(process.execPath, ["server.mjs"], {
  cwd: __dirname,
  env: {
    ...process.env,
    PORT: String(PORT),
    DEMO: "1",
    PUBLIC_BASE_URL: BASE,
    DATA_DIR: TEST_DATA_DIR,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr.on("data", (d) => process.stderr.write(`[sponsor] ${d}`));

async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) return true; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

let failures = 0;
function check(name, ok) {
  console.log(`${ok ? "ok" : "FAIL"} - ${name}`);
  if (!ok) failures++;
}

try {
  const up = await waitFor(async () => (await fetch(BASE + "/")).status === 200);
  check("server boots in demo mode", up);

  const page = await (await fetch(BASE + "/")).text();
  check("page renders personal plan card", page.includes("个人版 Personal"));
  check("page renders donation section (demo)", page.includes("一次性赞助"));

  const qrRes = await fetch(BASE + "/api/qr?text=hello");
  check("qr endpoint serves png", qrRes.status === 200 && qrRes.headers.get("content-type") === "image/png");

  const order = await (await fetch(BASE + "/api/order", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel: "wechat", plan: "personal", handle: "smoke-test" }),
  })).json();
  check("personal order created", order.ok === undefined && !!order.orderId && order.qr.includes("/demo/pay/"));

  const payPage = await fetch(BASE + `/demo/pay/${order.orderId}`);
  check("demo pay page renders", payPage.status === 200);
  await fetch(BASE + `/demo/confirm/${order.orderId}`);

  const status = await (await fetch(BASE + "/api/order/" + order.orderId)).json();
  check("order auto-confirms in demo", status.status === "paid");

  const sub = await (await fetch(BASE + "/api/subscription/smoke-test")).json();
  check("subscription activated (+30d)", sub.active === true && !!sub.expiresAt);

  const bad = await fetch(BASE + "/api/order", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel: "wechat", plan: "personal" }),
  });
  check("personal order without handle rejected", bad.status === 400);

  const claim = await (await fetch(BASE + "/api/manual-claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel: "alipay", plan: "personal", handle: "manual-test" }),
  })).json();
  check("manual claim accepted", claim.ok === true);

  // license activation: machine binding + limit (LICENSE_MAX_MACHINES default 3)
  const crypto = await import("node:crypto");
  fs.writeFileSync(path.join(TEST_DATA_DIR, "subscribers.json"),
    JSON.stringify({ "LH": { handle: "LH", expiresAt: new Date(Date.now() + 864e5).toISOString() } }));
  const act = (h) => fetch(BASE + "/api/activate", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle: "LH", machineHash: crypto.randomBytes(31).toString("hex") + String(h).padStart(2, "0") }),
  });
  const r1 = await act(1), r2 = await act(2), r3 = await act(3), r4 = await act(4);
  if (!(r1.ok && r2.ok && r3.ok)) {
    console.log("debug r1:", r1.status, await r1.clone().text());
    console.log("debug r2:", r2.status, await r2.clone().text());
  }
  check("activation 1-3 accepted", r1.ok && r2.ok && r3.ok);
  const r4body = await r4.json();
  check("4th machine rejected (machine_limit)", r4.status === 403 && r4body.code === "machine_limit");
  fs.rmSync(path.join(TEST_DATA_DIR, "subscribers.json"), { force: true });
} catch (err) {
  failures++;
  console.log("FAIL - unexpected error:", err.message);
} finally {
  server.kill();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
}

process.exit(failures ? 1 : 0);
