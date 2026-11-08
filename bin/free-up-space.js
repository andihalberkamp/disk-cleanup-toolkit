#!/usr/bin/env node
/**
 * free-up-space.js - builds a step-by-step plan to free a target amount of disk space.
 *
 * SAFE: this script only READS and REPORTS. It never deletes anything.
 *
 * It looks for, in order of safety:
 *   1. SAFE      caches, trash, build folders (node_modules ...), old junk files
 *   2. LOW RISK  duplicate files (one copy is kept) and old installers/archives
 *   3. REVIEW    old large files (videos, VM images, old iPhone backups, ...)
 *   4. CAREFUL   old personal photos/documents (move to external drive instead)
 * and recommends items tier by tier, biggest first, until your target is reached.
 *
 * Usage examples:
 *   node free-up-space.js ~                          # target 100 GB (default)
 *   node free-up-space.js "C:\Users\Me" --target 100
 *   node free-up-space.js /mnt/data --target 50 --months 6
 *
 * Requires Node.js 14+ (no npm packages needed).
 */

"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const MB = 1024 * 1024;
const GB = 1024 * MB;
const DAY_MS = 86400 * 1000;

// Never look inside these (system / program folders).
const SYSTEM_DIRS = new Set([
  "windows", "program files", "program files (x86)", "programdata",
  "$recycle.bin", "system volume information", "appdata",
  "system", "library", "applications", "private", "volumes",
  "proc", "sys", "dev", "run", "boot", "bin", "sbin", "lib", "lib64",
  "usr", "etc", "var", "snap", ".git",
]);

// Folders that can be recreated automatically.
const REGENERABLE_DIRS = new Map([
  ["node_modules", "Node.js dependencies - recreate with `npm install`"],
  ["__pycache__", "Python bytecode cache - recreated automatically"],
  [".pytest_cache", "pytest cache - recreated automatically"],
  [".next", "Next.js build cache - recreated on next build"],
  [".nuxt", "Nuxt build cache - recreated on next build"],
  [".parcel-cache", "Parcel build cache - recreated on next build"],
  ["deriveddata", "Xcode build files - recreated on next build"],
]);

const JUNK_EXT = new Set([".log", ".tmp", ".temp", ".dmp", ".part", ".crdownload", ".download"]);
const INSTALLER_EXT = new Set([
  ".iso", ".dmg", ".exe", ".msi", ".pkg", ".deb", ".rpm", ".appimage", ".apk",
  ".zip", ".rar", ".7z", ".tar", ".gz", ".tgz", ".bz2", ".xz",
]);
const PERSONAL_EXT = new Set([
  ".jpg", ".jpeg", ".png", ".heic", ".tif", ".tiff", ".raw", ".cr2", ".nef", ".arw", ".dng",
  ".psd", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".pdf", ".odt", ".ods",
  ".key", ".pages", ".numbers",
]);

const TIERS = {
  1: { name: "SAFE", title: "Caches, trash & junk - recreated automatically or no longer needed",
       advice: "No risk to your own data." },
  2: { name: "LOW RISK", title: "Duplicates & old installers/archives",
       advice: "For duplicates one copy is kept. Installers can be downloaded again." },
  3: { name: "REVIEW", title: "Old large files (videos, VM images, backups, ...)",
       advice: "Look at each one before deleting." },
  4: { name: "CAREFUL", title: "Old personal photos & documents",
       advice: "Back up or move to an external drive / cloud instead of deleting." },
};

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
  if (!ms) return "unknown";
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function expandHome(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function lastUsed(st) {
  return Math.max(st.atimeMs, st.mtimeMs); // atime alone is unreliable
}

function parseArgs(argv) {
  const o = { path: os.homedir(), target: 100, months: 4, minSize: 100, dupMinSize: 10,
              minCache: 20, out: "free_space_plan", includeHidden: false, skipKnown: false };
  const r = argv.slice(2);
  for (let i = 0; i < r.length; i++) {
    const a = r[i];
    switch (a) {
      case "--target": o.target = Number(r[++i]); break;
      case "--months": o.months = Number(r[++i]); break;
      case "--min-size": o.minSize = Number(r[++i]); break;
      case "--dup-min-size": o.dupMinSize = Number(r[++i]); break;
      case "--min-cache": o.minCache = Number(r[++i]); break;
      case "--out": o.out = r[++i]; break;
      case "--include-hidden": o.includeHidden = true; break;
      case "--skip-known-caches": o.skipKnown = true; break;
      case "-h":
      case "--help":
        console.log(
          "Usage: node free-up-space.js [path] [--target 100] [--months 4] [--min-size 100]\n" +
          "       [--dup-min-size 10] [--min-cache 20] [--include-hidden] [--skip-known-caches]\n" +
          "       [--out free_space_plan]\n" +
          "  --target GB, --min-size/--dup-min-size/--min-cache in MB"
        );
        process.exit(0);
        break;
      default:
        if (a.startsWith("--")) { console.error(`Unknown option: ${a}`); process.exit(1); }
        o.path = a;
    }
  }
  if (![o.target, o.months, o.minSize, o.dupMinSize, o.minCache].every((x) => Number.isFinite(x) && x >= 0)) {
    console.error("Numeric options must be valid numbers.");
    process.exit(1);
  }
  return o;
}

// ---------- scanning ----------

async function dirSize(dir) {
  let size = 0;
  let newest = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) {
        try {
          const st = await fsp.stat(full);
          size += st.size;
          newest = Math.max(newest, lastUsed(st));
        } catch { /* ignore */ }
      }
    }
  }
  return { size, newest };
}

async function scan(root, skipHidden, minCacheBytes) {
  const files = [];
  const regen = [];
  const stack = [root];
  let count = 0;
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const name = e.name;
      const lower = name.toLowerCase();
      const full = path.join(dir, name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (REGENERABLE_DIRS.has(lower)) {
          const { size, newest } = await dirSize(full);
          if (size >= minCacheBytes) {
            regen.push({ p: full, size, ts: newest, isDir: true, why: REGENERABLE_DIRS.get(lower) });
          }
          continue;
        }
        if (SYSTEM_DIRS.has(lower)) continue;
        if (skipHidden && name.startsWith(".")) continue;
        stack.push(full);
      } else if (e.isFile()) {
        if (skipHidden && name.startsWith(".")) continue;
        try {
          const st = await fsp.stat(full);
          files.push({ p: full, size: st.size, ts: lastUsed(st), at: st.atimeMs, mt: st.mtimeMs });
          if (++count % 20000 === 0) process.stderr.write(`  ...${count.toLocaleString()} files scanned\n`);
        } catch { /* ignore */ }
      }
    }
  }
  return { files, regen };
}

// Well-known cache / trash locations (checked directly, wherever you scan).
async function knownCaches(minCacheBytes) {
  const home = os.homedir();
  const loc = [];
  const add = (p, why) => p && loc.push({ p: path.resolve(p), why });
  add(path.join(home, ".Trash"), "Trash - emptying it frees this space");
  add(path.join(home, ".local", "share", "Trash"), "Trash - emptying it frees this space");
  add(path.join(home, ".cache"), "User cache folder - apps rebuild it as needed");
  add(path.join(home, ".npm", "_cacache"), "npm download cache");
  add(path.join(home, ".gradle", "caches"), "Gradle download cache");
  if (process.platform === "darwin") {
    add(path.join(home, "Library", "Caches"), "App caches - rebuilt as needed");
    add(path.join(home, "Library", "Developer", "Xcode", "DerivedData"), "Xcode build files");
    add(path.join(home, "Library", "Developer", "Xcode", "iOS DeviceSupport"), "Xcode device symbols - re-created when you plug in a device");
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    if (local) {
      add(path.join(local, "Temp"), "Windows temp files");
      add(path.join(local, "npm-cache"), "npm download cache");
      add(path.join(local, "pip", "Cache"), "pip download cache");
    }
  }
  const out = [];
  for (const l of loc) {
    const { size, newest } = await dirSize(l.p);
    if (size >= minCacheBytes) out.push({ ...l, size, ts: newest, isDir: true });
  }
  return out;
}

// Old iPhone/iPad backups: every sub-folder is one backup.
async function oldIosBackups(cutoff, minBytes) {
  const home = os.homedir();
  const bases = [];
  if (process.platform === "darwin") bases.push(path.join(home, "Library", "Application Support", "MobileSync", "Backup"));
  if (process.platform === "win32") {
    if (process.env.APPDATA) bases.push(path.join(process.env.APPDATA, "Apple Computer", "MobileSync", "Backup"));
    bases.push(path.join(home, "Apple", "MobileSync", "Backup"));
  }
  const out = [];
  for (const base of bases) {
    let entries;
    try { entries = await fsp.readdir(base, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(base, e.name);
      const { size, newest } = await dirSize(full);
      if (size >= minBytes && newest < cutoff) {
        out.push({ p: full, size, ts: newest, isDir: true, why: "Old iPhone/iPad backup" });
      }
    }
  }
  return out;
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
    const { bytesRead } = await fh.read(buf, 0, MB, 0);
    return crypto.createHash("sha256").update(buf.subarray(0, bytesRead)).digest("hex");
  } catch { return null; } finally { if (fh) await fh.close().catch(() => {}); }
}

function hashFull(file) {
  return new Promise((resolve) => {
    const h = crypto.createHash("sha256");
    const s = fs.createReadStream(file);
    s.on("error", () => resolve(null));
    s.on("data", (c) => h.update(c));
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

async function findDuplicates(files, minBytes) {
  const groups = [];
  for (const [size, items] of groupBy(files.filter((f) => f.size >= minBytes), (f) => f.size)) {
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
  return groups;
}

// ---------- tips ----------

function platformTips() {
  const tips = [];
  if (process.platform === "win32") {
    tips.push("Settings > System > Storage > Temporary files / Cleanup recommendations (old Windows updates, Windows.old).");
    tips.push("Uninstall unused apps and games (Settings > Apps) - games are often 50-150 GB each.");
    tips.push("Docker/WSL users: `docker system prune -a` and compact the WSL virtual disk.");
    tips.push("Only if you never use hibernate/fast startup: `powercfg /hibernate off` frees several GB.");
  } else if (process.platform === "darwin") {
    tips.push("System Settings > General > Storage: review the built-in recommendations.");
    tips.push("Uninstall unused apps and games from Applications.");
    tips.push("Developers: `xcrun simctl delete unavailable` and `docker system prune -a`.");
    tips.push("Check Time Machine local snapshots: `tmutil listlocalsnapshots /`.");
  } else {
    tips.push("Debian/Ubuntu: `sudo apt clean && sudo apt autoremove`; Fedora: `sudo dnf clean all`.");
    tips.push("Shrink system logs: `sudo journalctl --vacuum-size=200M`.");
    tips.push("Docker users: `docker system prune -a`.");
    tips.push("Find what is big: `ncdu /` or `du -h --max-depth=1 / | sort -h`.");
  }
  tips.push("Move rarely used photos/videos to an external drive or cloud storage instead of deleting them.");
  return tips;
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
  try { st = fs.statSync(root); } catch { console.error(`Not found: ${root}`); process.exit(1); }
  if (!st.isDirectory()) { console.error(`Not a folder: ${root}`); process.exit(1); }

  const cutoff = Date.now() - opts.months * 30.44 * DAY_MS;
  const minBytes = Math.floor(opts.minSize * MB);
  const dupBytes = Math.floor(opts.dupMinSize * MB);
  const cacheBytes = Math.floor(opts.minCache * MB);
  const targetBytes = opts.target * GB;

  let diskInfo = "";
  try {
    if (typeof fs.statfsSync === "function") {
      const s = fs.statfsSync(root);
      diskInfo = `Disk: ${human(s.bavail * s.bsize)} free of ${human(s.blocks * s.bsize)}`;
    }
  } catch { /* not available */ }

  process.stderr.write(`Scanning ${root} ...\n`);
  const { files, regen } = await scan(root, !opts.includeHidden, cacheBytes);
  process.stderr.write(`Found ${files.length.toLocaleString()} files. Checking caches ...\n`);
  const known = opts.skipKnown ? [] : await knownCaches(cacheBytes);

  // --- selection state (avoids counting the same bytes twice) ---
  const chosenFiles = new Set();
  const chosenDirs = [];
  const protectedFiles = new Set(); // copies we keep
  const insideDir = (p) => chosenDirs.some((d) => p === d || p.startsWith(d + path.sep));
  const taken = (p) => chosenFiles.has(p) || protectedFiles.has(p) || insideDir(p);
  const items = []; // { tier, p, size, ts, isDir, why, action }

  const addDir = (c, tier, action) => {
    if (insideDir(c.p) || chosenDirs.some((d) => d.startsWith(c.p + path.sep))) return;
    chosenDirs.push(c.p);
    items.push({ tier, ...c, action });
  };
  const addFile = (c, tier, action) => {
    chosenFiles.add(c.p);
    items.push({ tier, ...c, isDir: false, action });
  };

  // Tier 1: caches / regenerable folders / trash / old junk files
  [...regen, ...known].sort((a, b) => b.size - a.size).forEach((c) => addDir(c, 1, "delete"));
  for (const f of files.filter((f) => JUNK_EXT.has(path.extname(f.p).toLowerCase())
        && f.size >= cacheBytes && f.ts < cutoff && !taken(f.p)).sort((a, b) => b.size - a.size)) {
    addFile({ ...f, why: "Old log / temp / incomplete-download file" }, 1, "delete");
  }

  // Tier 2: duplicates (keep one copy) + old installers/archives
  process.stderr.write("Looking for duplicates ...\n");
  const dupGroups = await findDuplicates(files.filter((f) => !taken(f.p)), dupBytes);
  const tier2 = [];
  for (const g of dupGroups) {
    const sorted = [...g.items].sort((a, b) => a.p.length - b.p.length || a.ts - b.ts);
    const keeper = sorted[0];
    protectedFiles.add(keeper.p);
    for (const dup of sorted.slice(1)) {
      chosenFiles.add(dup.p);
      tier2.push({ tier: 2, ...dup, isDir: false, action: "delete",
                   why: `Duplicate - keep: ${keeper.p}` });
    }
  }
  for (const f of files) {
    if (INSTALLER_EXT.has(path.extname(f.p).toLowerCase()) && f.size >= minBytes
        && f.ts < cutoff && !taken(f.p)) {
      chosenFiles.add(f.p);
      tier2.push({ tier: 2, ...f, isDir: false, action: "delete",
                   why: "Old installer / archive - can usually be downloaded again" });
    }
  }
  tier2.sort((a, b) => b.size - a.size).forEach((c) => items.push(c));

  // Tier 3 & 4: old large files, plus old iPhone backups
  const backups = opts.skipKnown ? [] : await oldIosBackups(cutoff, cacheBytes);
  backups.sort((a, b) => b.size - a.size).forEach((c) => addDir(c, 3, "review, then delete"));

  const oldBig = files.filter((f) => f.size >= minBytes && f.ts < cutoff && !taken(f.p))
    .sort((a, b) => b.size - a.size);
  for (const f of oldBig) {
    if (PERSONAL_EXT.has(path.extname(f.p).toLowerCase())) {
      addFile({ ...f, why: "Old personal photo/document - consider moving to external drive or cloud" },
              4, "back up, then delete");
    } else {
      addFile({ ...f, why: "Large file not used for a long time" }, 3, "review, then delete");
    }
  }
  items.sort((a, b) => a.tier - b.tier); // stable: size order kept inside each tier

  // --- build plan up to target ---
  let cum = 0;
  let reachedAt = -1;
  items.forEach((it, i) => {
    if (reachedAt === -1) {
      cum += it.size;
      it.inPlan = true;
      it.cum = cum;
      if (cum >= targetBytes) reachedAt = i;
    } else {
      it.inPlan = false;
    }
  });
  const totalFound = items.reduce((s, i) => s + i.size, 0);
  const planned = items.filter((i) => i.inPlan);

  // --- report ---
  const lines = [];
  const w = (s = "") => lines.push(s);
  const bar = "=".repeat(74);

  w(`SPACE-FREEING PLAN for ${root}`);
  w(`Created: ${new Date().toISOString().slice(0, 16).replace("T", " ")}`);
  if (diskInfo) w(diskInfo);
  w(`Goal: free ${opts.target} GB    (old = not used for ${opts.months}+ months)`);
  w("Nothing was deleted. Do the steps in order and review before removing.\n");

  w(bar);
  w("WHAT WAS FOUND");
  w(bar);
  let running = 0;
  for (const t of [1, 2, 3, 4]) {
    const ti = items.filter((i) => i.tier === t);
    const sum = ti.reduce((s, i) => s + i.size, 0);
    running += sum;
    w(`Tier ${t} ${TIERS[t].name.padEnd(9)} ${String(ti.length).padStart(5)} items  ${human(sum).padStart(10)}   (tiers 1-${t} together: ${human(running)})`);
  }
  if (totalFound >= targetBytes) {
    const tierNeeded = planned.length ? planned[planned.length - 1].tier : 1;
    w(`\nGood news: enough was found to reach ${opts.target} GB (needs tiers 1-${tierNeeded}).`);
  } else {
    w(`\nOnly ${human(totalFound)} found - short by ${human(targetBytes - totalFound)}. See "OTHER IDEAS" below.`);
  }

  w("\n" + bar);
  w("RECOMMENDED PLAN (in this order)");
  w(bar);
  let lastTier = 0;
  planned.forEach((it, i) => {
    if (it.tier !== lastTier) {
      lastTier = it.tier;
      const tierItems = planned.filter((x) => x.tier === it.tier);
      w(`\n--- STEP ${it.tier}: ${TIERS[it.tier].name} - ${TIERS[it.tier].title}`);
      w(`    ${TIERS[it.tier].advice}  (${tierItems.length} items, ${human(tierItems.reduce((s, x) => s + x.size, 0))})`);
    }
    w(`${String(i + 1).padStart(4)}. ${human(it.size).padStart(9)}  [total ${human(it.cum)}]  ${it.isDir ? "FOLDER " : ""}${it.p}`);
    w(`       last used ${fmtDate(it.ts)} | ${it.why}`);
  });
  if (reachedAt !== -1) {
    w(`\n>>> TARGET REACHED: ${human(cum)} freed after the last item above. <<<`);
  }

  const rest = items.filter((i) => !i.inPlan);
  if (rest.length) {
    w(`\n(${rest.length} more candidates, ${human(rest.reduce((s, i) => s + i.size, 0))}, are listed in the CSV but not needed for your target.)`);
  }

  w("\n" + bar);
  w("OTHER IDEAS (not scanned automatically)");
  w(bar);
  platformTips().forEach((t) => w(`- ${t}`));

  const report = lines.join("\n");
  fs.writeFileSync(`${opts.out}.txt`, report, "utf8");

  const rows = [["step_tier", "tier_name", "size_bytes", "size_human", "last_used", "type", "path", "action", "reason", "in_plan", "cumulative_human"]];
  for (const it of items) {
    rows.push([it.tier, TIERS[it.tier].name, it.size, human(it.size), fmtDate(it.ts),
               it.isDir ? "folder" : "file", it.p, it.action, it.why,
               it.inPlan ? "yes" : "no", it.inPlan ? human(it.cum) : ""]);
  }
  fs.writeFileSync(`${opts.out}.csv`, rows.map((r) => r.map(csvCell).join(",")).join("\n"), "utf8");

  console.log(report.slice(0, 8000));
  if (report.length > 8000) console.log("\n... (truncated, see full report file)");
  console.log(`\nFull plan saved to:\n  ${path.resolve(opts.out + ".txt")}\n  ${path.resolve(opts.out + ".csv")}`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
