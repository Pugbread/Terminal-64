use crate::claude_manager::ClaudeManager;
use crate::types::*;
use futures_util::{SinkExt, StreamExt};
use reqwest::Client as HttpClient;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Listener};
use tokio::sync::Mutex as TokioMutex;

const DISCORD_API: &str = "https://discord.com/api/v10";

struct BotState {
    token: String,
    guild_id: u64,
    category_id: Option<u64>,
    session_to_channel: HashMap<String, u64>,
    channel_to_session: HashMap<u64, String>,
    session_cwd: HashMap<String, String>,
    http: HttpClient,
}

type UnlistenHandle = Box<dyn std::any::Any + Send>;

pub struct DiscordBot {
    runtime: Option<tokio::runtime::Runtime>,
    state: Arc<TokioMutex<Option<BotState>>>,
    shutdown_tx: Option<tokio::sync::watch::Sender<bool>>,
    _unlisten_handles: std::sync::Mutex<Vec<UnlistenHandle>>,
}

impl DiscordBot {
    pub fn new() -> Self {
        Self {
            runtime: None,
            state: Arc::new(TokioMutex::new(None)),
            shutdown_tx: None,
            _unlisten_handles: std::sync::Mutex::new(Vec::new()),
        }
    }

    pub fn start(
        &mut self,
        token: String,
        guild_id: u64,
        app_handle: AppHandle,
        claude_manager: Arc<ClaudeManager>,
    ) -> Result<(), String> {
        if self.runtime.is_some() {
            return Err("Bot already running".into());
        }

        eprintln!("[discord] Starting bot for guild {}", guild_id);

        let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);

        let http = HttpClient::new();
        let bot_state = Arc::new(TokioMutex::new(Some(BotState {
            token: token.clone(),
            guild_id,
            category_id: None,
            session_to_channel: HashMap::new(),
            channel_to_session: HashMap::new(),
            session_cwd: HashMap::new(),
            http: http.clone(),
        })));

        self.state = bot_state.clone();

        // Fetch guild channels once, then find/create category and restore session mappings
        let state_for_init = bot_state.clone();
        let token_for_init = token.clone();
        rt.block_on(async {
            let channels = match fetch_guild_channels(&state_for_init, &token_for_init).await {
                Ok(ch) => ch,
                Err(e) => { eprintln!("[discord] Failed to fetch channels: {}", e); return; }
            };
            if let Err(e) = ensure_category(&state_for_init, &token_for_init, &channels).await {
                eprintln!("[discord] Failed to ensure category: {}", e);
                return;
            }
            if let Err(e) = restore_channel_mappings(&state_for_init, &channels).await {
                eprintln!("[discord] Channel restore error: {}", e);
            }
        });

        // Shared typing indicator state
        let typing_stops: TypingStops = Arc::new(std::sync::Mutex::new(HashMap::new()));

        // Spawn gateway listener
        let state_for_gw = bot_state.clone();
        let token_for_gw = token.clone();
        let cm = claude_manager.clone();
        let ah = app_handle.clone();
        let mut shutdown_rx_gw = shutdown_rx.clone();
        let typing_stops_for_gw = typing_stops.clone();
        let http_for_typing = http.clone();

        rt.spawn(async move {
            loop {
                if *shutdown_rx_gw.borrow() { break; }
                if let Err(e) = run_gateway(&token_for_gw, &state_for_gw, &cm, &ah, &mut shutdown_rx_gw, &typing_stops_for_gw, &http_for_typing).await {
                    eprintln!("[discord] Gateway error: {}, reconnecting in 5s...", e);
                    tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                }
                if *shutdown_rx_gw.borrow() { break; }
            }
            eprintln!("[discord] Gateway loop ended");
        });

        // Channel for forwarding messages to Discord from Tauri event listeners
        let (msg_tx, mut msg_rx) = tokio::sync::mpsc::unbounded_channel::<(String, String)>(); // (session_id, text)

        // Spawn a task to process the message queue on the bot's runtime
        let state_for_queue = bot_state.clone();
        let token_for_queue = token.clone();
        let typing_stops_for_queue = typing_stops.clone();
        let http_for_queue = http.clone();
        rt.spawn(async move {
            while let Some((session_id, text)) = msg_rx.recv().await {
                // Look up channel with a brief lock, then release before sending
                let channel_id = {
                    let s = state_for_queue.lock().await;
                    s.as_ref().and_then(|bs| bs.session_to_channel.get(&session_id).copied())
                };
                if let Some(channel_id) = channel_id {
                    // Stop the typing indicator — a real message is going out
                    if let Ok(mut stops) = typing_stops_for_queue.lock() {
                        if let Some(tx) = stops.remove(&channel_id) {
                            let _ = tx.send(true);
                        }
                    }
                    for chunk in split_msg(&text, 1900) {
                        let _ = send_discord_message(&http_for_queue, &token_for_queue, channel_id, &chunk).await;
                    }
                }
            }
        });

        // Listen for claude-event — forward assistant messages to Discord
        let tx1 = msg_tx.clone();
        let unlisten1 = app_handle.listen("claude-event", move |event| {
            let Ok(payload) = serde_json::from_str::<ClaudeEvent>(event.payload()) else { return };
            let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&payload.data) else { return };
            if parsed["type"].as_str() != Some("assistant") { return; }
            let Some(content) = parsed["message"]["content"].as_array() else { return };

            let mut text = String::new();
            for block in content {
                if block["type"] == "text" {
                    if let Some(t) = block["text"].as_str() { text.push_str(t); }
                } else if block["type"] == "tool_use" {
                    let name = block["name"].as_str().unwrap_or("Tool");
                    let detail = summarize_tool(name, &block["input"]);
                    text.push_str(&format!("\n> ⚙ **{}** {}\n", name, detail));
                }
            }
            if !text.trim().is_empty() {
                let _ = tx1.send((payload.session_id, text));
            }
        });

        // Listen for GUI messages — forward as "ADMIN: message"
        let tx2 = msg_tx.clone();
        let unlisten2 = app_handle.listen("gui-message", move |event| {
            let Ok(parsed) = serde_json::from_str::<serde_json::Value>(event.payload()) else { return };
            let sid = parsed["session_id"].as_str().unwrap_or("").to_string();
            let content = parsed["content"].as_str().unwrap_or("").to_string();
            if !sid.is_empty() && !content.is_empty() {
                let _ = tx2.send((sid, format!("**ADMIN:** {}", content)));
            }
        });

        // Store unlisten handles for cleanup
        *self._unlisten_handles.lock().unwrap() = vec![
            Box::new(unlisten1),
            Box::new(unlisten2),
        ];

        self.shutdown_tx = Some(shutdown_tx);
        self.runtime = Some(rt);

        Ok(())
    }

    pub fn stop(&mut self) -> Result<(), String> {
        eprintln!("[discord] Stopping bot");
        // Drop unlisten handles to stop event listeners
        *self._unlisten_handles.lock().unwrap() = Vec::new();
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(true);
        }
        if let Some(rt) = self.runtime.take() {
            rt.shutdown_timeout(std::time::Duration::from_secs(2));
        }
        let state = self.state.clone();
        // Clear state synchronously
        let new_rt = tokio::runtime::Runtime::new().ok();
        if let Some(rt) = new_rt {
            rt.block_on(async { *state.lock().await = None; });
        }
        Ok(())
    }

    pub fn is_running(&self) -> bool {
        self.runtime.is_some()
    }

    pub fn unlink_session(&self, session_id: &str) -> Result<(), String> {
        if self.runtime.is_none() { return Ok(()); }
        let state = self.state.clone();
        let sid = session_id.to_string();

        let handle = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all().build().map_err(|e| e.to_string())?;
            rt.block_on(async {
                let mut s = state.lock().await;
                let bs = s.as_mut().ok_or("No state".to_string())?;
                if let Some(channel_id) = bs.session_to_channel.remove(&sid) {
                    bs.channel_to_session.remove(&channel_id);
                    // Delete the channel
                    let _ = bs.http.delete(format!("{}/channels/{}", DISCORD_API, channel_id))
                        .header("Authorization", format!("Bot {}", bs.token))
                        .send().await;
                    eprintln!("[discord] Deleted channel {} for session {}", channel_id, sid);
                }
                Ok(())
            })
        });
        handle.join().map_err(|_| "Thread panicked".to_string())?
    }

    pub fn link_session(&self, session_id: String, session_name: String, cwd: String) -> Result<(), String> {
        if self.runtime.is_none() {
            return Err("Bot not running".into());
        }
        let state = self.state.clone();

        // Use a separate thread + runtime to avoid deadlocking the main tokio runtime
        let handle = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|e| e.to_string())?;

            rt.block_on(async {
                let mut s = state.lock().await;
                let bs = s.as_mut().ok_or("Bot state not initialized".to_string())?;

                if bs.session_to_channel.contains_key(&session_id) {
                    return Ok(());
                }

                let cat_id = bs.category_id.ok_or("Category not found".to_string())?;
                let channel_name = sanitize_name(&session_name);

                let body = serde_json::json!({
                    "name": channel_name,
                    "type": 0,
                    "parent_id": cat_id.to_string(),
                    "topic": format!("Terminal 64: {}", session_id),
                });

                eprintln!("[discord] Creating channel #{} for session {}", channel_name, session_id);

                let resp = bs.http.post(format!("{}/guilds/{}/channels", DISCORD_API, bs.guild_id))
                    .header("Authorization", format!("Bot {}", bs.token))
                    .json(&body)
                    .send().await
                    .map_err(|e| format!("HTTP error: {}", e))?;

                let status = resp.status();
                let channel: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

                if !status.is_success() {
                    return Err(format!("Discord API error {}: {:?}", status, channel));
                }

                let channel_id = channel["id"].as_str().unwrap_or("0").parse::<u64>().unwrap_or(0);
                if channel_id == 0 {
                    return Err(format!("Failed to parse channel ID: {:?}", channel));
                }

                eprintln!("[discord] Created #{} (ID: {}) for session {}", channel_name, channel_id, session_id);
                bs.session_to_channel.insert(session_id.clone(), channel_id);
                bs.channel_to_session.insert(channel_id, session_id.clone());
                if !cwd.is_empty() {
                    bs.session_cwd.insert(session_id, cwd);
                }

                let _ = send_discord_message(&bs.http, &bs.token, channel_id,
                    &format!("**Linked to Terminal 64 session: {}**\nMessages here are forwarded to Claude.", session_name)
                ).await;

                Ok(())
            })
        });

        handle.join().map_err(|_| "Thread panicked".to_string())?
    }

    pub fn cleanup_orphaned(&self) -> Result<(), String> {
        if self.runtime.is_none() { return Ok(()); }
        let state = self.state.clone();

        let handle = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all().build().map_err(|e| e.to_string())?;
            rt.block_on(async {
                let s = state.lock().await;
                let bs = s.as_ref().ok_or("No state".to_string())?;
                let token = bs.token.clone();
                drop(s);
                cleanup_orphaned_channels(&state, &token).await
            })
        });
        handle.join().map_err(|_| "Thread panicked".to_string())?
    }

    pub fn rename_or_link_session(&self, session_id: String, session_name: String, cwd: String) -> Result<(), String> {
        if self.runtime.is_none() { return Ok(()); }
        let state = self.state.clone();

        let handle = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all().build().map_err(|e| e.to_string())?;
            rt.block_on(async {
                let mut s = state.lock().await;
                let bs = s.as_mut().ok_or("No state".to_string())?;

                if let Some(&channel_id) = bs.session_to_channel.get(&session_id) {
                    // Channel exists — rename it
                    let new_name = sanitize_name(&session_name);
                    let body = serde_json::json!({ "name": new_name });
                    let _ = bs.http.patch(format!("{}/channels/{}", DISCORD_API, channel_id))
                        .header("Authorization", format!("Bot {}", bs.token))
                        .json(&body)
                        .send().await;
                    eprintln!("[discord] Renamed channel {} to #{}", channel_id, new_name);
                    Ok(())
                } else if !session_name.is_empty() {
                    // No channel yet — create one (reuse link_session logic)
                    let cat_id = bs.category_id.ok_or("No category".to_string())?;
                    let channel_name = sanitize_name(&session_name);
                    let body = serde_json::json!({
                        "name": channel_name, "type": 0,
                        "parent_id": cat_id.to_string(),
                        "topic": format!("Terminal 64: {}", session_id),
                    });
                    let resp = bs.http.post(format!("{}/guilds/{}/channels", DISCORD_API, bs.guild_id))
                        .header("Authorization", format!("Bot {}", bs.token))
                        .json(&body)
                        .send().await.map_err(|e| e.to_string())?;
                    let channel: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
                    let channel_id = channel["id"].as_str().unwrap_or("0").parse::<u64>().unwrap_or(0);
                    if channel_id > 0 {
                        bs.session_to_channel.insert(session_id.clone(), channel_id);
                        bs.channel_to_session.insert(channel_id, session_id.clone());
                        if !cwd.is_empty() { bs.session_cwd.insert(session_id, cwd); }
                        eprintln!("[discord] Created #{} (ID: {}) on rename", channel_name, channel_id);
                    }
                    Ok(())
                } else {
                    Ok(())
                }
            })
        });
        handle.join().map_err(|_| "Thread panicked".to_string())?
    }
}

/// Fetch all guild channels once. Used by ensure_category and restore_channel_mappings.
async fn fetch_guild_channels(state: &Arc<TokioMutex<Option<BotState>>>, token: &str) -> Result<Vec<serde_json::Value>, String> {
    let s = state.lock().await;
    let bs = s.as_ref().ok_or("No state")?;
    let resp = bs.http.get(format!("{}/guilds/{}/channels", DISCORD_API, bs.guild_id))
        .header("Authorization", format!("Bot {}", token))
        .send().await.map_err(|e| e.to_string())?;
    resp.json().await.map_err(|e| e.to_string())
}

async fn ensure_category(state: &Arc<TokioMutex<Option<BotState>>>, token: &str, channels: &[serde_json::Value]) -> Result<(), String> {
    let mut s = state.lock().await;
    let bs = s.as_mut().ok_or("No state")?;

    for ch in channels {
        if ch["type"] == 4 && ch["name"].as_str() == Some("Terminal 64") {
            let id = ch["id"].as_str().unwrap_or("0").parse::<u64>().unwrap_or(0);
            bs.category_id = Some(id);
            eprintln!("[discord] Found category: {}", id);
            return Ok(());
        }
    }

    // Create it
    let body = serde_json::json!({ "name": "Terminal 64", "type": 4 });
    let resp = bs.http.post(format!("{}/guilds/{}/channels", DISCORD_API, bs.guild_id))
        .header("Authorization", format!("Bot {}", token))
        .json(&body)
        .send().await.map_err(|e| e.to_string())?;

    let cat: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let id = cat["id"].as_str().unwrap_or("0").parse::<u64>().unwrap_or(0);
    bs.category_id = Some(id);
    eprintln!("[discord] Created category: {}", id);
    Ok(())
}

type TypingStops = Arc<std::sync::Mutex<HashMap<u64, tokio::sync::watch::Sender<bool>>>>;

async fn run_gateway(
    token: &str,
    state: &Arc<TokioMutex<Option<BotState>>>,
    claude_manager: &Arc<ClaudeManager>,
    app_handle: &AppHandle,
    shutdown_rx: &mut tokio::sync::watch::Receiver<bool>,
    typing_stops: &TypingStops,
    typing_http: &HttpClient,
) -> Result<(), String> {
    // Get gateway URL
    let http = reqwest::Client::new();
    let gw_resp = http.get(format!("{}/gateway/bot", DISCORD_API))
        .header("Authorization", format!("Bot {}", token))
        .send().await.map_err(|e| e.to_string())?;

    let gw: serde_json::Value = gw_resp.json().await.map_err(|e| e.to_string())?;
    let url = gw["url"].as_str().unwrap_or("wss://gateway.discord.gg");
    let ws_url = format!("{}/?v=10&encoding=json", url);

    eprintln!("[discord] Connecting to gateway: {}", ws_url);

    let (ws_stream, _) = tokio_tungstenite::connect_async(&ws_url)
        .await.map_err(|e| format!("WS connect: {}", e))?;

    let (mut write, mut read) = ws_stream.split();
    let mut sequence: Option<u64> = None;
    let mut identified = false;
    let mut hb_interval = tokio::time::interval(tokio::time::Duration::from_secs(30));

    loop {
        tokio::select! {
            _ = shutdown_rx.changed() => {
                if *shutdown_rx.borrow() { break; }
            }
            _ = hb_interval.tick() => {
                let hb = serde_json::json!({ "op": 1, "d": sequence });
                if write.send(tokio_tungstenite::tungstenite::Message::Text(hb.to_string())).await.is_err() {
                    break;
                }
            }
            msg = read.next() => {
                let Some(Ok(msg)) = msg else { break };
                let text = match msg {
                    tokio_tungstenite::tungstenite::Message::Text(t) => t,
                    tokio_tungstenite::tungstenite::Message::Close(_) => break,
                    _ => continue,
                };

                let Ok(payload) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
                let op = payload["op"].as_u64().unwrap_or(0);

                if let Some(s) = payload["s"].as_u64() { sequence = Some(s); }

                match op {
                    10 => {
                        // Hello — set heartbeat interval and identify
                        if let Some(interval_ms) = payload["d"]["heartbeat_interval"].as_u64() {
                            hb_interval = tokio::time::interval(tokio::time::Duration::from_millis(interval_ms));
                        }
                        if !identified {
                            let identify = serde_json::json!({
                                "op": 2,
                                "d": {
                                    "token": token,
                                    "intents": 33281,
                                    "properties": { "os": std::env::consts::OS, "browser": "terminal64", "device": "terminal64" }
                                }
                            });
                            let _ = write.send(tokio_tungstenite::tungstenite::Message::Text(identify.to_string())).await;
                            identified = true;
                        }
                    }
                    1 => {
                        let hb = serde_json::json!({ "op": 1, "d": sequence });
                        let _ = write.send(tokio_tungstenite::tungstenite::Message::Text(hb.to_string())).await;
                    }
                    0 => {
                        let event_name = payload["t"].as_str().unwrap_or("");
                        if event_name == "MESSAGE_CREATE" {
                            let d = &payload["d"];
                            let author_bot = d["author"]["bot"].as_bool().unwrap_or(false);
                            if author_bot { continue; }

                            let channel_id = d["channel_id"].as_str().unwrap_or("0").parse::<u64>().unwrap_or(0);
                            let content = d["content"].as_str().unwrap_or("").to_string();
                            let username = d["author"]["username"].as_str().unwrap_or("user").to_string();
                            let attachments = d["attachments"].as_array();

                            eprintln!("[discord] MESSAGE_CREATE in channel {} from {}: {}", channel_id, username, &content[..content.len().min(50)]);

                            let has_attachments = attachments.map(|a| !a.is_empty()).unwrap_or(false);
                            if content.is_empty() && !has_attachments { continue; }

                            let (session_id, session_cwd) = {
                                let s = state.lock().await;
                                let sid = s.as_ref().and_then(|bs| bs.channel_to_session.get(&channel_id).cloned());
                                let cwd = sid.as_ref().and_then(|id| s.as_ref().and_then(|bs| bs.session_cwd.get(id).cloned())).unwrap_or_default();
                                (sid, cwd)
                            };

                            if let Some(sid) = session_id {
                                // Show typing indicator immediately while Claude processes
                                trigger_typing(typing_http, token, channel_id).await;
                                {
                                    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
                                    if let Ok(mut stops) = typing_stops.lock() {
                                        stops.insert(channel_id, stop_tx);
                                    }
                                    let http_t = typing_http.clone();
                                    let tok_t = token.to_string();
                                    tokio::spawn(async move {
                                        let mut rx = stop_rx;
                                        loop {
                                            tokio::select! {
                                                _ = tokio::time::sleep(tokio::time::Duration::from_secs(8)) => {
                                                    trigger_typing(&http_t, &tok_t, channel_id).await;
                                                }
                                                _ = rx.changed() => break,
                                            }
                                        }
                                    });
                                }

                                // Download Discord attachments into the session CWD so Claude can read them
                                let mut attachment_lines = Vec::new();
                                if let Some(atts) = attachments {
                                    let att_dir = if session_cwd.is_empty() { std::env::temp_dir() } else {
                                        let d = std::path::PathBuf::from(&session_cwd).join(".t64-attachments");
                                        let _ = std::fs::create_dir_all(&d);
                                        d
                                    };
                                    for att in atts {
                                        let url = att["url"].as_str().unwrap_or("");
                                        let filename = att["filename"].as_str().unwrap_or("file");
                                        if url.is_empty() { continue; }
                                        let dest = att_dir.join(filename);
                                        match typing_http.get(url).send().await {
                                            Ok(resp) => {
                                                if let Ok(bytes) = resp.bytes().await {
                                                    if std::fs::write(&dest, &bytes).is_ok() {
                                                        eprintln!("[discord] Downloaded attachment: {} -> {}", filename, dest.display());
                                                        attachment_lines.push(format!("[Attached file: {}]", dest.display()));
                                                    }
                                                }
                                            }
                                            Err(e) => eprintln!("[discord] Failed to download {}: {}", filename, e),
                                        }
                                    }
                                }

                                // Build prompt with attachments + text
                                let formatted_prompt = if attachment_lines.is_empty() {
                                    content.clone()
                                } else {
                                    let files = attachment_lines.join("\n");
                                    if content.is_empty() { files } else { format!("{}\n\n{}", files, content) }
                                };
                                eprintln!("[discord] Routing to session {} (cwd: {}): {}", sid, session_cwd, &formatted_prompt[..formatted_prompt.len().min(100)]);

                                // Show in the GUI as a user message
                                let _ = app_handle.emit("discord-message", serde_json::json!({
                                    "session_id": sid,
                                    "username": username,
                                    "content": content,
                                }));
                                // Check if session file exists on disk to decide create vs resume
                                let session_file_exists = {
                                    if let Some(home) = dirs::home_dir() {
                                        let cwd_hash = session_cwd.replace(':', "-").replace('\\', "-").replace('/', "-");
                                        let session_path = home.join(".claude").join("projects").join(&cwd_hash).join(format!("{}.jsonl", sid));
                                        session_path.exists()
                                    } else {
                                        false
                                    }
                                };

                                let discord_blocked = Some("mcp__plugin_discord_discord__reply,mcp__plugin_discord_discord__react,mcp__plugin_discord_discord__edit_message,mcp__plugin_discord_discord__fetch_messages,mcp__plugin_discord_discord__download_attachment".to_string());

                                let result = if session_file_exists {
                                    claude_manager.send_prompt(app_handle, SendClaudePromptRequest {
                                        session_id: sid.clone(),
                                        cwd: session_cwd.clone(),
                                        prompt: formatted_prompt.clone(),
                                        permission_mode: "accept_edits".to_string(),
                                        model: None, effort: None,
                                        disallowed_tools: discord_blocked.clone(),
                                    }, None)
                                } else {
                                    eprintln!("[discord] First message — creating new session");
                                    claude_manager.create_session(app_handle, CreateClaudeRequest {
                                        session_id: sid.clone(),
                                        cwd: session_cwd.clone(),
                                        prompt: formatted_prompt.clone(),
                                        permission_mode: "accept_edits".to_string(),
                                        model: None, effort: None,
                                    }, None)
                                };
                                if let Err(e) = result {
                                    eprintln!("[discord] Prompt error: {}", e);
                                }
                            }
                        } else if event_name == "READY" {
                            eprintln!("[discord] Gateway READY");
                        }
                    }
                    11 => {} // Heartbeat ACK
                    _ => {}
                }

            }
        }
    }

    Ok(())
}

async fn send_discord_message(http: &HttpClient, token: &str, channel_id: u64, content: &str) -> Result<(), String> {
    http.post(format!("{}/channels/{}/messages", DISCORD_API, channel_id))
        .header("Authorization", format!("Bot {}", token))
        .json(&serde_json::json!({ "content": content }))
        .send().await.map_err(|e| e.to_string())?;
    Ok(())
}

async fn trigger_typing(http: &HttpClient, token: &str, channel_id: u64) {
    let _ = http.post(format!("{}/channels/{}/typing", DISCORD_API, channel_id))
        .header("Authorization", format!("Bot {}", token))
        .send().await;
}

fn sanitize_name(name: &str) -> String {
    let s: String = name.to_lowercase().chars().map(|c| if c.is_alphanumeric() || c == '-' { c } else { '-' }).collect();
    let t = s.trim_matches('-').to_string();
    if t.is_empty() { "session".into() } else if t.len() > 90 { t[..90].into() } else { t }
}

fn summarize_tool(name: &str, input: &serde_json::Value) -> String {
    match name {
        "Bash" => format!("`{}`", input["command"].as_str().unwrap_or("").chars().take(60).collect::<String>()),
        "Read" | "Edit" | "Write" => format!("`{}`", input["file_path"].as_str().unwrap_or("")),
        "Glob" => format!("`{}`", input["pattern"].as_str().unwrap_or("")),
        "Grep" => format!("`/{}/`", input["pattern"].as_str().unwrap_or("")),
        _ => String::new(),
    }
}

async fn restore_channel_mappings(state: &Arc<TokioMutex<Option<BotState>>>, channels: &[serde_json::Value]) -> Result<(), String> {
    let mut s = state.lock().await;
    let bs = s.as_mut().ok_or("No state")?;
    let cat_id = bs.category_id.ok_or("No category")?;

    let mut restored = 0usize;
    for ch in channels {
        let parent = ch["parent_id"].as_str().and_then(|s| s.parse::<u64>().ok());
        if parent != Some(cat_id) { continue; }
        if ch["type"] != 0 { continue; }

        let ch_id = ch["id"].as_str().unwrap_or("0").parse::<u64>().unwrap_or(0);
        if ch_id == 0 { continue; }

        // Channel topics are "Terminal 64: {session_id}"
        if let Some(topic) = ch["topic"].as_str() {
            if let Some(session_id) = topic.strip_prefix("Terminal 64: ") {
                let sid = session_id.trim().to_string();
                if !sid.is_empty() {
                    bs.session_to_channel.insert(sid.clone(), ch_id);
                    bs.channel_to_session.insert(ch_id, sid);
                    restored += 1;
                }
            }
        }
    }

    eprintln!("[discord] Restored {} channel mappings from existing channels", restored);
    Ok(())
}

async fn cleanup_orphaned_channels(state: &Arc<TokioMutex<Option<BotState>>>, token: &str) -> Result<(), String> {
    let s = state.lock().await;
    let bs = s.as_ref().ok_or("No state")?;
    let cat_id = bs.category_id.ok_or("No category")?;

    let resp = bs.http.get(format!("{}/guilds/{}/channels", DISCORD_API, bs.guild_id))
        .header("Authorization", format!("Bot {}", token))
        .send().await.map_err(|e| e.to_string())?;

    let channels: Vec<serde_json::Value> = resp.json().await.map_err(|e| e.to_string())?;

    for ch in &channels {
        let parent = ch["parent_id"].as_str().and_then(|s| s.parse::<u64>().ok());
        if parent != Some(cat_id) { continue; }
        if ch["type"] != 0 { continue; } // Only text channels

        let ch_id_str = ch["id"].as_str().unwrap_or("0");
        let ch_id = ch_id_str.parse::<u64>().unwrap_or(0);
        let ch_name = ch["name"].as_str().unwrap_or("");

        // If this channel isn't in our session map, it's orphaned
        if !bs.channel_to_session.contains_key(&ch_id) {
            eprintln!("[discord] Deleting orphaned channel #{} ({})", ch_name, ch_id);
            let _ = bs.http.delete(format!("{}/channels/{}", DISCORD_API, ch_id))
                .header("Authorization", format!("Bot {}", token))
                .send().await;
        }
    }

    Ok(())
}

fn split_msg(text: &str, max: usize) -> Vec<String> {
    if text.len() <= max { return vec![text.to_string()]; }
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < text.len() {
        let end = (start + max).min(text.len());
        let split = if end < text.len() { text[start..end].rfind('\n').map(|i| start + i + 1).unwrap_or(end) } else { end };
        chunks.push(text[start..split].to_string());
        start = split;
    }
    chunks
}
