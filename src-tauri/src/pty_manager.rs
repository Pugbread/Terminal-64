use crate::types::*;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

pub type TerminalId = String;

struct PtyInstance {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    #[allow(dead_code)]
    child: Box<dyn portable_pty::Child + Send>,
}

pub struct PtyManager {
    instances: Mutex<HashMap<TerminalId, PtyInstance>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            instances: Mutex::new(HashMap::new()),
        }
    }

    pub fn create(
        &self,
        app_handle: &AppHandle,
        req: CreateTerminalRequest,
    ) -> Result<(), String> {
        let cols = req.cols.unwrap_or(80);
        let rows = req.rows.unwrap_or(24);

        safe_eprintln!("[pty] Creating terminal id={} cols={} rows={}", req.id, cols, rows);

        // Prevent double-creation (React StrictMode calls this twice)
        {
            let instances = self.instances.lock().map_err(|e| e.to_string())?;
            if instances.contains_key(&req.id) {
                safe_eprintln!("[pty] Terminal {} already exists, skipping", req.id);
                return Ok(());
            }
        }

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| {
                safe_eprintln!("[pty] Failed to open pty: {}", e);
                e.to_string()
            })?;

        let shell = req.shell.unwrap_or_else(|| {
            if cfg!(target_os = "windows") {
                "powershell.exe".to_string()
            } else {
                std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
            }
        });
        safe_eprintln!("[pty] Spawning shell: {}", shell);

        let mut cmd = CommandBuilder::new(&shell);
        cmd.env("TERM", "xterm-256color");
        if let Some(cwd) = &req.cwd {
            cmd.cwd(cwd);
        }

        let child = pair.slave.spawn_command(cmd).map_err(|e| {
            safe_eprintln!("[pty] Failed to spawn command: {}", e);
            e.to_string()
        })?;
        safe_eprintln!("[pty] Shell spawned successfully");

        let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

        // Start reader thread
        let terminal_id = req.id.clone();
        let handle = app_handle.clone();
        std::thread::spawn(move || {
            Self::reader_loop(handle, terminal_id, reader);
        });

        let instance = PtyInstance {
            writer,
            master: pair.master,
            child,
        };

        self.instances
            .lock()
            .map_err(|e| e.to_string())?
            .insert(req.id, instance);

        Ok(())
    }

    fn reader_loop(
        app_handle: AppHandle,
        terminal_id: String,
        mut reader: Box<dyn Read + Send>,
    ) {
        safe_eprintln!("[pty] Reader thread started for {}", terminal_id);
        let mut buf = [0u8; 4096];
        let mut total_bytes = 0usize;
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    safe_eprintln!("[pty] Reader got EOF for {}", terminal_id);
                    break;
                }
                Ok(n) => {
                    total_bytes += n;
                    if total_bytes == n {
                        safe_eprintln!("[pty] First read: {} bytes for {}", n, terminal_id);
                    }
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let result = app_handle.emit(
                        "terminal-output",
                        TerminalOutput {
                            id: terminal_id.clone(),
                            data,
                        },
                    );
                    if let Err(e) = result {
                        safe_eprintln!("[pty] Emit error: {} for {}", e, terminal_id);
                    }
                }
                Err(e) => {
                    safe_eprintln!("[pty] Reader error: {} for {}", e, terminal_id);
                    break;
                }
            }
        }
        let _ = app_handle.emit(
            "terminal-exit",
            TerminalExit {
                id: terminal_id,
                code: None,
            },
        );
    }

    pub fn write(&self, id: &str, data: &str) -> Result<(), String> {
        let mut instances = self.instances.lock().map_err(|e| e.to_string())?;
        let instance = instances.get_mut(id).ok_or("Terminal not found")?;
        instance
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        instance.writer.flush().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let instances = self.instances.lock().map_err(|e| e.to_string())?;
        let instance = instances.get(id).ok_or("Terminal not found")?;
        instance
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())
    }

    pub fn close(&self, id: &str) -> Result<(), String> {
        let mut instances = self.instances.lock().map_err(|e| e.to_string())?;
        if let Some(mut instance) = instances.remove(id) {
            let _ = instance.child.kill();
            let _ = instance.child.wait();
        }
        Ok(())
    }
}
