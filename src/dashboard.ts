/**
 * Attack-chain dashboard: renders the event log as a self-contained HTML file.
 * Everything is server-side rendered (no CDN, no JS dependencies) so the file
 * works offline and can be attached to incident reports.
 *
 * SECURITY: event payloads (tool args, paths, notes) are attacker-controlled.
 * Every interpolated value goes through esc() — the dashboard must never
 * become the injection vector it exists to detect.
 */
import type { CanaryEvent } from "./alerts.js";

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const KIND_META: Record<string, { label: string; color: string }> = {
  decoy_called: { label: "诱饵触发 DECOY", color: "#f85149" },
  token_found: { label: "令牌泄露 TOKEN LEAK", color: "#ffd338" },
  test: { label: "测试 TEST", color: "#8b949e" },
};

function kindMeta(kind: string) {
  return KIND_META[kind] ?? { label: kind, color: "#8b949e" };
}

function eventDetail(ev: CanaryEvent): string {
  if (ev.kind === "decoy_called") {
    return `诱饵工具 <code>${esc(ev.tool)}</code> 被调用 · 追踪令牌 <code>${esc(String(ev.token ?? "").slice(0, 18))}…</code>`;
  }
  if (ev.kind === "token_found") {
    return `金丝雀令牌 <code>${esc(ev.label)}</code> 出现在 <code>${esc(ev.path)}</code>`;
  }
  return esc(ev.note ?? "test");
}

export function renderDashboard(events: CanaryEvent[], meta: { generatedAt: string; version: string }): string {
  const sorted = [...events].sort((a, b) => (a.ts < b.ts ? 1 : -1)); // newest first
  const decoys = events.filter((e) => e.kind === "decoy_called").length;
  const leaks = events.filter((e) => e.kind === "token_found").length;
  const last = events.length ? events[events.length - 1].ts : "—";

  const cards = `
  <div class="cards">
    <div class="card"><div class="num">${events.length}</div><div class="lbl">事件总数</div></div>
    <div class="card ${decoys ? "hot" : ""}"><div class="num">${decoys}</div><div class="lbl">诱饵触发</div></div>
    <div class="card ${leaks ? "hot" : ""}"><div class="num">${leaks}</div><div class="lbl">令牌泄露</div></div>
    <div class="card"><div class="num" style="font-size:20px;padding-top:14px">${esc(last)}</div><div class="lbl">最后活动</div></div>
  </div>`;

  const timeline = sorted
    .map((ev) => {
      const km = kindMeta(ev.kind);
      const args = ev.args ? `<details><summary>调用参数</summary><pre>${esc(JSON.stringify(ev.args, null, 2))}</pre></details>` : "";
      return `
    <div class="ev">
      <div class="dot" style="background:${km.color}"></div>
      <div class="body">
        <div class="head"><span class="badge" style="border-color:${km.color};color:${km.color}">${km.label}</span>
        <span class="ts">${esc(ev.ts)}</span></div>
        <div class="detail">${eventDetail(ev)}</div>
        ${args}
      </div>
    </div>`;
    })
    .join("\n");

  const empty = `<div class="empty">暂无事件 —— 这是好消息。触发诱饵或令牌外泄时会出现在这里。</div>`;

  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>agent-canary 攻击链面板</title><style>
:root{--bg:#0d1117;--panel:#161b22;--fg:#c9d1d9;--dim:#8b949e;--y:#ffd338;--line:#21262d}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--fg);font-family:'Segoe UI',system-ui,sans-serif;padding:40px 20px}
.wrap{max-width:860px;margin:0 auto}
h1{color:#fff;font-size:26px}h1 span{color:var(--y)}
.meta{color:var(--dim);font-size:13px;margin:6px 0 24px}
.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:30px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;text-align:center}
.card.hot{border-color:var(--y)}
.card .num{font-size:32px;font-weight:700;color:#fff}
.card.hot .num{color:var(--y)}
.card .lbl{color:var(--dim);font-size:12px;margin-top:4px}
.tl{position:relative;padding-left:22px}
.tl::before{content:"";position:absolute;left:5px;top:6px;bottom:6px;width:2px;background:var(--line)}
.ev{position:relative;margin-bottom:14px}
.dot{position:absolute;left:-22px;top:16px;width:12px;height:12px;border-radius:50%;border:2px solid var(--bg)}
.body{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.head{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}
.badge{font-size:11px;border:1px solid;border-radius:999px;padding:2px 10px;font-weight:600}
.ts{color:var(--dim);font-size:12px}
.detail{margin-top:8px;font-size:14px}
code{background:#010409;padding:2px 6px;border-radius:6px;font-size:12.5px}
details{margin-top:8px}
summary{cursor:pointer;color:var(--dim);font-size:12px}
pre{background:#010409;border:1px solid var(--line);border-radius:8px;padding:10px;font-size:12px;overflow-x:auto;margin-top:6px}
.empty{color:var(--dim);text-align:center;padding:60px 0;background:var(--panel);border:1px dashed var(--line);border-radius:10px}
.foot{color:var(--dim);font-size:12px;margin-top:30px;text-align:center}
@media(max-width:640px){.cards{grid-template-columns:repeat(2,1fr)}}
</style></head><body><div class="wrap">
<h1>agent-canary <span>攻击链面板</span></h1>
<div class="meta">生成时间 ${esc(meta.generatedAt)} · agent-canary v${esc(meta.version)} · 数据源 ~/.agent-canary/events.jsonl</div>
${cards}
<div class="tl">${timeline || empty}</div>
<div class="foot">零误报：事件只在诱饵被触碰或金丝雀令牌外泄时产生 · github.com/DorianChn/agent-canary</div>
</div></body></html>`;
}
