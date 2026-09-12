#!/usr/bin/env node
/**
 * 人工确认工具（零成本收款模式配套）。
 *
 * 用法（在 sponsor/ 目录下）：
 *   node grant.mjs pending                 列出待确认的付款登记
 *   node grant.mjs grant <handle> [月数]   为该 GitHub 用户名/邮箱开通个人版（默认 1 个月=30 天，可叠加）
 *
 * 流程：付款人在赞助页登记 → 你在微信/支付宝账单里看到钱到账 → node grant.mjs grant xxx
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORDERS_FILE = path.join(__dirname, "orders.json");
const SUBS_FILE = path.join(__dirname, "subscribers.json");

function read(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function write(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

function main() {
  const [cmd, arg, monthsArg] = process.argv.slice(2);

  if (cmd === "pending") {
    const orders = Object.values(read(ORDERS_FILE, {}))
      .filter((o) => o.status === "pending_manual")
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    if (orders.length === 0) {
      console.log("没有待确认的登记。");
      return;
    }
    for (const o of orders) {
      console.log(
        `${o.createdAt}  ${o.id.slice(0, 8)}  ${o.channel.padEnd(7)} ¥${String(o.amount).padEnd(6)} plan=${o.plan ?? "-"}  handle=${o.handle ?? "-"}  note=${o.note ?? ""}`
      );
    }
    return;
  }

  if (cmd === "grant") {
    const handle = String(arg || "").trim();
    const months = Math.max(1, Number(monthsArg || 1));
    if (!handle) {
      console.log("用法: node grant.mjs grant <GitHub用户名或邮箱> [月数]");
      process.exit(1);
    }
    const subs = read(SUBS_FILE, {});
    const now = Date.now();
    const current = subs[handle]?.expiresAt ? Date.parse(subs[handle].expiresAt) : 0;
    const expiresAt = new Date(Math.max(now, current) + months * 30 * 864e5).toISOString();
    subs[handle] = { handle, expiresAt, lastOrderId: "manual-grant", updatedAt: new Date().toISOString() };
    write(SUBS_FILE, subs);
    console.log(`✓ ${handle} 个人版已开通，有效期至 ${expiresAt}`);
    return;
  }

  console.log("用法:\n  node grant.mjs pending                 列出待确认登记\n  node grant.mjs grant <handle> [月数]   开通/延长个人版");
}

main();
