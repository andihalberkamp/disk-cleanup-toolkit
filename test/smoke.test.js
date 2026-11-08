"use strict";

// Run with: npm test   (Node.js 18+ for the built-in test runner)

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const BIN = path.join(__dirname, "..", "bin");
const MB = 1024 * 1024;
const OLD = new Date(Date.now() - 240 * 86400 * 1000); // ~8 months ago

const roots = [];
after(() => roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true })));

function write(file, buf, old = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  if (old) fs.utimesSync(file, OLD, OLD);
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dct-"));
  roots.push(root);
  const report = crypto.randomBytes(2 * MB);
  write(path.join(root, "proj", "node_modules", "pkg", "big.bin"), crypto.randomBytes(3 * MB));
  write(path.join(root, "docs", "report.pdf"), report);
  write(path.join(root, "copy", "report-copy.pdf"), report); // duplicate
  write(path.join(root, "dl", "ubuntu.iso"), crypto.randomBytes(2 * MB), true);
  write(path.join(root, "movies", "old.mkv"), crypto.randomBytes(2 * MB), true);
  write(path.join(root, "docs", "scan.pdf"), crypto.randomBytes(2 * MB), true);
  return root;
}

function run(script, args) {
  return execFileSync(process.execPath, [path.join(BIN, script), ...args], { encoding: "utf8" });
}

function allFiles(root) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      e.isDirectory() ? walk(p) : out.push(p);
    }
  })(root);
  return out.sort();
}

test("--help works for both tools", () => {
  assert.match(run("free-up-space.js", ["--help"]), /Usage/);
  assert.match(run("disk-cleanup-scan.js", ["--help"]), /Usage/);
});

test("free-up-space builds a tiered plan and reaches the target", () => {
  const root = makeFixture();
  const out = path.join(root, "..", `plan-${path.basename(root)}`);
  const text = run("free-up-space.js", [
    root, "--target", "0.008", "--min-size", "1", "--dup-min-size", "1",
    "--min-cache", "1", "--skip-known-caches", "--out", out,
  ]);
  assert.match(text, /STEP 1: SAFE/);
  assert.match(text, /node_modules/);
  assert.match(text, /STEP 2: LOW RISK/);
  assert.match(text, /Duplicate - keep:/);
  assert.match(text, /TARGET REACHED/);
  assert.ok(fs.existsSync(`${out}.txt`) && fs.existsSync(`${out}.csv`));
  fs.rmSync(`${out}.txt`);
  fs.rmSync(`${out}.csv`);
});

test("free-up-space reports a shortfall when the target is too big", () => {
  const root = makeFixture();
  const out = path.join(root, "..", `plan-${path.basename(root)}`);
  const text = run("free-up-space.js", [
    root, "--target", "500", "--min-size", "1", "--dup-min-size", "1",
    "--min-cache", "1", "--skip-known-caches", "--out", out,
  ]);
  assert.match(text, /short by/);
  assert.doesNotMatch(text, /TARGET REACHED/);
  fs.rmSync(`${out}.txt`);
  fs.rmSync(`${out}.csv`);
});

test("disk-cleanup-scan finds old files and duplicates", () => {
  const root = makeFixture();
  const out = path.join(root, "..", `scan-${path.basename(root)}`);
  const text = run("disk-cleanup-scan.js", [root, "--min-size", "1", "--dup-min-size", "1", "--out", out]);
  assert.match(text, /BIG FILES NOT USED FOR 4\+ MONTHS/);
  assert.match(text, /ubuntu\.iso/);
  assert.match(text, /DUPLICATE FILES \(1 groups/);
  fs.rmSync(`${out}.txt`);
  fs.rmSync(`${out}.csv`);
});

test("nothing is deleted and old access times are preserved", () => {
  const root = makeFixture();
  const before = allFiles(root);
  const out = path.join(root, "..", `plan-${path.basename(root)}`);
  run("free-up-space.js", [
    root, "--target", "0.008", "--min-size", "1", "--dup-min-size", "1",
    "--min-cache", "1", "--skip-known-caches", "--out", out,
  ]);
  assert.deepStrictEqual(allFiles(root), before);
  // Files were read for duplicate detection, but must still look old afterwards.
  const st = fs.statSync(path.join(root, "dl", "ubuntu.iso"));
  assert.ok(Math.abs(st.atimeMs - OLD.getTime()) < 2000, "access time was changed");
  fs.rmSync(`${out}.txt`);
  fs.rmSync(`${out}.csv`);
});
