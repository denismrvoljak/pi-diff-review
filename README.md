# pi-diff-review

This is pure slop, see: https://pi.dev/session/#d4ce533cedbd60040f2622dc3db950e2

It is my hope, that someone takes this idea and makes it gud.

Native diff review window for pi, powered by [Glimpse](https://github.com/hazat/glimpse) and Monaco.

```
pi install git:https://github.com/badlogic/pi-diff-review
```

## What it does

Adds a `/diff-review` command to pi.

The command:

1. opens a native review window for the current repository, or for an explicit path via `/diff-review path:<repo-or-folder>`
2. captures a stable review snapshot when the window opens: aggregate branch diff, commit-by-commit changes since the merge base, and working tree changes
3. shows a collapsible sidebar with commit/file hierarchy, fuzzy file search, diff stats, commit metadata, and review/comment indicators
4. detects `linguist-generated` and `linguist-vendored` files and lets you hide or show them
5. lazy-loads file contents on demand, with a manual load step for large files
6. lets you mark files/commits reviewed, draft overall notes, commit/item notes, and inline comments
7. inserts a provenance-aware feedback prompt into the pi editor when you submit, including base/head/working-tree context and guidance to resolve ambiguous feedback before editing code

## Requirements

- macOS, Linux, or Windows
- Node.js 20+
- `pi` installed
- internet access for the Tailwind and Monaco CDNs used by the review window

### Windows notes

Glimpse now supports Windows. To build the native host during install you need:

- .NET 8 SDK
- Microsoft Edge WebView2 Runtime
