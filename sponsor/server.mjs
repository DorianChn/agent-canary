/**
 * agent-canary sponsor gateway.
 *
 * Self-hosted, single-file payment server that lets the project accept
 * WeChat Pay (Native scan-to-pay, API v3) and Alipay (当面付 precreate) —
 * used to fund paid promotion and hosting.
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
const WECHAT_READY = Boolean(WECHAT.mchid && WECHAT.serial && WECHAT.appid && WECHAT.apiv3Key && WECHAT.keyPath);
const ALIPAY_READY = Boolean(ALIPAY.appId && ALIPAY.privateKeyPath && ALIPAY.publicKeyPath);
const DEMO = process.env.DEMO === "1" || (!WECHAT_READY && !ALIPAY_READY && process.env.DEMO !== "0");
const PRESETS = [5, 10, 25, 50]; // CNY

// ---------- order store ----------
const ORDERS_FILE = path.join(__dirname, "orders.json");
function loadOrders() {
  try {
    return JSON.parse(fs.readFileSync(ORDERS_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveOrders() {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2) + "\n");
}
const orders = loadOrders();

function newOrder(channel, amountYuan, note) {
  const id = crypto.randomBytes(8).toString("hex");
  const order = {
    id,
    channel,
    amount: Math.round(amountYuan * 100) / 100,
    note: (note || "").slice(0, 120),
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
  saveOrders();
  console.log(`[sponsor] order ${id.slice(0, 8)} PAID (${o.channel}, ¥${o.amount})`);
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
    description: "agent-canary sponsorship",
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
      subject: "agent-canary sponsorship",
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

// ---------- payment creation dispatch ----------
async function createPayment(order) {
  if (DEMO) return `${PUBLIC_BASE}/demo/pay/${order.id}`;
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

    // ---- API: create order ----
    if (req.method === "POST" && url.pathname === "/api/order") {
      const input = JSON.parse((await readBody(req)) || "{}");
      const amount = Number(input.amount);
      if (!Number.isFinite(amount) || amount < 1 || amount > 10000) {
        return send(res, 400, JSON.stringify({ error: "invalid amount" }), "application/json");
      }
      const channel = input.channel === "alipay" ? "alipay" : "wechat";
      const order = newOrder(channel, amount, input.note);
      try {
        order.qr = await createPayment(order);
        saveOrders();
      } catch (err) {
        order.status = "failed";
        order.error = String(err.message).slice(0, 300);
        saveOrders();
        return send(res, 502, JSON.stringify({ error: order.error }), "application/json");
      }
      return send(res, 200, JSON.stringify({ orderId: order.id, qr: order.qr, demo: DEMO }), "application/json");
    }

    // ---- API: order status (page polls this) ----
    if (req.method === "GET" && url.pathname.startsWith("/api/order/")) {
      const o = orders[url.pathname.split("/")[3]];
      if (!o) return send(res, 404, "no such order");
      return send(res, 200, JSON.stringify({ status: o.status, amount: o.amount, channel: o.channel }), "application/json");
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

    // ---- demo-mode simulated gateway ----
    if (DEMO && req.method === "GET" && url.pathname.startsWith("/demo/pay/")) {
      const o = orders[url.pathname.split("/")[3]];
      if (!o) return send(res, 404, "no such order");
      return send(
        res,
        200,
        `<body style="font-family:sans-serif;background:#0d1117;color:#c9d1d9;text-align:center;padding-top:60px">
          <h2>演示模式 — 模拟${o.channel === "wechat" ? "微信支付" : "支付宝"}</h2>
          <p>订单 ${o.id.slice(0, 8)}… · ¥${o.amount.toFixed(2)}</p>
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
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sponsor agent-canary</title><style>
:root{--bg:#0d1117;--panel:#161b22;--fg:#c9d1d9;--dim:#8b949e;--y:#ffd338;--g:#3fb950}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--fg);font-family:'Segoe UI',system-ui,sans-serif;display:flex;justify-content:center;padding:48px 16px}
.box{width:100%;max-width:420px}
h1{color:#fff;font-size:26px}h1 span{color:var(--y)}
.sub{color:var(--dim);margin:8px 0 22px;font-size:14px}
.tabs{display:flex;gap:8px;margin-bottom:14px}
.tab{flex:1;padding:10px;border:1px solid #30363d;border-radius:8px;text-align:center;cursor:pointer;background:var(--panel)}
.tab.on{border-color:var(--y);color:var(--y)}
.amts{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px}
.amt{padding:10px 0;border:1px solid #30363d;border-radius:8px;text-align:center;cursor:pointer;background:var(--panel)}
.amt.on{border-color:var(--y);color:var(--y)}
input{width:100%;padding:11px;border:1px solid #30363d;border-radius:8px;background:#010409;color:var(--fg);margin-bottom:12px;font-size:15px}
button{width:100%;padding:13px;border:0;border-radius:8px;background:var(--y);color:#0d1117;font-weight:700;font-size:16px;cursor:pointer}
.qrbox{margin-top:18px;text-align:center;display:none}
.qrbox img{background:#fff;padding:10px;border-radius:12px;width:220px;height:220px}
.ok{color:var(--g);font-size:18px;font-weight:700;margin-top:10px;display:none}
.note{color:var(--dim);font-size:12px;margin-top:18px;line-height:1.6}
.demo{background:#2d2a12;color:var(--y);border:1px solid #5a4d12;border-radius:8px;padding:8px 12px;font-size:12px;margin-bottom:16px}
</style></head><body><div class="box">
<h1>赞助 <span>agent-canary</span></h1>
<p class="sub">资金用于付费推广、服务器与持续开发 · Sponsor funds ads, hosting and development.</p>
${DEMO ? '<div class="demo">演示模式：扫码后打开的是模拟支付页，不会产生真实扣款。配置 .env 后自动切换为真实收款。</div>' : ""}
<div class="tabs"><div class="tab on" id="t-wechat">微信支付</div><div class="tab" id="t-alipay">支付宝</div></div>
<div class="amts" id="amts"></div>
<input id="note" placeholder="留言（可选，120 字以内）" maxlength="120">
<button id="go">生成付款码</button>
<div class="qrbox" id="qrbox"><img id="qr" alt="付款二维码"><div id="st" class="sub" style="margin-top:10px">等待支付…</div><div class="ok" id="ok">✓ 支付成功，感谢支持！</div></div>
<p class="note">本页为自托管收款服务：微信/支付宝回调均经过签名验证。<br>项目：github.com/DorianChn/agent-canary</p>
</div>
<script>
let ch = "wechat", amount = null;
const amts = [${PRESETS.join(",")}];
const amtsEl = document.getElementById("amts");
amts.forEach(a => {
  const d = document.createElement("div");
  d.className = "amt"; d.textContent = "¥" + a;
  d.onclick = () => { amount = a; [...amtsEl.children].forEach(x => x.classList.remove("on")); d.classList.add("on"); };
  amtsEl.appendChild(d);
});
document.getElementById("t-wechat").onclick = () => setTab("wechat");
document.getElementById("t-alipay").onclick = () => setTab("alipay");
function setTab(c) {
  ch = c;
  document.getElementById("t-wechat").classList.toggle("on", c === "wechat");
  document.getElementById("t-alipay").classList.toggle("on", c === "alipay");
}
document.getElementById("go").onclick = async () => {
  if (!amount) { alert("先选一个金额"); return; }
  const r = await fetch("/api/order", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel: ch, amount, note: document.getElementById("note").value })
  });
  const j = await r.json();
  if (j.error) { alert("下单失败: " + j.error); return; }
  document.getElementById("qr").src = "/api/qr?text=" + encodeURIComponent(j.qr);
  document.getElementById("qrbox").style.display = "block";
  const iv = setInterval(async () => {
    const s = await (await fetch("/api/order/" + j.orderId)).json();
    if (s.status === "paid") {
      clearInterval(iv);
      document.getElementById("ok").style.display = "block";
      document.getElementById("st").style.display = "none";
    }
  }, 2000);
};
</script></body></html>`;
}

server.listen(PORT, () => {
  console.log(`[sponsor] listening on ${PUBLIC_BASE}`);
  console.log(`[sponsor] mode: ${DEMO ? "DEMO (simulated payments)" : "LIVE"}`);
  if (!DEMO) console.log(`[sponsor] wechat ready=${WECHAT_READY} alipay ready=${ALIPAY_READY}`);
});
