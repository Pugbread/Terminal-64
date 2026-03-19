import { useState } from "react";
import { useThemeStore } from "../../stores/themeStore";
import { useSettingsStore } from "../../stores/settingsStore";
import "./SettingsPanel.css";

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function SettingsPanel({ isOpen, onClose }: SettingsPanelProps) {
  const themes = useThemeStore((s) => s.themes);
  const currentThemeName = useThemeStore((s) => s.currentThemeName);
  const setTheme = useThemeStore((s) => s.setTheme);
  const bgAlpha = useThemeStore((s) => s.bgAlpha);
  const setBgAlpha = useThemeStore((s) => s.setBgAlpha);

  const apiKey = useSettingsStore((s) => s.openaiApiKey);
  const model = useSettingsStore((s) => s.openaiModel);
  const quickPastes = useSettingsStore((s) => s.quickPastes);
  const setSetting = useSettingsStore((s) => s.set);
  const addQuickPaste = useSettingsStore((s) => s.addQuickPaste);
  const removeQuickPaste = useSettingsStore((s) => s.removeQuickPaste);

  const [newCommand, setNewCommand] = useState("");

  if (!isOpen) return null;

  const opacityPercent = Math.round(bgAlpha * 100);

  const handleAddQuickPaste = () => {
    if (!newCommand.trim()) return;
    addQuickPaste(newCommand.trim());
    setNewCommand("");
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
          <div className="settings-group">
            <label className="settings-label">Theme</label>
            <select
              className="settings-select"
              value={currentThemeName}
              onChange={(e) => {
                setTheme(e.target.value);
                setSetting({ theme: e.target.value });
              }}
            >
              {themes.map((t) => (
                <option key={t.name} value={t.name}>{t.name}</option>
              ))}
            </select>
          </div>

          <div className="settings-group">
            <label className="settings-label">
              Background Opacity
              <span className="settings-value">{opacityPercent}%</span>
            </label>
            <input
              type="range"
              className="settings-range"
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

          <div className="settings-divider" />

          {/* Quick Pastes */}
          <div className="settings-group">
            <label className="settings-label">Quick Pastes</label>
            <span className="settings-hint">Ctrl+Shift+P to open quick paste palette</span>

            {quickPastes.length > 0 && (
              <div className="qp-list">
                {quickPastes.map((qp) => (
                  <div key={qp.id} className="qp-item">
                    <div className="qp-item-info">
                        <span className="qp-item-cmd" style={{ fontSize: "11.5px", color: "var(--fg-secondary)" }}>{qp.command}</span>
                    </div>
                    <button
                      className="qp-item-delete"
                      onClick={() => removeQuickPaste(qp.id)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="qp-add">
              <input
                className="settings-input"
                placeholder="e.g. claude --dangerously-skip-permissions"
                value={newCommand}
                onChange={(e) => setNewCommand(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddQuickPaste()}
              />
              <button
                className="qp-add-btn"
                onClick={handleAddQuickPaste}
                disabled={!newCommand.trim()}
              >
                + Add
              </button>
            </div>
          </div>

          <div className="settings-divider" />

          <div className="settings-group">
            <label className="settings-label">OpenAI API Key</label>
            <input
              type="password"
              className="settings-input"
              placeholder="sk-..."
              value={apiKey}
              onChange={(e) => setSetting({ openaiApiKey: e.target.value })}
            />
            <span className="settings-hint">For prompt rewriting in the text editor. Stored locally only.</span>
          </div>

          <div className="settings-group">
            <label className="settings-label">AI Model</label>
            <select
              className="settings-select"
              value={model}
              onChange={(e) => setSetting({ openaiModel: e.target.value })}
            >
              <option value="gpt-5.4-mini">gpt-5.4-mini (default, fast)</option>
              <option value="gpt-5.4">gpt-5.4 (frontier)</option>
              <option value="gpt-4o-mini">gpt-4o-mini (cheap)</option>
              <option value="gpt-4o">gpt-4o</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}
