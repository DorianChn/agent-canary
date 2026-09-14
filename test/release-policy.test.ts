import { test } from "node:test";
import assert from "node:assert/strict";
import { FREE_MAX_MAJOR, majorVersion, releaseRequiresLicense } from "../src/config.js";

test("public release line ends at v1 and v2 requires cooperation authorization", () => {
  assert.equal(FREE_MAX_MAJOR, 1);
  assert.equal(majorVersion("0.8.0"), 0);
  assert.equal(majorVersion("1.0.0"), 1);
  assert.equal(majorVersion("v1.9.3"), 1);
  assert.equal(majorVersion("2.0.0"), 2);
  assert.equal(releaseRequiresLicense("1.9.9"), false);
  assert.equal(releaseRequiresLicense("2.0.0"), true);
  assert.equal(releaseRequiresLicense("invalid"), true);
});
