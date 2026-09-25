import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverTestFiles } from "../scripts/run-tests.mjs";

test("discovers supported test files recursively in stable order", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agent-canary-test-discovery-"));

  try {
    mkdirSync(path.join(root, "nested", "deeper"), { recursive: true });
    for (const file of [
      "z-last.test.ts",
      "nested/a-first.test.mjs",
      "nested/deeper/middle.test.ts",
      "ignored.ts",
      "ignored.test.js",
    ]) {
      const target = path.join(root, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, "");
    }

    const discovered = discoverTestFiles(root).map((file) =>
      path.relative(root, file).split(path.sep).join("/"),
    );

    assert.deepEqual(discovered, [
      "nested/a-first.test.mjs",
      "nested/deeper/middle.test.ts",
      "z-last.test.ts",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
