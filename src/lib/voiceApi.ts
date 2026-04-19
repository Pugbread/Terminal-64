import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { VoiceIntent, VoiceState, VoiceModelsDownloaded } from "../stores/voiceStore";

export type VoiceModelKind = "wake" | "command" | "dictation";

export interface VoicePartialPayload {
  text: string;
}

/** LocalAgreement-2 split-event payload (committed prefix or tentative tail). */
export interface VoiceSplitPayload {
  text: string;
}

export interface VoiceFinalPayload {
  text: string;
}

export interface VoiceStatePayload {
  state: VoiceState;
}

export interface VoiceIntentPayload extends VoiceIntent {}

export interface VoiceErrorPayload {
  message: string;
}

export interface VoiceDownloadProgressPayload {
  kind: VoiceModelKind;
  progress: number; // 0..1
}

export async function startVoice(): Promise<void> {
  return invoke("start_voice");
}

export async function setVoiceSensitivity(sensitivity: number): Promise<void> {
  return invoke("voice_set_sensitivity", { sensitivity });
}

export async function abortVoiceDictation(): Promise<void> {
  return invoke("voice_abort_dictation");
}

export async function stopVoice(): Promise<void> {
  return invoke("stop_voice");
}

export async function downloadVoiceModel(kind: VoiceModelKind): Promise<void> {
  return invoke("download_voice_model", { kind });
}

export async function voiceModelsStatus(): Promise<VoiceModelsDownloaded> {
  return invoke("voice_models_status");
}

export function onVoiceIntent(callback: (payload: VoiceIntentPayload) => void): Promise<UnlistenFn> {
  return listen<VoiceIntentPayload>("voice-intent", (event) => callback(event.payload));
}

export function onVoicePartial(callback: (payload: VoicePartialPayload) => void): Promise<UnlistenFn> {
  return listen<VoicePartialPayload>("voice-partial", (event) => callback(event.payload));
}

/** LocalAgreement-2 committed prefix (stable, cumulative for the utterance). */
export function onVoiceCommitted(callback: (payload: VoiceSplitPayload) => void): Promise<UnlistenFn> {
  return listen<VoiceSplitPayload>("voice-committed", (event) => callback(event.payload));
}

/** LocalAgreement-2 tentative tail (un-agreed, dimmed in UI, may change). */
export function onVoiceTentative(callback: (payload: VoiceSplitPayload) => void): Promise<UnlistenFn> {
  return listen<VoiceSplitPayload>("voice-tentative", (event) => callback(event.payload));
}

export function onVoiceFinal(callback: (payload: VoiceFinalPayload) => void): Promise<UnlistenFn> {
  return listen<VoiceFinalPayload>("voice-final", (event) => callback(event.payload));
}

export function onVoiceState(callback: (payload: VoiceStatePayload) => void): Promise<UnlistenFn> {
  return listen<VoiceStatePayload>("voice-state", (event) => callback(event.payload));
}

export function onVoiceError(callback: (payload: VoiceErrorPayload) => void): Promise<UnlistenFn> {
  return listen<VoiceErrorPayload>("voice-error", (event) => callback(event.payload));
}

export function onVoiceDownloadProgress(
  callback: (payload: VoiceDownloadProgressPayload) => void
): Promise<UnlistenFn> {
  return listen<VoiceDownloadProgressPayload>("voice-download-progress", (event) => callback(event.payload));
}

export interface VoiceListeningProgressPayload {
  progress: number;
}

export function onVoiceListeningProgress(
  callback: (payload: VoiceListeningProgressPayload) => void
): Promise<UnlistenFn> {
  return listen<VoiceListeningProgressPayload>("voice-listening-progress", (event) => callback(event.payload));
}

/** 32 peak-amplitude floats (0..1) per 80 ms frame, emitted while Dictating. */
export interface VoiceWaveformPayload {
  samples: number[];
}
export function onVoiceWaveform(
  callback: (payload: VoiceWaveformPayload) => void,
): Promise<UnlistenFn> {
  return listen<VoiceWaveformPayload>("voice-waveform", (event) => callback(event.payload));
}
