import { useEffect, useRef } from "react";
import { useSettingsStore } from "../stores/settingsStore";
import {
  startPartyMode,
  stopPartyMode,
  onPartyModeSpectrum,
  SpectrumData,
} from "../lib/tauriApi";

// Module-level ref for components that need raw band data (e.g. equalizer)
// Updated at ~30fps by the spectrum listener — read via requestAnimationFrame
export const spectrumRef: { current: SpectrumData | null } = { current: null };

/** Parse a hex color to HSL, returns [h, s, l] with h in degrees, s/l in 0-100 */
function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h * 360, s * 100, l * 100];
}

export function usePartyMode() {
  const enabled = useSettingsStore((s) => s.partyModeEnabled);
  const intensity = useSettingsStore((s) => s.partyIntensity);
  const colorCycling = useSettingsStore((s) => s.partyColorCycling);

  // Use refs so the spectrum callback reads live values without restarting the effect
  const intensityRef = useRef(intensity);
  intensityRef.current = intensity;
  const colorCyclingRef = useRef(colorCycling);
  colorCyclingRef.current = colorCycling;

  useEffect(() => {
    const root = document.documentElement.style;

    if (!enabled) {
      root.setProperty("--party-active", "0");
      root.removeProperty("--party-bass");
      root.removeProperty("--party-mid");
      root.removeProperty("--party-treble");
      root.removeProperty("--party-peak");
      root.removeProperty("--party-hue");
      spectrumRef.current = null;
      stopPartyMode().catch(() => {});
      return;
    }

    root.setProperty("--party-active", "1");
    startPartyMode().catch((err) => {
      console.warn("[party] Failed to start audio capture:", err);
    });

    // Mild curve for equalizer — keeps contrast but doesn't crush mid values
    const eqCurve = (v: number) => Math.min(Math.pow(v, 1.2) * 1.8, 1);
    // Softer curve for glow/CSS vars
    const glowCurve = (v: number) => Math.min(Math.pow(v, 1.3) * 1.5, 1);

    let hue = 220; // start at blue
    let themeHue = 220; // derived from --accent when not cycling
    let themeSat = 85;
    let themeLit = 55;

    // Read theme accent color and convert to HSL for non-cycling mode
    const updateThemeHue = () => {
      const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
      if (accent && accent.startsWith("#") && accent.length >= 7) {
        const [h, s, l] = hexToHsl(accent);
        themeHue = h;
        themeSat = s;
        themeLit = l;
      }
    };
    updateThemeHue();
    // Re-read if theme changes (check every ~2s via interval, lightweight)
    const themeInterval = setInterval(updateThemeHue, 2000);

    const unlistenPromise = onPartyModeSpectrum((data) => {
      // Equalizer band data — amplified so bars are lively at any volume
      spectrumRef.current = {
        bands: data.bands.map((b) => eqCurve(b)),
        bass: eqCurve(data.bass),
        mid: eqCurve(data.mid),
        treble: eqCurve(data.treble),
        peak: eqCurve(data.peak),
      };

      // Read live settings from refs — no effect restart needed
      const i = intensityRef.current;
      root.setProperty("--party-bass", String(glowCurve(data.bass) * i));
      root.setProperty("--party-mid", String(glowCurve(data.mid) * i));
      root.setProperty("--party-treble", String(glowCurve(data.treble) * i));
      root.setProperty("--party-peak", String(glowCurve(data.peak) * i));

      if (colorCyclingRef.current) {
        // Base rotation speed + beat-reactive boost
        hue = (hue + 1.5 + glowCurve(data.peak) * 8) % 360;
        root.setProperty("--party-cycling", "1");
      } else {
        hue = themeHue;
        root.setProperty("--party-cycling", "0");
        root.setProperty("--party-theme-sat", String(themeSat));
        root.setProperty("--party-theme-lit", String(themeLit));
      }
      root.setProperty("--party-hue", String(hue));
    });

    return () => {
      clearInterval(themeInterval);
      unlistenPromise.then((fn) => fn());
      stopPartyMode().catch(() => {});
      spectrumRef.current = null;
      root.setProperty("--party-active", "0");
      root.removeProperty("--party-bass");
      root.removeProperty("--party-mid");
      root.removeProperty("--party-treble");
      root.removeProperty("--party-peak");
      root.removeProperty("--party-hue");
      root.removeProperty("--party-cycling");
      root.removeProperty("--party-theme-sat");
      root.removeProperty("--party-theme-lit");
    };
  }, [enabled]); // Only restart capture when enabled/disabled — intensity/colorCycling read from refs
}
