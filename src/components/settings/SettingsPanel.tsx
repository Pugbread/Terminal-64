import { useState, useEffect, useRef } from "react";
import { useThemeStore } from "../../stores/themeStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { startDiscordBot, stopDiscordBot, discordBotStatus, generateTheme, onThemeGenChunk, onThemeGenDone } from "../../lib/tauriApi";
import "./SettingsPanel.css";

import { FONT_OPTIONS, fontStack } from "../../lib/fonts";
import { ThemeDefinition } from "../../lib/types";

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

  const discordToken = useSettingsStore((s) => s.discordBotToken);
  const discordServerId = useSettingsStore((s) => s.discordServerId);
  const [botConnected, setBotConnected] = useState(false);
  const [botLoading, setBotLoading] = useState(false);

  // Quick Theme
  const [themePrompt, setThemePrompt] = useState("");
  const [themeGenerating, setThemeGenerating] = useState(false);
  const themeGenIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      discordBotStatus().then(setBotConnected).catch(() => {});
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const opacityPercent = Math.round(bgAlpha * 100);

  const handleAddQuickPaste = () => {
    if (!newCommand.trim()) return;
    addQuickPaste(newCommand.trim());
    setNewCommand("");
  };

  const handleGenerateTheme = async () => {
    if (!themePrompt.trim() || themeGenerating) return;
    setThemeGenerating(true);

    const unlistenChunk = await onThemeGenChunk(() => {});
    const unlistenDone = await onThemeGenDone((payload) => {
      if (themeGenIdRef.current && payload.id === themeGenIdRef.current) {
        try {
          // Extract JSON from response (may have markdown fences)
          let json = payload.text.trim();
          const fenceMatch = json.match(/```(?:json)?\s*([\s\S]*?)```/);
          if (fenceMatch) json = fenceMatch[1].trim();
          const theme = JSON.parse(json) as ThemeDefinition;
          if (theme.name && theme.ui && theme.terminal) {
            addTheme(theme);
            setTheme(theme.name);
            setSetting({ theme: theme.name });
            setThemePrompt("");
          }
        } catch (err) {
          console.error("[quick-theme] Failed to parse theme JSON:", err);
        }
        setThemeGenerating(false);
        themeGenIdRef.current = null;
        unlistenChunk();
        unlistenDone();
      }
    });

    try {
      const genId = await generateTheme(themePrompt.trim());
      themeGenIdRef.current = genId;
    } catch (err) {
      console.error("[quick-theme] Failed to start generation:", err);
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

          {/* Quick Pastes */}
          <Section label="Quick Pastes" icon="⎘" defaultOpen={false}>
            <span className="sp-hint">Saved commands for the command palette (Ctrl+Shift+P)</span>

            {quickPastes.length > 0 && (
              <div className="sp-qp-list">
                {quickPastes.map((qp) => (
                  <div key={qp.id} className="sp-qp-item">
                    <span className="sp-qp-text">{qp.command}</span>
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
