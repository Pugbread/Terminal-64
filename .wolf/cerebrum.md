# Cerebrum

> OpenWolf's learning memory. Updated automatically as the AI learns from interactions.
> Do not edit manually unless correcting an error.
> Last updated: 2026-04-15

## User Preferences

<!-- How the user likes things done. Code style, tools, patterns, communication. -->

## Key Learnings

- **Project:** terminal-64
- **Description:** A canvas-based terminal emulator and AI workstation built with **Tauri v2** + **React 19** + **xterm.js**. Manage multiple terminal sessions and Claude Code agents simultaneously on a free-form pan/zo

## Do-Not-Repeat

<!-- Mistakes made and corrected. Each entry prevents the same mistake recurring. -->
<!-- Format: [YYYY-MM-DD] Description of what went wrong and what to do instead. -->
- [2026-04-16] Rewind's restoreCheckpoint(keepTurns+1) restores the PREVIOUS turn's snapshot. When rewinding to the last user message (undo-send), this causes data loss. Always detect undo-send (target is last msg, no assistant response) and skip file operations.
- [2026-04-16] For a "traveling comet" border beam, NEVER use multiple discrete DOM elements (divs/dots) with staggered animation-delay riding the same offset-path — they always render as visibly separated dots. Correct approach: SVG `<rect pathLength="100">` + `stroke-dasharray` + animated `stroke-dashoffset` for geometrically-perfect corner wrapping with real `feGaussianBlur` for glow. Alternative: single element with gradient-to-transparent (gradient IS the tail). Conic-gradient+mask distorts speed at corners on wide rectangles.
- [2026-04-16] Rust `Command::new("pm2")` or `Command::new("openwolf")` on Windows DOES NOT resolve `.cmd`/`.bat` shims via PATHEXT (unlike the shell). npm-installed tools register as `.cmd` files in `%APPDATA%\npm` — must invoke via `cmd /C <shim> <args>` with CREATE_NO_WINDOW (0x08000000) to avoid a console flash. Applies to: pm2, claude, openwolf, any npx-installed CLI.
- [2026-04-16] `std::os::windows::fs::symlink_dir` REQUIRES Administrator or Developer Mode on Windows — normal users get permission denied. Fall back to directory junctions via `cmd /C mklink /J link target` which do NOT require elevated permissions. See `create_dir_link()` helper in lib.rs.
- [2026-04-16] `env!("CARGO_MANIFEST_DIR")` bakes in the developer's compile-time path — production builds crash looking for `/Users/janislacars/...` on end-user Windows machines. For bundled resources, always use `app_handle.path().resource_dir()` first and only fall back to CARGO_MANIFEST_DIR for dev/unpackaged runs.
- [2026-04-16] For rewind/undo flows: if `git` command itself fails to SPAWN (not found on PATH), treating that as "untracked" triggers `remove_file` on user-edited TRACKED files — DATA LOSS. Always distinguish `Err(spawn failed)` from `Ok(exit != 0)` — the former means skip-and-log, only the latter means safe-to-delete.
- [2026-04-16] `PathBuf::starts_with` is a LEXICAL prefix check — it does NOT collapse `..` segments. Zip archives with `..\..\foo` paths can escape the destination directory on Windows even with a `starts_with` guard. Always iterate `components()` and reject `Component::ParentDir`, `RootDir`, `Prefix` before joining.

## Decision Log

<!-- Significant technical decisions with rationale. Why X was chosen over Y. -->
