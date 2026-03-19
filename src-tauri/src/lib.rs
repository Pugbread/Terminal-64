mod pty_manager;
mod types;

use pty_manager::PtyManager;
use types::*;
use std::path::PathBuf;

struct AppState {
    pty_manager: PtyManager,
}

#[tauri::command]
fn create_terminal(
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
    req: CreateTerminalRequest,
) -> Result<(), String> {
    state.pty_manager.create(&app_handle, req)
}

#[tauri::command]
fn write_terminal(
    state: tauri::State<'_, AppState>,
    id: String,
    data: String,
) -> Result<(), String> {
    state.pty_manager.write(&id, &data)
}

#[tauri::command]
fn resize_terminal(
    state: tauri::State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.pty_manager.resize(&id, cols, rows)
}

#[tauri::command]
fn close_terminal(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state.pty_manager.close(&id)
}

/// Find the latest Claude session ID for a given project directory.
/// Claude stores sessions at ~/.claude/projects/<dir-hash>/<session-id>.jsonl
#[tauri::command]
fn get_claude_session_id(project_dir: String) -> Result<String, String> {
    let home = dirs::home_dir().ok_or("No home dir")?;
    let claude_projects = home.join(".claude").join("projects");

    if !claude_projects.exists() {
        return Err("No .claude/projects directory".into());
    }

    // Claude uses the path with separators replaced: C:\Users\Foo\Bar → C--Users-Foo-Bar
    let dir_hash = project_dir
        .replace(':', "-")
        .replace('\\', "-")
        .replace('/', "-");

    let project_path = claude_projects.join(&dir_hash);
    if !project_path.exists() {
        // Try to find a matching directory by scanning
        let mut found: Option<PathBuf> = None;
        if let Ok(entries) = std::fs::read_dir(&claude_projects) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.contains(&dir_hash) || dir_hash.contains(&name) {
                    found = Some(entry.path());
                    break;
                }
            }
        }
        if found.is_none() {
            return Err(format!("No Claude project dir found for {}", project_dir));
        }
        return find_latest_session(&found.unwrap());
    }

    find_latest_session(&project_path)
}

fn find_latest_session(dir: &std::path::Path) -> Result<String, String> {
    let mut latest: Option<(std::time::SystemTime, String)> = None;

    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                if let Ok(meta) = path.metadata() {
                    if let Ok(modified) = meta.modified() {
                        let name = path.file_stem()
                            .and_then(|s| s.to_str())
                            .unwrap_or("")
                            .to_string();
                        if latest.is_none() || modified > latest.as_ref().unwrap().0 {
                            latest = Some((modified, name));
                        }
                    }
                }
            }
        }
    }

    latest.map(|(_, id)| id).ok_or("No session files found".into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            pty_manager: PtyManager::new(),
        })
        .invoke_handler(tauri::generate_handler![
            create_terminal,
            write_terminal,
            resize_terminal,
            close_terminal,
            get_claude_session_id,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
