#!/usr/bin/env node
/**
 * disk-cleanup-scan.js - find big, unused and duplicate files/folders.
 *
 * SAFE: this script only READS and REPORTS. It never deletes anything.
 * You review the report and delete things yourself.
 *
 * Usage examples:
 *   node disk-cleanup-scan.js ~                       # scan home folder
 *   node disk-cleanup-scan.js D:\ --min-size 200      # Windows, files >= 200 MB
 *   node disk-cleanup-scan.js /mnt/data --months 6 --top 100
 *
 * Requires Node.js 14+ (no npm packages needed).
 */

"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const crypto = require("crypto");

// Folders that should never be suggested for deletion.
const SKIP_DIRS = new Set([
  // Windows
  "windows", "program files", "program files (x86)", "programdata",
  "$recycle.bin", "system volume information", "appdata",
  // macOS
  "system", "library", "applications", "private", "volumes",
  // Linux
  "proc", "sys", "dev", "run", "boot", "bin", "sbin", "lib", "lib64",
  "usr", "etc", "var", "snap",
  // Generic
  ".git", "node_modules", ".cache", "__pycache__",
]);

const MB = 1024 * 1024;
const DAY_MS = 86400 * 1000;

// ---------- helpers ----------

function human(n) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(1)} ${units[i]}`;
}

function fmtDate(ms) {
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function parseArgs(argv) {
  const opts = {
    path: os.homedir(),
    months: 4,
    minSize: 100,
    dupMinSize: 1,
    top: 50,
    includeHidden: false,
    out: "cleanup_report",
  };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    switch (a) {
      case "--months": opts.months = Number(rest[++i]); break;
      case "--min-size": opts.minSize = Number(rest[++i]); break;
      case "--dup-min-size": opts.dupMinSize = Number(rest[++i]); break;
      case "--top": opts.top = parseInt(rest[++i], 10); break;
      case "--out": opts.out = rest[++i]; break;
      case "--include-hidden": opts.includeHidden = true; break;
      case "-h":
      case "--help":
        console.log(
          "Usage: node disk-cleanup-scan.js [path] [--months 4] [--min-size 100]\n" +
          "       [--dup-min-size 1] [--top 50] [--include-hidden] [--out cleanup_report]"
        );
        process.exit(0);
        break;
      default:
        if (a.startsWith("--")) {
          console.error(`Unknown option: ${a}`);
          process.exit(1);
        }
        opts.path = a;
    }
  }
  return opts;
}

function expandHome(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

// last used = most recent of access/modify time (atime alone is unreliable)
function lastUsed(st) {
  return Math.max(st.atimeMs, st.mtimeMs);
}

// ---------- scanning ----------

async function scan(root, skipHidden) {
  const files = []; // { p, size, ts }
  const stack = [root];
  let count = 0;

  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // no permission etc.
    }
    for (const e of entries) {
      const name = e.name;
      if (skipHidden && name.startsWith(".")) continue;
      const full = path.join(dir, name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(name.toLowerCase())) continue;
        stack.push(full);
      } else if (e.isFile()) {
        try {
          const st = await fsp.stat(full);
          files.push({ p: full, size: st.size, ts: lastUsed(st), at: st.atimeMs, mt: st.mtimeMs });
          count++;
          if (count % 20000 === 0) {
            process.stderr.write(`  ...${count.toLocaleString()} files scanned\n`);
          }
        } catch {
          /* ignore unreadable files */
        }
      }
    }
  }
  return files;
}

// Reading a file for hashing can refresh its "last accessed" time on some systems,
// which would make old files look recently used on the next run. Put it back.
async function restoreTimes(f) {
  try {
    const st = await fsp.stat(f.p);
    if (st.atimeMs !== f.at) await fsp.utimes(f.p, new Date(f.at), new Date(st.mtimeMs));
  } catch { /* not allowed or file vanished - ignore */ }
}

// ---------- duplicates ----------

async function hashPartial(file) {
  let fh;
  try {
    fh = await fsp.open(file, "r");
    const buf = Buffer.alloc(MB);
    const { bytesRead } = await fh.read(buf, 0, MB, 0); // first 1 MB only
    return crypto.createHash("sha256").update(buf.subarray(0, bytesRead)).digest("hex");
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

function hashFull(file) {
  return new Promise((resolve) => {
    const h = crypto.createHash("sha256");
    const s = fs.createReadStream(file);
    s.on("error", () => resolve(null));
    s.on("data", (chunk) => h.update(chunk));
    s.on("end", () => resolve(h.digest("hex")));
  });
}

function groupBy(items, keyFn) {
  const m = new Map();
  for (const it of items) {
    const k = keyFn(it);
    if (k === null || k === undefined) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(it);
  }
  return m;
}

// size -> partial hash -> full hash (fast and accurate)
async function findDuplicates(files, minBytes) {
  const bySize = groupBy(files.filter((f) => f.size >= minBytes), (f) => f.size);
  const groups = [];

  for (const [size, items] of bySize) {
    if (items.length < 2) continue;

    for (const it of items) { it.partial = await hashPartial(it.p); await restoreTimes(it); }
    for (const cand of groupBy(items, (f) => f.partial).values()) {
      if (cand.length < 2) continue;

      for (const it of cand) { it.full = await hashFull(it.p); await restoreTimes(it); }
      for (const same of groupBy(cand, (f) => f.full).values()) {
        if (same.length > 1) groups.push({ size, items: same });
      }
    }
  }
  groups.sort((a, b) => b.size * (b.items.length - 1) - a.size * (a.items.length - 1));
  return groups;
}

// ---------- old folders ----------

function oldFolders(files, root, cutoff, minBytes) {
  const total = new Map();
  const newest = new Map();

  for (const f of files) {
    let d = path.dirname(f.p);
    for (;;) {
      total.set(d, (total.get(d) || 0) + f.size);
      newest.set(d, Math.max(newest.get(d) || 0, f.ts));
      if (d === root || path.dirname(d) === d) break;
      d = path.dirname(d);
    }
  }

  const result = [];
  for (const [d, size] of total) {
    if (d !== root && newest.get(d) < cutoff && size >= minBytes) {
      result.push({ d, size, ts: newest.get(d) });
    }
  }
  result.sort((a, b) => b.size - a.size);

  // Drop sub-folders whose parent is already listed (avoid double counting).
  const listed = [];
  for (const r of result) {
    if (!listed.some((p) => r.d.startsWith(p.d + path.sep))) listed.push(r);
  }
  return listed;
}

// ---------- main ----------

function csvCell(v) {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const opts = parseArgs(process.argv);
  const root = path.resolve(expandHome(opts.path));

  let st;
  try {
    st = fs.statSync(root);
  } catch {
    console.error(`Not found: ${root}`);
    process.exit(1);
  }
  if (!st.isDirectory()) {
    console.error(`Not a folder: ${root}`);
    process.exit(1);
  }

  const cutoff = Date.now() - opts.months * 30.44 * DAY_MS;
  const minBytes = Math.floor(opts.minSize * MB);
  const dupBytes = Math.floor(opts.dupMinSize * MB);

  process.stderr.write(`Scanning ${root} ...\n`);
  const files = await scan(root, !opts.includeHidden);
  process.stderr.write(`Found ${files.length.toLocaleString()} files. Looking for duplicates ...\n`);

  const oldBigFiles = files
    .filter((f) => f.size >= minBytes && f.ts < cutoff)
    .sort((a, b) => b.size - a.size);
  const folders = oldFolders(files, root, cutoff, minBytes);
  const dups = await findDuplicates(files, dupBytes);

  const reclaimDups = dups.reduce((s, g) => s + g.size * (g.items.length - 1), 0);
  const oldTotal = oldBigFiles.reduce((s, f) => s + f.size, 0);

  const lines = [];
  const w = (s = "") => lines.push(s);
  const bar = "=".repeat(70);

  w(`CLEANUP REPORT for ${root}`);
  w(`Created: ${new Date().toISOString().slice(0, 16).replace("T", " ")}`);
  w(`Criteria: unused for ${opts.months}+ months, size >= ${opts.minSize} MB`);
  w("(Nothing was deleted. Please review before removing anything.)\n");

  w(bar);
  w(`1) BIG FILES NOT USED FOR ${opts.months}+ MONTHS (${oldBigFiles.length} found, total ${human(oldTotal)})`);
  w(bar);
  for (const f of oldBigFiles.slice(0, opts.top)) {
    w(`${human(f.size).padStart(10)}  last used ${fmtDate(f.ts)}  ${f.p}`);
  }

  w("\n" + bar);
  w(`2) FOLDERS WHERE EVERYTHING IS UNUSED FOR ${opts.months}+ MONTHS (${folders.length} found)`);
  w(bar);
  for (const f of folders.slice(0, opts.top)) {
    w(`${human(f.size).padStart(10)}  last used ${fmtDate(f.ts)}  ${f.d}`);
  }

  w("\n" + bar);
  w(`3) DUPLICATE FILES (${dups.length} groups, could free ${human(reclaimDups)})`);
  w(bar);
  for (const g of dups.slice(0, opts.top)) {
    const extra = g.items.length - 1;
    w(`\n${human(g.size)} each, ${g.items.length} copies (deleting ${extra} frees ${human(g.size * extra)}):`);
    for (const it of [...g.items].sort((a, b) => a.ts - b.ts)) {
      w(`   last used ${fmtDate(it.ts)}  ${it.p}`);
    }
  }

  const report = lines.join("\n");
  const txtPath = `${opts.out}.txt`;
  fs.writeFileSync(txtPath, report, "utf8");

  const csvRows = [["type", "size_bytes", "size_human", "last_used", "path", "duplicate_group"]];
  for (const f of oldBigFiles) csvRows.push(["old_file", f.size, human(f.size), fmtDate(f.ts), f.p, ""]);
  for (const f of folders) csvRows.push(["old_folder", f.size, human(f.size), fmtDate(f.ts), f.d, ""]);
  dups.forEach((g, i) => {
    for (const it of g.items) csvRows.push(["duplicate", g.size, human(g.size), fmtDate(it.ts), it.p, i + 1]);
  });
  const csvPath = `${opts.out}.csv`;
  fs.writeFileSync(csvPath, csvRows.map((r) => r.map(csvCell).join(",")).join("\n"), "utf8");

  console.log(report.slice(0, 6000));
  if (report.length > 6000) console.log("\n... (truncated, see full report file)");
  console.log(`\nFull report saved to:\n  ${path.resolve(txtPath)}\n  ${path.resolve(csvPath)}`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
