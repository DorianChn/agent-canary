/**
 * agent-canary sponsor gateway.
 *
 * Self-hosted, single-file payment server that lets the project accept
 * WeChat Pay (Native scan-to-pay, API v3) and Alipay (当面付 precreate) —
 * used to fund paid promotion and hosting.
 *
 * Monetization:
 *  - one-off donations (presets / custom amount)
 *  - Personal Edition subscription: $10/month (billed in CNY), bound to a
 *    GitHub handle or email. WeChat/Alipay have no auto-debit for this use
 *    case, so a subscription = a 30-day entitlement; paying again extends
 *    from the current expiry (stackable), and GET /api/subscription/:handle
 *    is the single source of truth for "is this person entitled".
 *
 * Run `npm i && npm start` inside sponsor/. With DEMO=1 (default until you
 * fill .env) the whole flow works end-to-end with simulated payments, so you
 * can test the page, QR, polling and callbacks locally before touching money.
 *
 * Security notes:
 *  - credentials never leave this process; everything is env-based
 *  - WeChat callbacks are signature-verified (platform cert) + AES-256-GCM decrypted
 *  - Alipay notifications are RSA2-verified against the Alipay public key
 *  - amounts are validated server-side; the client never sets the price directly
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- config ----------
function loadDotEnv() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* .env optional */
  }
}
loadDotEnv();

const PORT = Number(process.env.PORT || 8787);
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const WECHAT = {
  mchid: process.env.WECHAT_MCHID || "",
  serial: process.env.WECHAT_SERIAL || "",
  appid: process.env.WECHAT_APPID || "",
  apiv3Key: process.env.WECHAT_APIV3_KEY || "",
  keyPath: process.env.WECHAT_PRIVATE_KEY_PATH || "",
  gateway: "https://api.mch.weixin.qq.com",
};
const ALIPAY = {
  appId: process.env.ALIPAY_APP_ID || "",
  privateKeyPath: process.env.ALIPAY_PRIVATE_KEY_PATH || "",
  publicKeyPath: process.env.ALIPAY_PUBLIC_KEY_PATH || "",
  gateway: process.env.ALIPAY_GATEWAY || "https://openapi.alipay.com/gateway.do",
};
// 易支付(Epay)协议聚合平台：个人免商户的常用通道（ZPAY / 七相PAY / 虎皮椒备用等均兼容此协议）。
// 填 EPAY_API_URL（如 https://zpayz.cn）、EPAY_PID、EPAY_KEY 三项即可启用。
const EPAY = {
  url: (process.env.EPAY_API_URL || "").replace(/\/$/, ""),
  pid: process.env.EPAY_PID || "",
  key: process.env.EPAY_KEY || "",
};
const WECHAT_READY = Boolean(WECHAT.mchid && WECHAT.serial && WECHAT.appid && WECHAT.apiv3Key && WECHAT.keyPath);
const ALIPAY_READY = Boolean(ALIPAY.appId && ALIPAY.privateKeyPath && ALIPAY.publicKeyPath);
const EPAY_READY = Boolean(EPAY.url && EPAY.pid && EPAY.key);
const DEMO = process.env.DEMO === "1" || (!WECHAT_READY && !ALIPAY_READY && !EPAY_READY && process.env.DEMO !== "0");
const PRESETS = [5, 10, 25, 50]; // CNY, one-off donations

// Personal Edition plan: $10/month, billed in CNY (rate configurable).
const PLAN = {
  personal: {
    usd: Number(process.env.PERSONAL_USD || 10),
    cny: Number(process.env.PERSONAL_CNY || 72),
    days: 30,
  },
};

// ---------- order store ----------
const ORDERS_FILE = path.join(__dirname, "orders.json");
const SUBS_FILE = path.join(__dirname, "subscribers.json");
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}
const orders = readJson(ORDERS_FILE, {});
function saveOrders() {
  writeJson(ORDERS_FILE, orders);
}

function newOrder(channel, amountYuan, note, plan = null, handle = null) {
  const id = crypto.randomBytes(8).toString("hex");
  const order = {
    id,
    channel,
    amount: Math.round(amountYuan * 100) / 100,
    note: (note || "").slice(0, 120),
    plan,
    handle,
    status: "created",
    outTradeNo: `AC${Date.now()}${crypto.randomBytes(3).toString("hex")}`.toUpperCase(),
    createdAt: new Date().toISOString(),
    paidAt: null,
    transactionId: null,
  };
  orders[id] = order;
  saveOrders();
  return order;
}
function markPaid(id, transactionId) {
  const o = orders[id];
  if (!o || o.status === "paid") return;
  o.status = "paid";
  o.paidAt = new Date().toISOString();
  o.transactionId = transactionId ?? o.transactionId ?? null;
  if (o.plan === "personal" && o.handle) {
    o.entitlementExpiresAt = extendSubscription(o.handle, o.id);
  }
  saveOrders();
  console.log(`[sponsor] order ${o.id.slice(0, 8)} PAID (${o.channel}, ¥${o.amount}${o.plan ? `, plan=${o.plan}` : ""})`);
}

// ---------- subscriptions ----------
function loadSubs() {
  return readJson(SUBS_FILE, {});
}
function extendSubscription(handle, orderId) {
  const subs = loadSubs();
  const now = Date.now();
  const current = subs[handle]?.expiresAt ? Date.parse(subs[handle].expiresAt) : 0;
  const expiresAt = new Date(Math.max(now, current) + PLAN.personal.days * 864e5).toISOString();
  subs[handle] = { handle, expiresAt, lastOrderId: orderId, updatedAt: new Date().toISOString() };
  writeJson(SUBS_FILE, subs);
  console.log(`[sponsor] personal edition for "${handle}" active until ${expiresAt}`);
  return expiresAt;
}

// ---------- WeChat Pay v3 helpers ----------
function readPrivateKey(p) {
  return fs.readFileSync(path.resolve(__dirname, p), "utf8");
}
async function wechatRequest(method, urlPath, bodyObj) {
  const body = bodyObj ? JSON.stringify(bodyObj) : "";
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString("hex");
  const message = `${method}\n${urlPath}\n${ts}\n${nonce}\n${body}\n`;
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(message)
    .sign(readPrivateKey(WECHAT.keyPath), "base64");
  const res = await fetch(WECHAT.gateway + urlPath, {
    method,
    headers: {
      Authorization: `WECHATPAY2-SHA256-RSA2048 mchid="${WECHAT.mchid}",nonce_str="${nonce}",signature="${signature}",timestamp="${ts}",serial_no="${WECHAT.serial}"`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "agent-canary-sponsor/0.1",
    },
    body: body || undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`WeChat API ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

// platform certificates: downloaded on demand, cached by serial
const platformKeys = new Map();
function gcmDecrypt(key, nonce, aad, ciphertextB64) {
  const buf = Buffer.from(ciphertextB64, "base64");
  const tag = buf.subarray(buf.length - 16);
  const data = buf.subarray(0, buf.length - 16);
  const d = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  d.setAAD(Buffer.from(aad || ""));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]);
}
async function ensurePlatformKey(serial) {
  if (platformKeys.has(serial)) return platformKeys.get(serial);
  const list = await wechatRequest("GET", "/v3/certificates");
  for (const item of list.data ?? []) {
    const pem = gcmDecrypt(
      Buffer.from(WECHAT.apiv3Key, "utf8"),
      item.encrypt_certificate.nonce,
      item.encrypt_certificate.associated_data,
      item.encrypt_certificate.ciphertext
    ).toString("utf8");
    platformKeys.set(item.serial_no, new crypto.X509Certificate(pem).publicKey);
  }
  const key = platformKeys.get(serial);
  if (!key) throw new Error(`Unknown Wechatpay-Serial: ${serial}`);
  return key;
}
async function verifyWechatCallback(headers, rawBody) {
  const { "wechatpay-timestamp": ts, "wechatpay-nonce": nonce, "wechatpay-signature": signature, "wechatpay-serial": serial } = headers;
  if (!ts || !nonce || !signature || !serial) return null;
  const pub = await ensurePlatformKey(serial);
  const ok = crypto
    .createVerify("RSA-SHA256")
    .update(`${ts}\n${nonce}\n${rawBody}\n`)
    .verify(pub, signature, "base64");
  if (!ok) return null;
  const evt = JSON.parse(rawBody);
  if (evt.resource) {
    evt.decrypted = JSON.parse(
      gcmDecrypt(
        Buffer.from(WECHAT.apiv3Key, "utf8"),
        evt.resource.nonce,
        evt.resource.associated_data,
        evt.resource.ciphertext
      ).toString("utf8")
    );
  }
  return evt;
}

async function createWechatOrder(order) {
  const res = await wechatRequest("POST", "/v3/pay/transactions/native", {
    appid: WECHAT.appid,
    mchid: WECHAT.mchid,
    description: order.plan === "personal" ? "agent-canary Personal Edition" : "agent-canary sponsorship",
    out_trade_no: order.outTradeNo,
    notify_url: `${PUBLIC_BASE}/callback/wechat`,
    amount: { total: Math.round(order.amount * 100), currency: "CNY" },
  });
  return res.code_url; // weixin://wxpay/bizpayurl?... → rendered as QR
}

// ---------- Alipay helpers ----------
function alipayTs() {
  const d = new Date();
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d);
  return `${date} ${time}`;
}
function alipaySignable(params) {
  return Object.keys(params)
    .filter((k) => k !== "sign" && params[k] !== "" && params[k] != null)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
}
function alipaySign(params) {
  return crypto.createSign("RSA-SHA256").update(alipaySignable(params)).sign(readPrivateKey(ALIPAY.privateKeyPath), "base64");
}
async function createAlipayOrder(order) {
  const params = {
    app_id: ALIPAY.appId,
    method: "alipay.trade.precreate",
    format: "JSON",
    charset: "utf-8",
    sign_type: "RSA2",
    timestamp: alipayTs(),
    version: "1.0",
    notify_url: `${PUBLIC_BASE}/callback/alipay`,
    biz_content: JSON.stringify({
      out_trade_no: order.outTradeNo,
      total_amount: order.amount.toFixed(2),
      subject: order.plan === "personal" ? "agent-canary Personal Edition" : "agent-canary sponsorship",
    }),
  };
  params.sign = alipaySign(params);
  const res = await fetch(ALIPAY.gateway, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const json = await res.json();
  const inner = json.alipay_trade_precreate_response;
  if (!inner || inner.code !== "10000") {
    throw new Error(`Alipay API: ${JSON.stringify(inner ?? json).slice(0, 300)}`);
  }
  return inner.qr_code;
}
function verifyAlipayNotify(form) {
  const params = { ...form };
  delete params.sign;
  delete params.sign_type;
  const query = alipaySignable(params);
  let pem = fs.readFileSync(path.resolve(__dirname, ALIPAY.publicKeyPath), "utf8");
  if (!pem.includes("BEGIN")) {
    pem = `-----BEGIN PUBLIC KEY-----\n${pem.replace(/\s+/g, "")}\n-----END PUBLIC KEY-----\n`;
  }
  return crypto.createVerify("RSA-SHA256").update(query).verify(pem, form.sign, "base64");
}

// ---------- 易支付(Epay)协议 helpers ----------
function epaySign(params, key) {
  const s =
    Object.keys(params)
      .filter((k) => k !== "sign" && k !== "sign_type" && params[k] !== "" && params[k] != null)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join("&") + key;
  return crypto.createHash("md5").update(s, "utf8").digest("hex");
}
function createEpayOrder(order) {
  const params = {
    pid: EPAY.pid,
    type: order.channel === "alipay" ? "alipay" : "wxpay",
    out_trade_no: order.outTradeNo,
    notify_url: `${PUBLIC_BASE}/callback/epay`,
    return_url: `${PUBLIC_BASE}/return`,
    name: order.plan === "personal" ? "agent-canary Personal Edition" : "agent-canary sponsorship",
    money: order.amount.toFixed(2),
    sitename: "agent-canary",
  };
  params.sign = epaySign(params, EPAY.key);
  params.sign_type = "MD5";
  return `${EPAY.url}/submit.php?${new URLSearchParams(params).toString()}`;
}

// ---------- payment creation dispatch ----------
async function createPayment(order) {
  if (DEMO) return `${PUBLIC_BASE}/demo/pay/${order.id}`;
  if (EPAY_READY) return createEpayOrder(order);
  if (order.channel === "wechat") {
    if (!WECHAT_READY) throw new Error("WeChat Pay credentials not configured (.env)");
    return createWechatOrder(order);
  }
  if (!ALIPAY_READY) throw new Error("Alipay credentials not configured (.env)");
  return createAlipayOrder(order);
}

// ---------- tiny HTTP framework ----------
function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, PUBLIC_BASE);
  try {
    // ---- sponsor page ----
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return send(res, 200, sponsorPage(), "text/html; charset=utf-8");
    }

    // ---- QR raster endpoint (page uses this for both real and demo QR) ----
    if (req.method === "GET" && url.pathname === "/api/qr") {
      const text = url.searchParams.get("text") || "";
      if (!text || text.length > 800) return send(res, 400, "bad text");
      const png = await QRCode.toBuffer(text, { width: 512, margin: 1 });
      return send(res, 200, png, "image/png");
    }

    // ---- API: create order (donation or Personal Edition subscription) ----
    if (req.method === "POST" && url.pathname === "/api/order") {
      const input = JSON.parse((await readBody(req)) || "{}");
      const channel = input.channel === "alipay" ? "alipay" : "wechat";
      let order;
      if (input.plan === "personal") {
        const handle = String(input.handle || "").trim().slice(0, 64);
        if (!handle) {
          return send(res, 400, JSON.stringify({ error: "handle required (GitHub 用户名或邮箱)" }), "application/json");
        }
        // price is server-authoritative for plan orders
        order = newOrder(channel, PLAN.personal.cny, input.note, "personal", handle);
      } else {
        const amount = Number(input.amount);
        if (!Number.isFinite(amount) || amount < 1 || amount > 10000) {
          return send(res, 400, JSON.stringify({ error: "invalid amount" }), "application/json");
        }
        order = newOrder(channel, amount, input.note);
      }
      try {
        order.qr = await createPayment(order);
        saveOrders();
      } catch (err) {
        order.status = "failed";
        order.error = String(err.message).slice(0, 300);
        saveOrders();
        return send(res, 502, JSON.stringify({ error: order.error }), "application/json");
      }
      return send(
        res,
        200,
        JSON.stringify({ orderId: order.id, qr: order.qr, demo: DEMO, plan: order.plan, handle: order.handle }),
        "application/json"
      );
    }

    // ---- API: order status (page polls this) ----
    if (req.method === "GET" && url.pathname.startsWith("/api/order/")) {
      const o = orders[url.pathname.split("/")[3]];
      if (!o) return send(res, 404, "no such order");
      return send(res, 200, JSON.stringify({ status: o.status, amount: o.amount, channel: o.channel, plan: o.plan }), "application/json");
    }

    // ---- API: subscription status — single source of truth for entitlement ----
    if (req.method === "GET" && url.pathname.startsWith("/api/subscription/")) {
      const handle = decodeURIComponent(url.pathname.split("/")[3] || "").trim();
      const s = loadSubs()[handle];
      const active = Boolean(s && Date.parse(s.expiresAt) > Date.now());
      return send(
        res,
        200,
        JSON.stringify({ handle, plan: "personal", active, expiresAt: s?.expiresAt ?? null, price: { usd: PLAN.personal.usd, cny: PLAN.personal.cny } }),
        "application/json"
      );
    }

    // ---- WeChat async callback ----
    if (req.method === "POST" && url.pathname === "/callback/wechat") {
      const raw = await readBody(req);
      const evt = await verifyWechatCallback(req.headers, raw).catch(() => null);
      if (!evt) return send(res, 401, JSON.stringify({ code: "FAIL", message: "bad signature" }), "application/json");
      const resource = evt.decrypted ?? {};
      const order = Object.values(orders).find((o) => o.outTradeNo === resource.out_trade_no);
      if (order && resource.trade_state === "SUCCESS") markPaid(order.id, resource.transaction_id);
      return send(res, 200, JSON.stringify({ code: "SUCCESS" }), "application/json");
    }

    // ---- Alipay async callback ----
    if (req.method === "POST" && url.pathname === "/callback/alipay") {
      const raw = await readBody(req);
      const form = Object.fromEntries(new URLSearchParams(raw));
      if (!verifyAlipayNotify(form)) return send(res, 401, "fail");
      const order = Object.values(orders).find((o) => o.outTradeNo === form.out_trade_no);
      if (order && (form.trade_status === "TRADE_SUCCESS" || form.trade_status === "TRADE_FINISHED")) {
        markPaid(order.id, form.trade_no);
      }
      return send(res, 200, "success");
    }

    // ---- 易支付(Epay) async callback (GET with signed params) ----
    if (req.method === "GET" && url.pathname === "/callback/epay") {
      const form = Object.fromEntries(url.searchParams);
      if (!EPAY_READY || form.sign !== epaySign(form, EPAY.key)) return send(res, 401, "fail");
      const order = Object.values(orders).find((o) => o.outTradeNo === form.out_trade_no);
      if (order && form.trade_status === "TRADE_SUCCESS") markPaid(order.id, form.trade_no);
      return send(res, 200, "success");
    }

    // ---- user-facing return page after payment ----
    if (req.method === "GET" && url.pathname === "/return") {
      return send(
        res,
        200,
        `<body style="font-family:sans-serif;background:#0d1117;color:#3fb950;text-align:center;padding-top:70px">
          <h1>✓ 支付完成</h1>
          <p style="color:#8b949e">感谢支持 agent-canary · <a href="/" style="color:#ffd338">返回赞助页</a></p>
        </body>`,
        "text/html; charset=utf-8"
      );
    }

    // ---- demo-mode simulated gateway ----
    if (DEMO && req.method === "GET" && url.pathname.startsWith("/demo/pay/")) {
      const o = orders[url.pathname.split("/")[3]];
      if (!o) return send(res, 404, "no such order");
      const what = o.plan === "personal" ? "个人版订阅" : "赞助";
      return send(
        res,
        200,
        `<body style="font-family:sans-serif;background:#0d1117;color:#c9d1d9;text-align:center;padding-top:60px">
          <h2>演示模式 — 模拟${o.channel === "wechat" ? "微信支付" : "支付宝"} · ${what}</h2>
          <p>订单 ${o.id.slice(0, 8)}… · ¥${o.amount.toFixed(2)}${o.handle ? ` · ${o.handle}` : ""}</p>
          <a href="/demo/confirm/${o.id}" style="display:inline-block;margin-top:20px;padding:12px 28px;background:#3fb950;color:#0d1117;border-radius:8px;text-decoration:none;font-weight:700">确认支付（模拟回调）</a>
        </body>`,
        "text/html; charset=utf-8"
      );
    }
    if (DEMO && req.method === "GET" && url.pathname.startsWith("/demo/confirm/")) {
      markPaid(url.pathname.split("/")[3], "DEMO_TXN");
      return send(
        res,
        200,
        `<body style="font-family:sans-serif;background:#0d1117;color:#3fb950;text-align:center;padding-top:60px"><h1>✓ 已支付（演示）</h1><p><a href="/" style="color:#8b949e">返回</a></p></body>`,
        "text/html; charset=utf-8"
      );
    }

    send(res, 404, "not found");
  } catch (err) {
    console.error("[sponsor]", err);
    send(res, 500, "internal error");
  }
});

// ---------- sponsor page ----------
function sponsorPage() {
  const p = PLAN.personal;
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sponsor agent-canary</title><style>
:root{--bg:#0d1117;--panel:#161b22;--fg:#c9d1d9;--dim:#8b949e;--y:#ffd338;--g:#3fb950}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--fg);font-family:'Segoe UI',system-ui,sans-serif;display:flex;justify-content:center;padding:48px 16px}
.box{width:100%;max-width:460px}
h1{color:#fff;font-size:26px}h1 span{color:var(--y)}
.sub{color:var(--dim);margin:8px 0 20px;font-size:14px}
.plan{background:var(--panel);border:1px solid var(--y);border-radius:12px;padding:18px;margin-bottom:22px}
.plan h2{color:#fff;font-size:18px}.plan h2 small{color:var(--y);font-weight:400;font-size:13px}
.plan ul{list-style:none;margin:10px 0 12px}
.plan li{font-size:13.5px;color:var(--fg);padding:3px 0}
.plan li::before{content:"▲ ";color:var(--y);font-size:10px}
.plan .fine{color:var(--dim);font-size:11.5px;margin-top:8px;line-height:1.5}
.donate-title{color:var(--dim);font-size:13px;margin-bottom:10px}
.tabs{display:flex;gap:8px;margin-bottom:14px}
.tab{flex:1;padding:10px;border:1px solid #30363d;border-radius:8px;text-align:center;cursor:pointer;background:var(--panel)}
.tab.on{border-color:var(--y);color:var(--y)}
.amts{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px}
.amt{padding:10px 0;border:1px solid #30363d;border-radius:8px;text-align:center;cursor:pointer;background:var(--panel)}
.amt.on{border-color:var(--y);color:var(--y)}
input{width:100%;padding:11px;border:1px solid #30363d;border-radius:8px;background:#010409;color:var(--fg);margin-bottom:12px;font-size:15px}
button{width:100%;padding:13px;border:0;border-radius:8px;background:var(--y);color:#0d1117;font-weight:700;font-size:16px;cursor:pointer;margin-bottom:10px}
button.ghost{background:transparent;border:1px solid #30363d;color:var(--fg)}
.qrbox{margin-top:18px;text-align:center;display:none}
.qrbox img{background:#fff;padding:10px;border-radius:12px;width:220px;height:220px}
.ok{color:var(--g);font-size:18px;font-weight:700;margin-top:10px;display:none}
.note{color:var(--dim);font-size:12px;margin-top:18px;line-height:1.6}
.demo{background:#2d2a12;color:var(--y);border:1px solid #5a4d12;border-radius:8px;padding:8px 12px;font-size:12px;margin-bottom:16px}
</style></head><body><div class="box">
<h1>支持 <span>agent-canary</span></h1>
<p class="sub">资金用于付费推广、服务器与持续开发 · Funds ads, hosting and development.</p>
${DEMO ? '<div class="demo">演示模式：扫码后打开的是模拟支付页，不会产生真实扣款。配置 .env 后自动切换为真实收款。</div>' : ""}

<div class="plan">
  <h2>个人版 Personal — ¥${p.cny}/月 <small>≈ US$${p.usd}/mo</small></h2>
  <ul>
    <li>赞助者名单署名（README + 落地页）</li>
    <li>Issue 优先响应 + 个人版标签</li>
    <li>新功能早期访问（评测模式 beta 等）</li>
  </ul>
  <input id="handle" placeholder="GitHub 用户名或邮箱（识别你的订阅）" maxlength="64">
  <button id="sub">订阅个人版 · ¥${p.cny}/月</button>
  <div class="fine">按 30 天为一期，到期后再次支付即自动顺延（可叠加）。微信/支付宝暂不支持自动代扣。绑定标识仅用于权益核对。</div>
  <div class="fine" id="subcheck"></div>
</div>

<div class="donate-title">或一次性赞助：</div>
<div class="tabs"><div class="tab on" id="t-wechat">微信支付</div><div class="tab" id="t-alipay">支付宝</div></div>
<div class="amts" id="amts"></div>
<input id="note" placeholder="留言（可选，120 字以内）" maxlength="120">
<button id="go" class="ghost">生成付款码</button>
<div class="qrbox" id="qrbox"><img id="qr" alt="付款二维码"><div id="st" class="sub" style="margin-top:10px">等待支付…</div><div class="ok" id="ok">✓ 支付成功，感谢支持！</div></div>
<p class="note">本页为自托管收款服务：微信/支付宝回调均经过签名验证。<br>项目：github.com/DorianChn/agent-canary</p>
</div>
<script>
let ch = "wechat";
const PLAN_CNY = ${p.cny};
const amts = [${PRESETS.join(",")}];
const amtsEl = document.getElementById("amts");
amts.forEach(a => {
  const d = document.createElement("div");
  d.className = "amt"; d.textContent = "¥" + a;
  d.onclick = () => { amount = a; [...amtsEl.children].forEach(x => x.classList.remove("on")); d.classList.add("on"); };
  amtsEl.appendChild(d);
});
let amount = null;
document.getElementById("t-wechat").onclick = () => setTab("wechat");
document.getElementById("t-alipay").onclick = () => setTab("alipay");
function setTab(c) {
  ch = c;
  document.getElementById("t-wechat").classList.toggle("on", c === "wechat");
  document.getElementById("t-alipay").classList.toggle("on", c === "alipay");
}
async function startOrder(body) {
  const r = await fetch("/api/order", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel: ch, ...body })
  });
  const j = await r.json();
  if (j.error) { alert("下单失败: " + j.error); return; }
  document.getElementById("qr").src = "/api/qr?text=" + encodeURIComponent(j.qr);
  document.getElementById("qrbox").style.display = "block";
  document.getElementById("ok").style.display = "none";
  document.getElementById("st").style.display = "block";
  const iv = setInterval(async () => {
    const s = await (await fetch("/api/order/" + j.orderId)).json();
    if (s.status === "paid") {
      clearInterval(iv);
      document.getElementById("st").style.display = "none";
      if (j.plan === "personal") {
        const sub = await (await fetch("/api/subscription/" + encodeURIComponent(j.handle))).json();
        document.getElementById("ok").textContent = "✓ 个人版已生效，有效期至 " + (sub.expiresAt || "").slice(0, 10);
      }
      document.getElementById("ok").style.display = "block";
    }
  }, 2000);
}
document.getElementById("sub").onclick = () => {
  const handle = document.getElementById("handle").value.trim();
  if (!handle) { alert("先填 GitHub 用户名或邮箱"); return; }
  startOrder({ plan: "personal", handle, note: document.getElementById("note").value });
};
document.getElementById("go").onclick = () => {
  if (!amount) { alert("先选一个金额"); return; }
  startOrder({ amount, note: document.getElementById("note").value });
};
// 订阅状态自查
document.getElementById("handle").addEventListener("change", async () => {
  const h = document.getElementById("handle").value.trim();
  if (!h) return;
  const s = await (await fetch("/api/subscription/" + encodeURIComponent(h))).json();
  document.getElementById("subcheck").textContent = s.active ? "当前状态：已生效，" + s.expiresAt.slice(0, 10) + " 到期" : "当前状态：无生效订阅";
});
</script></body></html>`;
}

server.listen(PORT, () => {
  console.log(`[sponsor] listening on ${PUBLIC_BASE}`);
  console.log(`[sponsor] mode: ${DEMO ? "DEMO (simulated payments)" : "LIVE"}`);
  console.log(`[sponsor] personal edition: $${PLAN.personal.usd}/mo = ¥${PLAN.personal.cny}/mo`);
  if (!DEMO) console.log(`[sponsor] wechat ready=${WECHAT_READY} alipay ready=${ALIPAY_READY}`);
});
