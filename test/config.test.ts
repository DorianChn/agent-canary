import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { writeFileAtomically } = await import("../src/config.js");

function makeTempPath(): { directory: string; file: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-canary-atomic-test-"));
  return { directory, file: path.join(directory, "nested", "config.json") };
}

test("writeFileAtomically creates a file and replaces it without leaving temp files", () => {
  const { directory, file } = makeTempPath();
  try {
    writeFileAtomically(file, '{"version":1}\n');
    assert.equal(fs.readFileSync(file, "utf8"), '{"version":1}\n');

    writeFileAtomically(file, '{"version":2}\n');
    assert.equal(fs.readFileSync(file, "utf8"), '{"version":2}\n');
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["config.json"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("writeFileAtomically leaves the existing file when the destination is invalid", () => {
  const { directory, file } = makeTempPath();
  try {
    fs.mkdirSync(file, { recursive: true });

    assert.throws(() => writeFileAtomically(file, "new content\n"), /EEXIST|EPERM|EISDIR|directory/i);
    assert.equal(fs.statSync(file).isDirectory(), true);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["config.json"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
