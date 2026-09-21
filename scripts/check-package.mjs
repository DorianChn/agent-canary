import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-canary-package-"));

function run(command, args, cwd = root) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runNpm(args, cwd = root) {
  // npm.cmd is a shell wrapper on Windows and cannot be passed to execFileSync
  // directly. npm exposes its own JS entrypoint while running package scripts.
  if (!npmCli) fail("npm_execpath is unavailable");
  return run(process.execPath, [npmCli, ...args], cwd);
}

function fail(message) {
  throw new Error(`package smoke check failed: ${message}`);
}

try {
  const pack = JSON.parse(runNpm(["pack", "--json", "--pack-destination", temp]))[0];
  if (!pack?.filename || !Array.isArray(pack.files)) fail("npm pack returned no file manifest");

  const files = pack.files.map((entry) => entry.path).sort();
  const required = ["LICENSE", "README.md", "README.zh-CN.md", "package.json", "dist/index.js", "dist/sdk.js"];
  for (const file of required) if (!files.includes(file)) fail(`missing required file ${file}`);

  for (const file of files) {
    const isPublicFile = file === "LICENSE" || file === "README.md" || file === "README.zh-CN.md" || file === "package.json" || file.startsWith("dist/");
    if (!isPublicFile) fail(`unexpected package file ${file}`);
    if (/(^|\/)(?:sponsor|test|src|docs|\.github)(\/|$)|(^|\/)\.env(?:\.|$)/i.test(file)) {
      fail(`sensitive or development path included: ${file}`);
    }
  }

  const packageFile = path.join(temp, pack.filename);
  const installDir = path.join(temp, "install");
  fs.mkdirSync(installDir);
  runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", packageFile], installDir);

  const cli = path.join(installDir, "node_modules", "@dorianchn", "agent-canary", "dist", "index.js");
  if (!fs.existsSync(cli)) fail("installed CLI entrypoint was not found");
  const help = run(process.execPath, [cli, "--help"], installDir);
  if (!help.includes("self-test")) fail("installed CLI help does not include self-test");
  const selfTest = JSON.parse(run(process.execPath, [cli, "self-test", "--json"], installDir));
  if (selfTest.passed !== true) fail("installed CLI self-test did not pass");

  console.log(`package smoke check passed: ${pack.filename} (${files.length} files)`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
