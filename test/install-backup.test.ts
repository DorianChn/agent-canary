import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { configPathFor, installServer } = await import("../src/install.js");

function restoreEnv(name: "HOME" | "USERPROFILE", value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("repeated installs preserve each previous MCP config backup", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-canary-backup-test-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  try {
    const configPath = configPathFor("claude");
    const original = {
      mcpServers: { docs: { command: "docs-server", args: [] } },
      version: 1,
    };
    fs.writeFileSync(configPath, JSON.stringify(original, null, 2) + "\n");

    const first = installServer("claude");
    assert.equal(first.backupPath, `${configPath}.agent-canary-backup`);
    assert.deepEqual(JSON.parse(fs.readFileSync(first.backupPath!, "utf8")), original);

    const current = JSON.parse(fs.readFileSync(configPath, "utf8"));
    current.version = 2;
    fs.writeFileSync(configPath, JSON.stringify(current, null, 2) + "\n");

    const second = installServer("claude");
    assert.equal(second.backupPath, `${configPath}.agent-canary-backup.1`);
    assert.notEqual(second.backupPath, first.backupPath);
    assert.deepEqual(JSON.parse(fs.readFileSync(first.backupPath!, "utf8")), original);
    assert.equal(JSON.parse(fs.readFileSync(second.backupPath!, "utf8")).version, 2);
  } finally {
    restoreEnv("HOME", previousHome);
    restoreEnv("USERPROFILE", previousUserProfile);
    fs.rmSync(home, { recursive: true, force: true });
  }
});
