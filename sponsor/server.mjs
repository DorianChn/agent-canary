/**
 * agent-canary sponsor gateway.
 *
 * Self-hosted, single-file payment server that lets the project accept
 * WeChat Pay (Native scan-to-pay, API v3) and Alipay (当面付 precreate) —
 * used to fund paid promotion and hosting.
 *
 * Public release policy:
 *  - one-off donations (presets / custom amount)
 *  - V1 remains free; V2 Personal is paid and explicitly enabled per gateway
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
import os from "node:os";
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
// 收款系统只服务本机回环：公网流量经隧道/路由器进来，局域网设备无需也不应直接访问
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
function isLoopbackBase(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}
function isSecureBase(raw) {
  try {
    return new URL(raw).protocol === "https:" || isLoopbackBase(raw);
  } catch {
    return false;
  }
}
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
// V免签（szvone/vmqphp 自托管 + 安卓监控端）：零成本全自动确认。
const VMQ = {
  url: (process.env.VMQ_URL || "").replace(/\/$/, ""),
  key: process.env.VMQ_KEY || "",
};
const VMQ_READY = Boolean(VMQ.url && VMQ.key);

// 零成本模式：个人收款码 + 人工确认。把你的个人收款码图片放到 sponsor/qr/ 下即可自动启用：
//   sponsor/qr/wechat.png (或 .jpg)   sponsor/qr/alipay.png (或 .jpg)
// 该目录已在 .gitignore 中（收款码是个人信息，不要提交进仓库）。
const QR_DIR = path.join(__dirname, "qr");
const qrFiles = {
  wechat: ["wechat.png", "wechat.jpg", "wechat.jpeg", "wechat.webp"]
    .map((f) => path.join(QR_DIR, f))
    .find((f) => fs.existsSync(f)),
  alipay: ["alipay.png", "alipay.jpg", "alipay.jpeg", "alipay.webp"]
    .map((f) => path.join(QR_DIR, f))
    .find((f) => fs.existsSync(f)),
};
const MANUAL_READY = Boolean(qrFiles.wechat || qrFiles.alipay);
const DEMO = process.env.DEMO === "1" || (!WECHAT_READY && !ALIPAY_READY && !EPAY_READY && !VMQ_READY && !MANUAL_READY && process.env.DEMO !== "0");
if (!DEMO && !isSecureBase(PUBLIC_BASE)) {
  throw new Error("LIVE sponsor gateway requires PUBLIC_BASE_URL to be HTTPS (localhost is allowed only for local development)");
}
const PRESETS = [5, 10, 25, 50]; // CNY, one-off donations

// V2 Personal paid plan. Prices are server-authoritative and configurable.
const PLAN = {
  personal: {
    usd: Number(process.env.PERSONAL_USD || 10),
    cny: Number(process.env.PERSONAL_CNY || 72),
    days: 30,
  },
};
// Keep the old name as a migration alias, but make the V2 switch explicit.
const V2_PAID_ORDERS = process.env.V2_PAID_ORDERS === "1" || process.env.COOPERATION_ORDERS === "1";
const PAYMENT_CHANNELS = Object.freeze([
  ...(WECHAT_READY ? ["wechat"] : []),
  ...(ALIPAY_READY ? ["alipay"] : []),
  ...(VMQ_READY ? ["vmq"] : []),
  ...(EPAY_READY ? ["epay"] : []),
  ...(MANUAL_READY ? ["manual"] : []),
]);
if (!DEMO && PAYMENT_CHANNELS.length === 0) {
  throw new Error("LIVE sponsor gateway has no payment channel; configure WeChat, Alipay, Vmq, Epay, or a local QR code");
}

// ---------- order store ----------
// Tests can point persistence at an isolated temporary directory. Production
// defaults to a private directory outside the source checkout.
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(os.homedir(), ".agent-canary-sponsor"));
fs.mkdirSync(DATA_DIR, { recursive: true });
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");
const SUBS_FILE = path.join(DATA_DIR, "subscribers.json");
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}
const orders = readJson(ORDERS_FILE, {});
function saveOrders() {
  writeJson(ORDERS_FILE, orders);
}

function normalizeHandle(value) {
  const handle = String(value ?? "").trim();
  if (!handle || handle.length > 64 || /[\u0000-\u001f\u007f]/.test(handle)) return null;
  return handle;
}

function channelReady(channel) {
  if (DEMO || EPAY_READY || VMQ_READY) return true;
  return channel === "wechat" ? WECHAT_READY : ALIPAY_READY;
}

function newOrder(channel, amountYuan, note, plan = null, handle = null) {
  // disk-fill guard: keep the newest 1500 orders, pruning settled ones first
  const ids = Object.keys(orders);
  if (ids.length > 2000) {
    for (const id of ids.slice(0, ids.length - 1500)) {
      if (orders[id].status === "paid" || orders[id].status === "failed") delete orders[id];
    }
    saveOrders();
  }
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

// ---------- V2 paid-edition signing (Ed25519) ----------
// license-keys.json holds the PRIVATE signing key — generated on first run,
// never committed. The matching public key is baked into the agent-canary CLI.
const KEYS_FILE = path.join(DATA_DIR, "license-keys.json");
const ACTIVATIONS_FILE = path.join(DATA_DIR, "activations.json");
const MAX_MACHINES = Number(process.env.LICENSE_MAX_MACHINES || 3);
const LICENSE_TTL_DAYS = Number(process.env.LICENSE_TTL_DAYS || 30);
const LICENSE_RELEASE_MAJOR = Number(process.env.LICENSE_RELEASE_MAJOR || 2);
if (!Number.isSafeInteger(LICENSE_RELEASE_MAJOR) || LICENSE_RELEASE_MAJOR < 2 || LICENSE_RELEASE_MAJOR > 100) {
  throw new Error("LICENSE_RELEASE_MAJOR must be an integer between 2 and 100");
}

const CLI_PUBLIC_KEY =
  "-----BEGIN PUBLIC KEY-----\n" +
  "MCowBQYDK2VwAyEA/EuB78D0nLimALPsllVTuvFZtCaOU8CDs2kd03SpdV0=\n" +
  "-----END PUBLIC KEY-----\n";
function normalizePem(value) {
  return String(value || "").replace(/\r/g, "").trim();
}
function keyMatchesCli(kp) {
  if (!kp || typeof kp.privateKey !== "string") return false;
  try {
    const derived = crypto
      .createPublicKey(crypto.createPrivateKey(kp.privateKey))
      .export({ type: "spki", format: "pem" })
      .toString();
    return (
      normalizePem(derived) === normalizePem(CLI_PUBLIC_KEY) &&
      (!kp.publicKey || normalizePem(kp.publicKey) === normalizePem(CLI_PUBLIC_KEY))
    );
  } catch {
    return false;
  }
}
function ensureLicenseKeys() {
  const configuredPrivateKey = process.env.LICENSE_PRIVATE_KEY_PATH;
  if (configuredPrivateKey) {
    let privateKey;
    try {
      privateKey = fs.readFileSync(path.resolve(configuredPrivateKey), "utf8");
    } catch {
      throw new Error("LICENSE_PRIVATE_KEY_PATH cannot be read");
    }
    const kp = {
      publicKey: crypto.createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString(),
      privateKey,
    };
    if (!keyMatchesCli(kp)) {
      throw new Error("Configured license private key does not match the public key shipped in the CLI");
    }
    return kp;
  }
  const stored = readJson(KEYS_FILE, null);
  if (stored) {
    if (!keyMatchesCli(stored)) {
      throw new Error("sponsor/license-keys.json does not match the public key shipped in the CLI");
    }
    return stored;
  }
  if (!DEMO) {
    throw new Error("LIVE sponsor gateway requires LICENSE_PRIVATE_KEY_PATH or a matching sponsor/license-keys.json");
  }
  return generateKeys();
  function generateKeys() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const kp = {
      publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    };
    writeJson(KEYS_FILE, kp);
    try { fs.chmodSync(KEYS_FILE, 0o600); } catch {}
    console.log("[sponsor] generated license signing keypair → license-keys.json (keep it private, back it up)");
    console.warn("[sponsor] DEMO signing key is temporary and cannot activate a production CLI");
    return kp;
  }
}
const LICENSE_KEYS = ensureLicenseKeys();

function b64u(buf) {
  return Buffer.from(buf).toString("base64url");
}
function signLicensePayload(payloadObj) {
  const payload = b64u(JSON.stringify(payloadObj));
  const sig = b64u(crypto.sign(null, Buffer.from(payload), crypto.createPrivateKey(LICENSE_KEYS.privateKey)));
  return `${payload}.${sig}`;
}

// activation registry: handle → { machines: { machineHash: lastSeenMs } }
const rateMap = new Map();
function rateLimited(key, max = 10, windowMs = 600_000) {
  const now = Date.now();
  const arr = (rateMap.get(key) ?? []).filter((t) => now - t < windowMs);
  arr.push(now);
  rateMap.set(key, arr);
  if (rateMap.size > 5000) for (const [k, v] of rateMap) if (v.every((t) => now - t >= windowMs)) rateMap.delete(k);
  return arr.length > max;
}

function isLoopback(ip) {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function extendSubscription(handle, orderId) {
  const subs = loadSubs();
  const now = Date.now();
  const parsedCurrent = subs[handle]?.expiresAt ? Date.parse(subs[handle].expiresAt) : 0;
  const current = Number.isFinite(parsedCurrent) ? parsedCurrent : 0;
  const expiresAt = new Date(Math.max(now, current) + PLAN.personal.days * 864e5).toISOString();
  subs[handle] = { handle, expiresAt, lastOrderId: orderId, updatedAt: new Date().toISOString() };
  writeJson(SUBS_FILE, subs);
  console.log(`[sponsor] V2 Personal for "${handle}" active until ${expiresAt}`);
  return expiresAt;
}

function orderAmountMatches(order, received, unit = "yuan") {
  const expected = Math.round(Number(order?.amount) * 100);
  const actual = Number(received);
  if (!Number.isFinite(expected) || !Number.isFinite(actual)) return false;
  if (unit === "fen") return Number.isInteger(actual) && actual === expected;
  return Math.round(actual * 100) === expected;
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
    description: order.plan === "personal" ? "agent-canary V2 Personal Edition" : "agent-canary sponsorship",
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
      subject: order.plan === "personal" ? "agent-canary V2 Personal Edition" : "agent-canary sponsorship",
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
    name: order.plan === "personal" ? "agent-canary V2 Personal Edition" : "agent-canary sponsorship",
    money: order.amount.toFixed(2),
    sitename: "agent-canary",
  };
  params.sign = epaySign(params, EPAY.key);
  params.sign_type = "MD5";
  return `${EPAY.url}/submit.php?${new URLSearchParams(params).toString()}`;
}

// ---------- V免签 helpers（协议来源：szvone/vmqphp public/api.html 与 Index.php） ----------
function vmqMd5(s) {
  return crypto.createHash("md5").update(s, "utf8").digest("hex");
}
// 每次下单实时读取 .env 中的 VMQ_PUBLIC_URL（隧道域名轮换后由守护进程更新此文件）
function currentVmqPublicUrl() {
  try {
    const env = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
    const m = env.match(/^VMQ_PUBLIC_URL=(.+)$/m);
    if (m) {
      const v = m[1].trim().replace(/^["']|["']$/g, "");
      if (v && v !== "null") return v.replace(/\/$/, "");
    }
  } catch {}
  return null;
}

async function createVmqOrder(order) {
  const param = order.id; // 原样随异步通知返回，便于对账
  const price = order.amount.toFixed(2);
  const type = order.channel === "alipay" ? "2" : "1";
  const sign = vmqMd5(`${order.outTradeNo}${param}${type}${price}${VMQ.key}`);
  const q = new URLSearchParams({
    payId: order.outTradeNo,
    type,
    price,
    param,
    isHtml: "0",
    notifyUrl: `${PUBLIC_BASE}/callback/vmq`,
    returnUrl: `${PUBLIC_BASE}/return`,
    sign,
  });
  const res = await fetch(`${VMQ.url}/createOrder?${q.toString()}`);
  const j = await res.json();
  if (j.code !== 1 || !j.data?.orderId) {
    throw new Error(`Vmq API: ${JSON.stringify(j).slice(0, 200)}`);
  }
  // pay.html 会展示匹配好金额尾数的个人收款码，是给付款人的正确落地页
  // 付款人通常在公网——支付页走公网地址。隧道域名会轮换，所以每次下单都
  // 实时读 .env 里的最新值（守护进程更新文件即可生效，无需重启网关）
  const payBase = (currentVmqPublicUrl() ?? process.env.VMQ_PUBLIC_URL ?? VMQ.url).replace(/\/$/, "");
  return `${payBase}/payPage/pay.html?orderId=${j.data.orderId}`;
}

// ---------- payment creation dispatch ----------
async function createPayment(order) {
  if (DEMO) return `${PUBLIC_BASE}/demo/pay/${order.id}`;
  if (EPAY_READY) return createEpayOrder(order);
  if (VMQ_READY) return createVmqOrder(order);
  if (order.channel === "wechat") {
    if (!WECHAT_READY) throw new Error("WeChat Pay credentials not configured (.env)");
    return createWechatOrder(order);
  }
  if (!ALIPAY_READY) throw new Error("Alipay credentials not configured (.env)");
  return createAlipayOrder(order);
}

// ---------- tiny HTTP framework ----------
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);
}

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "content-security-policy":
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; connect-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let rejected = false;
    req.on("data", (c) => {
      if (rejected) return;
      data += c;
      if (data.length > 1e6) {
        rejected = true;
        req.destroy();
        reject(new Error("body too large"));
      }
    });
    req.on("end", () => {
      if (!rejected) resolve(data);
    });
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

    // ---- API: safe operational health/status (never returns credentials) ----
    if (req.method === "GET" && url.pathname === "/api/health") {
      return send(
        res,
        200,
        JSON.stringify({
          ok: true,
          mode: DEMO ? "demo" : "live",
          v2PaidOrders: V2_PAID_ORDERS,
          publicHttps: isSecureBase(PUBLIC_BASE),
          channels: {
            wechat: WECHAT_READY,
            alipay: ALIPAY_READY,
            vmq: VMQ_READY,
            epay: EPAY_READY,
            manual: MANUAL_READY,
          },
          plan: { usd: PLAN.personal.usd, cny: PLAN.personal.cny, days: PLAN.personal.days },
        }),
        "application/json"
      );
    }

    // ---- QR raster endpoint (page uses this for both real and demo QR) ----
    if (req.method === "GET" && url.pathname === "/api/qr") {
      const ip = req.socket.remoteAddress ?? "?";
      if (rateLimited("qr:" + ip, 120)) return send(res, 429, "too many");
      const text = url.searchParams.get("text") || "";
      if (!text || text.length > 800) return send(res, 400, "bad text");
      const png = await QRCode.toBuffer(text, { width: 512, margin: 1 });
      return send(res, 200, png, "image/png");
    }

    // ---- API: create order (donation or V2 Personal purchase) ----
    if (req.method === "POST" && url.pathname === "/api/order") {
      const ip = req.socket.remoteAddress ?? "?";
      if (rateLimited("order:" + ip, 10)) {
        return send(res, 429, JSON.stringify({ ok: false, error: "too many orders, slow down" }), "application/json");
      }
      const input = JSON.parse((await readBody(req)) || "{}");
      const channel = input.channel === "alipay" ? "alipay" : "wechat";
      if (!channelReady(channel)) {
        return send(
          res,
          503,
          JSON.stringify({ ok: false, error: `${channel === "wechat" ? "WeChat" : "Alipay"} payment is not configured on this gateway` }),
          "application/json"
        );
      }
      let order;
      if (input.plan === "personal") {
        if (!V2_PAID_ORDERS) {
          return send(
            res,
            503,
            JSON.stringify({ ok: false, error: "V2 paid orders are not enabled on this gateway" }),
            "application/json"
          );
        }
        const handle = normalizeHandle(input.handle);
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

    // ---- 个人收款码图片（零成本模式；未配置本地文件时返回 404） ----
    if (req.method === "GET" && url.pathname.startsWith("/qr-image/")) {
      const ch = url.pathname.split("/")[2] === "alipay" ? "alipay" : "wechat";
      if (qrFiles[ch]) {
        const type = qrFiles[ch].endsWith(".png") ? "image/png" : qrFiles[ch].endsWith(".webp") ? "image/webp" : "image/jpeg";
        return send(res, 200, fs.readFileSync(qrFiles[ch]), type);
      }
      return send(res, 404, "payment QR not configured");
    }

    // ---- 零成本模式：付款登记（作者用 grant.mjs 人工确认后生效） ----
    if (req.method === "POST" && url.pathname === "/api/manual-claim") {
      const ip = req.socket.remoteAddress ?? "?";
      if (rateLimited("claim:" + ip, 10)) {
        return send(res, 429, JSON.stringify({ ok: false, error: "too many claims" }), "application/json");
      }
      if (!MANUAL_READY && !DEMO) {
        return send(res, 503, JSON.stringify({ ok: false, error: "manual payment QR is not configured" }), "application/json");
      }
      const input = JSON.parse((await readBody(req)) || "{}");
      const handle = normalizeHandle(input.handle);
      const channel = input.channel === "alipay" ? "alipay" : "wechat";
      // plan orders are server-priced; donations need an explicit amount
      const amount = input.plan === "personal" ? PLAN.personal.cny : Number(input.amount);
      if (!handle || !Number.isFinite(amount) || amount < 1 || amount > 100000) {
        return send(res, 400, JSON.stringify({ error: "invalid input" }), "application/json");
      }
      const plan = input.plan === "personal" ? "personal" : null;
      const order = plan
        ? newOrder(channel, PLAN.personal.cny, input.note, "personal", handle)
        : newOrder(channel, amount, input.note);
      order.status = "pending_manual";
      saveOrders();
      console.log(`[sponsor] manual claim: ${handle} ¥${order.amount} (${channel}${plan ? ", personal" : ""})`);
      return send(res, 200, JSON.stringify({ ok: true, orderId: order.id }), "application/json");
    }

    // ---- API: order status (page polls this) ----
    if (req.method === "GET" && url.pathname.startsWith("/api/order/")) {
      const o = orders[url.pathname.split("/")[3]];
      if (!o) return send(res, 404, "no such order");
      return send(
        res,
        200,
        JSON.stringify({
          ok: true,
          status: o.status,
          amount: o.amount,
          channel: o.channel,
          plan: o.plan,
          paidAt: o.paidAt,
          ...(o.status === "failed" ? { error: "payment initialization failed" } : {}),
        }),
        "application/json"
      );
    }

    // ---- API: subscription status — single source of truth for entitlement ----
    if (req.method === "GET" && url.pathname.startsWith("/api/subscription/")) {
      if (rateLimited("sub:" + (req.socket.remoteAddress ?? "?"))) {
        return send(res, 429, JSON.stringify({ ok: false, error: "too many requests" }), "application/json");
      }
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
      if (
        order &&
        resource.trade_state === "SUCCESS" &&
        resource.mchid === WECHAT.mchid &&
        resource.appid === WECHAT.appid &&
        resource.amount?.currency === "CNY" &&
        orderAmountMatches(order, resource.amount?.total, "fen")
      ) {
        markPaid(order.id, resource.transaction_id);
      }
      return send(res, 200, JSON.stringify({ code: "SUCCESS" }), "application/json");
    }

    // ---- Alipay async callback ----
    if (req.method === "POST" && url.pathname === "/callback/alipay") {
      const raw = await readBody(req);
      const form = Object.fromEntries(new URLSearchParams(raw));
      if (!verifyAlipayNotify(form)) return send(res, 401, "fail");
      const order = Object.values(orders).find((o) => o.outTradeNo === form.out_trade_no);
      if (
        order &&
        form.app_id === ALIPAY.appId &&
        orderAmountMatches(order, form.total_amount) &&
        (form.trade_status === "TRADE_SUCCESS" || form.trade_status === "TRADE_FINISHED")
      ) {
        markPaid(order.id, form.trade_no);
      }
      return send(res, 200, "success");
    }

    // ---- 易支付(Epay) async callback (GET with signed params) ----
    if (req.method === "GET" && url.pathname === "/callback/epay") {
      const form = Object.fromEntries(url.searchParams);
      if (!EPAY_READY || form.sign !== epaySign(form, EPAY.key)) return send(res, 401, "fail");
      const order = Object.values(orders).find((o) => o.outTradeNo === form.out_trade_no);
      if (order && form.pid === EPAY.pid && orderAmountMatches(order, form.money) && form.trade_status === "TRADE_SUCCESS") {
        markPaid(order.id, form.trade_no);
      }
      return send(res, 200, "success");
    }

    // ---- V免签 async callback: sign = md5(payId+param+type+price+reallyPrice+key) ----
    if (req.method === "GET" && url.pathname === "/callback/vmq") {
      const form = Object.fromEntries(url.searchParams);
      const expect = vmqMd5(
        `${form.payId ?? ""}${form.param ?? ""}${form.type ?? ""}${form.price ?? ""}${form.reallyPrice ?? ""}${VMQ.key}`
      );
      if (!VMQ_READY || form.sign !== expect) return send(res, 401, "error_sign");
      const order = Object.values(orders).find((o) => o.outTradeNo === form.payId);
      // reallyPrice 含金额尾数浮动（防撞单）；同时绑定订单号和原始订单金额。
      if (order && form.param === order.id && orderAmountMatches(order, form.price)) {
        markPaid(order.id, `vmq:${form.param ?? ""}`);
      }
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

    // ---- V2 activation (signed license + machine binding) ----
    if (req.method === "POST" && url.pathname === "/api/activate") {
      const ip = req.socket.remoteAddress ?? "?";
      if (DEMO && !isLoopback(ip)) {
        // 演示模式的"支付"是模拟的——绝不能让远程机器据此拿到许可
        return send(res, 403, JSON.stringify({ ok: false, error: "demo mode: activation only from localhost" }), "application/json");
      }
      if (rateLimited("act:" + ip)) return send(res, 429, JSON.stringify({ ok: false, error: "too many attempts" }), "application/json");
      const body = JSON.parse((await readBody(req)) || "{}");
      const handle = String(body.handle || "").trim().slice(0, 64);
      const machineHash = String(body.machineHash || "").trim();
      const requestedReleaseMajor = Number(body.releaseMajor || 0);
      if (!handle || !/^[0-9a-f]{64}$/.test(machineHash)) {
        return send(res, 400, JSON.stringify({ ok: false, error: "invalid handle or machineHash" }), "application/json");
      }
      if (requestedReleaseMajor !== LICENSE_RELEASE_MAJOR) {
        return send(res, 400, JSON.stringify({ ok: false, error: `unsupported release major; this gateway issues V${LICENSE_RELEASE_MAJOR} licenses` }), "application/json");
      }
      const sub = loadSubs()[handle];
      if (!sub || new Date(sub.expiresAt) <= new Date()) {
        return send(res, 403, JSON.stringify({ ok: false, error: "no active subscription for this handle" }), "application/json");
      }
      const acts = readJson(ACTIVATIONS_FILE, {});
      const rec = acts[handle] ?? { machines: {} };
      const MONTH = 45 * 864e5;
      const activeCount = Object.entries(rec.machines ?? {}).filter(([, t]) => Date.now() - t < MONTH).length;
      if (!rec.machines[machineHash] && activeCount >= MAX_MACHINES) {
        writeJson(ACTIVATIONS_FILE, { ...acts, [handle]: rec });
        return send(res, 403, JSON.stringify({ ok: false, error: `machine limit reached (${MAX_MACHINES})`, code: "machine_limit" }), "application/json");
      }
      rec.machines[machineHash] = Date.now();
      acts[handle] = rec;
      writeJson(ACTIVATIONS_FILE, acts);
      const expiresAt = new Date(Math.min(new Date(sub.expiresAt).getTime(), Date.now() + LICENSE_TTL_DAYS * 864e5)).toISOString();
      const license = signLicensePayload({
        releaseMajor: LICENSE_RELEASE_MAJOR,
        handle,
        machineHash,
        expiresAt,
        iat: Date.now(),
      });
      console.log(`[sponsor] activated "${handle}" machine ${machineHash.slice(0, 12)}… until ${expiresAt}`);
      return send(res, 200, JSON.stringify({ ok: true, license, revalidateAfter: Date.now() + 3 * 864e5 }), "application/json");
    }

    // ---- demo-mode simulated gateway ----
    if (DEMO && req.method === "GET" && url.pathname.startsWith("/demo/pay/")) {
      const o = orders[url.pathname.split("/")[3]];
      if (!o) return send(res, 404, "no such order");
      const what = o.plan === "personal" ? "V2 Personal 测试" : "赞助";
      const safeHandle = o.handle ? ` · ${escapeHtml(o.handle)}` : "";
      return send(
        res,
        200,
        `<body style="font-family:sans-serif;background:#0d1117;color:#c9d1d9;text-align:center;padding-top:60px">
          <h2>演示模式 — 模拟${o.channel === "wechat" ? "微信支付" : "支付宝"} · ${what}</h2>
          <p>订单 ${o.id.slice(0, 8)}… · ¥${o.amount.toFixed(2)}${safeHandle}</p>
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
<h1><span>agent-canary</span> 购买与支持</h1>
<p class="sub">检测 AI agent 是否被提示注入劫持：诱饵工具 + 金丝雀令牌 + 可追踪告警。</p>
${DEMO ? '<div class="demo">演示模式：此页面不会产生真实扣款，也不会发放真实生产许可证。配置并审核 .env 后才可切换为真实收款。</div>' : ""}

<div class="plan" style="border-color:#30363d">
  <h2>项目作用</h2>
  <div class="fine" style="font-size:13px">正常 agent 永远不会调用假的转账、密钥读取或 root shell 工具；一旦调用，或蜜罐令牌出现在输出、外发请求、CI 日志或 git diff 中，就是需要调查的入侵信号。工具本身不会执行真实转账、命令或删除。</div>
</div>

<div class="plan">
  <h2>V2 Personal 付费版 <small>¥${p.cny}/30 天</small></h2>
  <ul>
    <li>V2 进阶评测、攻击链面板与 SIEM 导出</li>
    <li>短期许可证 + 设备绑定</li>
    <li>付款回调验签成功后自动进入激活流程</li>
  </ul>
  <input id="handle" placeholder="GitHub 用户名或邮箱（许可证标识）" maxlength="64">
  <button id="sub">购买并激活 V2 Personal</button>
  <div class="fine">V1 永久免费；V2 Personal 是 30 天许可证。真实购买支持微信、支付宝、Vmq 或 Epay（以当前网关实际配置为准），付款成功后才会开通，单纯赞助不会授予许可证。</div>
  <div class="fine" id="subcheck"></div>
</div>
${MANUAL_READY ? `
<div class="plan" style="border-color:#30363d">
  <h2>V2 Personal 人工收款 <small>付款后由管理员确认</small></h2>
  <div style="display:flex;gap:14px;justify-content:center;margin:12px 0">
    ${qrFiles.wechat ? `<div style="text-align:center"><img src="/qr-image/wechat" style="width:168px;height:168px;background:#fff;padding:8px;border-radius:10px" alt="微信收款码"><div class="fine">微信支付</div></div>` : ""}
    ${qrFiles.alipay ? `<div style="text-align:center"><img src="/qr-image/alipay" style="width:168px;height:168px;background:#fff;padding:8px;border-radius:10px" alt="支付宝收款码"><div class="fine">支付宝</div></div>` : ""}
  </div>
  <div class="fine">人工收款只在本机配置了收款码时显示。付款后登记许可证标识，管理员核对到账后手动开通；不要在备注里填写密码、私钥或付款截图。</div>
  <div style="display:flex;gap:8px;margin-top:8px">
    <select id="m-channel" style="width:110px;padding:11px;border:1px solid #30363d;border-radius:8px;background:#010409;color:var(--fg);font-size:14px">
      <option value="wechat">微信</option>
      <option value="alipay">支付宝</option>
    </select>
    <input id="m-amount" type="number" min="1" value="${p.cny}" style="margin:0">
  </div>
  <input id="m-note" placeholder="GitHub 用户名或邮箱 + 转账单号后四位" maxlength="120">
  <button id="m-claim" class="ghost">我已付款，提交登记</button>
  <div class="fine" id="m-ok"></div>
</div>
` : ""}
${DEMO || EPAY_READY || WECHAT_READY || ALIPAY_READY || VMQ_READY ? `
<div class="donate-title">额外支持项目（不包含 V2 授权）：</div>
<div class="tabs"><div class="tab on" id="t-wechat">微信支付</div><div class="tab" id="t-alipay">支付宝</div></div>
<div class="amts" id="amts"></div>
<input id="note" placeholder="留言（可选，120 字以内）" maxlength="120">
<button id="go" class="ghost">生成付款码</button>
<div class="qrbox" id="qrbox"><img id="qr" alt="付款二维码"><div id="st" class="sub" style="margin-top:10px">等待支付…</div><div class="ok" id="ok">✓ 支付成功，感谢支持！</div></div>
` : ""}
<p class="note">本页为自托管收款服务：线上通道回调均经过签名验证，服务器不保存支付密钥到代码仓库。<br>项目：github.com/DorianChn/agent-canary</p>
</div>
<script>
const MODE = "${DEMO ? "demo" : MANUAL_READY && !EPAY_READY && !WECHAT_READY && !ALIPAY_READY && !VMQ_READY ? "manual" : "auto"}";
const PLAN_CNY = ${p.cny};
let ch = "wechat", amount = null;

if (document.getElementById("amts")) {
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
}
function setTab(c) {
  ch = c;
  document.getElementById("t-wechat").classList.toggle("on", c === "wechat");
  document.getElementById("t-alipay").classList.toggle("on", c === "alipay");
}
async function startOrder(body) {
  const qrEl = document.getElementById("qr");
  if (!qrEl) { alert("当前模式不支持在线支付，请使用下方扫码登记"); return; }
  try {
    const r = await fetch("/api/order", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: ch, ...body })
    });
    const j = await r.json();
    if (!r.ok || j.error) { alert("下单失败: " + (j.error || "服务暂不可用")); return; }
    qrEl.src = "/api/qr?text=" + encodeURIComponent(j.qr);
    document.getElementById("qrbox").style.display = "block";
    document.getElementById("ok").style.display = "none";
    const st = document.getElementById("st");
    st.textContent = "等待支付回调…";
    st.style.display = "block";
    const deadline = Date.now() + 15 * 60 * 1000;
    const iv = setInterval(async () => {
      if (Date.now() > deadline) {
        clearInterval(iv);
        st.textContent = "订单已超时，请重新下单；如已付款请保留订单页面并联系作者。";
        return;
      }
      try {
        const sr = await fetch("/api/order/" + j.orderId);
        const s = await sr.json();
        if (s.status === "failed") {
          clearInterval(iv);
          st.textContent = "支付通道初始化失败，请更换方式或联系作者。";
          return;
        }
        if (s.status === "paid") {
          clearInterval(iv);
          st.style.display = "none";
          if (j.plan === "personal") {
            const sub = await (await fetch("/api/subscription/" + encodeURIComponent(j.handle))).json();
            document.getElementById("ok").textContent = sub.active
              ? "✓ V2 Personal 已生效，有效期至 " + (sub.expiresAt || "").slice(0, 10)
              : "✓ 已收到付款，许可证正在同步，请稍后查询状态";
          }
          document.getElementById("ok").style.display = "block";
        }
      } catch {
        st.textContent = "网络暂时中断，正在继续查询订单…";
      }
    }, 2000);
  } catch {
    alert("网络错误：无法创建订单，请稍后重试");
  }
}
async function manualClaim(body, okEl) {
  const r = await fetch("/api/manual-claim", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel: document.getElementById("m-channel")?.value || "wechat", ...body })
  });
  const j = await r.json();
  const el = document.getElementById(okEl || "m-ok");
  el.textContent = j.ok ? "✓ 登记成功，作者确认后开通（通常当天）" : "登记失败: " + (j.error || "?");
}
document.getElementById("sub").onclick = () => {
  const handle = document.getElementById("handle").value.trim();
  if (!handle) { alert("先填 GitHub 用户名或邮箱"); return; }
  if (MODE === "manual") return manualClaim({ plan: "personal", handle, amount: PLAN_CNY, note: document.getElementById("m-note")?.value || "" }, "subcheck");
  startOrder({ plan: "personal", handle, note: document.getElementById("note")?.value || "" });
};
if (document.getElementById("go")) {
  document.getElementById("go").onclick = () => {
    if (!amount) { alert("先选一个金额"); return; }
    startOrder({ amount, note: document.getElementById("note").value });
  };
}
if (document.getElementById("m-claim")) {
  document.getElementById("m-claim").onclick = () => {
    const amt = Number(document.getElementById("m-amount").value);
    if (!Number.isFinite(amt) || amt < 1) { alert("填一个金额"); return; }
    manualClaim({ amount: amt, note: document.getElementById("m-note").value });
  };
}
// 订阅状态自查
document.getElementById("handle").addEventListener("change", async () => {
  const h = document.getElementById("handle").value.trim();
  if (!h) return;
  const s = await (await fetch("/api/subscription/" + encodeURIComponent(h))).json();
  document.getElementById("subcheck").textContent = s.active ? "当前状态：已生效，" + s.expiresAt.slice(0, 10) + " 到期" : "当前状态：无生效订阅";
});
</script></body></html>`;
}

server.listen(PORT, HOST, () => {
  console.log(`[sponsor] listening on ${PUBLIC_BASE}`);
  console.log(`[sponsor] mode: ${DEMO ? "DEMO (simulated payments)" : "LIVE"}`);
  console.log(`[sponsor] V2 Personal: $${PLAN.personal.usd}/30d = ¥${PLAN.personal.cny}/30d · paid orders ${V2_PAID_ORDERS ? "enabled" : "disabled"} · license TTL ${LICENSE_TTL_DAYS}d · max ${MAX_MACHINES} machines`);
  if (!isSecureBase(PUBLIC_BASE)) {
    console.warn("[sponsor] ⚠ PUBLIC_BASE_URL 是明文 HTTP —— 付款二维码可能被中间人替换，生产环境请使用 HTTPS");
  }
  if (VMQ_READY && (VMQ.key === "admin" || VMQ.key.length < 16)) {
    console.warn("[sponsor] ⚠ VMQ 通讯密钥过弱（默认值或短于 16 位）——伪造回调可以绕过付费校验！");
    console.warn("[sponsor] ⚠ 请在 vmq 后台更换强密钥，并同步更新 sponsor/.env 的 VMQ_KEY");
  }
  if (VMQ_READY) {
    // 探测 V免签后台是否仍是默认账号密码（admin/admin）——是的话任何人可登录改收款码
    fetch(`${VMQ.url}/login?user=admin&pass=admin`, { signal: AbortSignal.timeout(4000) })
      .then((r) => r.json())
      .then((j) => {
        if (j.code === 1) console.warn("[sponsor] ⚠⚠ V免签后台仍为默认密码 admin/admin —— 请立即修改，否则付款码可被攻击者重定向！");
      })
      .catch(() => {});
  }
  if (!DEMO) console.log(`[sponsor] wechat ready=${WECHAT_READY} alipay ready=${ALIPAY_READY}`);
});
