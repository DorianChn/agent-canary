import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

test("public MCP and Glama metadata stays aligned with the free V1 release", () => {
  const pkg = readJson("package.json");
  const registry = readJson("server.json");
  const glama = readJson("glama.json");
  const dockerfile = fs.readFileSync("Dockerfile", "utf8");

  assert.equal(registry.name, "io.github.DorianChn/agent-canary");
  assert.equal(registry.version, pkg.version);
  assert.match(String(registry.description), /inert decoy tools/i);
  assert.equal(glama.$schema, "https://glama.ai/mcp/schemas/server.json");
  assert.deepEqual(glama.maintainers, ["DorianChn"]);
  assert.match(dockerfile, /ENTRYPOINT \["node", "dist\/index\.js", "serve"\]/);
});
