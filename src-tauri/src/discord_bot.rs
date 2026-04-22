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
    ) -> Result<(), String> {
        if self.runtime.is_some() {
            return Err("Bot already running".into());
        }

        safe_eprintln!("[discord] Starting bot for guild {}", guild_id);

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
                Err(e) => {
                    safe_eprintln!("[discord] Failed to fetch channels: {}", e);
                    return;
                }
            };
            if let Err(e) = ensure_category(&state_for_init, &token_for_init, &channels).await {
                safe_eprintln!("[discord] Failed to ensure category: {}", e);
                return;
            }
            if let Err(e) = restore_channel_mappings(&state_for_init, &channels).await {
                safe_eprintln!("[discord] Channel restore error: {}", e);
            }
        });

        // Shared typing indicator state
        let typing_stops: TypingStops = Arc::new(std::sync::Mutex::new(HashMap::new()));

        // Spawn gateway listener
        let state_for_gw = bot_state.clone();
        let token_for_gw = token.clone();
        let ah = app_handle.clone();
        let mut shutdown_rx_gw = shutdown_rx.clone();
        let typing_stops_for_gw = typing_stops.clone();
        let http_for_typing = http.clone();

        rt.spawn(async move {
            loop {
                if *shutdown_rx_gw.borrow() {
                    break;
                }
                if let Err(e) = run_gateway(
                    &token_for_gw,
                    &state_for_gw,
                    &ah,
                    &mut shutdown_rx_gw,
                    &typing_stops_for_gw,
                    &http_for_typing,
                )
                .await
                {
                    safe_eprintln!("[discord] Gateway error: {}, reconnecting in 5s...", e);
                    tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                }
                if *shutdown_rx_gw.borrow() {
                    break;
                }
            }
            safe_eprintln!("[discord] Gateway loop ended");
        });

        // Queue of outbound events. Streaming is modeled as a series of
        // `StreamUpdate` events (each carrying the full accumulated assistant
        // text so far) followed by a `StreamEnd` when Claude finishes. The
        // consumer maintains per-channel state and edits a single Discord
        // message instead of posting one per chunk, throttled to stay under
        // Discord's 5 req / 5 s per-channel bucket.
        let (msg_tx, mut msg_rx) = tokio::sync::mpsc::unbounded_channel::<DiscordOutMsg>();

        let state_for_queue = bot_state.clone();
        let token_for_queue = token.clone();
        let typing_stops_for_queue = typing_stops.clone();
        let http_for_queue = http.clone();
        rt.spawn(async move {
            let mut streams: HashMap<u64, StreamState> = HashMap::new();
            let mut tick = tokio::time::interval(tokio::time::Duration::from_millis(400));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tokio::select! {
                    maybe = msg_rx.recv() => {
                        let Some(msg) = maybe else { break };
                        match msg {
                            DiscordOutMsg::StreamUpdate { session_id, full_text } => {
                                let channel_id = {
                                    let s = state_for_queue.lock().await;
                                    s.as_ref()
                                        .and_then(|bs| bs.session_to_channel.get(&session_id).copied())
                                };
                                let Some(channel_id) = channel_id else { continue };
                                let state = streams.entry(channel_id).or_insert_with(StreamState::new);
                                state.pending = full_text;
                                state.dirty = true;
                                // First update for this turn: stop typing, post the initial
                                // message immediately so the user sees SOMETHING before the
                                // throttle kicks in.
                                if state.current_msg_id.is_none() {
                                    if let Ok(mut stops) = typing_stops_for_queue.lock() {
                                        if let Some(tx) = stops.remove(&channel_id) {
                                            let _ = tx.send(true);
                                        }
                                    }
                                    state.flush_now(channel_id, &http_for_queue, &token_for_queue, false).await;
                                }
                            }
                            DiscordOutMsg::StreamEnd { session_id } => {
                                let channel_id = {
                                    let s = state_for_queue.lock().await;
                                    s.as_ref()
                                        .and_then(|bs| bs.session_to_channel.get(&session_id).copied())
                                };
                                let Some(channel_id) = channel_id else { continue };
                                if let Some(state) = streams.get_mut(&channel_id) {
                                    // Force-send: bypass throttle + diff guard + markdown sealing.
                                    state.flush_now(channel_id, &http_for_queue, &token_for_queue, true).await;
                                }
                                streams.remove(&channel_id);
                            }
                            DiscordOutMsg::Post { session_id, text } => {
                                let channel_id = {
                                    let s = state_for_queue.lock().await;
                                    s.as_ref()
                                        .and_then(|bs| bs.session_to_channel.get(&session_id).copied())
                                };
                                let Some(channel_id) = channel_id else { continue };
                                // A non-stream post (ADMIN, etc.) closes any active stream
                                // for this channel so future streaming starts a fresh message.
                                if let Some(state) = streams.get_mut(&channel_id) {
                                    // Force-final the dying stream too — same reasoning as StreamEnd.
                                    state.flush_now(channel_id, &http_for_queue, &token_for_queue, true).await;
                                }
                                streams.remove(&channel_id);
                                if let Ok(mut stops) = typing_stops_for_queue.lock() {
                                    if let Some(tx) = stops.remove(&channel_id) {
                                        let _ = tx.send(true);
                                    }
                                }
                                for chunk in split_msg(&text, 1900) {
                                    let _ = send_discord_message(
                                        &http_for_queue,
                                        &token_for_queue,
                                        channel_id,
                                        &chunk,
                                    ).await;
                                }
                            }
                        }
                    }
                    _ = tick.tick() => {
                        // Per-channel flush, gated by a 1.2s min edit interval so we
                        // stay well under Discord's 5/5s per-channel edit bucket.
                        for (channel_id, state) in streams.iter_mut() {
                            if state.dirty && state.last_edit.elapsed() >= std::time::Duration::from_millis(1200) {
                                state.flush_now(*channel_id, &http_for_queue, &token_for_queue, false).await;
                            }
                        }
                    }
                }
            }
        });

        // Listen for claude-event — forward assistant output to Discord as
        // streaming edits. Claude Code (with `--include-partial-messages`)
        // emits:
        //   * stream_event → content_block_start (text | tool_use)
        //   * stream_event → content_block_delta (text_delta | input_json_delta)
        //   * stream_event → content_block_stop
        //   * assistant (full snapshot, ignored — we've already rendered it)
        //   * result (turn complete — final flush)
        //
        // Per-session text accumulator builds up live text for streaming;
        // per-(session, block_index) tool buffer accumulates the partial
        // JSON for a tool call so we can post its Discord message once
        // `content_block_stop` arrives with the complete input (the
        // `content_block_start` payload has `input: {}` — all args come in
        // later via `input_json_delta`).
        struct ToolBuild {
            name: String,
            partial_json: String,
        }
        let accum: Arc<std::sync::Mutex<HashMap<String, String>>> =
            Arc::new(std::sync::Mutex::new(HashMap::new()));
        let tools: Arc<std::sync::Mutex<HashMap<String, HashMap<usize, ToolBuild>>>> =
            Arc::new(std::sync::Mutex::new(HashMap::new()));
        let tx1 = msg_tx.clone();
        let accum_for_claude = accum.clone();
        let tools_for_claude = tools.clone();
        let unlisten1 = app_handle.listen("claude-event", move |event| {
            let Ok(payload) = serde_json::from_str::<ClaudeEvent>(event.payload()) else {
                return;
            };
            let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&payload.data) else {
                return;
            };
            let sid = payload.session_id.clone();
            match parsed["type"].as_str() {
                Some("stream_event") => {
                    let inner = &parsed["event"];
                    let etype = inner["type"].as_str().unwrap_or("");
                    match etype {
                        "message_start" => {
                            // Fresh turn: clear stale accumulators.
                            if let Ok(mut g) = accum_for_claude.lock() {
                                g.insert(sid.clone(), String::new());
                            }
                            if let Ok(mut g) = tools_for_claude.lock() {
                                g.remove(&sid);
                            }
                        }
                        "content_block_start" => {
                            let index = inner["index"].as_u64().unwrap_or(0) as usize;
                            let block_type = inner["content_block"]["type"].as_str();
                            match block_type {
                                Some("tool_use") => {
                                    let name = inner["content_block"]["name"]
                                        .as_str()
                                        .unwrap_or("Tool")
                                        .to_string();
                                    // Buffer input JSON until content_block_stop.
                                    if let Ok(mut g) = tools_for_claude.lock() {
                                        g.entry(sid.clone()).or_default().insert(
                                            index,
                                            ToolBuild {
                                                name,
                                                partial_json: String::new(),
                                            },
                                        );
                                    }
                                    // Tool use breaks any in-flight text stream.
                                    let _ = tx1.send(DiscordOutMsg::StreamEnd {
                                        session_id: sid.clone(),
                                    });
                                }
                                Some("text") => {
                                    // Text block: finalize any open stream so
                                    // the next text deltas start a new message.
                                    let _ = tx1.send(DiscordOutMsg::StreamEnd {
                                        session_id: sid.clone(),
                                    });
                                }
                                _ => {}
                            }
                            // Reset text accumulator at every block boundary.
                            if let Ok(mut g) = accum_for_claude.lock() {
                                g.insert(sid.clone(), String::new());
                            }
                        }
                        "content_block_delta" => {
                            let index = inner["index"].as_u64().unwrap_or(0) as usize;
                            let delta = &inner["delta"];
                            match delta["type"].as_str() {
                                Some("text_delta") => {
                                    if let Some(t) = delta["text"].as_str() {
                                        let full = if let Ok(mut g) = accum_for_claude.lock() {
                                            let buf = g.entry(sid.clone()).or_default();
                                            buf.push_str(t);
                                            buf.clone()
                                        } else {
                                            return;
                                        };
                                        let _ = tx1.send(DiscordOutMsg::StreamUpdate {
                                            session_id: sid,
                                            full_text: full,
                                        });
                                    }
                                }
                                Some("input_json_delta") => {
                                    if let Some(partial) = delta["partial_json"].as_str() {
                                        if let Ok(mut g) = tools_for_claude.lock() {
                                            if let Some(m) = g.get_mut(&sid) {
                                                if let Some(tool) = m.get_mut(&index) {
                                                    tool.partial_json.push_str(partial);
                                                }
                                            }
                                        }
                                    }
                                }
                                _ => {}
                            }
                        }
                        "content_block_stop" => {
                            let index = inner["index"].as_u64().unwrap_or(0) as usize;
                            // If this block was a tool_use we tracked, render
                            // its summary line now that the input is complete.
                            let done = if let Ok(mut g) = tools_for_claude.lock() {
                                g.get_mut(&sid).and_then(|m| m.remove(&index))
                            } else {
                                None
                            };
                            if let Some(tool) = done {
                                let input: serde_json::Value =
                                    serde_json::from_str(&tool.partial_json)
                                        .unwrap_or_else(|_| serde_json::json!({}));
                                let detail = summarize_tool(&tool.name, &input);
                                let line = if detail.is_empty() {
                                    format!("> ⚙ **{}**", tool.name)
                                } else {
                                    format!("> ⚙ **{}** {}", tool.name, detail)
                                };
                                let _ = tx1.send(DiscordOutMsg::Post {
                                    session_id: sid,
                                    text: line,
                                });
                            }
                        }
                        _ => {}
                    }
                }
                Some("result") => {
                    // Turn complete — finalize the edit and clear buffers
                    // so the next turn starts a new message with no stale
                    // text or half-built tool input.
                    if let Ok(mut g) = accum_for_claude.lock() {
                        g.remove(&sid);
                    }
                    if let Ok(mut g) = tools_for_claude.lock() {
                        g.remove(&sid);
                    }
                    let _ = tx1.send(DiscordOutMsg::StreamEnd { session_id: sid });
                }
                _ => {}
            }
        });

        // Listen for GUI messages — forward as "ADMIN: message"
        let tx2 = msg_tx.clone();
        let unlisten2 = app_handle.listen("gui-message", move |event| {
            let Ok(parsed) = serde_json::from_str::<serde_json::Value>(event.payload()) else {
                return;
            };
            let sid = parsed["session_id"].as_str().unwrap_or("").to_string();
            let content = parsed["content"].as_str().unwrap_or("").to_string();
            if !sid.is_empty() && !content.is_empty() {
                let _ = tx2.send(DiscordOutMsg::Post {
                    session_id: sid,
                    text: format!("**ADMIN:** {}", content),
                });
            }
        });

        // Store unlisten handles for cleanup
        *self._unlisten_handles.lock().map_err(|e| e.to_string())? =
            vec![Box::new(unlisten1), Box::new(unlisten2)];

        self.shutdown_tx = Some(shutdown_tx);
        self.runtime = Some(rt);

        Ok(())
    }

    pub fn stop(&mut self) -> Result<(), String> {
        safe_eprintln!("[discord] Stopping bot");
        // Drop unlisten handles to stop event listeners
        *self._unlisten_handles.lock().map_err(|e| e.to_string())? = Vec::new();
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(true);
        }
        if let Some(rt) = self.runtime.take() {
            rt.shutdown_timeout(std::time::Duration::from_secs(2));
        }
        let state = self.state.clone();
        let new_rt = match tokio::runtime::Runtime::new() {
            Ok(rt) => Some(rt),
            Err(e) => {
                safe_eprintln!("[discord] Failed to create runtime for cleanup: {}", e);
                None
            }
        };
        if let Some(rt) = new_rt {
            rt.block_on(async {
                *state.lock().await = None;
            });
        }
        Ok(())
    }

    pub fn is_running(&self) -> bool {
        self.runtime.is_some()
    }

    pub fn unlink_session(&self, session_id: &str) -> Result<(), String> {
        if self.runtime.is_none() {
            return Ok(());
        }
        let state = self.state.clone();
        let sid = session_id.to_string();

        let handle = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|e| e.to_string())?;
            rt.block_on(async {
                let mut s = state.lock().await;
                let bs = s.as_mut().ok_or("No state".to_string())?;
                if let Some(channel_id) = bs.session_to_channel.remove(&sid) {
                    bs.channel_to_session.remove(&channel_id);
                    let _ = bs
                        .http
                        .delete(format!("{}/channels/{}", DISCORD_API, channel_id))
                        .header("Authorization", format!("Bot {}", bs.token))
                        .send()
                        .await;
                    safe_eprintln!(
                        "[discord] Deleted channel {} for session {}",
                        channel_id,
                        sid
                    );
                }
                Ok(())
            })
        });
        handle.join().map_err(|_| "Thread panicked".to_string())?
    }

    pub fn link_session(
        &self,
        session_id: String,
        session_name: String,
        cwd: String,
    ) -> Result<(), String> {
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

                let channel_id = create_session_channel(bs, &session_id, &session_name, &cwd).await?;

                let _ = send_discord_message(&bs.http, &bs.token, channel_id,
                    &format!("**Linked to Terminal 64 session: {}**\nMessages here are forwarded to Claude.", session_name)
                ).await;

                Ok(())
            })
        });

        handle.join().map_err(|_| "Thread panicked".to_string())?
    }

    pub fn cleanup_orphaned(&self, active_session_ids: Vec<String>) -> Result<(), String> {
        if self.runtime.is_none() {
            return Ok(());
        }
        let state = self.state.clone();

        let handle = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|e| e.to_string())?;
            rt.block_on(async {
                let token = {
                    let s = state.lock().await;
                    let bs = s.as_ref().ok_or("No state".to_string())?;
                    bs.token.clone()
                };
                cleanup_orphaned_channels(&state, &token, &active_session_ids).await
            })
        });
        handle.join().map_err(|_| "Thread panicked".to_string())?
    }

    pub fn rename_or_link_session(
        &self,
        session_id: String,
        session_name: String,
        cwd: String,
    ) -> Result<(), String> {
        if self.runtime.is_none() {
            return Ok(());
        }
        let state = self.state.clone();

        let handle = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|e| e.to_string())?;
            rt.block_on(async {
                let mut s = state.lock().await;
                let bs = s.as_mut().ok_or("No state".to_string())?;

                if let Some(&channel_id) = bs.session_to_channel.get(&session_id) {
                    // Channel exists — rename it
                    let new_name = sanitize_name(&session_name);
                    let body = serde_json::json!({ "name": new_name });
                    let _ = bs
                        .http
                        .patch(format!("{}/channels/{}", DISCORD_API, channel_id))
                        .header("Authorization", format!("Bot {}", bs.token))
                        .json(&body)
                        .send()
                        .await;
                    safe_eprintln!("[discord] Renamed channel {} to #{}", channel_id, new_name);
                    Ok(())
                } else if !session_name.is_empty() {
                    // No channel yet — create one
                    create_session_channel(bs, &session_id, &session_name, &cwd).await?;
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
async fn fetch_guild_channels(
    state: &Arc<TokioMutex<Option<BotState>>>,
    token: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let s = state.lock().await;
    let bs = s.as_ref().ok_or("No state")?;
    let resp = bs
        .http
        .get(format!("{}/guilds/{}/channels", DISCORD_API, bs.guild_id))
        .header("Authorization", format!("Bot {}", token))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    resp.json().await.map_err(|e| e.to_string())
}

async fn ensure_category(
    state: &Arc<TokioMutex<Option<BotState>>>,
    token: &str,
    channels: &[serde_json::Value],
) -> Result<(), String> {
    let mut s = state.lock().await;
    let bs = s.as_mut().ok_or("No state")?;

    for ch in channels {
        if ch["type"] == 4 && ch["name"].as_str() == Some("Terminal 64") {
            let id = ch["id"].as_str().unwrap_or("0").parse::<u64>().unwrap_or(0);
            bs.category_id = Some(id);
            safe_eprintln!("[discord] Found category: {}", id);
            return Ok(());
        }
    }

    let body = serde_json::json!({ "name": "Terminal 64", "type": 4 });
    let resp = bs
        .http
        .post(format!("{}/guilds/{}/channels", DISCORD_API, bs.guild_id))
        .header("Authorization", format!("Bot {}", token))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let cat: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let id = cat["id"]
        .as_str()
        .unwrap_or("0")
        .parse::<u64>()
        .unwrap_or(0);
    bs.category_id = Some(id);
    safe_eprintln!("[discord] Created category: {}", id);
    Ok(())
}

type TypingStops = Arc<std::sync::Mutex<HashMap<u64, tokio::sync::watch::Sender<bool>>>>;

async fn run_gateway(
    token: &str,
    state: &Arc<TokioMutex<Option<BotState>>>,
    app_handle: &AppHandle,
    shutdown_rx: &mut tokio::sync::watch::Receiver<bool>,
    typing_stops: &TypingStops,
    typing_http: &HttpClient,
) -> Result<(), String> {
    let http = reqwest::Client::new();
    let gw_resp = http
        .get(format!("{}/gateway/bot", DISCORD_API))
        .header("Authorization", format!("Bot {}", token))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let gw: serde_json::Value = gw_resp.json().await.map_err(|e| e.to_string())?;
    let url = gw["url"].as_str().unwrap_or("wss://gateway.discord.gg");
    let ws_url = format!("{}/?v=10&encoding=json", url);

    safe_eprintln!("[discord] Connecting to gateway: {}", ws_url);

    let (ws_stream, _) = tokio_tungstenite::connect_async(&ws_url)
        .await
        .map_err(|e| format!("WS connect: {}", e))?;

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

                            safe_eprintln!("[discord] MESSAGE_CREATE in channel {} from {}: {}", channel_id, username, &content[..content.len().min(50)]);

                            let has_attachments = attachments.map(|a| !a.is_empty()).unwrap_or(false);
                            if content.trim().is_empty() && !has_attachments { continue; }

                            let (session_id, session_cwd) = {
                                let s = state.lock().await;
                                let sid = s.as_ref().and_then(|bs| bs.channel_to_session.get(&channel_id).cloned());
                                let cwd = sid.as_ref().and_then(|id| s.as_ref().and_then(|bs| bs.session_cwd.get(id).cloned())).unwrap_or_default();
                                (sid, cwd)
                            };

                            if let Some(sid) = session_id {
                                trigger_typing(typing_http, token, channel_id).await;
                                {
                                    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
                                    match typing_stops.lock() {
                                        Ok(mut stops) => { stops.insert(channel_id, stop_tx); }
                                        Err(e) => safe_eprintln!("[discord] Lock poisoned (typing stops): {}", e),
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

                                // Download Discord attachments into the session CWD so Claude can read them.
                                // Discord voice notes (recorded with the in-app mic button) carry a
                                // `waveform` field + content_type audio/ogg — transcribe them via
                                // whisper and inline the text instead of dropping an .ogg Claude
                                // can't play.
                                let mut attachment_lines = Vec::new();
                                let mut voice_transcripts: Vec<String> = Vec::new();
                                if let Some(atts) = attachments {
                                    let att_dir = if session_cwd.is_empty() { std::env::temp_dir() } else {
                                        let d = std::path::PathBuf::from(&session_cwd).join(".t64-attachments");
                                        let _ = std::fs::create_dir_all(&d);
                                        d
                                    };
                                    for att in atts {
                                        let url = att["url"].as_str().unwrap_or("");
                                        let raw_filename = att["filename"].as_str().unwrap_or("file");
                                        let is_voice_note = att.get("waveform").is_some()
                                            || att["content_type"].as_str().map(|t| t.starts_with("audio/")).unwrap_or(false);
                                        if url.is_empty() { continue; }
                                        // Sanitize: strip path separators, drive letters, and traversal.
                                        // Discord filenames can contain "../" or "\" — treating them as
                                        // path segments would let a malicious attachment write outside
                                        // the attachment dir (more severe on Windows where "\" is a separator).
                                        let filename: String = raw_filename
                                            .rsplit(['/', '\\'])
                                            .next()
                                            .unwrap_or("file")
                                            .chars()
                                            .filter(|c| !matches!(c, '\0'..='\x1f' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
                                            .collect();
                                        // Windows silently strips trailing dots/spaces from filenames —
                                        // "CON.txt." becomes "CON.txt", which can cause file open failures
                                        // and create collisions with sibling files.
                                        let filename = filename.trim_end_matches(['.', ' ']).to_string();
                                        // Windows reserves device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9) —
                                        // a file named "CON.png" or just "CON" will fail to open.
                                        // Match on the stem (part before the first dot) case-insensitively.
                                        let stem_upper = filename
                                            .split('.')
                                            .next()
                                            .unwrap_or("")
                                            .to_uppercase();
                                        let is_reserved = matches!(
                                            stem_upper.as_str(),
                                            "CON" | "PRN" | "AUX" | "NUL"
                                            | "COM1" | "COM2" | "COM3" | "COM4" | "COM5"
                                            | "COM6" | "COM7" | "COM8" | "COM9"
                                            | "LPT1" | "LPT2" | "LPT3" | "LPT4" | "LPT5"
                                            | "LPT6" | "LPT7" | "LPT8" | "LPT9"
                                        );
                                        let filename = if filename.trim().is_empty()
                                            || filename == "."
                                            || filename == ".."
                                            || is_reserved
                                        {
                                            "file".to_string()
                                        } else {
                                            filename
                                        };
                                        let dest = att_dir.join(&filename);
                                        match typing_http.get(url).send().await {
                                            Ok(resp) => {
                                                if let Ok(bytes) = resp.bytes().await {
                                                    if std::fs::write(&dest, &bytes).is_ok() {
                                                        safe_eprintln!("[discord] Downloaded attachment: {} -> {}", filename, dest.display());
                                                        if is_voice_note {
                                                            // Transcribe on the blocking pool so whisper.cpp
                                                            // doesn't stall the gateway's tokio runtime.
                                                            let path_owned = dest.clone();
                                                            let res = tokio::task::spawn_blocking(move || {
                                                                let samples = crate::voice::audio_file::load_as_16k_mono(&path_owned)?;
                                                                let need = (crate::voice::audio_file::TARGET_RATE as usize * 11) / 10;
                                                                let padded: Vec<f32> = if samples.len() < need {
                                                                    let mut v = samples;
                                                                    v.resize(need, 0.0);
                                                                    v
                                                                } else { samples };
                                                                let info = crate::voice::models::find(crate::voice::models::ModelKind::Whisper, "small.en-q5_1")
                                                                    .ok_or_else(|| "whisper model not in registry".to_string())?;
                                                                if !crate::voice::models::is_downloaded(info) {
                                                                    return Err("whisper model not downloaded".to_string());
                                                                }
                                                                let dir = crate::voice::models::model_dir(crate::voice::models::ModelKind::Whisper, "small.en-q5_1")?;
                                                                let bin = dir.join("ggml-small.en-q5_1.bin");
                                                                let runner = crate::voice::whisper::WhisperRunner::load(&bin)?;
                                                                let raw = runner.transcribe_oneshot(&padded)?;
                                                                Ok::<String, String>(crate::voice::whisper::strip_whisper_tags(&raw))
                                                            }).await;
                                                            match res {
                                                                Ok(Ok(text)) => {
                                                                    let trimmed = text.trim();
                                                                    if !trimmed.is_empty() {
                                                                        safe_eprintln!("[discord] Voice note transcribed ({} chars)", trimmed.len());
                                                                        // Echo the transcript back to Discord as a
                                                                        // plain markdown blockquote — no tag, just
                                                                        // the message itself, one blockquote line per
                                                                        // transcript line. A small-text separator line
                                                                        // follows so the blockquote reads distinct
                                                                        // from Claude's streamed response that lands
                                                                        // right after. 2000-char Discord limit —
                                                                        // truncate with ellipsis.
                                                                        let quoted: String = trimmed
                                                                            .lines()
                                                                            .map(|l| format!("> {}", l))
                                                                            .collect::<Vec<_>>()
                                                                            .join("\n");
                                                                        let divider = "\n-# ─────────────────────────";
                                                                        let body = format!("{}{}", quoted, divider);
                                                                        let echo = if body.len() > 1990 {
                                                                            // Drop the divider if we're already near the
                                                                            // limit; prefer preserving the transcript.
                                                                            format!("{}…", &quoted[..quoted.len().min(1989)])
                                                                        } else {
                                                                            body
                                                                        };
                                                                        let _ = send_discord_message(typing_http, token, channel_id, &echo).await;
                                                                        // Posting a message clears Discord's typing
                                                                        // indicator. Re-trigger it so the user sees
                                                                        // the bot is thinking (= Claude processing)
                                                                        // through to the actual response, not just
                                                                        // until the echo lands.
                                                                        trigger_typing(typing_http, token, channel_id).await;
                                                                        // Send only the RAW transcript into the Claude
                                                                        // prompt — the tag is for Discord readers, not
                                                                        // for the model.
                                                                        voice_transcripts.push(trimmed.to_string());
                                                                    } else {
                                                                        safe_eprintln!("[discord] Voice note transcription empty");
                                                                    }
                                                                }
                                                                Ok(Err(e)) => safe_eprintln!("[discord] Voice note transcription failed: {}", e),
                                                                Err(e) => safe_eprintln!("[discord] Voice note task panicked: {}", e),
                                                            }
                                                            // Always clean up the .ogg — we've extracted what we need.
                                                            let _ = std::fs::remove_file(&dest);
                                                        } else {
                                                            attachment_lines.push(format!("[Attached file: {}]", dest.display()));
                                                        }
                                                    }
                                                }
                                            }
                                            Err(e) => safe_eprintln!("[discord] Failed to download {}: {}", filename, e),
                                        }
                                    }
                                }

                                // Build prompt: file refs + voice transcripts + user text.
                                // Voice transcripts are merged into the text the same way the
                                // user's Discord message content is, so Claude treats the whole
                                // thing as one spoken request.
                                let text_parts: Vec<String> = voice_transcripts
                                    .into_iter()
                                    .chain(if content.trim().is_empty() { vec![] } else { vec![content.clone()] })
                                    .collect();
                                let merged_text = text_parts.join("\n\n");
                                let formatted_prompt = if attachment_lines.is_empty() {
                                    merged_text
                                } else {
                                    let files = attachment_lines.join("\n");
                                    if merged_text.is_empty() { files } else { format!("{}\n\n{}", files, merged_text) }
                                };
                                safe_eprintln!("[discord] Routing to session {} (cwd: {}): {}", sid, session_cwd, &formatted_prompt[..formatted_prompt.len().min(100)]);

                                // Route through the frontend — emit discord-prompt so the
                                // GUI's handleSend/actualSend handles streaming checks,
                                // queuing, resume/create fallback, permission mode, etc.
                                let _ = app_handle.emit("discord-prompt", serde_json::json!({
                                    "session_id": sid,
                                    "username": username,
                                    "prompt": formatted_prompt,
                                }));
                            }
                        } else if event_name == "READY" {
                            safe_eprintln!("[discord] Gateway READY");
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

async fn send_discord_message(
    http: &HttpClient,
    token: &str,
    channel_id: u64,
    content: &str,
) -> Result<(), String> {
    http.post(format!("{}/channels/{}/messages", DISCORD_API, channel_id))
        .header("Authorization", format!("Bot {}", token))
        .json(&serde_json::json!({ "content": content }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Post a message and return its id so the caller can edit it later.
async fn post_and_get_id(
    http: &HttpClient,
    token: &str,
    channel_id: u64,
    content: &str,
) -> Result<u64, String> {
    let resp = http
        .post(format!("{}/channels/{}/messages", DISCORD_API, channel_id))
        .header("Authorization", format!("Bot {}", token))
        .json(&serde_json::json!({ "content": content }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    v["id"]
        .as_str()
        .and_then(|s| s.parse::<u64>().ok())
        .ok_or_else(|| "no id in post response".to_string())
}

/// PATCH an existing message with new content (for live streaming edits).
async fn edit_discord_message(
    http: &HttpClient,
    token: &str,
    channel_id: u64,
    message_id: u64,
    content: &str,
) -> Result<(), String> {
    http.patch(format!(
        "{}/channels/{}/messages/{}",
        DISCORD_API, channel_id, message_id
    ))
    .header("Authorization", format!("Bot {}", token))
    .json(&serde_json::json!({ "content": content }))
    .send()
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Outbound Discord message kinds. `StreamUpdate` is coalesced/edited;
/// `Post` is always a fresh atomic message; `StreamEnd` finalizes pending.
enum DiscordOutMsg {
    StreamUpdate {
        session_id: String,
        full_text: String,
    },
    StreamEnd {
        session_id: String,
    },
    Post {
        session_id: String,
        text: String,
    },
}

/// Per-channel streaming state: the message currently being edited, what
/// Discord sees vs. what we want, and any overflow once the current
/// message exceeds Discord's 2000-char limit (continued in a new message).
struct StreamState {
    current_msg_id: Option<u64>,
    /// Starting offset (in the accumulated `pending` text) of whatever the
    /// current Discord message is editing. Used to split at the 1900-char
    /// boundary: when `pending.len() - window_start > 1900`, we close the
    /// current message at that boundary and open a new one beginning at
    /// the next char.
    window_start: usize,
    /// Latest cumulative assistant text from Claude.
    pending: String,
    /// Last text we actually sent to Discord (for diff skip).
    last_sent: String,
    last_edit: std::time::Instant,
    dirty: bool,
}

impl StreamState {
    fn new() -> Self {
        Self {
            current_msg_id: None,
            window_start: 0,
            pending: String::new(),
            last_sent: String::new(),
            last_edit: std::time::Instant::now() - std::time::Duration::from_secs(10),
            dirty: false,
        }
    }

    /// Render + send whatever's pending. Handles the 1900-char rollover by
    /// freezing the current message and opening a new one. When `is_final`
    /// is true, skips the markdown-sealing auto-closers (the final text is
    /// balanced by construction) and always PATCHes even if the content
    /// didn't change from the last sent snapshot — guarantees the last few
    /// characters land even if a tick already fired just before the stream
    /// ended.
    async fn flush_now(&mut self, channel_id: u64, http: &HttpClient, token: &str, is_final: bool) {
        const MAX: usize = 1900;
        loop {
            let window_text: String = self.pending.chars().skip(self.window_start).collect();
            let window_len = window_text.chars().count();
            if window_len > MAX {
                let head: String = window_text.chars().take(MAX).collect();
                let head_safe = if is_final {
                    head.clone()
                } else {
                    seal_open_markdown(&head)
                };
                if let Some(msg_id) = self.current_msg_id {
                    let _ = edit_discord_message(http, token, channel_id, msg_id, &head_safe).await;
                } else if let Ok(id) = post_and_get_id(http, token, channel_id, &head_safe).await {
                    self.current_msg_id = Some(id);
                }
                self.window_start += MAX;
                self.current_msg_id = None;
                self.last_sent = String::new();
                continue;
            }
            // Fits in one message. Skip the diff guard on final so the
            // last edit always lands clean (no leftover auto-closed `**`
            // tokens from a mid-stream seal).
            if !is_final && window_text == self.last_sent {
                self.dirty = false;
                return;
            }
            let safe = if is_final {
                window_text.clone()
            } else {
                seal_open_markdown(&window_text)
            };
            match self.current_msg_id {
                Some(msg_id) => {
                    let _ = edit_discord_message(http, token, channel_id, msg_id, &safe).await;
                }
                None => {
                    let initial = if safe.is_empty() {
                        "…".to_string()
                    } else {
                        safe.clone()
                    };
                    if let Ok(id) = post_and_get_id(http, token, channel_id, &initial).await {
                        self.current_msg_id = Some(id);
                    }
                }
            }
            self.last_sent = window_text;
            self.last_edit = std::time::Instant::now();
            self.dirty = false;
            return;
        }
    }
}

/// Close unterminated markdown spans mid-stream so Discord doesn't render
/// the rest of the message as bold/italic/code while the stream is still
/// landing the closing token. Cheap heuristic: count odd occurrences of
/// the common delimiters and append the missing close.
fn seal_open_markdown(s: &str) -> String {
    let mut out = s.to_string();
    // Triple-backtick code fence: close if unbalanced.
    let fence_count = s.matches("```").count();
    if fence_count % 2 == 1 {
        out.push_str("\n```");
    }
    // Inline markers — only if the pair count is odd AND no unclosed fence
    // (code-fence contents may legitimately contain unbalanced asterisks).
    if fence_count % 2 == 0 {
        for marker in ["**", "__", "*", "_", "`"] {
            let count = out.matches(marker).count();
            if count % 2 == 1 {
                out.push_str(marker);
            }
        }
    }
    out
}

async fn trigger_typing(http: &HttpClient, token: &str, channel_id: u64) {
    let _ = http
        .post(format!("{}/channels/{}/typing", DISCORD_API, channel_id))
        .header("Authorization", format!("Bot {}", token))
        .send()
        .await;
}

fn sanitize_name(name: &str) -> String {
    let s: String = name
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let t = s.trim_matches('-').to_string();
    if t.is_empty() {
        "session".into()
    } else if t.len() > 90 {
        t[..90].into()
    } else {
        t
    }
}

fn summarize_tool(name: &str, input: &serde_json::Value) -> String {
    match name {
        "Bash" => format!(
            "`{}`",
            input["command"]
                .as_str()
                .unwrap_or("")
                .chars()
                .take(60)
                .collect::<String>()
        ),
        "Read" | "Edit" | "Write" => format!("`{}`", input["file_path"].as_str().unwrap_or("")),
        "Glob" => format!("`{}`", input["pattern"].as_str().unwrap_or("")),
        "Grep" => format!("`/{}/`", input["pattern"].as_str().unwrap_or("")),
        _ => String::new(),
    }
}

async fn restore_channel_mappings(
    state: &Arc<TokioMutex<Option<BotState>>>,
    channels: &[serde_json::Value],
) -> Result<(), String> {
    let mut s = state.lock().await;
    let bs = s.as_mut().ok_or("No state")?;
    let cat_id = bs.category_id.ok_or("No category")?;

    let mut restored = 0usize;
    for ch in channels {
        let parent = ch["parent_id"].as_str().and_then(|s| s.parse::<u64>().ok());
        if parent != Some(cat_id) {
            continue;
        }
        if ch["type"] != 0 {
            continue;
        }

        let ch_id = ch["id"].as_str().unwrap_or("0").parse::<u64>().unwrap_or(0);
        if ch_id == 0 {
            continue;
        }

        // Channel topics are "Terminal 64: {session_id} | {cwd}"
        if let Some(topic) = ch["topic"].as_str() {
            if let Some(rest) = topic.strip_prefix("Terminal 64: ") {
                let (sid, cwd) = if let Some((s, c)) = rest.split_once(" | ") {
                    (s.trim().to_string(), c.trim().to_string())
                } else {
                    (rest.trim().to_string(), String::new())
                };
                if !sid.is_empty() {
                    bs.session_to_channel.insert(sid.clone(), ch_id);
                    bs.channel_to_session.insert(ch_id, sid.clone());
                    if !cwd.is_empty() {
                        bs.session_cwd.insert(sid, cwd);
                    }
                    restored += 1;
                }
            }
        }
    }

    safe_eprintln!(
        "[discord] Restored {} channel mappings from existing channels",
        restored
    );
    Ok(())
}

async fn cleanup_orphaned_channels(
    state: &Arc<TokioMutex<Option<BotState>>>,
    token: &str,
    active_session_ids: &[String],
) -> Result<(), String> {
    let active: std::collections::HashSet<&str> =
        active_session_ids.iter().map(|s| s.as_str()).collect();

    // Snapshot what we need without holding the lock across the HTTP call.
    let (http, guild_id, cat_id, channel_to_session) = {
        let s = state.lock().await;
        let bs = s.as_ref().ok_or("No state")?;
        (
            bs.http.clone(),
            bs.guild_id,
            bs.category_id.ok_or("No category")?,
            bs.channel_to_session.clone(),
        )
    };

    let resp = http
        .get(format!("{}/guilds/{}/channels", DISCORD_API, guild_id))
        .header("Authorization", format!("Bot {}", token))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let channels: Vec<serde_json::Value> = resp.json().await.map_err(|e| e.to_string())?;

    let mut to_remove: Vec<(u64, Option<String>)> = Vec::new();
    for ch in &channels {
        let parent = ch["parent_id"].as_str().and_then(|s| s.parse::<u64>().ok());
        if parent != Some(cat_id) {
            continue;
        }
        if ch["type"] != 0 {
            continue;
        } // Only text channels

        let ch_id = ch["id"].as_str().unwrap_or("0").parse::<u64>().unwrap_or(0);
        let ch_name = ch["name"].as_str().unwrap_or("");
        if ch_id == 0 {
            continue;
        }

        // A channel is orphaned if it's not mapped at all, or it's mapped to
        // a session that isn't currently open on the canvas.
        let mapped_sid = channel_to_session.get(&ch_id);
        let is_orphan = match mapped_sid {
            None => true,
            Some(sid) => !active.contains(sid.as_str()),
        };
        if is_orphan {
            safe_eprintln!(
                "[discord] Deleting orphaned channel #{} ({})",
                ch_name,
                ch_id
            );
            let _ = http
                .delete(format!("{}/channels/{}", DISCORD_API, ch_id))
                .header("Authorization", format!("Bot {}", token))
                .send()
                .await;
            to_remove.push((ch_id, mapped_sid.cloned()));
        }
    }

    // Drop stale in-memory mappings for the channels we just deleted.
    if !to_remove.is_empty() {
        let mut s = state.lock().await;
        if let Some(bs) = s.as_mut() {
            for (ch_id, sid) in &to_remove {
                bs.channel_to_session.remove(ch_id);
                if let Some(sid) = sid {
                    bs.session_to_channel.remove(sid);
                    bs.session_cwd.remove(sid);
                }
            }
        }
    }

    Ok(())
}

/// Create a new text channel under the Terminal 64 category and register the mapping.
async fn create_session_channel(
    bs: &mut BotState,
    session_id: &str,
    session_name: &str,
    cwd: &str,
) -> Result<u64, String> {
    let cat_id = bs.category_id.ok_or("Category not found".to_string())?;
    let channel_name = sanitize_name(session_name);
    let body = serde_json::json!({
        "name": channel_name,
        "type": 0,
        "parent_id": cat_id.to_string(),
        "topic": if cwd.is_empty() {
            format!("Terminal 64: {}", session_id)
        } else {
            format!("Terminal 64: {} | {}", session_id, cwd)
        },
    });

    safe_eprintln!(
        "[discord] Creating channel #{} for session {}",
        channel_name,
        session_id
    );

    let mut channel: serde_json::Value;
    let mut status;
    let mut attempts = 0;
    loop {
        let resp = bs
            .http
            .post(format!("{}/guilds/{}/channels", DISCORD_API, bs.guild_id))
            .header("Authorization", format!("Bot {}", bs.token))
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("HTTP error: {}", e))?;

        status = resp.status();
        channel = resp.json().await.map_err(|e| e.to_string())?;

        if status.as_u16() == 429 && attempts < 3 {
            let retry_after = channel["retry_after"].as_f64().unwrap_or(1.0);
            safe_eprintln!("[discord] Rate limited, retrying in {:.1}s", retry_after);
            tokio::time::sleep(std::time::Duration::from_secs_f64(retry_after)).await;
            attempts += 1;
            continue;
        }
        break;
    }

    if !status.is_success() {
        return Err(format!("Discord API error {}: {:?}", status, channel));
    }

    let channel_id = channel["id"]
        .as_str()
        .unwrap_or("0")
        .parse::<u64>()
        .unwrap_or(0);
    if channel_id == 0 {
        return Err(format!("Failed to parse channel ID: {:?}", channel));
    }

    safe_eprintln!(
        "[discord] Created #{} (ID: {}) for session {}",
        channel_name,
        channel_id,
        session_id
    );
    bs.session_to_channel
        .insert(session_id.to_string(), channel_id);
    bs.channel_to_session
        .insert(channel_id, session_id.to_string());
    if !cwd.is_empty() {
        bs.session_cwd
            .insert(session_id.to_string(), cwd.to_string());
    }

    Ok(channel_id)
}

fn split_msg(text: &str, max: usize) -> Vec<String> {
    if max == 0 {
        return vec![text.to_string()];
    }
    if text.len() <= max {
        return vec![text.to_string()];
    }
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < text.len() {
        let mut end = (start + max).min(text.len());
        // Ensure we don't split in the middle of a multi-byte UTF-8 character
        while end > start && !text.is_char_boundary(end) {
            end -= 1;
        }
        if end == start {
            end = start + 1;
            while end < text.len() && !text.is_char_boundary(end) {
                end += 1;
            }
        }
        let split = if end < text.len() {
            text[start..end]
                .rfind('\n')
                .map(|i| start + i + 1)
                .unwrap_or(end)
        } else {
            end
        };
        chunks.push(text[start..split].to_string());
        start = split;
    }
    chunks
}
