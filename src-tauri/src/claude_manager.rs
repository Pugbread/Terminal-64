//! OpenWolf integration helpers + the shared `shim_command` Windows wrapper.
//!
//! The bulk of this module — Claude CLI spawning, JSONL streaming, session
//! sanitisation, event-size capping — moved to `providers/claude.rs` as part
//! of the ProviderAdapter port. The OpenWolf block stayed here for now because
//! it isn't provider-scoped; it will move to a dedicated `openwolf.rs` in a
//! follow-up refactor. `shim_command` is kept `pub` so existing call sites in
//! `lib.rs` and the new `providers::claude` module continue to compile
//! without tracking a moved import path.

use std::process::Stdio;

// Re-exports keep the historical `claude_manager::*` import paths alive so
// the rest of the crate compiles without chasing every call site. The
// definitions now live in the `providers` module.
pub use crate::providers::claude::resolve_claude_path;
pub use crate::providers::util::shim_command;

// ── OpenWolf integration ───────────────────────────────────

/// Resolve the openwolf CLI binary path, similar to resolve_claude_path.
/// Cached after first lookup to avoid shelling out `which` on every prompt.
pub fn resolve_openwolf_path() -> String {
    static CACHED: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    CACHED.get_or_init(resolve_openwolf_path_inner).clone()
}

/// PATH that includes common locations for node, npm, pm2.
pub fn openwolf_env_path() -> String {
    crate::providers::util::expanded_tool_path()
}

fn resolve_openwolf_path_inner() -> String {
    // Bare name on Windows so `where` uses PATHEXT to find .cmd shims.
    let lookup = {
        let (cmd, arg) = if cfg!(windows) {
            ("where", "openwolf")
        } else {
            ("which", "openwolf")
        };
        let mut c = std::process::Command::new(cmd);
        c.arg(arg)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .stdin(Stdio::null());
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x08000000);
        }
        c.output()
    };
    if let Ok(p) = lookup {
        if p.status.success() {
            let s = String::from_utf8_lossy(&p.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            if !s.is_empty() {
                return s;
            }
        }
    }

    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok();

    let mut candidates: Vec<String> = Vec::new();

    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var("APPDATA").ok();
        if let Some(ref a) = appdata {
            candidates.push(format!("{}\\npm\\openwolf.cmd", a));
            candidates.push(format!("{}\\npm\\openwolf.exe", a));
        }
        if let Some(ref h) = home {
            candidates.push(format!("{}\\.npm-global\\openwolf.cmd", h));
            let npx_dir = format!("{}\\AppData\\Local\\npm-cache\\_npx", h);
            if let Ok(entries) = std::fs::read_dir(&npx_dir) {
                for entry in entries.flatten() {
                    let bin = entry
                        .path()
                        .join("node_modules")
                        .join(".bin")
                        .join("openwolf.cmd");
                    if bin.exists() {
                        candidates.push(bin.to_string_lossy().to_string());
                    }
                }
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Some(ref h) = home {
            candidates.push(format!("{}/.local/bin/openwolf", h));
            candidates.push(format!("{}/.npm-global/bin/openwolf", h));
            let npx_dir = format!("{}/.npm/_npx", h);
            if let Ok(entries) = std::fs::read_dir(&npx_dir) {
                for entry in entries.flatten() {
                    let bin = entry
                        .path()
                        .join("node_modules")
                        .join(".bin")
                        .join("openwolf");
                    if bin.exists() {
                        candidates.push(bin.to_string_lossy().to_string());
                    }
                }
            }
        }
        candidates.push("/usr/local/bin/openwolf".to_string());
        candidates.push("/opt/homebrew/bin/openwolf".to_string());
    }

    for c in &candidates {
        if std::path::Path::new(c).exists() {
            return c.clone();
        }
    }

    #[cfg(target_os = "windows")]
    return "openwolf.cmd".to_string();
    #[cfg(not(target_os = "windows"))]
    return "openwolf".to_string();
}

/// Check if .wolf/ exists in the project CWD. If auto_init is true
/// and .wolf/ is missing, run `openwolf init` to create it.
/// Returns true if .wolf/ exists (or was just created).
pub fn ensure_openwolf(cwd: &str, auto_init: bool) -> bool {
    let wolf_dir = std::path::Path::new(cwd).join(".wolf");
    if wolf_dir.is_dir() {
        return true;
    }

    if !auto_init {
        crate::safe_eprintln!(
            "[openwolf] .wolf/ not found in {} and auto-init disabled",
            cwd
        );
        return false;
    }

    crate::safe_eprintln!("[openwolf] .wolf/ not found in {} — running init", cwd);
    let wolf_bin = resolve_openwolf_path();
    let mut cmd = shim_command(&wolf_bin);
    cmd.arg("init")
        .current_dir(cwd)
        .env("PATH", openwolf_env_path())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    match cmd.output() {
        Ok(output) => {
            if output.status.success() {
                crate::safe_eprintln!("[openwolf] Init succeeded in {}", cwd);
                true
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                crate::safe_eprintln!("[openwolf] Init failed: {}", stderr.trim());
                false
            }
        }
        Err(e) => {
            crate::safe_eprintln!("[openwolf] Failed to run openwolf init: {}", e);
            false
        }
    }
}

/// OpenWolf hook entries matching the upstream spec in
/// `openwolf/src/cli/init.ts` (HOOK_SETTINGS). Uses `$CLAUDE_PROJECT_DIR`
/// so hooks resolve correctly even if CWD changes mid-session.
/// `_design_qc` is kept for signature compatibility but no longer gates
/// PreToolUse/PostToolUse — those always register when OpenWolf is enabled.
fn openwolf_hook_entries(_cwd: &str, _design_qc: bool) -> Vec<(&'static str, serde_json::Value)> {
    let mk = |script: &str, timeout: u64| {
        serde_json::json!({
            "type": "command",
            "command": format!("node \"$CLAUDE_PROJECT_DIR/.wolf/hooks/{}\"", script),
            "timeout": timeout,
        })
    };

    vec![
        (
            "SessionStart",
            serde_json::json!({
                "matcher": "",
                "hooks": [mk("session-start.js", 5)]
            }),
        ),
        (
            "PreToolUse",
            serde_json::json!({
                "matcher": "Read",
                "hooks": [mk("pre-read.js", 5)]
            }),
        ),
        (
            "PreToolUse",
            serde_json::json!({
                "matcher": "Write|Edit|MultiEdit",
                "hooks": [mk("pre-write.js", 5)]
            }),
        ),
        (
            "PostToolUse",
            serde_json::json!({
                "matcher": "Read",
                "hooks": [mk("post-read.js", 5)]
            }),
        ),
        (
            "PostToolUse",
            serde_json::json!({
                "matcher": "Write|Edit|MultiEdit",
                "hooks": [mk("post-write.js", 10)]
            }),
        ),
        (
            "Stop",
            serde_json::json!({
                "matcher": "",
                "hooks": [mk("stop.js", 10)]
            }),
        ),
    ]
}

/// Merge OpenWolf hook entries into an existing settings JSON file.
/// Reads the file, adds OpenWolf hooks alongside T64's existing hooks
/// (combining arrays, not overwriting), and writes back.
pub fn merge_openwolf_hooks(settings_path: &str, cwd: &str, design_qc: bool) -> Result<(), String> {
    let content =
        std::fs::read_to_string(settings_path).map_err(|e| format!("read settings: {}", e))?;
    let mut settings: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("parse settings: {}", e))?;

    let hooks_obj = settings
        .as_object_mut()
        .ok_or("settings not an object")?
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}));

    let hooks_map = hooks_obj.as_object_mut().ok_or("hooks not an object")?;

    let is_openwolf_entry = |entry: &serde_json::Value| -> bool {
        entry
            .get("hooks")
            .and_then(|h| h.as_array())
            .map(|hooks| {
                hooks.iter().any(|h| {
                    h.get("command")
                        .and_then(|c| c.as_str())
                        .map(|s| s.contains(".wolf/hooks/") || s.contains("openwolf hook"))
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false)
    };

    let desired = openwolf_hook_entries(cwd, design_qc);
    let mut desired_grouped: std::collections::HashMap<&'static str, Vec<&serde_json::Value>> =
        std::collections::HashMap::new();
    for (event, entry) in &desired {
        desired_grouped.entry(*event).or_default().push(entry);
    }

    // Equality check using refs (no clones). Rewrite only if the current set
    // of openwolf entries differs from desired.
    let already_correct = desired_grouped.iter().all(|(k, desired_vec)| {
        hooks_map
            .get(*k)
            .and_then(|v| v.as_array())
            .map(|arr| {
                let cur: Vec<&serde_json::Value> =
                    arr.iter().filter(|e| is_openwolf_entry(e)).collect();
                cur.len() == desired_vec.len()
                    && cur.iter().zip(desired_vec.iter()).all(|(a, b)| a == b)
            })
            .unwrap_or(false)
    }) && hooks_map.iter().all(|(k, v)| {
        let has_ow = v
            .as_array()
            .map(|arr| arr.iter().any(is_openwolf_entry))
            .unwrap_or(false);
        !has_ow || desired_grouped.contains_key(k.as_str())
    });

    if already_correct {
        return Ok(());
    }

    for (_event, arr_val) in hooks_map.iter_mut() {
        if let Some(arr) = arr_val.as_array_mut() {
            arr.retain(|e| !is_openwolf_entry(e));
        }
    }

    for (event_name, entry) in desired {
        let arr = hooks_map
            .entry(event_name)
            .or_insert_with(|| serde_json::json!([]));
        if let Some(existing) = arr.as_array_mut() {
            existing.push(entry);
        }
    }

    let settings_json =
        serde_json::to_string(&settings).map_err(|e| format!("serialize settings: {}", e))?;
    std::fs::write(settings_path, settings_json).map_err(|e| format!("write settings: {}", e))?;

    crate::safe_eprintln!("[openwolf] Merged hooks into {}", settings_path);
    Ok(())
}
