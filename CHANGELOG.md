# Changelog

## 1.0.0

First public version.

- `free-up-space`: builds a tiered plan (safe, low risk, review, careful) to free a target amount of space.
- `disk-cleanup-scan`: lists big files and folders unused for N months and duplicate files.
- Duplicate detection by size, then first-megabyte hash, then full SHA-256 hash.
- Access times of files read during duplicate detection are restored, so a second run is not fooled.
- `--skip-known-caches` to scan only the folder you give.
- Report-only: nothing is ever deleted.
