import { useState, useEffect, useRef } from "react";
import { useThemeStore } from "../../stores/themeStore";
import {
  isProviderAvailable,
  normalizeWidgetRenderMode,
  resolveWidgetRenderMode,
  useSettingsStore,
  WIDGET_RENDER_MODES,
  type WidgetRenderMode,
} from "../../stores/settingsStore";
import { startDiscordBot, stopDiscordBot, discordBotStatus, renameDiscordSession, discordCleanupOrphaned, generateTheme, onThemeGenChunk, onThemeGenDone, startOpenwolfDaemon, stopOpenwolfDaemon, openwolfDaemonStatus } from "../../lib/tauriApi";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import "./SettingsPanel.css";

import { FONT_OPTIONS, fontStack } from "../../lib/fonts";
import type { ThemeDefinition } from "../../lib/types";
import { useCanvasStore } from "../../stores/canvasStore";
import {
  readProviderSessionMetadataSnapshot,
  useProviderSessionStore,
} from "../../stores/providerSessionStore";
import { useWidgetMetricsStore, type WidgetMetrics } from "../../stores/widgetMetricsStore";
import { usePerformanceStore, type PerformanceDebugEvent } from "../../stores/performanceStore";
import {
  NOISY_WIDGET_DEFAULTS,
  WIDGET_HOST_PROTECTION_DROP_THRESHOLD,
  WIDGET_HOST_PROTECTION_WINDOW_MS,
  getNoisyWidgetDefault,
  type WidgetHostProtectionMode,
} from "../../lib/widgetHostProtection";
import type { ProviderControlValue, ProviderId } from "../../lib/providers";
import {
  getProviderSnapshotCapabilityLabels,
  getProviderSnapshotModelSummary,
  listProviderSnapshotControls,
  listProviderSnapshotDisplays,
  providerSnapshotOptionValue,
  useProviderSnapshots,
} from "../../lib/providerSnapshots";
import { ProviderLogo } from "../ui/BrandLogos";
import { downloadVoiceModel, voiceModelsStatus, onVoiceDownloadProgress } from "../../lib/voiceApi";

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

function Toggle({
  checked,
  onChange,
  disabled = false,
  title,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  title?: string | undefined;
}) {
  return (
    <button
      className={`sp-toggle ${checked ? "sp-toggle--on" : ""} ${disabled ? "sp-toggle--disabled" : ""}`}
      onClick={() => onChange(!checked)}
      disabled={disabled}
      title={title}
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

function formatBytes(bytes: number | null) {
  if (bytes === null) return "n/a";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatAge(at: number | null) {
  if (at === null) return "n/a";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

function shortPayload(payload: unknown) {
  try {
    const text = typeof payload === "string" ? payload : JSON.stringify(payload);
    return text.length > 180 ? `${text.slice(0, 177)}...` : text;
  } catch {
    return String(payload);
  }
}

function widgetMetricTone(metrics: WidgetMetrics) {
  if (metrics.bridgeErrorCount > 0) return "error";
  if (metrics.reloadCount >= 5 || metrics.pluginSubscriptions >= 10 || metrics.busSubscriptions >= 10 || metrics.sessionEventSubscriptions >= 5 || metrics.voiceSubscriptions >= 3) return "warn";
  return "ok";
}

function performanceEventTone(event: PerformanceDebugEvent) {
  if (event.durationMs >= 500) return "error";
  if (event.kind === "frame-drop" && event.durationMs >= 55) return "warn";
  if (event.durationMs >= 120) return "warn";
  return "ok";
}

const WIDGET_RENDER_MODE_LABELS: Record<WidgetRenderMode, string> = {
  iframe: "Iframe",
  "native-webview": "Native",
  auto: "Auto",
};

const WIDGET_HOST_PROTECTION_LABELS: Record<WidgetHostProtectionMode, string> = {
  observe: "Observe",
  "auto-pause": "Auto Pause",
  "auto-promote": "Auto Promote",
};

function renderModeStatus(mode: WidgetRenderMode) {
  const resolution = resolveWidgetRenderMode(mode);
  if (resolution.fallbackReason) return `${WIDGET_RENDER_MODE_LABELS[mode]} -> ${resolution.effectiveMode}`;
  return WIDGET_RENDER_MODE_LABELS[resolution.effectiveMode];
}

function PerformanceDebugSection() {
  const events = usePerformanceStore((s) => s.events);
  const clearEvents = usePerformanceStore((s) => s.clearEvents);
  const logSnapshot = usePerformanceStore((s) => s.logSnapshot);
  const [copied, setCopied] = useState(false);
  const latest = events.slice(0, 10);
  const copySnapshot = async () => {
    logSnapshot();
    const rows = events.map((event) => ({
      at: new Date(event.at).toLocaleTimeString(),
      kind: event.kind,
      durationMs: event.durationMs,
      detail: event.detail,
      bytes: event.bytes ?? null,
      widgetCandidates: event.widgetCandidates?.map((candidate) => ({
        widgetId: candidate.widgetId,
        visibleFrames: candidate.visibleFrameCount,
        bridgeInRate: candidate.bridgeInRate ?? null,
        bridgeOutRate: candidate.bridgeOutRate ?? null,
        preferredRenderMode: candidate.preferredRenderMode ?? null,
      })) ?? [],
      hostProtection: event.hostProtection ?? null,
      visibility: event.visibility,
    }));
    await navigator.clipboard.writeText(JSON.stringify(rows, null, 2));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <Section label="Performance" icon="⌁" defaultOpen={false}>
      <div className="sp-row sp-row--col">
        <span className="sp-hint">
          Records frame drops, renderer stalls, browser long tasks, and slow storage writes. Open the console for matching [perf] warnings.
        </span>
        <div className="sp-row">
          <span className="sp-value">{events.length} events tracked</span>
          <div className="sp-debug-actions">
            <button className="sp-btn sp-btn--small" onClick={() => { void copySnapshot(); }} disabled={events.length === 0}>
              {copied ? "Copied" : "Copy"}
            </button>
            <button className="sp-btn sp-btn--small" onClick={clearEvents} disabled={events.length === 0}>
              Clear
            </button>
          </div>
        </div>
      </div>

      {latest.length === 0 ? (
        <span className="sp-hint">No stalls recorded yet.</span>
      ) : (
        <div className="sp-debug-list">
          {latest.map((event) => {
            const tone = performanceEventTone(event);
            return (
              <div className="sp-perf-card" key={event.id}>
                <div className="sp-debug-head">
                  <span className="sp-debug-title">{event.kind}</span>
                  <span className={`sp-debug-status sp-debug-status--${tone}`}>{event.durationMs}ms</span>
                </div>
                <div className="sp-perf-detail">{event.detail}</div>
                {event.widgetCandidates && event.widgetCandidates.length > 0 && (
                  <div className="sp-perf-candidates">
                    {event.widgetCandidates.slice(0, 3).map((candidate) => (
                      <span key={candidate.widgetId}>
                        {candidate.widgetId}
                        {candidate.bridgeInRate !== undefined && ` ${Math.round(candidate.bridgeInRate)}/s`}
                        {candidate.preferredRenderMode && ` -> ${candidate.preferredRenderMode}`}
                      </span>
                    ))}
                  </div>
                )}
                {event.hostProtection && (
                  <div className="sp-perf-action">
                    {WIDGET_HOST_PROTECTION_LABELS[event.hostProtection.mode]}: {event.hostProtection.detail}
                  </div>
                )}
                <div className="sp-perf-meta">
                  <span>{formatAge(event.at)} ago</span>
                  <span>{event.visibility}</span>
                  {typeof event.bytes === "number" && <span>{formatBytes(event.bytes)}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

function WidgetDebugSection() {
  const widgetMetricsById = useWidgetMetricsStore((s) => s.widgets);
  const clearWidgetMetrics = useWidgetMetricsStore((s) => s.clearWidgetMetrics);
  const logWidgetMetricsSnapshot = useWidgetMetricsStore((s) => s.logWidgetMetricsSnapshot);
  const [copied, setCopied] = useState(false);
  const widgetsPaused = useSettingsStore((s) => s.widgetsPaused);
  const pausedWidgetIds = useSettingsStore((s) => s.pausedWidgetIds);
  const widgetRenderMode = useSettingsStore((s) => s.widgetRenderMode);
  const widgetRenderModesById = useSettingsStore((s) => s.widgetRenderModesById);
  const widgetHostProtectionMode = useSettingsStore((s) => s.widgetHostProtectionMode);
  const setSetting = useSettingsStore((s) => s.set);
  const widgetMetrics = Object.values(widgetMetricsById)
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  const activeWidgetMetrics = widgetMetrics.filter((metrics) => metrics.unmountedAt === null);
  const globalRenderModeResolution = resolveWidgetRenderMode(widgetRenderMode);
  const toggleWidgetPaused = (widgetId: string) => {
    const paused = new Set(pausedWidgetIds);
    if (paused.has(widgetId)) paused.delete(widgetId);
    else paused.add(widgetId);
    setSetting({ pausedWidgetIds: Array.from(paused) });
  };
  const setWidgetRenderMode = (widgetId: string, mode: WidgetRenderMode | null) => {
    const next = { ...widgetRenderModesById };
    if (mode === null) delete next[widgetId];
    else next[widgetId] = mode;
    setSetting({ widgetRenderModesById: next });
  };
  const copyWidgetSnapshot = async () => {
    logWidgetMetricsSnapshot();
    const rows = widgetMetrics.map((metrics) => {
      const requestedRenderMode = widgetRenderModesById[metrics.widgetId] ?? widgetRenderMode;
      const renderMode = resolveWidgetRenderMode(requestedRenderMode);
      return {
        widgetId: metrics.widgetId,
        active: metrics.unmountedAt === null,
        ageSeconds: Math.round((Date.now() - metrics.mountedAt) / 1000),
        reloads: metrics.reloadCount,
        loads: metrics.iframeLoadCount,
        bridgeIn: metrics.bridgeInCount,
        bridgeOut: metrics.bridgeOutCount,
        errors: metrics.bridgeErrorCount,
        plugins: metrics.pluginSubscriptions,
        bus: metrics.busSubscriptions,
        session: metrics.sessionEventSubscriptions,
        termWaits: metrics.terminalWaiters,
        voice: metrics.voiceSubscriptions,
        browser: metrics.browserActive,
        paused: widgetsPaused || pausedWidgetIds.includes(metrics.widgetId),
        requestedRenderMode,
        effectiveRenderMode: renderMode.effectiveMode,
        renderModeFallback: renderMode.fallbackReason,
        heapBytes: metrics.hostHeapUsedBytes,
        report: metrics.lastWidgetReport?.payload ?? null,
      };
    });
    await navigator.clipboard.writeText(JSON.stringify(rows, null, 2));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <Section label="Widget Debug" icon="▣" defaultOpen={false}>
      <div className="sp-row sp-row--col">
        <span className="sp-hint">
          Host-side counters for widget panels. Heap is renderer-wide when Chromium exposes it; widgets can post t64:debug-metrics for their own numbers.
        </span>
        <div className="sp-row">
          <label className="sp-label">
            Host Protection
            <span className="sp-hint-inline">
              {WIDGET_HOST_PROTECTION_DROP_THRESHOLD} drops / {Math.round(WIDGET_HOST_PROTECTION_WINDOW_MS / 1000)}s
            </span>
          </label>
          <select
            className="sp-select sp-select--wide"
            value={widgetHostProtectionMode}
            onChange={(e) => setSetting({ widgetHostProtectionMode: e.currentTarget.value as WidgetHostProtectionMode })}
          >
            <option value="observe">Observe</option>
            <option value="auto-pause">Auto Pause</option>
            <option value="auto-promote">Auto Promote</option>
          </select>
        </div>
        <div className="sp-row">
          <label className="sp-label">
            Render Mode
            <span className="sp-hint-inline">effective {globalRenderModeResolution.effectiveMode}</span>
          </label>
          <select
            className="sp-select sp-select--wide"
            value={widgetRenderMode}
            title={globalRenderModeResolution.fallbackReason ?? undefined}
            onChange={(e) => setSetting({ widgetRenderMode: normalizeWidgetRenderMode(e.currentTarget.value) })}
          >
            {WIDGET_RENDER_MODES.map((mode) => (
              <option key={mode} value={mode}>{WIDGET_RENDER_MODE_LABELS[mode]}</option>
            ))}
          </select>
        </div>
        <div className="sp-row">
          <label className="sp-label">
            Pause Widgets
            <span className="sp-hint-inline">Unmount all widget iframes for isolation</span>
          </label>
          <Toggle checked={widgetsPaused} onChange={(v) => setSetting({ widgetsPaused: v })} />
        </div>
        <div className="sp-row">
          <span className="sp-value">{activeWidgetMetrics.length} active / {widgetMetrics.length} tracked</span>
          <div className="sp-debug-actions">
            <button className="sp-btn sp-btn--small" onClick={() => { void copyWidgetSnapshot(); }} disabled={widgetMetrics.length === 0}>
              {copied ? "Copied" : "Copy"}
            </button>
            <button className="sp-btn sp-btn--small" onClick={clearWidgetMetrics} disabled={widgetMetrics.length === 0}>
              Reset
            </button>
          </div>
        </div>
        <div className="sp-protection-defaults">
          {Object.values(NOISY_WIDGET_DEFAULTS).map((defaults) => (
            <span key={defaults.widgetId}>
              {defaults.widgetId}: prefer {defaults.preferredRenderMode}; fallback {WIDGET_HOST_PROTECTION_LABELS[defaults.fallbackProtection]}
            </span>
          ))}
        </div>
      </div>

      {widgetMetrics.length === 0 ? (
        <span className="sp-hint">No widget panels tracked yet.</span>
      ) : (
        <div className="sp-debug-list">
          {widgetMetrics.map((metrics) => {
            const tone = widgetMetricTone(metrics);
            const paused = widgetsPaused || pausedWidgetIds.includes(metrics.widgetId);
            const requestedRenderMode = widgetRenderModesById[metrics.widgetId] ?? widgetRenderMode;
            const renderMode = resolveWidgetRenderMode(requestedRenderMode);
            const noisyDefault = getNoisyWidgetDefault(metrics.widgetId);
            return (
              <div className="sp-debug-card" key={metrics.instanceId} title={metrics.instanceId}>
                <div className="sp-debug-head">
                  <span className="sp-debug-title">{metrics.widgetId}</span>
                  <div className="sp-debug-actions">
                    <select
                      className="sp-select sp-select--mini"
                      value={widgetRenderModesById[metrics.widgetId] ?? ""}
                      title={renderMode.fallbackReason ?? undefined}
                      onChange={(e) => {
                        const nextValue = e.currentTarget.value;
                        setWidgetRenderMode(
                          metrics.widgetId,
                          nextValue ? normalizeWidgetRenderMode(nextValue) : null,
                        );
                      }}
                    >
                      <option value="">Default</option>
                      {WIDGET_RENDER_MODES.map((mode) => (
                        <option key={mode} value={mode}>{WIDGET_RENDER_MODE_LABELS[mode]}</option>
                      ))}
                    </select>
                    <button
                      className="sp-btn sp-btn--small"
                      onClick={() => toggleWidgetPaused(metrics.widgetId)}
                    >
                      {paused ? "Resume" : "Pause"}
                    </button>
                    <span className={`sp-debug-status sp-debug-status--${paused ? "warn" : tone}`}>
                      {paused ? "paused" : metrics.unmountedAt === null ? "active" : "closed"}
                    </span>
                  </div>
                </div>
                <div className="sp-debug-grid">
                  <span>age</span><strong>{formatAge(metrics.mountedAt)}</strong>
                  <span>reloads</span><strong>{metrics.reloadCount}</strong>
                  <span>loads</span><strong>{metrics.iframeLoadCount}</strong>
                  <span>bridge</span><strong>{metrics.bridgeInCount}/{metrics.bridgeOutCount}</strong>
                  <span>errors</span><strong>{metrics.bridgeErrorCount}</strong>
                  <span>plugins</span><strong>{metrics.pluginSubscriptions}</strong>
                  <span>bus</span><strong>{metrics.busSubscriptions}</strong>
                  <span>session</span><strong>{metrics.sessionEventSubscriptions}</strong>
                  <span>term waits</span><strong>{metrics.terminalWaiters}</strong>
                  <span>voice</span><strong>{metrics.voiceSubscriptions}</strong>
                  <span>browser</span><strong>{metrics.browserActive ? "on" : "off"}</strong>
                  <span>mode</span><strong title={renderMode.fallbackReason ?? undefined}>{renderModeStatus(requestedRenderMode)}</strong>
                  <span>heap</span><strong>{formatBytes(metrics.hostHeapUsedBytes)}</strong>
                </div>
                {metrics.lastWidgetReport && (
                  <div className="sp-debug-report">
                    <span>report {formatAge(metrics.lastWidgetReport.at)} ago</span>
                    <code>{shortPayload(metrics.lastWidgetReport.payload)}</code>
                  </div>
                )}
                {noisyDefault && (
                  <div className="sp-debug-report">
                    <span>host protection default</span>
                    <code>{noisyDefault.reason}</code>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

function DebugSection() {
  return (
    <Section label="Debug" icon="⌁" defaultOpen={false}>
      <div className="sp-debug-menu">
        <WidgetDebugSection />
        <PerformanceDebugSection />
      </div>
    </Section>
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

  const addTheme = useThemeStore((s) => s.addTheme);

  // Background
  const backgroundImage = useSettingsStore((s) => s.backgroundImage);
  const backgroundOpacity = useSettingsStore((s) => s.backgroundOpacity);
  const showGrid = useSettingsStore((s) => s.showGrid);

  // Auto-Compact
  const autoCompactEnabled = useSettingsStore((s) => s.autoCompactEnabled);
  const autoCompactThreshold = useSettingsStore((s) => s.autoCompactThreshold);

  // Provider availability
  const providerAvailability = useSettingsStore((s) => s.providerAvailability);
  const providerControlDefaults = useSettingsStore((s) => s.providerControlDefaults);
  const providerSnapshots = useProviderSnapshots();
  const providerDisplays = listProviderSnapshotDisplays(providerSnapshots);
  const enabledProviderCount = providerDisplays.filter((display) =>
    isProviderAvailable(display.provider, providerAvailability)
  ).length;
  const handleProviderAvailabilityChange = (providerId: ProviderId, enabled: boolean) => {
    if (!enabled && enabledProviderCount <= 1 && isProviderAvailable(providerId, providerAvailability)) return;
    setSetting({
      providerAvailability: {
        ...providerAvailability,
        [providerId]: enabled,
      },
    });
  };
  const handleProviderDefaultChange = (providerId: ProviderId, controlId: string, value: ProviderControlValue) => {
    const control = listProviderSnapshotControls(providerId, providerSnapshots)
      .find((candidate) => candidate.id === controlId);
    if (!control) return;
    const nextDefaults = {
      ...providerControlDefaults,
      [providerId]: {
        ...(providerControlDefaults[providerId] ?? {}),
        [controlId]: value,
      },
    };
    const legacyPatch: { claudeModel?: string; claudeEffort?: string } = {};
    if (providerId === "anthropic" && typeof value === "string" && control.legacySlot === "model") legacyPatch.claudeModel = value;
    if (providerId === "anthropic" && typeof value === "string" && control.legacySlot === "effort") legacyPatch.claudeEffort = value;
    setSetting({ providerControlDefaults: nextDefaults, ...legacyPatch });
  };

  // Claude window defaults
  const claudeDefaultPermMode = useSettingsStore((s) => s.claudeDefaultPermMode);

  // OpenWolf
  const openwolfEnabled = useSettingsStore((s) => s.openwolfEnabled);
  const openwolfAutoInit = useSettingsStore((s) => s.openwolfAutoInit);
  const openwolfDaemon = useSettingsStore((s) => s.openwolfDaemon);
  const openwolfDesignQC = useSettingsStore((s) => s.openwolfDesignQC);
  const [wolfDaemonRunning, setWolfDaemonRunning] = useState(false);
  const [wolfDaemonLoading, setWolfDaemonLoading] = useState(false);

  const wolfCwd = useProviderSessionStore((s) => {
    for (const sid in s.sessions) {
      const sess = s.sessions[sid];
      if (sess?.cwd) return sess.cwd;
    }
    return "";
  });

  const [discordVoiceModelInstalled, setDiscordVoiceModelInstalled] = useState(false);
  const [discordVoiceProgress, setDiscordVoiceProgress] = useState(0);
  const [discordVoiceDownloading, setDiscordVoiceDownloading] = useState(false);

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
        .then((m) => setDiscordVoiceModelInstalled(!!m.dictation))
        .catch(() => {});
    }
  }, [isOpen]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    onVoiceDownloadProgress((p) => {
      if (p.kind !== "dictation") return;
      setDiscordVoiceProgress(p.progress);
      if (p.progress >= 1) {
        setDiscordVoiceDownloading(false);
        setDiscordVoiceModelInstalled(true);
      }
    }).then((un) => { unlisten = un; }).catch(() => {});
    return () => { if (unlisten) unlisten(); };
  }, []);

  const handleDownloadDiscordVoiceModel = async () => {
    setDiscordVoiceDownloading(true);
    setDiscordVoiceProgress(0);
    try {
      await downloadVoiceModel("dictation");
      setDiscordVoiceModelInstalled(true);
    } catch (err) {
      alert(`Failed to download Discord voice transcription model: ${err}`);
      setDiscordVoiceDownloading(false);
    }
  };

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

          {/* Providers */}
          <Section label="Providers" icon="◇">
            <div className="sp-section-intro">
              <span>Choose which providers appear in new-session pickers and set the defaults each one starts with.</span>
            </div>
            <div className="sp-provider-list">
              {providerDisplays.map((display) => {
                const enabled = isProviderAvailable(display.provider, providerAvailability);
                const disableLocked = enabled && enabledProviderCount <= 1;
                const modelSummary = getProviderSnapshotModelSummary(display.provider, providerSnapshots);
                const capabilitySummary = getProviderSnapshotCapabilityLabels(display.provider, providerSnapshots).join(", ");
                const controls = listProviderSnapshotControls(display.provider, providerSnapshots);
                return (
                  <div
                    className={`sp-provider-row ${enabled ? "" : "sp-provider-row--disabled"}`}
                    key={display.provider}
                  >
                    <div className="sp-provider-card-head">
                      <div className="sp-provider-info">
                        <ProviderLogo provider={display.provider} size={18} />
                        <div className="sp-provider-copy">
                          <span className="sp-provider-name">{display.label}</span>
                          <span className="sp-hint-inline">{display.defaultSessionName}</span>
                        </div>
                      </div>
                      <Toggle
                        checked={enabled}
                        disabled={disableLocked}
                        {...(disableLocked ? { title: "Keep at least one provider enabled" } : {})}
                        onChange={(v) => handleProviderAvailabilityChange(display.provider, v)}
                      />
                    </div>
                    <span className="sp-provider-meta">
                      {modelSummary && <span>Models: {modelSummary}</span>}
                      {capabilitySummary && <span>Capabilities: {capabilitySummary}</span>}
                    </span>
                    <span className="sp-provider-badges">
                      <span className={`sp-provider-badge ${enabled ? "sp-provider-badge--ok" : "sp-provider-badge--muted"}`}>
                        {enabled ? "Enabled" : "Hidden"}
                      </span>
                      {display.installed !== null && (
                        <span className={`sp-provider-badge ${display.installed ? "sp-provider-badge--ok" : "sp-provider-badge--warn"}`}>
                          {display.installed ? "Installed" : "Not installed"}
                        </span>
                      )}
                      {display.statusLabel && (
                        <span className={`sp-provider-badge ${display.enabled === false ? "sp-provider-badge--warn" : "sp-provider-badge--muted"}`}>
                          {display.statusLabel}
                        </span>
                      )}
                    </span>
                    {controls.length > 0 && (
                      <div className="sp-provider-controls">
                        {controls.map((control) => {
                          const currentValue = providerControlDefaults[display.provider]?.[control.id] ?? control.defaultValue;
                          if (control.kind === "boolean") {
                            return (
                              <div className="sp-row" key={control.id}>
                                <label className="sp-label">{control.label}</label>
                                <Toggle
                                  checked={currentValue === true}
                                  onChange={(v) => handleProviderDefaultChange(display.provider, control.id, v)}
                                />
                              </div>
                            );
                          }
                          if (control.kind === "number") {
                            return (
                              <div className="sp-row" key={control.id}>
                                <label className="sp-label">{control.label}</label>
                                <input
                                  className="sp-input sp-input--compact"
                                  type="number"
                                  value={typeof currentValue === "number" ? currentValue : Number(control.defaultValue) || 0}
                                  onChange={(e) => handleProviderDefaultChange(display.provider, control.id, Number(e.currentTarget.value))}
                                />
                              </div>
                            );
                          }
                          if (control.kind === "text") {
                            return (
                              <div className="sp-row" key={control.id}>
                                <label className="sp-label">{control.label}</label>
                                <input
                                  className="sp-input sp-input--compact"
                                  value={typeof currentValue === "string" ? currentValue : ""}
                                  onChange={(e) => handleProviderDefaultChange(display.provider, control.id, e.currentTarget.value)}
                                />
                              </div>
                            );
                          }
                          return (
                            <div className="sp-row" key={control.id}>
                              <label className="sp-label">{control.label}</label>
                              <select
                                className="sp-select sp-select--wide"
                                value={String(currentValue ?? control.defaultValue)}
                                onChange={(e) => handleProviderDefaultChange(display.provider, control.id, e.currentTarget.value)}
                              >
                                {control.options.map((option) => (
                                  <option key={option.id} value={String(providerSnapshotOptionValue(option))}>
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {display.provider === "anthropic" && (
                      <div className="sp-provider-advanced">
                        <div className="sp-row">
                          <label className="sp-label">
                            New Window Permission
                            <span className="sp-hint-inline">Claude-only startup mode</span>
                          </label>
                          <select
                            className="sp-select sp-select--wide"
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
                            </div>
                          </div>
                        )}

                        <div className="sp-provider-subhead">OpenWolf</div>
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
                              title={!wolfCwd ? "Open an AI session first so the daemon knows which project to watch" : ""}
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
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
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

          {/* Discord */}
          <Section label="Discord Bot" icon="⊕" defaultOpen={false}>
            <div className="sp-row">
              <label className="sp-label">
                Status
                <span className={`sp-dot ${botConnected ? "sp-dot--on" : ""}`} />
              </label>
              <span className="sp-value">{botConnected ? "Connected" : "Disconnected"}</span>
            </div>

            <div className="sp-sub">
              <div className="sp-row" style={{ gap: 8 }}>
                <label className="sp-label" style={{ flex: 1 }}>
                  Voice Message Transcription
                  <span className={`sp-dot ${discordVoiceModelInstalled ? "sp-dot--on" : ""}`} />
                  <span className="sp-hint-inline">Whisper model, ~80 MB</span>
                </label>
                <button
                  className="sp-btn sp-btn--small"
                  disabled={discordVoiceDownloading || discordVoiceModelInstalled}
                  onClick={handleDownloadDiscordVoiceModel}
                >
                  {discordVoiceModelInstalled
                    ? "Installed"
                    : discordVoiceDownloading
                      ? `${Math.round(discordVoiceProgress * 100)}%`
                      : "Download"}
                </button>
              </div>
              <span className="sp-hint">Discord voice messages are transcribed locally, echoed back to Discord, then routed into the linked chat as a normal prompt.</span>
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
                    // Wait for gateway to be ready, then link all open AI session panels.
                    await new Promise((r) => setTimeout(r, 2000));
                    const terminals = useCanvasStore.getState().terminals;
                    // Canvas `t.title` is a stale snapshot; read the live name from the session store.
                    let savedSessions: Record<string, { name?: string; cwd?: string }> = {};
                    try {
                      savedSessions = readProviderSessionMetadataSnapshot();
                    } catch (err) {
                      console.warn("[discord] Failed to read session store:", err);
                    }
                    const providerSessions = useProviderSessionStore.getState().sessions;
                    for (const t of terminals) {
                      if (t.panelType !== "claude") continue;
                      const liveName = providerSessions[t.terminalId]?.name;
                      const savedName = savedSessions[t.terminalId]?.name;
                      const name = (liveName || savedName || "").trim();
                      if (!name) continue;
                      const cwd = providerSessions[t.terminalId]?.cwd
                        || savedSessions[t.terminalId]?.cwd
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

          {/* Debug */}
          <DebugSection />
        </div>
      </div>
    </div>
  );
}
