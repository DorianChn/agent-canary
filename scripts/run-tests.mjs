import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const testRoot = path.join(projectRoot, "test");
const testFilePattern = /\.test\.(?:mjs|ts)$/;

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function discoverTestFiles(root) {
  const absoluteRoot = path.resolve(root);
  const files = [];

  function visit(directory) {
    const entries = readdirSync(directory, { withFileTypes: true });
    entries.sort((left, right) => compare(left.name, right.name));

    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(filePath);
      } else if (entry.isFile() && testFilePattern.test(entry.name)) {
        files.push(filePath);
      }
    }
  }

  visit(absoluteRoot);
  return files.sort((left, right) => {
    const leftRelative = path.relative(absoluteRoot, left).split(path.sep).join("/");
    const rightRelative = path.relative(absoluteRoot, right).split(path.sep).join("/");
    return compare(leftRelative, rightRelative);
  });
}

function runTests() {
  const testFiles = discoverTestFiles(testRoot);
  if (testFiles.length === 0) {
    console.error(`No .test.ts or .test.mjs files found under ${testRoot}`);
    return 1;
  }

  const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...testFiles], {
    cwd: projectRoot,
    stdio: "inherit",
  });

  if (result.error) {
    console.error(`Could not start the test runner: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  process.exitCode = runTests();
}
