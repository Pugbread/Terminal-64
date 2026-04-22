use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};

/// A simple localhost-only HTTP server that serves widget files from
/// `~/.terminal64/widgets/{widget_id}/`.  Widgets loaded via `<iframe src=...>`
/// get a proper `http://127.0.0.1:{port}` origin, enabling relative imports,
/// ES modules, multi-file projects, and camera/mic permissions.
///
/// On top of file serving, the server exposes two plugin-host bridge routes
/// used by `kind: "plugin"` / `"hybrid"` widgets:
///
/// * `POST /widgets/{id}/plugin/invoke` — JSON envelope forwarded to the
///   installed [`PluginHostBridge`] for request/response RPC.
/// * `GET  /widgets/{id}/plugin/stream` — Server-Sent Events of plugin-pushed
///   events and crash signals. Each message is a pre-serialized JSON frame.
pub struct WidgetServer {
    inner: Arc<ServerInner>,
}

struct ServerInner {
    port: AtomicU16,
    /// Parsed `widget.json` manifests keyed by widget id, with the mtime they
    /// were loaded at for cheap re-validation.
    manifest_cache: Mutex<HashMap<String, ManifestState>>,
    /// Optional plugin host implementation. Installed after construction via
    /// [`WidgetServer::set_plugin_host`]. When `None`, plugin routes respond
    /// with HTTP 503 so the frontend can surface a clear error.
    bridge: Mutex<Option<Arc<dyn PluginHostBridge>>>,
}

fn widgets_base() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".terminal64").join("widgets"))
}

// =====================================================================
// Plugin manifest (shared with frontend via `pluginManifest.ts`)
// =====================================================================

/// Supported values for the manifest `kind` field. `Web` is the classic
/// iframe-only widget (no subprocess); `Plugin` is a headless/native plugin
/// with no iframe surface; `Hybrid` combines both.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ManifestKind {
    Web,
    Plugin,
    Hybrid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SurfaceDef {
    pub id: String,
    /// One of `panel` | `fullscreen` | `overlay` | `headless` | `settings-section`.
    #[serde(rename = "type")]
    pub surface_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionEntry {
    /// Canonical permission name, e.g. `host.emit`, `host.secrets.get`.
    pub name: String,
    /// Human-readable justification shown on the consent screen.
    pub reason: String,
    #[serde(default)]
    pub scopes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    /// Wire version. Host refuses plugins whose apiVersion is > host max.
    #[serde(rename = "apiVersion", default = "default_api_version")]
    pub api_version: u32,
    pub kind: ManifestKind,
    #[serde(default)]
    pub surfaces: Vec<SurfaceDef>,
    #[serde(default)]
    pub permissions: Vec<PermissionEntry>,
    #[serde(default)]
    pub config: serde_json::Value,
    #[serde(default)]
    pub rpc: serde_json::Value,
    #[serde(default)]
    pub autostart: bool,
    #[serde(default)]
    pub singleton: bool,
}

fn default_api_version() -> u32 {
    1
}

#[derive(Debug, Clone)]
struct ManifestState {
    mtime: SystemTime,
    manifest: PluginManifest,
    /// SHA-256 of the raw manifest bytes, used by the consent workflow
    /// (`~/.terminal64/widgets/{id}/.approved.json`).
    #[allow(dead_code)] // Scaffolding for consent flow — wired up via load_manifest_with_hash.
    raw_hash: String,
}

// =====================================================================
// Plugin host bridge
// =====================================================================

/// Abstraction over the plugin subprocess supervisor. Implemented by the
/// plugin_host module; installed on the `WidgetServer` after its setup so the
/// HTTP routes can forward invoke + stream traffic without depending on the
/// concrete type.
pub trait PluginHostBridge: Send + Sync {
    /// Forward a `plugin/invoke` request. `args` is whatever JSON the caller
    /// passed through; the bridge is expected to enforce manifest permissions
    /// before routing to the plugin process.
    fn invoke(
        &self,
        plugin_id: &str,
        method: &str,
        args: serde_json::Value,
        request_id: &str,
    ) -> Result<serde_json::Value, String>;

    /// Open an event stream for the given plugin. Each received `String` is a
    /// pre-serialized JSON frame that will be written as a single SSE
    /// `data:` line. Dropping the receiver ends the SSE connection.
    fn subscribe(&self, plugin_id: &str) -> Result<mpsc::Receiver<String>, String>;
}

// =====================================================================
// Manifest loading
// =====================================================================

fn hash_manifest_bytes(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn load_manifest_from_disk(widget_id: &str) -> Result<(ManifestState, serde_json::Value), String> {
    let base = widgets_base().ok_or_else(|| "no home dir".to_string())?;
    let path = base.join(widget_id).join("widget.json");
    let metadata = std::fs::metadata(&path)
        .map_err(|e| format!("widget.json not found for {}: {}", widget_id, e))?;
    let mtime = metadata.modified().unwrap_or_else(|_| SystemTime::now());
    let bytes = std::fs::read(&path).map_err(|e| format!("read widget.json: {}", e))?;
    let raw_json: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|e| format!("widget.json is not valid JSON: {}", e))?;
    let manifest: PluginManifest = serde_json::from_value(raw_json.clone())
        .map_err(|e| format!("widget.json failed schema validation: {}", e))?;
    if manifest.id != widget_id {
        return Err(format!(
            "widget.json id `{}` does not match folder `{}`",
            manifest.id, widget_id
        ));
    }
    let state = ManifestState {
        mtime,
        manifest,
        raw_hash: hash_manifest_bytes(&bytes),
    };
    Ok((state, raw_json))
}

impl ServerInner {
    /// Look up the cached manifest, reloading from disk when the file mtime
    /// has changed since the last read.
    fn get_manifest(&self, widget_id: &str) -> Result<PluginManifest, String> {
        // Quick mtime check on the cached copy.
        let base = widgets_base().ok_or_else(|| "no home dir".to_string())?;
        let path = base.join(widget_id).join("widget.json");
        let disk_mtime = std::fs::metadata(&path).and_then(|m| m.modified()).ok();

        if let Ok(cache) = self.manifest_cache.lock() {
            if let (Some(state), Some(disk)) = (cache.get(widget_id), disk_mtime) {
                if state.mtime == disk {
                    return Ok(state.manifest.clone());
                }
            }
        }

        let (state, _raw) = load_manifest_from_disk(widget_id)?;
        let manifest = state.manifest.clone();
        if let Ok(mut cache) = self.manifest_cache.lock() {
            cache.insert(widget_id.to_string(), state);
        }
        Ok(manifest)
    }
}

// =====================================================================
// Mime + HTTP helpers
// =====================================================================

fn mime_for(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "wasm" => "application/wasm",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "xml" => "application/xml",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn respond(mut stream: TcpStream, status: u16, mime: &str, body: &[u8]) {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        403 => "Forbidden",
        405 => "Method Not Allowed",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "Error",
    };
    let header = format!(
        "HTTP/1.1 {} {}\r\n\
         Content-Type: {}\r\n\
         Content-Length: {}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Cache-Control: no-cache\r\n\
         X-Content-Type-Options: nosniff\r\n\
         Connection: close\r\n\r\n",
        status,
        reason,
        mime,
        body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

fn respond_json(stream: TcpStream, status: u16, value: &serde_json::Value) {
    let body = serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec());
    respond(stream, status, "application/json; charset=utf-8", &body);
}

/// The widget_id validator shared across every HTTP route. Matches the
/// canonical regex `^[A-Za-z0-9_-]+$` and rejects any `..` traversal.
fn is_valid_widget_id(id: &str) -> bool {
    !id.is_empty()
        && !id.contains("..")
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

struct ParsedRequest {
    method: String,
    path: String,
    #[allow(dead_code)] // Parsed for future auth/cookie routes; unused in current handlers.
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn parse_request(stream: &TcpStream) -> Result<ParsedRequest, String> {
    // We do our own line-by-line reader so we can keep access to the
    // underlying stream (no BufReader consumes ownership). The headers are
    // always in ASCII, so byte-by-byte is fine.
    let mut reader = std::io::BufReader::new(stream);
    let mut request_line = String::new();
    std::io::BufRead::read_line(&mut reader, &mut request_line)
        .map_err(|e| format!("read request line: {}", e))?;

    let parts: Vec<&str> = request_line.split_whitespace().collect();
    if parts.len() < 2 {
        return Err("malformed request line".to_string());
    }
    let method = parts[0].to_string();
    let path = parts[1].to_string();

    let mut headers: HashMap<String, String> = HashMap::new();
    loop {
        let mut line = String::new();
        match std::io::BufRead::read_line(&mut reader, &mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                if line.trim().is_empty() {
                    break;
                }
                if let Some((k, v)) = line.split_once(':') {
                    headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
                }
            }
        }
    }

    let content_length: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    // Cap request bodies at 2 MiB — plugin invokes carry JSON args, not blobs.
    const MAX_BODY: usize = 2 * 1024 * 1024;
    let to_read = content_length.min(MAX_BODY);
    let mut body = vec![0u8; to_read];
    if to_read > 0 {
        reader
            .read_exact(&mut body)
            .map_err(|e| format!("read request body: {}", e))?;
    }

    Ok(ParsedRequest {
        method,
        path,
        headers,
        body,
    })
}

// =====================================================================
// Request handlers
// =====================================================================

fn handle_request(mut stream: TcpStream, inner: Arc<ServerInner>) {
    let req = match parse_request(&stream) {
        Ok(r) => r,
        Err(_) => {
            respond(stream, 400, "text/plain", b"Bad request");
            return;
        }
    };

    if req.method == "OPTIONS" {
        let header = "HTTP/1.1 204 No Content\r\n\
            Access-Control-Allow-Origin: *\r\n\
            Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
            Access-Control-Allow-Headers: *\r\n\
            Connection: close\r\n\r\n";
        let _ = stream.write_all(header.as_bytes());
        return;
    }

    let decoded = url_decode(&req.path);
    let path = decoded.split('?').next().unwrap_or(&decoded).to_string();

    // Route: /widgets/{widget_id}/...
    let stripped = match path.strip_prefix("/widgets/") {
        Some(s) if !s.is_empty() => s,
        _ => {
            respond(stream, 404, "text/plain", b"Not found");
            return;
        }
    };

    let (widget_id, rest) = match stripped.find('/') {
        Some(idx) => (&stripped[..idx], &stripped[idx + 1..]),
        None => (stripped, ""),
    };

    if !is_valid_widget_id(widget_id) {
        respond(stream, 403, "text/plain", b"Invalid widget id");
        return;
    }

    // ---- Plugin routes ------------------------------------------------
    match rest {
        "plugin/invoke" => {
            if req.method != "POST" {
                respond(stream, 405, "text/plain", b"POST required");
                return;
            }
            handle_plugin_invoke(stream, &inner, widget_id, &req.body);
            return;
        }
        "plugin/stream" => {
            if req.method != "GET" {
                respond(stream, 405, "text/plain", b"GET required");
                return;
            }
            handle_plugin_stream(stream, &inner, widget_id);
            return;
        }
        _ => {}
    }

    // ---- Classic file serving ----------------------------------------
    if req.method != "GET" {
        respond(stream, 405, "text/plain", b"Only GET supported");
        return;
    }

    let rel_path = if rest.is_empty() { "index.html" } else { rest };

    let base = match widgets_base() {
        Some(b) => b,
        None => {
            respond(stream, 500, "text/plain", b"No home dir");
            return;
        }
    };

    let file_path = base.join(widget_id).join(rel_path);

    // Security: canonicalize and verify it's inside the widgets dir.
    // (Preserves the regex + canonicalize + starts_with(base) guards.)
    let canonical = match file_path.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            respond(stream, 404, "text/plain", b"Not found");
            return;
        }
    };
    let base_canonical = match base.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            respond(stream, 500, "text/plain", b"Base dir missing");
            return;
        }
    };
    if !canonical.starts_with(&base_canonical) {
        respond(stream, 403, "text/plain", b"Path traversal blocked");
        return;
    }

    match std::fs::read(&canonical) {
        Ok(body) => {
            let mime = mime_for(&canonical.to_string_lossy());
            respond(stream, 200, mime, &body);
        }
        Err(_) => {
            respond(stream, 404, "text/plain", b"Not found");
        }
    }
}

#[derive(Debug, Deserialize)]
struct InvokeRequest {
    method: String,
    #[serde(default)]
    args: serde_json::Value,
    #[serde(default, rename = "requestId")]
    request_id: Option<String>,
}

fn handle_plugin_invoke(stream: TcpStream, inner: &Arc<ServerInner>, widget_id: &str, body: &[u8]) {
    // Ensure the manifest loads cleanly — this is what gates whether a plugin
    // exists at all. Permission enforcement lives in the bridge.
    if let Err(e) = inner.get_manifest(widget_id) {
        respond_json(
            stream,
            400,
            &serde_json::json!({ "ok": false, "error": e, "code": "manifest" }),
        );
        return;
    }

    let bridge = match inner.bridge.lock().ok().and_then(|g| g.clone()) {
        Some(b) => b,
        None => {
            respond_json(
                stream,
                503,
                &serde_json::json!({
                    "ok": false,
                    "error": "plugin host is not running",
                    "code": "no_host",
                }),
            );
            return;
        }
    };

    let req: InvokeRequest = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(e) => {
            respond_json(
                stream,
                400,
                &serde_json::json!({ "ok": false, "error": format!("bad envelope: {}", e) }),
            );
            return;
        }
    };
    let request_id = req.request_id.unwrap_or_default();

    match bridge.invoke(widget_id, &req.method, req.args, &request_id) {
        Ok(result) => respond_json(
            stream,
            200,
            &serde_json::json!({
                "ok": true,
                "requestId": request_id,
                "result": result,
            }),
        ),
        Err(e) => respond_json(
            stream,
            500,
            &serde_json::json!({
                "ok": false,
                "requestId": request_id,
                "error": e,
            }),
        ),
    }
}

fn handle_plugin_stream(mut stream: TcpStream, inner: &Arc<ServerInner>, widget_id: &str) {
    if let Err(e) = inner.get_manifest(widget_id) {
        respond_json(
            stream,
            400,
            &serde_json::json!({ "ok": false, "error": e, "code": "manifest" }),
        );
        return;
    }

    let bridge = match inner.bridge.lock().ok().and_then(|g| g.clone()) {
        Some(b) => b,
        None => {
            respond_json(
                stream,
                503,
                &serde_json::json!({
                    "ok": false,
                    "error": "plugin host is not running",
                }),
            );
            return;
        }
    };

    let rx = match bridge.subscribe(widget_id) {
        Ok(rx) => rx,
        Err(e) => {
            respond_json(stream, 500, &serde_json::json!({ "ok": false, "error": e }));
            return;
        }
    };

    // SSE response headers.
    let header = "HTTP/1.1 200 OK\r\n\
         Content-Type: text/event-stream\r\n\
         Cache-Control: no-cache\r\n\
         X-Accel-Buffering: no\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Connection: close\r\n\r\n";
    if stream.write_all(header.as_bytes()).is_err() {
        return;
    }
    // Clear the read timeout set by the accept loop — SSE connections stay
    // open indefinitely, and we're only writing, never reading.
    let _ = stream.set_read_timeout(None);
    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));

    // Initial comment line acts as a connection keep-alive primer and
    // flushes any intermediary buffers (curl, fetch, etc.).
    if stream.write_all(b": connected\n\n").is_err() {
        return;
    }

    // Pump: block on recv up to 15s, emit a comment heartbeat if the plugin
    // is idle, and tear down on any write failure (client disconnect).
    loop {
        match rx.recv_timeout(Duration::from_secs(15)) {
            Ok(frame) => {
                // `frame` is expected to be a single-line JSON payload; if a
                // plugin emits literal newlines we escape them by stripping
                // (SSE forbids embedded CR/LF in a single data: line).
                let safe = frame.replace('\r', "").replace('\n', " ");
                let chunk = format!("data: {}\n\n", safe);
                if stream.write_all(chunk.as_bytes()).is_err() {
                    return;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if stream.write_all(b": keepalive\n\n").is_err() {
                    return;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                // Plugin process closed its sender — emit a final crash frame
                // so the frontend's PluginErrorCard can surface the event.
                let frame = serde_json::json!({
                    "type": "host.crash",
                    "pluginId": widget_id,
                })
                .to_string();
                let _ = stream.write_all(format!("data: {}\n\n", frame).as_bytes());
                return;
            }
        }
    }
}

fn url_decode(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut chars = s.bytes();
    while let Some(b) = chars.next() {
        if b == b'%' {
            let hi = chars.next().unwrap_or(b'0');
            let lo = chars.next().unwrap_or(b'0');
            let hex = [hi, lo];
            if let Ok(s) = std::str::from_utf8(&hex) {
                if let Ok(val) = u8::from_str_radix(s, 16) {
                    result.push(val as char);
                    continue;
                }
            }
            result.push('%');
            result.push(hi as char);
            result.push(lo as char);
        } else {
            result.push(b as char);
        }
    }
    result
}

impl WidgetServer {
    pub fn start() -> Result<Self, String> {
        let listener =
            TcpListener::bind("127.0.0.1:0").map_err(|e| format!("widget server bind: {}", e))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();

        safe_eprintln!("[widget-server] Listening on 127.0.0.1:{}", port);

        let inner = Arc::new(ServerInner {
            port: AtomicU16::new(port),
            manifest_cache: Mutex::new(HashMap::new()),
            bridge: Mutex::new(None),
        });

        {
            let inner = Arc::clone(&inner);
            std::thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
                    let inner = Arc::clone(&inner);
                    std::thread::spawn(move || handle_request(stream, inner));
                }
            });
        }

        Ok(Self { inner })
    }

    pub fn port(&self) -> u16 {
        self.inner.port.load(Ordering::SeqCst)
    }

    /// Install the plugin host bridge. Intended to be called once, after the
    /// `PluginHost` has been constructed in `lib.rs` setup.
    #[allow(dead_code)] // Public API for plugin host wire-up; caller lands in a follow-up.
    pub fn set_plugin_host(&self, bridge: Arc<dyn PluginHostBridge>) {
        if let Ok(mut guard) = self.inner.bridge.lock() {
            *guard = Some(bridge);
        }
    }

    /// Load and cache a widget's manifest. Returns a fresh clone each call;
    /// the cache is invalidated when the `widget.json` mtime changes on disk.
    #[allow(dead_code)] // Public API consumed by consent flow in follow-up PR.
    pub fn load_manifest(&self, widget_id: &str) -> Result<PluginManifest, String> {
        if !is_valid_widget_id(widget_id) {
            return Err("invalid widget id".to_string());
        }
        self.inner.get_manifest(widget_id)
    }

    /// Read the manifest and return `(manifest, raw_hash)`, used by the
    /// consent flow so the frontend can compare against `.approved.json`.
    #[allow(dead_code)] // Public API consumed by consent flow in follow-up PR.
    pub fn load_manifest_with_hash(
        &self,
        widget_id: &str,
    ) -> Result<(PluginManifest, String), String> {
        if !is_valid_widget_id(widget_id) {
            return Err("invalid widget id".to_string());
        }
        let (state, _raw) = load_manifest_from_disk(widget_id)?;
        // Refresh the cache entry since we've just re-read from disk.
        if let Ok(mut cache) = self.inner.manifest_cache.lock() {
            cache.insert(widget_id.to_string(), state.clone());
        }
        Ok((state.manifest, state.raw_hash))
    }
}
