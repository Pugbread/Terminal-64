use std::collections::HashMap;
use std::io::{BufRead, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

static REQ_COUNTER: AtomicU64 = AtomicU64::new(0);

fn next_id() -> String {
    format!("perm-{}", REQ_COUNTER.fetch_add(1, Ordering::Relaxed))
}

fn random_token() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let bytes: [u8; 32] = rng.gen();
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

#[derive(Clone, serde::Serialize)]
pub struct DelegationMessage {
    pub group_id: String,
    pub agent: String,
    pub message: String,
    pub timestamp: u64,
    pub msg_type: String, // "chat" | "complete"
}

pub struct PermissionServer {
    port: AtomicU16,
    secret: String,
    alive: Arc<AtomicBool>,
    app_handle: AppHandle,
    pending: Arc<Mutex<HashMap<String, mpsc::SyncSender<(bool, String)>>>>,
    pub(crate) session_map: Arc<Mutex<HashMap<String, String>>>,
    settings_files: Arc<Mutex<HashMap<String, PathBuf>>>,
    pub(crate) delegation_messages: Arc<Mutex<HashMap<String, Vec<DelegationMessage>>>>,
}

impl PermissionServer {
    pub fn start(app_handle: AppHandle) -> Result<Self, String> {
        let secret = random_token();
        let alive = Arc::new(AtomicBool::new(false));
        let pending: Arc<Mutex<HashMap<String, mpsc::SyncSender<(bool, String)>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let session_map: Arc<Mutex<HashMap<String, String>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let delegation_messages: Arc<Mutex<HashMap<String, Vec<DelegationMessage>>>> =
            Arc::new(Mutex::new(HashMap::new()));

        let server = Self {
            port: AtomicU16::new(0),
            secret,
            alive,
            app_handle,
            pending,
            session_map,
            settings_files: Arc::new(Mutex::new(HashMap::new())),
            delegation_messages,
        };
        server.spawn_listener()?;
        Ok(server)
    }

    fn spawn_listener(&self) -> Result<(), String> {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("bind: {}", e))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        self.port.store(port, Ordering::SeqCst);
        self.alive.store(true, Ordering::SeqCst);

        safe_eprintln!("[perm-server] Listening on 127.0.0.1:{}", port);

        let secret = self.secret.clone();
        let pending = self.pending.clone();
        let session_map = self.session_map.clone();
        let delegation_messages = self.delegation_messages.clone();
        let app_handle = self.app_handle.clone();
        let alive = self.alive.clone();

        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let stream = match stream {
                    Ok(s) => s,
                    Err(e) => {
                        safe_eprintln!("[perm-server] Accept error: {}", e);
                        continue;
                    }
                };
                let secret = secret.clone();
                let pending = pending.clone();
                let sessions = session_map.clone();
                let app = app_handle.clone();
                let deleg = delegation_messages.clone();
                std::thread::spawn(move || {
                    if let Err(e) = handle_connection(stream, &secret, &pending, &sessions, &app, &deleg) {
                        safe_eprintln!("[perm-server] Connection error: {}", e);
                    }
                });
            }
            // If we exit the loop, the listener is dead
            alive.store(false, Ordering::SeqCst);
            safe_eprintln!("[perm-server] Listener thread exited — server is down");
        });

        Ok(())
    }

    /// Check if the listener is alive; if not, attempt restart with exponential backoff.
    /// Returns the current port on success.
    pub fn ensure_alive(&self) -> Result<u16, String> {
        if self.alive.load(Ordering::SeqCst) {
            return Ok(self.port.load(Ordering::SeqCst));
        }
        safe_eprintln!("[perm-server] Server is down, attempting restart...");
        let mut delay_ms = 100u64;
        for attempt in 1..=5 {
            match self.spawn_listener() {
                Ok(()) => {
                    let new_port = self.port.load(Ordering::SeqCst);
                    safe_eprintln!("[perm-server] Restarted on port {} (attempt {})", new_port, attempt);
                    // Re-register all existing sessions with the new port
                    self.reregister_sessions();
                    return Ok(new_port);
                }
                Err(e) => {
                    safe_eprintln!("[perm-server] Restart attempt {} failed: {}", attempt, e);
                    std::thread::sleep(Duration::from_millis(delay_ms));
                    delay_ms = (delay_ms * 2).min(5000);
                }
            }
        }
        Err("Permission server failed to restart after 5 attempts".into())
    }

    /// After a restart on a new port, re-write all temp settings files with the new URL.
    fn reregister_sessions(&self) {
        let new_port = self.port.load(Ordering::SeqCst);
        let tokens: Vec<(String, String)> = self.session_map
            .lock().unwrap_or_else(|e| e.into_inner())
            .iter().map(|(k, v)| (k.clone(), v.clone())).collect();

        for (run_token, session_id) in &tokens {
            let url = format!("http://127.0.0.1:{}/hook/{}/{}", new_port, self.secret, run_token);
            let settings = serde_json::json!({
                "hooks": {
                    "PermissionRequest": [{
                        "matcher": "",
                        "hooks": [{ "type": "http", "url": url }]
                    }]
                }
            });
            if let Some(path) = self.settings_files.lock().unwrap_or_else(|e| e.into_inner()).get(run_token) {
                if let Err(e) = std::fs::write(path, settings.to_string()) {
                    safe_eprintln!("[perm-server] Failed to rewrite settings for session {}: {}", session_id, e);
                }
            }
        }
        if !tokens.is_empty() {
            safe_eprintln!("[perm-server] Re-registered {} sessions on new port {}", tokens.len(), new_port);
        }
    }

    #[allow(dead_code)]
    pub fn port(&self) -> u16 {
        self.port.load(Ordering::SeqCst)
    }

    pub fn secret(&self) -> &str {
        &self.secret
    }

    pub fn cleanup_delegation_group(&self, group_id: &str) {
        if let Ok(mut store) = self.delegation_messages.lock() {
            store.remove(group_id);
        }
    }

    /// Get or create a settings file for a session. Reuses existing registration.
    /// Auto-restarts the server if it's down.
    pub fn register_session(&self, session_id: &str) -> Result<(String, PathBuf), String> {
        // Ensure the listener is alive before registering
        self.ensure_alive()?;

        // Reuse existing token if session is already registered
        {
            let map = self.session_map.lock().map_err(|e| e.to_string())?;
            for (token, sid) in map.iter() {
                if sid == session_id {
                    if let Some(path) = self.settings_files.lock().map_err(|e| e.to_string())?.get(token) {
                        return Ok((token.clone(), path.clone()));
                    }
                }
            }
        }

        let run_token = random_token();
        let port = self.port.load(Ordering::SeqCst);
        let url = format!(
            "http://127.0.0.1:{}/hook/{}/{}",
            port, self.secret, run_token
        );

        let settings = serde_json::json!({
            "hooks": {
                "PermissionRequest": [{
                    "matcher": "",
                    "hooks": [{ "type": "http", "url": url }]
                }]
            }
        });

        let path = std::env::temp_dir().join(format!("t64-hook-{}.json", &run_token[..run_token.len().min(12)]));
        std::fs::write(&path, settings.to_string()).map_err(|e| format!("write settings: {}", e))?;

        self.session_map
            .lock()
            .map_err(|e| e.to_string())?
            .insert(run_token.clone(), session_id.to_string());
        self.settings_files
            .lock()
            .map_err(|e| e.to_string())?
            .insert(run_token.clone(), path.clone());

        safe_eprintln!(
            "[perm-server] Registered session {} with token {}",
            session_id,
            &run_token[..run_token.len().min(12)]
        );
        Ok((run_token, path))
    }

    /// Unregister a session: remove mapping, delete temp file, deny pending requests.
    pub fn unregister_session(&self, run_token: &str) {
        self.session_map.lock().unwrap_or_else(|e| e.into_inner()).remove(run_token);
        if let Some(path) = self.settings_files.lock().unwrap_or_else(|e| e.into_inner()).remove(run_token) {
            let _ = std::fs::remove_file(path);
        }
    }

    /// Resolve a pending permission request.
    pub fn resolve(&self, request_id: &str, allow: bool, reason: &str) {
        if let Some(tx) = self.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(request_id) {
            let _ = tx.send((allow, reason.to_string()));
        }
    }
}

fn handle_connection(
    mut stream: TcpStream,
    secret: &str,
    pending: &Arc<Mutex<HashMap<String, mpsc::SyncSender<(bool, String)>>>>,
    sessions: &Arc<Mutex<HashMap<String, String>>>,
    app_handle: &AppHandle,
    delegation_messages: &Arc<Mutex<HashMap<String, Vec<DelegationMessage>>>>,
) -> Result<(), String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .ok();

    // Read headers (cap at 16KB to prevent DoS)
    const MAX_HEADER_SIZE: usize = 16 * 1024;
    let mut reader = std::io::BufReader::new(&stream);
    let mut headers = String::new();
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => return Err("connection closed".into()),
            Ok(_) => {
                if headers.len() + line.len() > MAX_HEADER_SIZE {
                    return Err("headers too large".into());
                }
                headers.push_str(&line);
                if line == "\r\n" || line == "\n" {
                    break;
                }
            }
            Err(e) => return Err(format!("read: {}", e)),
        }
    }

    // Parse first line
    let first_line = headers.lines().next().unwrap_or("");
    let method = first_line.split_whitespace().next().unwrap_or("");
    let path = first_line.split_whitespace().nth(1).unwrap_or("");

    // --- Delegation routes (require secret token via Authorization header) ---
    if path.starts_with("/delegation/") {
        // Verify Authorization: Bearer {secret}
        let auth_header = headers
            .lines()
            .find(|l| l.to_lowercase().starts_with("authorization:"))
            .and_then(|l| l.split_once(':'))
            .map(|(_, v)| v.trim());
        let auth_valid = auth_header
            .and_then(|v| v.strip_prefix("Bearer "))
            .map(|token| token == secret)
            .unwrap_or(false);

        if !auth_valid {
            safe_eprintln!("[delegation] AUTH FAILED for {} {} (got: {:?})",
                method, path, auth_header.map(|h| h.chars().take(20).collect::<String>()));
            send_http(&mut stream, 403, r#"{"error":"forbidden"}"#);
            return Ok(());
        }

        // Parse Content-Length (cap at 1MB to prevent DoS)
        const MAX_BODY: usize = 1024 * 1024;
        let content_length: usize = headers
            .lines()
            .find(|l| l.to_lowercase().starts_with("content-length:"))
            .and_then(|l| l.split(':').nth(1))
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(0)
            .min(MAX_BODY);

        if method == "POST" && (path == "/delegation/message" || path == "/delegation/complete") {
            let mut body = vec![0u8; content_length];
            if content_length > 0 {
                reader.read_exact(&mut body).map_err(|e| format!("body: {}", e))?;
            }
            let parsed: serde_json::Value = serde_json::from_str(&String::from_utf8_lossy(&body)).unwrap_or_default();
            let group_id = parsed["group_id"].as_str().unwrap_or("").to_string();
            let agent = parsed["agent"].as_str().unwrap_or("Agent").to_string();
            let message = if path == "/delegation/complete" {
                parsed["summary"].as_str().unwrap_or("").to_string()
            } else {
                parsed["message"].as_str().unwrap_or("").to_string()
            };
            let msg_type = if path == "/delegation/complete" { "complete" } else { "chat" };

            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;

            let del_msg = DelegationMessage {
                group_id: group_id.clone(),
                agent: agent.clone(),
                message: message.clone(),
                timestamp: ts,
                msg_type: msg_type.to_string(),
            };

            // Store message
            if let Ok(mut store) = delegation_messages.lock() {
                store.entry(group_id.clone()).or_default().push(del_msg.clone());
            }

            // Emit to frontend
            let _ = app_handle.emit("delegation-message", &del_msg);

            safe_eprintln!("[delegation] {} from {} in group {}: {}", msg_type, agent, &group_id[..group_id.len().min(8)], &message[..message.len().min(80)]);

            send_http(&mut stream, 200, r#"{"ok":true}"#);
            return Ok(());
        }

        if method == "GET" && path.starts_with("/delegation/messages") {
            // Parse query params: ?group=X&last=N
            let query = path.split('?').nth(1).unwrap_or("");
            let params: HashMap<&str, &str> = query.split('&')
                .filter_map(|p| p.split_once('='))
                .collect();
            let group_id = params.get("group").unwrap_or(&"");
            let last_n: usize = params.get("last").and_then(|v| v.parse().ok()).unwrap_or(20);

            let recent: Vec<DelegationMessage> = if let Ok(store) = delegation_messages.lock() {
                if let Some(msgs) = store.get(*group_id) {
                    let start = msgs.len().saturating_sub(last_n);
                    msgs[start..].to_vec()
                } else {
                    vec![]
                }
            } else {
                vec![]
            };
            let body = serde_json::to_string(&recent).unwrap_or("[]".to_string());
            send_http(&mut stream, 200, &body);
            return Ok(());
        }

        send_http(&mut stream, 404, r#"{"error":"not found"}"#);
        return Ok(());
    }

    if method != "POST" {
        send_http(&mut stream, 405, r#"{"error":"method not allowed"}"#);
        return Ok(());
    }

    // Parse path: /hook/{secret}/{run_token}
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() < 4 || parts[1] != "hook" || parts[2] != secret {
        send_http(&mut stream, 403, r#"{"error":"forbidden"}"#);
        return Ok(());
    }
    let run_token = parts[3].to_string();

    // Parse Content-Length (cap at 1MB to prevent DoS)
    const MAX_BODY: usize = 1024 * 1024;
    let content_length: usize = headers
        .lines()
        .find(|l| l.to_lowercase().starts_with("content-length:"))
        .and_then(|l| l.split(':').nth(1))
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(0)
        .min(MAX_BODY);

    // Read body
    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader
            .read_exact(&mut body)
            .map_err(|e| format!("body read: {}", e))?;
    }
    let body_str = String::from_utf8_lossy(&body);
    let parsed: serde_json::Value = serde_json::from_str(&body_str).unwrap_or_default();

    let tool_name = parsed["tool_name"]
        .as_str()
        .unwrap_or("unknown")
        .to_string();
    let tool_input = parsed["tool_input"].clone();

    // Look up session
    let session_id = sessions
        .lock()
        .map_err(|e| e.to_string())?
        .get(&run_token)
        .cloned()
        .unwrap_or_default();

    if session_id.is_empty() {
        // Unknown token — deny by default (fail-closed)
        let resp = serde_json::json!({
            "hookSpecificOutput": {
                "hookEventName": "PermissionRequest",
                "decision": {
                    "behavior": "deny",
                    "message": "Unknown session — denied for safety"
                }
            }
        });
        send_http(&mut stream, 200, &resp.to_string());
        return Ok(());
    }

    let request_id = next_id();
    safe_eprintln!(
        "[perm-server] Permission request {} for {} in session {}: {}",
        request_id, tool_name, &session_id[..session_id.len().min(8)], tool_name
    );

    // Create channel and store sender
    let (tx, rx) = mpsc::sync_channel(1);
    pending.lock().map_err(|e| e.to_string())?.insert(request_id.clone(), tx);

    // Emit to frontend
    let _ = app_handle.emit(
        "permission-request",
        serde_json::json!({
            "request_id": request_id,
            "session_id": session_id,
            "tool_name": tool_name,
            "tool_input": tool_input,
        }),
    );

    // Wait for decision (5 minute timeout)
    // Remove read timeout so the connection stays open
    stream.set_read_timeout(None).ok();

    let (allow, reason) = match rx.recv_timeout(Duration::from_secs(300)) {
        Ok(decision) => decision,
        Err(_) => {
            pending.lock().map_err(|e| e.to_string())?.remove(&request_id);
            safe_eprintln!("[perm-server] Timeout for request {}", request_id);
            (false, "Permission request timed out".to_string())
        }
    };

    let decision = if allow { "allow" } else { "deny" };
    safe_eprintln!("[perm-server] Resolved {}: {}", request_id, decision);

    let resp = if allow {
        serde_json::json!({
            "hookSpecificOutput": {
                "hookEventName": "PermissionRequest",
                "decision": {
                    "behavior": "allow"
                }
            }
        })
    } else {
        serde_json::json!({
            "hookSpecificOutput": {
                "hookEventName": "PermissionRequest",
                "decision": {
                    "behavior": "deny",
                    "message": reason
                }
            }
        })
    };
    send_http(&mut stream, 200, &resp.to_string());

    Ok(())
}

fn send_http(stream: &mut TcpStream, status: u16, body: &str) {
    let status_text = match status {
        200 => "OK",
        403 => "Forbidden",
        405 => "Method Not Allowed",
        _ => "Error",
    };
    let response = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status,
        status_text,
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}
