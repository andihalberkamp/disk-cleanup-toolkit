# Contributing

Thanks for helping! This project is intentionally small: plain Node.js, no runtime dependencies.

## Ground rules

1. **Report-only.** The tools must never delete, move or modify the user's files.
   (The only exception is restoring a file's original "last accessed" time after reading it.)
2. **No runtime dependencies.** Use Node's built-in modules.
3. **Safe by default.** When unsure whether something is safe to delete, put it in a more cautious tier or leave it out.
4. Works on Windows, macOS and Linux, Node.js 14+.

## Development

```
git clone https://github.com/andihalberkamp/disk-cleanup-toolkit.git
cd disk-cleanup-toolkit
npm test            # needs Node.js 18+ (uses the built-in test runner)
node bin/free-up-space.js ~/Downloads --target 5
```

## Pull requests

- Add or update a test in `test/` for behaviour changes.
- Update `README.md` and `CHANGELOG.md` if options or output change.
- Keep the PR focused on one thing.

## Ideas that would be welcome

- More known cache locations (per OS)
- Moving selected items to the Recycle Bin / Trash (opt-in, with confirmation)
- HTML report
- Ignore-list file
