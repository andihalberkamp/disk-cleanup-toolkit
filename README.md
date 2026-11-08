# 🧹 disk-cleanup-toolkit

> Find big, old and duplicate files, and get a **safe, step-by-step plan** to free up disk space (for example: "free 100 GB").
> **Report-only: it never deletes anything.** You stay in control.

[![CI](https://github.com/andihalberkamp/disk-cleanup-toolkit/actions/workflows/ci.yml/badge.svg)](https://github.com/YOUR-USERNAME/disk-cleanup-toolkit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
![Node.js](https://img.shields.io/badge/node-%3E%3D14-brightgreen)
![Dependencies](https://img.shields.io/badge/dependencies-0-blue)

## Why?

Disk cleaners are often scary: they delete things for you and you have to trust them.
This toolkit does the opposite. It scans, explains, and gives you a ranked list. You decide what to remove.

- 🔒 **Read-only**: nothing is deleted, moved or changed
- 📦 **Zero dependencies**: just Node.js
- 🖥️ **Windows, macOS and Linux**
- 🎯 **Goal-based**: tell it how much space you want, it builds the plan

## Tools

| Tool | What it does |
|------|--------------|
| `free-up-space` | Builds a prioritized plan to free a **target amount** (default 100 GB), safest items first |
| `disk-cleanup-scan` | Lists **big files/folders unused for N months** and **duplicate files** |

## Quick start

You need [Node.js](https://nodejs.org) 14 or newer.

```bash
git clone https://github.com/andihalberkamp/disk-cleanup-toolkit.git
cd disk-cleanup-toolkit

# Plan to free 100 GB from your home folder
node bin/free-up-space.js ~ --target 100
```

Windows:

```powershell
node bin\free-up-space.js "C:\Users\YourName" --target 100
```

Optional, to get the commands everywhere: `npm link`, then use `free-up-space` and `disk-cleanup-scan`.

> 💡 Start with a folder like `Downloads` or `Videos` to try it out. Scanning a whole drive for duplicates can take a while.

## `free-up-space`: the plan

Items are recommended tier by tier, biggest first, until your target is reached.

| Tier | Name | What is in it | Risk |
|------|------|---------------|------|
| 1 | **SAFE** | Caches, trash, temp files, old logs, incomplete downloads, `node_modules` and similar folders that can be recreated | None for your own data |
| 2 | **LOW RISK** | Duplicate files (one copy is kept, the plan tells you which) and old installers/archives (`.iso`, `.dmg`, `.exe`, `.zip` ...) | Low |
| 3 | **REVIEW** | Old large files (videos, VM images, old iPhone/iPad backups ...) | Check each one |
| 4 | **CAREFUL** | Old personal photos and documents | Back up / move to an external drive first |

Example output (shortened):

```
SPACE-FREEING PLAN for /home/me
Goal: free 100 GB    (old = not used for 4+ months)

WHAT WAS FOUND
Tier 1 SAFE          14 items     38.2 GB   (tiers 1-1 together: 38.2 GB)
Tier 2 LOW RISK      63 items     41.7 GB   (tiers 1-2 together: 79.9 GB)
Tier 3 REVIEW        22 items     57.0 GB   (tiers 1-3 together: 136.9 GB)
Tier 4 CAREFUL        9 items      8.1 GB   (tiers 1-4 together: 145.0 GB)

Good news: enough was found to reach 100 GB (needs tiers 1-3).

--- STEP 1: SAFE - Caches, trash & junk - recreated automatically or no longer needed
   1.   12.4 GB  [total 12.4 GB]  FOLDER /home/me/projects/app/node_modules
       last used 2026-09-01 | Node.js dependencies - recreate with `npm install`
...
>>> TARGET REACHED: 101.3 GB freed after the last item above. <<<
```

The full plan is saved as `free_space_plan.txt` and `free_space_plan.csv` (open the CSV in Excel / Numbers / LibreOffice).

### Options

| Option | Default | Meaning |
|--------|---------|---------|
| `[path]` | home folder | Folder to scan |
| `--target <GB>` | `100` | How much space you want to free |
| `--months <N>` | `4` | A file counts as "old" if unused for N months |
| `--min-size <MB>` | `100` | Minimum size for old large files and installers |
| `--dup-min-size <MB>` | `10` | Minimum size for the duplicate check |
| `--min-cache <MB>` | `20` | Minimum size for cache folders and junk files |
| `--include-hidden` | off | Also scan hidden files and folders |
| `--skip-known-caches` | off | Only scan the given folder (skip well-known cache/trash/backup locations) |
| `--out <name>` | `free_space_plan` | Prefix for the report files |

## `disk-cleanup-scan`: simple report

```bash
node bin/disk-cleanup-scan.js ~ --months 4 --min-size 100
```

Creates `cleanup_report.txt` / `.csv` with:

1. Big files not used for N months
2. Folders where *everything* inside is unused for N months
3. Duplicate files, grouped, with the space you would free

Options: `--months`, `--min-size <MB>`, `--dup-min-size <MB>`, `--top <N>`, `--include-hidden`, `--out <name>`.

## How it works

- **"Unused"** means the later of *last accessed* and *last modified* time, because access times alone are unreliable on many systems.
- **Duplicates** are found in three steps: same size, then same first megabyte (hash), then same full SHA-256 hash. So it is fast *and* exact.
  The copy with the shortest path is kept; the others are suggested for deletion.
- Reading files for the duplicate check can refresh their "last accessed" time on some systems. The tools put the original time back, so a second run is not fooled.
- System folders (`Windows`, `Program Files`, `/usr`, `Library`, `.git` ...) are never scanned.
- Nothing is counted twice: a file inside a folder that is already in the plan is skipped.

## Safety

- The tools **only read** your files. The single write operation is restoring a file's original access time (see above) and writing the report files in the current folder.
- Still, **review everything** before you delete it, and keep backups of anything you care about.
- Deleting `node_modules` from a project you are working on just means running `npm install` again.
- Some tiers are suggestions based on file type and age, not on knowing what the file is. Tier 3 and 4 need your judgement.

## Platform notes

- **macOS:** to include the Trash and some caches, give your terminal *Full Disk Access* (System Settings → Privacy & Security).
- **Windows:** run in a normal terminal; no administrator rights needed.
- **Linux:** the report also lists tips like `apt clean`, `journalctl --vacuum-size` and `docker system prune` that the tool cannot safely scan for.
- Network drives and external disks work but can be slow.

## Development

```bash
npm test      # Node.js 18+ (built-in test runner)
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Ideas: opt-in move-to-Trash, HTML report, ignore-list.

## License

[MIT](LICENSE)
