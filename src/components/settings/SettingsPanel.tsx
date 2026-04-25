import { useState, useEffect, useRef } from "react";
import { useThemeStore } from "../../stores/themeStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { startDiscordBot, stopDiscordBot, discordBotStatus, renameDiscordSession, discordCleanupOrphaned, generateTheme, onThemeGenChunk, onThemeGenDone, startOpenwolfDaemon, stopOpenwolfDaemon, openwolfDaemonStatus } from "../../lib/tauriApi";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import "./SettingsPanel.css";

import { FONT_OPTIONS, fontStack } from "../../lib/fonts";
import type { ThemeDefinition } from "../../lib/types";
import { useCanvasStore } from "../../stores/canvasStore";
import { useClaudeStore, STORAGE_KEY as CLAUDE_STORAGE_KEY } from "../../stores/claudeStore";
import { useVoiceStore } from "../../stores/voiceStore";
import { downloadVoiceModel, voiceModelsStatus, onVoiceDownloadProgress, setVoiceSensitivity as setVoiceSensitivityBackend, type VoiceModelKind } from "../../lib/voiceApi";

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      className={`sp-toggle ${checked ? "sp-toggle--on" : ""}`}
      onClick={() => onChange(!checked)}
      role="switch"
      aria-checked={checked}
    >
      <span className="sp-toggle-knob" />
    </button>
  );
}

function Section({ label, icon, children, defaultOpen = true }: { label: string; icon: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="sp-section">
      <button className="sp-section-header" onClick={() => setOpen((v) => !v)}>
        <span className="sp-section-icon">{icon}</span>
        <span className="sp-section-label">{label}</span>
        <span className={`sp-section-chevron ${open ? "sp-section-chevron--open" : ""}`}>&#x25B8;</span>
      </button>
      {open && <div className="sp-section-body">{children}</div>}
    </div>
  );
}

export default function SettingsPanel({ isOpen, onClose }: SettingsPanelProps) {
  const themes = useThemeStore((s) => s.themes);
  const currentThemeName = useThemeStore((s) => s.currentThemeName);
  const setTheme = useThemeStore((s) => s.setTheme);
  const bgAlpha = useThemeStore((s) => s.bgAlpha);
  const setBgAlpha = useThemeStore((s) => s.setBgAlpha);

  const quickPastes = useSettingsStore((s) => s.quickPastes);
  const setSetting = useSettingsStore((s) => s.set);
  const addQuickPaste = useSettingsStore((s) => s.addQuickPaste);
  const removeQuickPaste = useSettingsStore((s) => s.removeQuickPaste);
  const snapToGrid = useSettingsStore((s) => s.snapToGrid);

  const [newCommand, setNewCommand] = useState("");

  // Party Mode
  const partyEnabled = useSettingsStore((s) => s.partyModeEnabled);
  const partyEdgeGlow = useSettingsStore((s) => s.partyEdgeGlow);
  const partyEqualizer = useSettingsStore((s) => s.partyEqualizer);
  const partyBackgroundPulse = useSettingsStore((s) => s.partyBackgroundPulse);
  const partyColorCycling = useSettingsStore((s) => s.partyColorCycling);
  const partyEqualizerDance = useSettingsStore((s) => s.partyEqualizerDance);
  const partyEqualizerRotation = useSettingsStore((s) => s.partyEqualizerRotation);
  const partyIntensity = useSettingsStore((s) => s.partyIntensity);

  const addTheme = useThemeStore((s) => s.addTheme);

  // Background
  const backgroundImage = useSettingsStore((s) => s.backgroundImage);
  const backgroundOpacity = useSettingsStore((s) => s.backgroundOpacity);
  const showGrid = useSettingsStore((s) => s.showGrid);

  // Auto-Compact
  const autoCompactEnabled = useSettingsStore((s) => s.autoCompactEnabled);
  const autoCompactThreshold = useSettingsStore((s) => s.autoCompactThreshold);

  // Claude window defaults
  const claudeDefaultPermMode = useSettingsStore((s) => s.claudeDefaultPermMode);

  // OpenWolf
  const openwolfEnabled = useSettingsStore((s) => s.openwolfEnabled);
  const openwolfAutoInit = useSettingsStore((s) => s.openwolfAutoInit);
  const openwolfDaemon = useSettingsStore((s) => s.openwolfDaemon);
  const openwolfDesignQC = useSettingsStore((s) => s.openwolfDesignQC);
  const [wolfDaemonRunning, setWolfDaemonRunning] = useState(false);
  const [wolfDaemonLoading, setWolfDaemonLoading] = useState(false);

  const wolfCwd = useClaudeStore((s) => {
    for (const sid in s.sessions) {
      const sess = s.sessions[sid];
      if (sess?.cwd) return sess.cwd;
    }
    return "";
  });

  // Voice Control
  const voiceEnabled = useVoiceStore((s) => s.enabled);
  const voiceState = useVoiceStore((s) => s.state);
  const voiceError = useVoiceStore((s) => s.error);
  const voiceModels = useVoiceStore((s) => s.modelsDownloaded);
  const setVoiceEnabled = useVoiceStore((s) => s.setEnabled);
  const setVoiceModelsDownloaded = useVoiceStore((s) => s.setModelsDownloaded);
  const voiceWakeWord = useVoiceStore((s) => s.wakeWord);
  const setVoiceWakeWord = useVoiceStore((s) => s.setWakeWord);
  const [voiceProgress, setVoiceProgress] = useState<Record<VoiceModelKind, number>>({ wake: 0, command: 0, dictation: 0 });
  const [voiceDownloading, setVoiceDownloading] = useState<Record<VoiceModelKind, boolean>>({ wake: false, command: false, dictation: false });
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
  const [voiceSensitivity, setVoiceSensitivity] = useState<number>(() => {
    const v = Number(localStorage.getItem("terminal64-voice-sensitivity"));
    return Number.isFinite(v) && v > 0 ? v : 0.5;
  });
  const [micDeviceId, setMicDeviceId] = useState<string>(() => localStorage.getItem("terminal64-voice-mic-device") || "default");

  const discordToken = useSettingsStore((s) => s.discordBotToken);
  const discordServerId = useSettingsStore((s) => s.discordServerId);
  const [botConnected, setBotConnected] = useState(false);
  const [botLoading, setBotLoading] = useState(false);

  // Quick Theme
  const [themePrompt, setThemePrompt] = useState("");
  const [themeGenerating, setThemeGenerating] = useState(false);
  const [themeError, setThemeError] = useState<string | null>(null);
  const themeGenIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      discordBotStatus().then(setBotConnected).catch(() => {});
      openwolfDaemonStatus().then(setWolfDaemonRunning).catch(() => {});
      voiceModelsStatus()
        .then((m) => setVoiceModelsDownloaded(m))
        .catch(() => {});
      if (navigator.mediaDevices?.enumerateDevices) {
        navigator.mediaDevices.enumerateDevices()
          .then((all) => setMicDevices(all.filter((d) => d.kind === "audioinput")))
          .catch(() => {});
      }
    }
  }, [isOpen, setVoiceModelsDownloaded]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    onVoiceDownloadProgress((p) => {
      setVoiceProgress((prev) => ({ ...prev, [p.kind]: p.progress }));
      if (p.progress >= 1) {
        setVoiceDownloading((prev) => ({ ...prev, [p.kind]: false }));
      }
    }).then((un) => { unlisten = un; }).catch(() => {});
    return () => { if (unlisten) unlisten(); };
  }, []);

  const handleDownloadVoiceModel = async (kind: VoiceModelKind) => {
    setVoiceDownloading((prev) => ({ ...prev, [kind]: true }));
    setVoiceProgress((prev) => ({ ...prev, [kind]: 0 }));
    try {
      await downloadVoiceModel(kind);
    } catch (err) {
      alert(`Failed to download ${kind} model: ${err}`);
      setVoiceDownloading((prev) => ({ ...prev, [kind]: false }));
    }
  };

  const voiceModelMeta: { kind: VoiceModelKind; label: string; sizeMB: number }[] = [
    { kind: "wake", label: "Wake Word (Jarvis)", sizeMB: 2 },
    { kind: "command", label: "Command STT (Moonshine)", sizeMB: 40 },
    { kind: "dictation", label: "Dictation (whisper.cpp)", sizeMB: 80 },
  ];

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const opacityPercent = Math.round(bgAlpha * 100);

  const handleAddQuickPaste = () => {
    if (!newCommand.trim()) return;
    addQuickPaste(newCommand.trim());
    setNewCommand("");
  };

  const handleGenerateTheme = async () => {
    if (!themePrompt.trim() || themeGenerating) return;
    setThemeError(null);
    setThemeGenerating(true);

    const unlistenChunk = await onThemeGenChunk(() => {});
    const unlistenDone = await onThemeGenDone((payload) => {
      if (!themeGenIdRef.current || payload.id !== themeGenIdRef.current) return;

      try {
        if (!payload.text.trim()) {
          throw new Error("empty response from claude — check claude CLI auth");
        }
        // Strip markdown fences if Haiku wrapped the JSON in one
        let json = payload.text.trim();
        const fenceMatch = json.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fenceMatch && fenceMatch[1]) json = fenceMatch[1].trim();
        const theme = JSON.parse(json) as ThemeDefinition;

        const requiredUi = ["bg","bgSecondary","bgTertiary","fg","fgSecondary","fgMuted","border","accent","accentHover","tabActiveBg","tabInactiveBg","tabActiveFg","tabInactiveFg","tabHoverBg","scrollbar","scrollbarHover"] as const;
        if (!theme.name || !theme.ui || !theme.terminal) {
          throw new Error("response missing name/ui/terminal fields");
        }
        const missing = requiredUi.filter((k) => !theme.ui[k]);
        if (missing.length > 0) {
          throw new Error(`theme.ui missing fields: ${missing.join(", ")}`);
        }

        addTheme(theme);
        setTheme(theme.name);
        setSetting({ theme: theme.name });
        setThemePrompt("");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[quick-theme] Failed:", msg, "\nResponse:", payload.text);
        setThemeError(msg);
      }
      setThemeGenerating(false);
      themeGenIdRef.current = null;
      unlistenChunk();
      unlistenDone();
    });

    try {
      const genId = await generateTheme(themePrompt.trim());
      themeGenIdRef.current = genId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[quick-theme] Failed to start generation:", msg);
      setThemeError(`failed to start: ${msg}`);
      setThemeGenerating(false);
      unlistenChunk();
      unlistenDone();
    }
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <span className="settings-title">Settings</span>
          <button className="settings-close" onClick={onClose}>
            <svg width="10" height="10" viewBox="0 0 10 10">
              <path d="M1 1L9 9M9 1L1 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="settings-body">
          {/* Appearance */}
          <Section label="Appearance" icon="◑">
            <div className="sp-row">
              <label className="sp-label">Theme</label>
              <select
                className="sp-select"
                value={currentThemeName}
                onChange={(e) => { setTheme(e.target.value); setSetting({ theme: e.target.value }); }}
              >
                {themes.map((t) => (
                  <option key={t.name} value={t.name}>{t.name}</option>
                ))}
              </select>
            </div>

            <div className="sp-row">
              <label className="sp-label">Chat Font</label>
              <select
                className="sp-select"
                value={useSettingsStore.getState().claudeFont || "system"}
                onChange={(e) => {
                  setSetting({ claudeFont: e.target.value });
                  document.documentElement.style.setProperty("--claude-font", fontStack(e.target.value));
                }}
              >
                {FONT_OPTIONS.map((f) => (
                  <option key={f.id} value={f.id}>{f.label}</option>
                ))}
              </select>
            </div>

            <div className="sp-row sp-row--col">
              <div className="sp-row">
                <label className="sp-label">Opacity</label>
                <span className="sp-value">{opacityPercent}%</span>
              </div>
              <input
                type="range"
                className="sp-range"
                min={20}
                max={100}
                value={opacityPercent}
                onChange={(e) => {
                  const a = Number(e.target.value) / 100;
                  setBgAlpha(a);
                  setSetting({ bgAlpha: a });
                }}
              />
            </div>

            <div className="sp-row sp-row--col">
              <label className="sp-label">Quick Theme</label>
              <span className="sp-hint">Describe a vibe — Haiku generates a theme</span>
              <div className="sp-qp-add">
                <input
                  className="sp-input"
                  placeholder="e.g. ocean blue retro"
                  value={themePrompt}
                  onChange={(e) => setThemePrompt(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleGenerateTheme()}
                  disabled={themeGenerating}
                />
                <button
                  className="sp-btn"
                  onClick={handleGenerateTheme}
                  disabled={!themePrompt.trim() || themeGenerating}
                >
                  {themeGenerating ? "..." : "Go"}
                </button>
              </div>
              {themeError && (
                <span className="sp-hint" style={{ color: "#f38ba8" }}>
                  Theme generation failed: {themeError}
                </span>
              )}
            </div>
          </Section>

          {/* Canvas */}
          <Section label="Canvas" icon="⊞">
            <div className="sp-row">
              <label className="sp-label">
                Snap to Grid
                <span className="sp-hint-inline">Edge &amp; size snapping</span>
              </label>
              <Toggle checked={snapToGrid} onChange={(v) => setSetting({ snapToGrid: v })} />
            </div>
          </Section>

          {/* Background */}
          <Section label="Background" icon="▦">
            <div className="sp-row">
              <label className="sp-label">Show Grid</label>
              <Toggle checked={showGrid} onChange={(v) => setSetting({ showGrid: v })} />
            </div>

            <div className="sp-row sp-row--col">
              <label className="sp-label">Background Image</label>
              <div className="sp-bg-picker">
                <button
                  className="sp-btn"
                  onClick={async () => {
                    const file = await openDialog({
                      title: "Choose background image",
                      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"] }],
                    });
                    if (file) setSetting({ backgroundImage: file });
                  }}
                >
                  Choose...
                </button>
                {backgroundImage && (
                  <button className="sp-btn sp-btn--danger sp-btn--small" onClick={() => setSetting({ backgroundImage: "" })}>
                    Clear
                  </button>
                )}
              </div>
              {backgroundImage && (
                <span className="sp-hint sp-bg-path">{backgroundImage.split(/[/\\]/).pop()}</span>
              )}
            </div>

            {backgroundImage && (
              <div className="sp-row sp-row--col">
                <div className="sp-row">
                  <label className="sp-label">Image Opacity</label>
                  <span className="sp-value">{Math.round(backgroundOpacity * 100)}%</span>
                </div>
                <input
                  type="range"
                  className="sp-range"
                  min={1}
                  max={100}
                  value={Math.round(backgroundOpacity * 100)}
                  onChange={(e) => setSetting({ backgroundOpacity: Number(e.target.value) / 100 })}
                />
              </div>
            )}
          </Section>

          {/* Claude */}
          <Section label="Claude" icon="⬡">
            <div className="sp-row">
              <label className="sp-label">
                New Window Permission Mode
                <span className="sp-hint-inline">Mode each new Claude window starts in</span>
              </label>
              <select
                className="sp-select"
                value={claudeDefaultPermMode}
                onChange={(e) => setSetting({ claudeDefaultPermMode: e.target.value })}
              >
                <option value="">Remember last used</option>
                <option value="default">Default (ask)</option>
                <option value="plan">Plan</option>
                <option value="auto">Auto</option>
                <option value="accept_edits">Accept Edits</option>
                <option value="bypass_all">YOLO (bypass)</option>
              </select>
            </div>

            <div className="sp-row">
              <label className="sp-label">
                Auto-Compact
                <span className="sp-hint-inline">Send /compact when context is high</span>
              </label>
              <Toggle checked={autoCompactEnabled} onChange={(v) => setSetting({ autoCompactEnabled: v })} />
            </div>

            {autoCompactEnabled && (
              <div className="sp-sub">
                <div className="sp-row sp-row--col">
                  <div className="sp-row">
                    <label className="sp-label">Threshold</label>
                    <span className="sp-value">{autoCompactThreshold}%</span>
                  </div>
                  <input
                    type="range"
                    className="sp-range"
                    min={10}
                    max={95}
                    step={5}
                    value={autoCompactThreshold}
                    onChange={(e) => setSetting({ autoCompactThreshold: Number(e.target.value) })}
                  />
                  <span className="sp-hint">Triggers /compact when context usage exceeds this percentage</span>
                </div>
              </div>
            )}
          </Section>

          {/* OpenWolf */}
          <Section label="OpenWolf" icon="◈" defaultOpen={false}>
            <div className="sp-row">
              <label className="sp-label">
                Enabled
                <span className="sp-hint-inline">Project intelligence via .wolf/</span>
              </label>
              <Toggle checked={openwolfEnabled} onChange={(v) => setSetting({ openwolfEnabled: v })} />
            </div>

            {openwolfEnabled && (
              <div className="sp-sub">
                <div className="sp-row">
                  <label className="sp-label">
                    Auto-Init
                    <span className="sp-hint-inline">Create .wolf/ on session start</span>
                  </label>
                  <Toggle checked={openwolfAutoInit} onChange={(v) => setSetting({ openwolfAutoInit: v })} />
                </div>

                <div className="sp-row">
                  <label className="sp-label">
                    Design QC Hooks
                    <span className="sp-hint-inline">Pre/PostToolUse quality checks</span>
                  </label>
                  <Toggle checked={openwolfDesignQC} onChange={(v) => setSetting({ openwolfDesignQC: v })} />
                </div>

                <div className="sp-row">
                  <label className="sp-label">
                    Daemon
                    <span className={`sp-dot ${wolfDaemonRunning ? "sp-dot--on" : ""}`} />
                  </label>
                  <span className="sp-value">{wolfDaemonRunning ? "Running" : "Stopped"}</span>
                </div>

                <button
                  className={`sp-btn sp-btn--wide ${wolfDaemonRunning ? "sp-btn--danger" : ""}`}
                  disabled={wolfDaemonLoading || !wolfCwd}
                  title={!wolfCwd ? "Open a Claude session first so the daemon knows which project to watch" : ""}
                  onClick={async () => {
                    setWolfDaemonLoading(true);
                    try {
                      if (wolfDaemonRunning) {
                        await stopOpenwolfDaemon(wolfCwd);
                        setWolfDaemonRunning(false);
                        setSetting({ openwolfDaemon: false });
                      } else {
                        await startOpenwolfDaemon(wolfCwd);
                        setWolfDaemonRunning(true);
                        setSetting({ openwolfDaemon: true });
                      }
                    } catch (err) {
                      alert(String(err));
                    } finally {
                      setWolfDaemonLoading(false);
                    }
                  }}
                >
                  {wolfDaemonLoading ? "..." : wolfDaemonRunning ? "Stop Daemon" : "Start Daemon"}
                </button>
                <span className="sp-hint">Background daemon for continuous project analysis</span>
              </div>
            )}
          </Section>

          {/* Quick Pastes */}
          <Section label="Quick Pastes" icon="⎘" defaultOpen={false}>
            <span className="sp-hint">Saved commands for the command palette (Ctrl+Shift+P)</span>

            {quickPastes.length > 0 && (
              <div className="sp-qp-list">
                {quickPastes.map((qp) => (
                  <div key={qp.id} className="sp-qp-item">
                    <span className="sp-qp-text" title={qp.command}>{qp.command}</span>
                    <button className="sp-qp-del" onClick={() => removeQuickPaste(qp.id)} title="Remove">×</button>
                  </div>
                ))}
              </div>
            )}

            <div className="sp-qp-add">
              <input
                className="sp-input"
                placeholder="Command to save..."
                value={newCommand}
                onChange={(e) => setNewCommand(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddQuickPaste()}
              />
              <button className="sp-btn" onClick={handleAddQuickPaste} disabled={!newCommand.trim()}>Add</button>
            </div>
          </Section>

          {/* Party Mode */}
          <Section label="Party Mode" icon="♫" defaultOpen={false}>
            <div className="sp-row">
              <label className="sp-label">
                Enabled
                <span className={`sp-dot ${partyEnabled ? "sp-dot--on" : ""}`} />
              </label>
              <Toggle checked={partyEnabled} onChange={(v) => setSetting({ partyModeEnabled: v })} />
            </div>

            {partyEnabled && (
              <div className="sp-sub">
                <div className="sp-row sp-row--col">
                  <div className="sp-row">
                    <label className="sp-label">Intensity</label>
                    <span className="sp-value">{Math.round(partyIntensity * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    className="sp-range"
                    min={10}
                    max={100}
                    value={Math.round(partyIntensity * 100)}
                    onChange={(e) => setSetting({ partyIntensity: Number(e.target.value) / 100 })}
                  />
                </div>
                <div className="sp-row">
                  <label className="sp-label">Edge Glow</label>
                  <Toggle checked={partyEdgeGlow} onChange={(v) => setSetting({ partyEdgeGlow: v })} />
                </div>
                <div className="sp-row">
                  <label className="sp-label">Equalizer Bars</label>
                  <Toggle checked={partyEqualizer} onChange={(v) => setSetting({ partyEqualizer: v })} />
                </div>
                <div className="sp-row">
                  <label className="sp-label">Background Pulse</label>
                  <Toggle checked={partyBackgroundPulse} onChange={(v) => setSetting({ partyBackgroundPulse: v })} />
                </div>
                <div className="sp-row">
                  <label className="sp-label">Color Cycling</label>
                  <Toggle checked={partyColorCycling} onChange={(v) => setSetting({ partyColorCycling: v })} />
                </div>
                <div className="sp-row">
                  <label className="sp-label">Equalizer Dance</label>
                  <Toggle checked={partyEqualizerDance} onChange={(v) => setSetting({ partyEqualizerDance: v })} />
                </div>
                <div className="sp-row">
                  <label className="sp-label">Equalizer Rotation</label>
                  <Toggle checked={partyEqualizerRotation} onChange={(v) => setSetting({ partyEqualizerRotation: v })} />
                </div>
              </div>
            )}
          </Section>

          {/* Voice Control */}
          <Section label="Voice Control" icon="🎤" defaultOpen={false}>
            <div className="sp-row">
              <label className="sp-label">
                Enabled
                <span className={`sp-dot ${voiceEnabled ? "sp-dot--on" : ""}`} />
                <span className="sp-hint-inline">Always-on wake word ("Jarvis")</span>
              </label>
              <Toggle checked={voiceEnabled} onChange={(v) => setVoiceEnabled(v)} />
            </div>

            {voiceEnabled && (
              <div className="sp-sub">
                <div className="sp-row">
                  <label className="sp-label">Status</label>
                  <span className="sp-value" style={voiceError ? { color: "#f38ba8" } : undefined}>
                    {voiceError ? `Error: ${voiceError}` : voiceState === "listening" ? "Listening for 'Jarvis'" : voiceState === "dictating" ? "Dictating" : "Idle"}
                  </span>
                </div>

                <div className="sp-row sp-row--col">
                  <label className="sp-label">Wake Word</label>
                  <select
                    className="sp-select"
                    value={voiceWakeWord}
                    onChange={(e) => setVoiceWakeWord(e.target.value as "jarvis" | "t64")}
                  >
                    <option value="jarvis">Hey Jarvis (stock)</option>
                    <option value="t64">T Six Four (custom, requires training)</option>
                  </select>
                  <span className="sp-hint">
                    {voiceWakeWord === "t64"
                      ? "Drop t_six_four.onnx into ~/.terminal64/stt-models/wake/t64/ — see docs/wake-training.md. Falls back to Jarvis if missing."
                      : "Built-in openWakeWord model."}
                  </span>
                </div>

                <div className="sp-row sp-row--col">
                  <div className="sp-row">
                    <label className="sp-label">Wake Sensitivity</label>
                    <span className="sp-value">{Math.round(voiceSensitivity * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    className="sp-range"
                    min={10}
                    max={100}
                    value={Math.round(voiceSensitivity * 100)}
                    onChange={(e) => {
                      const v = Number(e.target.value) / 100;
                      setVoiceSensitivity(v);
                      localStorage.setItem("terminal64-voice-sensitivity", String(v));
                      // Push live to the backend so the change takes effect
                      // without restarting voice. Ignored if voice is off.
                      void setVoiceSensitivityBackend(v).catch(() => {});
                    }}
                  />
                  <span className="sp-hint">Higher = more triggers, but more false positives</span>
                </div>

                <div className="sp-row sp-row--col">
                  <label className="sp-label">Microphone</label>
                  <select
                    className="sp-select"
                    value={micDeviceId}
                    onChange={(e) => {
                      setMicDeviceId(e.target.value);
                      localStorage.setItem("terminal64-voice-mic-device", e.target.value);
                    }}
                  >
                    <option value="default">System Default</option>
                    {micDevices.map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label || `Microphone ${d.deviceId.slice(0, 6)}`}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            <div className="sp-sub">
              <span className="sp-hint">Models (downloaded to ~/.terminal64/stt-models/)</span>
              {voiceModelMeta.map((m) => {
                const downloaded = voiceModels[m.kind];
                const downloading = voiceDownloading[m.kind];
                const progress = voiceProgress[m.kind];
                return (
                  <div key={m.kind} className="sp-row" style={{ gap: 8 }}>
                    <label className="sp-label" style={{ flex: 1 }}>
                      {m.label}
                      <span className={`sp-dot ${downloaded ? "sp-dot--on" : ""}`} />
                      <span className="sp-hint-inline">~{m.sizeMB} MB</span>
                    </label>
                    <button
                      className="sp-btn sp-btn--small"
                      disabled={downloading || downloaded}
                      onClick={() => handleDownloadVoiceModel(m.kind)}
                    >
                      {downloaded ? "Installed" : downloading ? `${Math.round(progress * 100)}%` : "Download"}
                    </button>
                  </div>
                );
              })}
            </div>

            <span className="sp-hint">Toggle with Ctrl+Shift+V. Commands: "Jarvis send", "Jarvis exit", "Jarvis rewrite", "Jarvis switch to &lt;session&gt;".</span>
          </Section>

          {/* Discord */}
          <Section label="Discord Bot" icon="⊕" defaultOpen={false}>
            <div className="sp-row">
              <label className="sp-label">
                Status
                <span className={`sp-dot ${botConnected ? "sp-dot--on" : ""}`} />
              </label>
              <span className="sp-value">{botConnected ? "Connected" : "Disconnected"}</span>
            </div>

            <input
              type="password"
              className="sp-input"
              placeholder="Bot token"
              value={discordToken}
              onChange={(e) => setSetting({ discordBotToken: e.target.value })}
            />
            <input
              className="sp-input"
              placeholder="Server ID"
              value={discordServerId}
              onChange={(e) => setSetting({ discordServerId: e.target.value })}
            />
            <span className="sp-hint">Named sessions sync to Discord channels for remote access.</span>

            <button
              className={`sp-btn sp-btn--wide ${botConnected ? "sp-btn--danger" : ""}`}
              disabled={botLoading || (!botConnected && (!discordToken || !discordServerId))}
              onClick={async () => {
                setBotLoading(true);
                try {
                  if (botConnected) {
                    await stopDiscordBot();
                    setBotConnected(false);
                  } else {
                    await startDiscordBot(discordToken, discordServerId);
                    setBotConnected(true);
                    // Wait for gateway to be ready, then link all open Claude panels
                    await new Promise((r) => setTimeout(r, 2000));
                    const terminals = useCanvasStore.getState().terminals;
                    // Canvas `t.title` is a stale snapshot; read the live name from claudeStore.
                    let claudeSaved: Record<string, { name?: string; cwd?: string }> = {};
                    try {
                      const raw = localStorage.getItem(CLAUDE_STORAGE_KEY);
                      if (raw) claudeSaved = JSON.parse(raw);
                    } catch (err) {
                      console.warn("[discord] Failed to read claude store:", err);
                    }
                    const claudeSessions = useClaudeStore.getState().sessions;
                    for (const t of terminals) {
                      if (t.panelType !== "claude") continue;
                      const liveName = claudeSessions[t.terminalId]?.name;
                      const savedName = claudeSaved[t.terminalId]?.name;
                      const name = (liveName || savedName || "").trim();
                      if (!name) continue;
                      const cwd = claudeSessions[t.terminalId]?.cwd
                        || claudeSaved[t.terminalId]?.cwd
                        || t.cwd
                        || "";
                      try {
                        await renameDiscordSession(t.terminalId, name, cwd);
                      } catch (err) {
                        console.warn("[discord] Failed to rename/link session:", t.terminalId, err);
                        await new Promise((r) => setTimeout(r, 1500));
                        await renameDiscordSession(t.terminalId, name, cwd).catch(() => {});
                      }
                      await new Promise((r) => setTimeout(r, 500));
                    }
                    const activeIds = useCanvasStore.getState().terminals
                      .filter((x) => x.panelType === "claude")
                      .map((x) => x.terminalId);
                    discordCleanupOrphaned(activeIds).catch(() => {});
                  }
                } catch (err) {
                  alert(String(err));
                } finally {
                  setBotLoading(false);
                }
              }}
            >
              {botLoading ? "..." : botConnected ? "Disconnect" : "Connect"}
            </button>
          </Section>
        </div>
      </div>
    </div>
  );
}
