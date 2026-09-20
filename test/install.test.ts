import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { configPathFor, entryForPlatform, installServer, uninstallServer } = await import("../src/install.js");

function makeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-canary-install-test-"));
}

function writeConfig(configPath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(value, null, 2) + "\n");
}

test("install creates a Claude config in an isolated home", () => {
  const home = makeHome();
  try {
    const result = installServer("claude", home);
    const config = JSON.parse(fs.readFileSync(result.configPath, "utf8"));

    assert.equal(result.configPath, configPathFor("claude", home));
    assert.equal(result.backupPath, null);
    assert.deepEqual(config.mcpServers["agent-canary"], entryForPlatform());
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("install backs up and preserves unrelated MCP servers", () => {
  const home = makeHome();
  try {
    const configPath = configPathFor("cursor", home);
    const original = {
      mcpServers: {
        docs: { command: "docs-server", args: ["serve"] },
      },
      otherSetting: true,
    };
    writeConfig(configPath, original);

    const result = installServer("cursor", home);
    assert.ok(result.backupPath);
    assert.deepEqual(JSON.parse(fs.readFileSync(result.backupPath!, "utf8")), original);

    const updated = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.deepEqual(updated.mcpServers.docs, original.mcpServers.docs);
    assert.deepEqual(updated.mcpServers["agent-canary"], entryForPlatform());
    assert.equal(updated.otherSetting, true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("uninstall removes only agent-canary and leaves other servers intact", () => {
  const home = makeHome();
  try {
    const configPath = configPathFor("claude", home);
    writeConfig(configPath, {
      mcpServers: {
        docs: { command: "docs-server", args: [] },
        "agent-canary": entryForPlatform(),
      },
    });

    assert.equal(uninstallServer("claude", home), true);
    const updated = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.deepEqual(updated.mcpServers, { docs: { command: "docs-server", args: [] } });
    assert.equal(uninstallServer("claude", home), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("invalid JSON returns a clear error instead of being overwritten", () => {
  const home = makeHome();
  try {
    const configPath = configPathFor("claude", home);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "{ not valid json\n");

    assert.throws(
      () => installServer("claude", home),
      /Could not parse .* Fix it manually, then retry\./
    );
    assert.equal(fs.readFileSync(configPath, "utf8"), "{ not valid json\n");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("entry commands cover Windows and Unix MCP process rules", () => {
  assert.deepEqual(entryForPlatform("win32"), {
    command: "cmd",
    args: ["/c", "npx", "-y", "agent-canary@latest", "serve"],
  });
  assert.deepEqual(entryForPlatform("linux"), {
    command: "npx",
    args: ["-y", "agent-canary@latest", "serve"],
  });
  assert.deepEqual(entryForPlatform("darwin"), entryForPlatform("linux"));
});
