import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Windows: npx is a .cmd shim — several MCP clients spawn without a shell and
// fail with ENOENT unless wrapped in cmd /c (the documented Claude Code pattern).
const ENTRY =
  process.platform === "win32"
    ? { command: "cmd", args: ["/c", "npx", "-y", "agent-canary@latest", "serve"] }
    : { command: "npx", args: ["-y", "agent-canary@latest", "serve"] };

export type InstallTarget = "claude" | "cursor";

export function configPathFor(target: InstallTarget): string {
  return target === "claude"
    ? path.join(os.homedir(), ".claude.json")
    : path.join(os.homedir(), ".cursor", "mcp.json");
}

function readJson(cfgPath: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error(`Could not parse ${cfgPath}. Fix it manually, then retry.`);
  }
}

export function installServer(target: InstallTarget): { configPath: string; backupPath: string | null } {
  const cfgPath = configPathFor(target);
  let doc: Record<string, unknown> = {};
  let backupPath: string | null = null;

  if (fs.existsSync(cfgPath)) {
    backupPath = `${cfgPath}.agent-canary-backup`;
    fs.copyFileSync(cfgPath, backupPath);
    doc = readJson(cfgPath);
  }

  const servers = (doc.mcpServers && typeof doc.mcpServers === "object" ? { ...(doc.mcpServers as object) } : {}) as Record<string, unknown>;
  servers["agent-canary"] = ENTRY;
  doc.mcpServers = servers;

  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(doc, null, 2) + "\n");
  return { configPath: cfgPath, backupPath };
}

export function uninstallServer(target: InstallTarget): boolean {
  const cfgPath = configPathFor(target);
  if (!fs.existsSync(cfgPath)) return false;
  const doc = readJson(cfgPath);
  const servers = doc.mcpServers as Record<string, unknown> | undefined;
  if (!servers || !("agent-canary" in servers)) return false;
  delete servers["agent-canary"];
  fs.writeFileSync(cfgPath, JSON.stringify(doc, null, 2) + "\n");
  return true;
}
