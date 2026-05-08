use std::collections::HashMap;
use std::ffi::OsStr;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::providers::util::{expanded_tool_path, shim_command};
use crate::types::{LuauDiagnostic, LuauLintResult};
use serde_json::{json, Value as JsonValue};
use url::Url;

const LUAU_LSP_DIAGNOSTIC_TIMEOUT: Duration = Duration::from_secs(4);
const ROSYNC_SOURCEMAP_CACHE_TTL: Duration = Duration::from_secs(5);
const ROBLOX_DEFINITIONS_URL: &str =
    "https://luau-lsp.pages.dev/type-definitions/globalTypes.RobloxScriptSecurity.d.luau";

struct TempFile {
    path: PathBuf,
}

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

struct CachedRosyncSourcemap {
    path: PathBuf,
    generated_at: Instant,
}

static ROSYNC_SOURCEMAP_CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedRosyncSourcemap>>> =
    OnceLock::new();

fn is_luau_file_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "lua" | "luau"))
        .unwrap_or(false)
}

fn find_nearest_luaurc(path: &Path) -> Option<PathBuf> {
    let mut dir = path.parent();
    while let Some(current) = dir {
        let candidate = current.join(".luaurc");
        if candidate.is_file() {
            return Some(candidate);
        }
        dir = current.parent();
    }
    None
}

fn luau_cache_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".terminal64").join("luau-lsp"))
}

fn ensure_roblox_definitions() -> Option<PathBuf> {
    let dir = luau_cache_dir()?;
    let path = dir.join("globalTypes.RobloxScriptSecurity.d.luau");
    if path.is_file() {
        return Some(path);
    }
    if std::fs::create_dir_all(&dir).is_err() {
        return None;
    }
    let response = reqwest::blocking::get(ROBLOX_DEFINITIONS_URL)
        .ok()?
        .error_for_status()
        .ok()?;
    let body = response.text().ok()?;
    if body.trim().is_empty() {
        return None;
    }
    if std::fs::write(&path, body).is_err() {
        return None;
    }
    Some(path)
}

fn find_nearest_file_named(
    path: &Path,
    file_name: &str,
    boundary: Option<&Path>,
) -> Option<PathBuf> {
    let mut dir = if path.is_dir() {
        Some(path)
    } else {
        path.parent()
    };
    while let Some(current) = dir {
        let candidate = current.join(file_name);
        if candidate.is_file() {
            return Some(candidate);
        }
        if boundary.is_some_and(|boundary| current == boundary) {
            break;
        }
        dir = current.parent();
    }
    None
}

fn lsp_settings_path(path: &Path, workspace_root: &Path) -> String {
    path.strip_prefix(workspace_root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn workspace_cache_key(workspace_root: &Path) -> PathBuf {
    std::fs::canonicalize(workspace_root).unwrap_or_else(|_| workspace_root.to_path_buf())
}

fn generate_rosync_sourcemap(workspace_root: &Path) -> Option<PathBuf> {
    if !workspace_root.join("ro-sync.json").is_file() {
        return None;
    }

    let cache_key = workspace_cache_key(workspace_root);
    let cache = ROSYNC_SOURCEMAP_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(cache) = cache.lock() {
        if let Some(cached) = cache.get(&cache_key) {
            if cached.generated_at.elapsed() <= ROSYNC_SOURCEMAP_CACHE_TTL && cached.path.is_file()
            {
                return Some(cached.path.clone());
            }
        }
    }

    let sourcemap_path = std::env::temp_dir().join(format!(
        "t64-rosync-sourcemap-{}.json",
        uuid::Uuid::new_v4()
    ));
    let mut cmd = shim_command("rosync");
    cmd.arg("repair")
        .arg("sourcemap")
        .arg("--project")
        .arg(workspace_root)
        .arg("--output")
        .arg(&sourcemap_path)
        .arg("--raw")
        .env("PATH", expanded_tool_path())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .current_dir(workspace_root);

    let output = match cmd.output() {
        Ok(output) => output,
        Err(_) => {
            let _ = std::fs::remove_file(&sourcemap_path);
            return None;
        }
    };
    let file_is_usable = std::fs::metadata(&sourcemap_path)
        .map(|metadata| metadata.is_file() && metadata.len() > 0)
        .unwrap_or(false);
    if !output.status.success() || !file_is_usable {
        let _ = std::fs::remove_file(&sourcemap_path);
        return None;
    }

    if let Ok(mut cache) = cache.lock() {
        cache.insert(
            cache_key,
            CachedRosyncSourcemap {
                path: sourcemap_path.clone(),
                generated_at: Instant::now(),
            },
        );
    }

    Some(sourcemap_path)
}

fn find_luau_sourcemap(config_lookup_path: &Path, workspace_root: &Path) -> Option<PathBuf> {
    generate_rosync_sourcemap(workspace_root)
        .or_else(|| find_nearest_file_named(config_lookup_path, "sourcemap.json", None))
        .or_else(|| {
            let root_sourcemap = workspace_root.join("sourcemap.json");
            root_sourcemap.is_file().then_some(root_sourcemap)
        })
}

fn write_luau_lsp_settings(config_lookup_path: &Path, workspace_root: &Path) -> Option<TempFile> {
    let sourcemap_path = find_luau_sourcemap(config_lookup_path, workspace_root);
    let has_sourcemap = sourcemap_path.is_some();
    let sourcemap_file = sourcemap_path
        .as_ref()
        .map(|path| lsp_settings_path(path, workspace_root))
        .unwrap_or_else(|| "sourcemap.json".to_string());
    let settings = json!({
        "luau-lsp.platform.type": "roblox",
        "luau-lsp.sourcemap.enabled": has_sourcemap,
        "luau-lsp.sourcemap.autogenerate": false,
        "luau-lsp.sourcemap.includeNonScripts": true,
        "luau-lsp.sourcemap.sourcemapFile": sourcemap_file,
        "luau-lsp.diagnostics.includeDependents": true,
        "luau-lsp.diagnostics.workspace": false,
        "luau-lsp.diagnostics.strictDatamodelTypes": has_sourcemap,
        "luau-lsp.hover.enabled": true,
        "luau-lsp.hover.strictDatamodelTypes": true,
        "luau-lsp.hover.multilineFunctionDefinitions": true,
        "luau-lsp.completion.enabled": true,
        "luau-lsp.completion.addParentheses": true,
        "luau-lsp.completion.addTabstopAfterParentheses": true,
        "luau-lsp.completion.fillCallArguments": true,
        "luau-lsp.completion.imports.enabled": true,
        "luau-lsp.completion.imports.suggestServices": true,
        "luau-lsp.completion.imports.suggestRequires": true,
        "luau-lsp.completion.imports.stringRequires.enabled": true,
        "luau-lsp.signatureHelp.enabled": true,
        "luau-lsp.semanticTokens.enabled": true,
    });
    let path = std::env::temp_dir().join(format!(
        "t64-luau-lsp-settings-{}.json",
        uuid::Uuid::new_v4()
    ));
    let body = serde_json::to_vec(&settings).ok()?;
    std::fs::write(&path, body).ok()?;
    Some(TempFile { path })
}

fn configure_luau_lsp_command(
    cmd: &mut Command,
    config_lookup_path: &Path,
    workspace_root: &Path,
) -> Option<TempFile> {
    if let Some(luaurc) = find_nearest_luaurc(config_lookup_path) {
        cmd.arg("--base-luaurc").arg(luaurc);
    }
    if let Some(definitions) = ensure_roblox_definitions() {
        cmd.arg(format!("--definitions:@roblox={}", definitions.display()));
    }
    let settings_file = write_luau_lsp_settings(config_lookup_path, workspace_root)?;
    cmd.arg("--settings").arg(&settings_file.path);
    Some(settings_file)
}

fn parse_luau_plain_diagnostic(line: &str, path: &str) -> Option<LuauDiagnostic> {
    let line = line.trim();
    if line.is_empty()
        || line.starts_with("[WARN]")
        || line.starts_with("[INFO]")
        || line.starts_with("WARNING:")
    {
        return None;
    }

    let (location, rest) = line.rsplit_once(": (")?;
    let (_, code_and_message) = rest.split_once(") ")?;
    let (code, message) = code_and_message
        .split_once(": ")
        .unwrap_or((code_and_message, ""));
    let (before_range, range) = location.rsplit_once(':')?;
    let (_, line_text) = before_range.rsplit_once(':')?;
    let (start_col_text, end_col_text) = range.split_once('-')?;

    let line_num = line_text.parse::<u32>().ok()?;
    let start_column = start_col_text.parse::<u32>().ok()?.max(1);
    let parsed_end_column = end_col_text.parse::<u32>().unwrap_or(start_column);
    let end_column = parsed_end_column.max(start_column);
    let code = code.trim().to_string();
    let severity = if code.contains("Error") || matches!(code.as_str(), "SyntaxError" | "TypeError")
    {
        "error"
    } else {
        "warning"
    };

    Some(LuauDiagnostic {
        path: path.to_string(),
        line: line_num.max(1),
        start_column,
        end_line: line_num.max(1),
        end_column,
        code,
        message: message.trim().to_string(),
        severity: severity.to_string(),
    })
}

fn parse_luau_plain_diagnostics(output: &str, path: &str) -> Vec<LuauDiagnostic> {
    output
        .lines()
        .filter_map(|line| parse_luau_plain_diagnostic(line, path))
        .collect()
}

fn path_to_file_uri(path: &Path, directory: bool) -> Result<String, String> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| format!("resolve current dir for Luau LSP URI: {}", e))?
            .join(path)
    };
    let url = if directory {
        Url::from_directory_path(&absolute)
    } else {
        Url::from_file_path(&absolute)
    };
    url.map(|url| url.to_string()).map_err(|()| {
        format!(
            "Failed to convert Luau path to file URI: {}",
            absolute.display()
        )
    })
}

fn write_lsp_message(writer: &mut impl Write, message: &JsonValue) -> Result<(), String> {
    let body =
        serde_json::to_vec(message).map_err(|e| format!("serialize Luau LSP message: {}", e))?;
    writer
        .write_all(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes())
        .map_err(|e| format!("write Luau LSP header: {}", e))?;
    writer
        .write_all(&body)
        .map_err(|e| format!("write Luau LSP body: {}", e))?;
    writer
        .flush()
        .map_err(|e| format!("flush Luau LSP stdin: {}", e))
}

fn read_lsp_message(reader: &mut impl Read) -> Result<Option<JsonValue>, String> {
    let mut header = Vec::new();
    let mut byte = [0_u8; 1];
    loop {
        match reader.read(&mut byte) {
            Ok(0) if header.is_empty() => return Ok(None),
            Ok(0) => return Err("Luau LSP stdout ended while reading a message header".to_string()),
            Ok(_) => {
                header.push(byte[0]);
                if header.ends_with(b"\r\n\r\n") {
                    break;
                }
                if header.len() > 8192 {
                    return Err("Luau LSP message header exceeded 8KiB".to_string());
                }
            }
            Err(e) => return Err(format!("read Luau LSP header: {}", e)),
        }
    }

    let header_text = String::from_utf8_lossy(&header);
    let content_length = header_text
        .lines()
        .filter_map(|line| line.split_once(':'))
        .find_map(|(name, value)| {
            if name.eq_ignore_ascii_case("content-length") {
                value.trim().parse::<usize>().ok()
            } else {
                None
            }
        })
        .ok_or_else(|| "Luau LSP message missing Content-Length".to_string())?;

    let mut body = vec![0_u8; content_length];
    reader
        .read_exact(&mut body)
        .map_err(|e| format!("read Luau LSP body: {}", e))?;
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|e| format!("parse Luau LSP JSON: {}", e))
}

fn json_value_label(value: &JsonValue) -> String {
    match value {
        JsonValue::String(text) => text.clone(),
        JsonValue::Number(number) => number.to_string(),
        JsonValue::Bool(value) => value.to_string(),
        _ => value.to_string(),
    }
}

fn lsp_severity_name(value: Option<u64>) -> String {
    match value {
        Some(1) => "error",
        Some(2) => "warning",
        Some(3) | Some(4) => "info",
        _ => "warning",
    }
    .to_string()
}

fn lsp_position_u32(diagnostic: &JsonValue, pointer: &str, fallback: u32) -> u32 {
    diagnostic
        .pointer(pointer)
        .and_then(JsonValue::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .unwrap_or(fallback)
}

fn parse_lsp_publish_diagnostics(
    message: &JsonValue,
    expected_uri: &str,
    display_path: &str,
) -> Option<Vec<LuauDiagnostic>> {
    if message.get("method").and_then(JsonValue::as_str) != Some("textDocument/publishDiagnostics")
    {
        return None;
    }
    let params = message.get("params")?;
    if params.get("uri").and_then(JsonValue::as_str) != Some(expected_uri) {
        return None;
    }
    let diagnostics = params.get("diagnostics")?.as_array()?;
    Some(
        diagnostics
            .iter()
            .map(|diagnostic| {
                let start_line = lsp_position_u32(diagnostic, "/range/start/line", 0);
                let start_character = lsp_position_u32(diagnostic, "/range/start/character", 0);
                let end_line = lsp_position_u32(diagnostic, "/range/end/line", start_line);
                let end_character =
                    lsp_position_u32(diagnostic, "/range/end/character", start_character + 1);
                let code = diagnostic
                    .get("code")
                    .map(json_value_label)
                    .or_else(|| {
                        diagnostic
                            .get("source")
                            .and_then(JsonValue::as_str)
                            .map(str::to_string)
                    })
                    .unwrap_or_else(|| "luau-lsp".to_string());
                let message = diagnostic
                    .get("message")
                    .and_then(JsonValue::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string();
                LuauDiagnostic {
                    path: display_path.to_string(),
                    line: start_line + 1,
                    start_column: start_character + 1,
                    end_line: end_line + 1,
                    end_column: end_character.max(start_character + 1),
                    code,
                    message,
                    severity: lsp_severity_name(
                        diagnostic.get("severity").and_then(JsonValue::as_u64),
                    ),
                }
            })
            .collect(),
    )
}

fn spawn_lsp_reader<R>(mut reader: R) -> mpsc::Receiver<Result<JsonValue, String>>
where
    R: Read + Send + 'static,
{
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        while let Ok(Some(message)) = read_lsp_message(&mut reader) {
            if tx.send(Ok(message)).is_err() {
                return;
            }
        }
    });
    rx
}

fn wait_for_lsp_response(
    receiver: &mpsc::Receiver<Result<JsonValue, String>>,
    id: u64,
    deadline: Instant,
) -> Result<(), String> {
    wait_for_lsp_response_value(receiver, id, deadline).map(|_| ())
}

fn wait_for_lsp_response_value(
    receiver: &mpsc::Receiver<Result<JsonValue, String>>,
    id: u64,
    deadline: Instant,
) -> Result<JsonValue, String> {
    loop {
        let now = Instant::now();
        if now >= deadline {
            return Err(format!("Timed out waiting for Luau LSP response {}", id));
        }
        let remaining = deadline.saturating_duration_since(now);
        let wait_for = if remaining > Duration::from_millis(250) {
            Duration::from_millis(250)
        } else {
            remaining
        };
        match receiver.recv_timeout(wait_for) {
            Ok(Ok(message)) if message.get("id").and_then(JsonValue::as_u64) == Some(id) => {
                return Ok(message);
            }
            Ok(Ok(_)) => {}
            Ok(Err(e)) => return Err(e),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(format!(
                    "Luau LSP stdout closed before response {} arrived",
                    id
                ));
            }
        }
    }
}

fn wait_for_lsp_diagnostics(
    receiver: &mpsc::Receiver<Result<JsonValue, String>>,
    document_uri: &str,
    display_path: &str,
    deadline: Instant,
) -> Result<Vec<LuauDiagnostic>, String> {
    loop {
        let now = Instant::now();
        if now >= deadline {
            return Err("Timed out waiting for Luau LSP diagnostics".to_string());
        }
        let remaining = deadline.saturating_duration_since(now);
        let wait_for = if remaining > Duration::from_millis(250) {
            Duration::from_millis(250)
        } else {
            remaining
        };
        match receiver.recv_timeout(wait_for) {
            Ok(Ok(message)) => {
                if let Some(diagnostics) =
                    parse_lsp_publish_diagnostics(&message, document_uri, display_path)
                {
                    return Ok(diagnostics);
                }
            }
            Ok(Err(e)) => return Err(e),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("Luau LSP stdout closed before diagnostics arrived".to_string());
            }
        }
    }
}

fn run_luau_lsp_document_diagnostics(
    target_path: &Path,
    display_path: &str,
    cwd: Option<&Path>,
    config_lookup_path: &Path,
    content: &str,
) -> Result<LuauLintResult, String> {
    let root_path = cwd
        .map(Path::to_path_buf)
        .or_else(|| target_path.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."));
    let root_uri = path_to_file_uri(&root_path, true)?;
    let document_uri = path_to_file_uri(target_path, false)?;
    let workspace_name = root_path
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or("workspace")
        .to_string();

    let mut cmd = shim_command("luau-lsp");
    cmd.arg("lsp")
        .arg("--stdio")
        .env("PATH", expanded_tool_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let _settings_file = configure_luau_lsp_command(&mut cmd, config_lookup_path, &root_path);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }

    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "Failed to start luau-lsp LSP. Install luau-lsp or put it on PATH: {}",
            e
        )
    })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Luau LSP stdout was not piped".to_string())?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Luau LSP stdin was not piped".to_string())?;
    let receiver = spawn_lsp_reader(stdout);
    let deadline = Instant::now() + LUAU_LSP_DIAGNOSTIC_TIMEOUT;

    write_lsp_message(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "processId": null,
                "rootUri": root_uri,
                "workspaceFolders": [{
                    "uri": root_uri,
                    "name": workspace_name,
                }],
                "capabilities": {
                    "textDocument": {
                        "publishDiagnostics": {
                            "relatedInformation": true,
                            "versionSupport": true,
                        },
                        "synchronization": {
                            "dynamicRegistration": false,
                            "willSave": false,
                            "willSaveWaitUntil": false,
                            "didSave": true,
                        },
                    },
                    "workspace": {
                        "workspaceFolders": true,
                        "configuration": false,
                    },
                },
                "clientInfo": {
                    "name": "Terminal 64",
                },
            },
        }),
    )?;
    wait_for_lsp_response(&receiver, 1, deadline)?;
    write_lsp_message(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "method": "initialized",
            "params": {},
        }),
    )?;
    write_lsp_message(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "method": "textDocument/didOpen",
            "params": {
                "textDocument": {
                    "uri": document_uri,
                    "languageId": "luau",
                    "version": 1,
                    "text": content,
                },
            },
        }),
    )?;

    let diagnostics = wait_for_lsp_diagnostics(&receiver, &document_uri, display_path, deadline)?;
    let _ = write_lsp_message(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "shutdown",
            "params": null,
        }),
    );
    let _ = write_lsp_message(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "method": "exit",
            "params": null,
        }),
    );
    let _ = child.kill();
    let _ = child.wait();
    Ok(LuauLintResult {
        path: display_path.to_string(),
        analyzer: "luau-lsp-lsp".to_string(),
        diagnostics,
    })
}

fn run_luau_lsp_position_request(
    target_path: &Path,
    cwd: Option<&Path>,
    config_lookup_path: &Path,
    content: &str,
    method: &str,
    line: u32,
    column: u32,
) -> Result<JsonValue, String> {
    let root_path = cwd
        .map(Path::to_path_buf)
        .or_else(|| target_path.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."));
    let root_uri = path_to_file_uri(&root_path, true)?;
    let document_uri = path_to_file_uri(target_path, false)?;
    let workspace_name = root_path
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or("workspace")
        .to_string();

    let mut cmd = shim_command("luau-lsp");
    cmd.arg("lsp")
        .arg("--stdio")
        .env("PATH", expanded_tool_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let _settings_file = configure_luau_lsp_command(&mut cmd, config_lookup_path, &root_path);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }

    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "Failed to start luau-lsp LSP. Install luau-lsp or put it on PATH: {}",
            e
        )
    })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Luau LSP stdout was not piped".to_string())?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Luau LSP stdin was not piped".to_string())?;
    let receiver = spawn_lsp_reader(stdout);
    let deadline = Instant::now() + LUAU_LSP_DIAGNOSTIC_TIMEOUT;

    write_lsp_message(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "processId": null,
                "rootUri": root_uri,
                "workspaceFolders": [{
                    "uri": root_uri,
                    "name": workspace_name,
                }],
                "capabilities": {
                    "textDocument": {
                        "completion": {
                            "completionItem": {
                                "snippetSupport": true,
                                "documentationFormat": ["markdown", "plaintext"],
                            },
                        },
                        "hover": {
                            "contentFormat": ["markdown", "plaintext"],
                        },
                        "publishDiagnostics": {
                            "relatedInformation": true,
                        },
                        "synchronization": {
                            "dynamicRegistration": false,
                            "didSave": true,
                        },
                    },
                    "workspace": {
                        "workspaceFolders": true,
                        "configuration": false,
                    },
                },
                "clientInfo": {
                    "name": "Terminal 64",
                },
            },
        }),
    )?;
    wait_for_lsp_response(&receiver, 1, deadline)?;
    write_lsp_message(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "method": "initialized",
            "params": {},
        }),
    )?;
    write_lsp_message(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "method": "textDocument/didOpen",
            "params": {
                "textDocument": {
                    "uri": document_uri,
                    "languageId": "luau",
                    "version": 1,
                    "text": content,
                },
            },
        }),
    )?;
    write_lsp_message(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": method,
            "params": {
                "textDocument": {
                    "uri": document_uri,
                },
                "position": {
                    "line": line.saturating_sub(1),
                    "character": column.saturating_sub(1),
                },
            },
        }),
    )?;

    let response = wait_for_lsp_response_value(&receiver, 2, deadline)?;
    let _ = write_lsp_message(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "shutdown",
            "params": null,
        }),
    );
    let _ = write_lsp_message(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "method": "exit",
            "params": null,
        }),
    );
    let _ = child.kill();
    let _ = child.wait();
    Ok(response.get("result").cloned().unwrap_or(JsonValue::Null))
}

fn run_luau_lsp_semantic_tokens(
    target_path: &Path,
    cwd: Option<&Path>,
    config_lookup_path: &Path,
    content: &str,
) -> Result<JsonValue, String> {
    let root_path = cwd
        .map(Path::to_path_buf)
        .or_else(|| target_path.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."));
    let root_uri = path_to_file_uri(&root_path, true)?;
    let document_uri = path_to_file_uri(target_path, false)?;
    let workspace_name = root_path
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or("workspace")
        .to_string();

    let mut cmd = shim_command("luau-lsp");
    cmd.arg("lsp")
        .arg("--stdio")
        .env("PATH", expanded_tool_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let _settings_file = configure_luau_lsp_command(&mut cmd, config_lookup_path, &root_path);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }

    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "Failed to start luau-lsp LSP. Install luau-lsp or put it on PATH: {}",
            e
        )
    })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Luau LSP stdout was not piped".to_string())?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Luau LSP stdin was not piped".to_string())?;
    let receiver = spawn_lsp_reader(stdout);
    let deadline = Instant::now() + LUAU_LSP_DIAGNOSTIC_TIMEOUT;

    write_lsp_message(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "processId": null,
                "rootUri": root_uri,
                "workspaceFolders": [{
                    "uri": root_uri,
                    "name": workspace_name,
                }],
                "capabilities": {
                    "textDocument": {
                        "semanticTokens": {
                            "dynamicRegistration": false,
                            "requests": {
                                "full": true,
                                "range": false,
                            },
                            "tokenTypes": [
                                "namespace", "type", "class", "enum", "interface",
                                "struct", "typeParameter", "parameter", "variable",
                                "property", "enumMember", "event", "function", "method",
                                "macro", "keyword", "modifier", "comment", "string",
                                "number", "regexp", "operator", "decorator"
                            ],
                            "tokenModifiers": [
                                "declaration", "definition", "readonly", "static",
                                "deprecated", "abstract", "async", "modification",
                                "documentation", "defaultLibrary"
                            ],
                            "formats": ["relative"],
                            "overlappingTokenSupport": false,
                            "multilineTokenSupport": false,
                        },
                        "synchronization": {
                            "dynamicRegistration": false,
                            "didSave": true,
                        },
                    },
                    "workspace": {
                        "workspaceFolders": true,
                        "configuration": false,
                    },
                },
                "clientInfo": {
                    "name": "Terminal 64",
                },
            },
        }),
    )?;
    let initialize_response = wait_for_lsp_response_value(&receiver, 1, deadline)?;
    let semantic_tokens_provider = initialize_response
        .pointer("/result/capabilities/semanticTokensProvider")
        .cloned()
        .unwrap_or(JsonValue::Null);
    write_lsp_message(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "method": "initialized",
            "params": {},
        }),
    )?;
    write_lsp_message(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "method": "textDocument/didOpen",
            "params": {
                "textDocument": {
                    "uri": document_uri,
                    "languageId": "luau",
                    "version": 1,
                    "text": content,
                },
            },
        }),
    )?;
    write_lsp_message(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "textDocument/semanticTokens/full",
            "params": {
                "textDocument": {
                    "uri": document_uri,
                },
            },
        }),
    )?;

    let response = wait_for_lsp_response_value(&receiver, 2, deadline)?;
    let _ = write_lsp_message(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "shutdown",
            "params": null,
        }),
    );
    let _ = write_lsp_message(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "method": "exit",
            "params": null,
        }),
    );
    let _ = child.kill();
    let _ = child.wait();
    Ok(json!({
        "provider": semantic_tokens_provider,
        "tokens": response.get("result").cloned().unwrap_or(JsonValue::Null),
    }))
}

fn run_luau_lsp_analyze(
    target_path: &Path,
    display_path: &str,
    cwd: Option<&Path>,
    config_lookup_path: &Path,
) -> Result<LuauLintResult, String> {
    let root_path = cwd
        .map(Path::to_path_buf)
        .or_else(|| target_path.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."));
    let mut cmd = shim_command("luau-lsp");
    cmd.arg("analyze")
        .arg("--formatter=plain")
        .arg("--platform=roblox")
        .env("PATH", expanded_tool_path())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    let _settings_file = configure_luau_lsp_command(&mut cmd, config_lookup_path, &root_path);
    if let Some(sourcemap_path) = find_luau_sourcemap(config_lookup_path, &root_path) {
        cmd.arg("--sourcemap").arg(sourcemap_path);
    }
    cmd.arg(target_path);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }

    let output = cmd.output().map_err(|e| {
        format!(
            "Failed to run luau-lsp. Install luau-lsp or put it on PATH: {}",
            e
        )
    })?;
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(LuauLintResult {
        path: display_path.to_string(),
        analyzer: "luau-lsp".to_string(),
        diagnostics: parse_luau_plain_diagnostics(&combined, display_path),
    })
}

pub(crate) async fn lint_luau_file(
    path: String,
    content: Option<String>,
    cwd: Option<String>,
) -> Result<LuauLintResult, String> {
    tokio::task::spawn_blocking(move || {
        let requested_path = PathBuf::from(&path);
        let project_dir = cwd
            .as_deref()
            .filter(|value| !value.trim().is_empty() && *value != ".")
            .map(PathBuf::from);
        let resolved_path = if requested_path.is_absolute() {
            requested_path.clone()
        } else if let Some(project_dir) = &project_dir {
            project_dir.join(&requested_path)
        } else {
            requested_path.clone()
        };
        let display_path = resolved_path.to_string_lossy().to_string();

        if !is_luau_file_path(&resolved_path) {
            return Ok(LuauLintResult {
                path: display_path,
                analyzer: "none".to_string(),
                diagnostics: Vec::new(),
            });
        }

        if let Some(content) = content {
            let cwd_for_lsp = project_dir.as_deref().or_else(|| resolved_path.parent());
            if let Ok(result) = run_luau_lsp_document_diagnostics(
                &resolved_path,
                &display_path,
                cwd_for_lsp,
                &resolved_path,
                &content,
            ) {
                return Ok(result);
            }

            let temp_dir =
                std::env::temp_dir().join(format!("t64-luau-lint-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&temp_dir)
                .map_err(|e| format!("Failed to create luau lint temp dir: {}", e))?;
            let file_name = resolved_path
                .file_name()
                .unwrap_or_else(|| OsStr::new("buffer.luau"));
            let temp_path = temp_dir.join(file_name);
            let cleanup_path = temp_dir.clone();
            let result = (|| {
                std::fs::write(&temp_path, content)
                    .map_err(|e| format!("Failed to write luau lint temp file: {}", e))?;
                run_luau_lsp_analyze(
                    &temp_path,
                    &display_path,
                    project_dir.as_deref().or_else(|| resolved_path.parent()),
                    &resolved_path,
                )
            })();
            let _ = std::fs::remove_dir_all(cleanup_path);
            return result;
        }

        run_luau_lsp_analyze(
            &resolved_path,
            &display_path,
            project_dir.as_deref().or_else(|| resolved_path.parent()),
            &resolved_path,
        )
    })
    .await
    .map_err(|e| format!("join error: {}", e))?
}

pub(crate) async fn luau_lsp_completion(
    path: String,
    content: String,
    cwd: Option<String>,
    line: u32,
    column: u32,
) -> Result<JsonValue, String> {
    tokio::task::spawn_blocking(move || {
        let requested_path = PathBuf::from(&path);
        let project_dir = cwd
            .as_deref()
            .filter(|value| !value.trim().is_empty() && *value != ".")
            .map(PathBuf::from);
        let resolved_path = if requested_path.is_absolute() {
            requested_path.clone()
        } else if let Some(project_dir) = &project_dir {
            project_dir.join(&requested_path)
        } else {
            requested_path.clone()
        };
        if !is_luau_file_path(&resolved_path) {
            return Ok(JsonValue::Null);
        }
        let cwd_for_lsp = project_dir.as_deref().or_else(|| resolved_path.parent());
        run_luau_lsp_position_request(
            &resolved_path,
            cwd_for_lsp,
            &resolved_path,
            &content,
            "textDocument/completion",
            line,
            column,
        )
    })
    .await
    .map_err(|e| format!("join error: {}", e))?
}

pub(crate) async fn luau_lsp_hover(
    path: String,
    content: String,
    cwd: Option<String>,
    line: u32,
    column: u32,
) -> Result<JsonValue, String> {
    tokio::task::spawn_blocking(move || {
        let requested_path = PathBuf::from(&path);
        let project_dir = cwd
            .as_deref()
            .filter(|value| !value.trim().is_empty() && *value != ".")
            .map(PathBuf::from);
        let resolved_path = if requested_path.is_absolute() {
            requested_path.clone()
        } else if let Some(project_dir) = &project_dir {
            project_dir.join(&requested_path)
        } else {
            requested_path.clone()
        };
        if !is_luau_file_path(&resolved_path) {
            return Ok(JsonValue::Null);
        }
        let cwd_for_lsp = project_dir.as_deref().or_else(|| resolved_path.parent());
        run_luau_lsp_position_request(
            &resolved_path,
            cwd_for_lsp,
            &resolved_path,
            &content,
            "textDocument/hover",
            line,
            column,
        )
    })
    .await
    .map_err(|e| format!("join error: {}", e))?
}

pub(crate) async fn luau_lsp_signature_help(
    path: String,
    content: String,
    cwd: Option<String>,
    line: u32,
    column: u32,
) -> Result<JsonValue, String> {
    tokio::task::spawn_blocking(move || {
        let requested_path = PathBuf::from(&path);
        let project_dir = cwd
            .as_deref()
            .filter(|value| !value.trim().is_empty() && *value != ".")
            .map(PathBuf::from);
        let resolved_path = if requested_path.is_absolute() {
            requested_path.clone()
        } else if let Some(project_dir) = &project_dir {
            project_dir.join(&requested_path)
        } else {
            requested_path.clone()
        };
        if !is_luau_file_path(&resolved_path) {
            return Ok(JsonValue::Null);
        }
        let cwd_for_lsp = project_dir.as_deref().or_else(|| resolved_path.parent());
        run_luau_lsp_position_request(
            &resolved_path,
            cwd_for_lsp,
            &resolved_path,
            &content,
            "textDocument/signatureHelp",
            line,
            column,
        )
    })
    .await
    .map_err(|e| format!("join error: {}", e))?
}

pub(crate) async fn luau_lsp_semantic_tokens(
    path: String,
    content: String,
    cwd: Option<String>,
) -> Result<JsonValue, String> {
    tokio::task::spawn_blocking(move || {
        let requested_path = PathBuf::from(&path);
        let project_dir = cwd
            .as_deref()
            .filter(|value| !value.trim().is_empty() && *value != ".")
            .map(PathBuf::from);
        let resolved_path = if requested_path.is_absolute() {
            requested_path.clone()
        } else if let Some(project_dir) = &project_dir {
            project_dir.join(&requested_path)
        } else {
            requested_path.clone()
        };
        if !is_luau_file_path(&resolved_path) {
            return Ok(JsonValue::Null);
        }
        let cwd_for_lsp = project_dir.as_deref().or_else(|| resolved_path.parent());
        run_luau_lsp_semantic_tokens(&resolved_path, cwd_for_lsp, &resolved_path, &content)
    })
    .await
    .map_err(|e| format!("join error: {}", e))?
}
