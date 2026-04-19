import { useEffect } from "react";
import {
  onVoiceIntent,
  onVoicePartial,
  onVoiceCommitted,
  onVoiceTentative,
  onVoiceFinal,
  onVoiceState,
  onVoiceError,
  onVoiceDownloadProgress,
  onVoiceListeningProgress,
  setVoiceSensitivity,
  abortVoiceDictation,
  startVoice,
  stopVoice,
} from "../lib/voiceApi";
import {
  useVoiceStore,
  getChatInputVoiceActions,
  type VoiceIntent,
} from "../stores/voiceStore";
import { matchSession } from "../lib/sessionFuzzyMatch";
import { getSessionsForVoiceMatch } from "../stores/claudeStore";

/**
 * Top-level voice-control hook. Mount once in App. Listens to `voice-*` Tauri
 * events and dispatches to the voiceStore + the active session's registered
 * ChatInput actions. Also drives backend start/stop via the `enabled` flag.
 */
export function useVoiceControl() {
  // React to enabled toggle → start/stop backend.
  const enabled = useVoiceStore((s) => s.enabled);
  useEffect(() => {
    if (enabled) {
      startVoice()
        .then(() => {
          // Push saved sensitivity after start so the slider value users set
          // in a previous session actually reaches the wake detector. The
          // backend defaults to 0.5-equivalent threshold until this lands.
          const raw = Number(localStorage.getItem("terminal64-voice-sensitivity"));
          const s = Number.isFinite(raw) && raw > 0 ? raw : 0.85;
          void setVoiceSensitivity(s).catch(() => {});
        })
        .catch((e) => {
          console.warn("[voice] startVoice failed:", e);
          const store = useVoiceStore.getState();
          store.setError(String(e));
          store.setState("idle");
        });
      return () => {
        stopVoice().catch((e) => console.warn("[voice] stopVoice failed:", e));
      };
    }
    return;
  }, [enabled]);

  // Wire event listeners once on mount; tear them all down on unmount.
  useEffect(() => {
    let cancelled = false;
    const unlisteners: (() => void)[] = [];
    // Mute late dictation events for a window after a command intent
    // fires, so stragglers from the dying worker can't repaint the
    // textarea after it's been cleared by send.
    let muteUntil = 0;
    const muteNow = () => { muteUntil = Date.now() + 1500; };
    const isMuted = () => Date.now() < muteUntil;

    const handleIntent = (intent: VoiceIntent) => {
      const store = useVoiceStore.getState();
      store.setLastIntent(intent);

      if (intent.kind === "SelectSession") {
        const transcript = intent.payload || "";
        const candidates = getSessionsForVoiceMatch();
        const matched = matchSession(transcript, candidates);
        if (matched) {
          store.setActiveSessionId(matched);
          if (store.error) store.setError(null);
        } else {
          // No match: the backend will have already transitioned to
          // Dictating (it can't know our session list). Abort it, or the
          // user's next utterance gets dictated into whatever session was
          // active before — which is really confusing.
          void abortVoiceDictation().catch(() => {});
          // Also drop the active session target so even if a stray
          // partial slips through, there's nowhere for it to land.
          store.setActiveSessionId(null);
          const names = candidates.map((c) => c.name).filter(Boolean);
          console.info("[voice] SelectSession: no match for", transcript, "against", names);
          // Soft error — the mascot should show a brief confused face,
          // NOT the red "dead" error state. Clear after 2.5 s so idle
          // resumes naturally.
          store.setError(
            `Heard "${transcript}" — no matching session. Try: ${names.slice(0, 4).join(", ")}${names.length > 4 ? "…" : ""}`
          );
          setTimeout(() => {
            const s = useVoiceStore.getState();
            if (s.error && s.error.startsWith("Heard ")) s.setError(null);
          }, 2500);
        }
        return;
      }

      const targetId = store.activeSessionId;
      if (!targetId) {
        console.info("[voice] intent received with no active session:", intent.kind);
        return;
      }
      const actions = getChatInputVoiceActions(targetId);
      if (!actions) {
        console.info("[voice] no ChatInput actions registered for session", targetId);
        return;
      }

      // Two-phase finalize: first END the dictation cleanly (mute, clear
      // store fields, rollback any live partial from the textarea, give
      // stragglers a 350 ms window to arrive and be muted), THEN fire the
      // actual action with the authoritative payload. Without this wait,
      // late committed/tentative events from the dying worker can still
      // repaint the textarea between our clear and our send.
      //
      // The snapshot captures what's actually in the textarea RIGHT NOW —
      // including text committed by prior Dictation intents — so when the
      // current "jarvis send" utterance has an empty residual (it was just
      // the command, no prefix), we still send the accumulated dictation.
      // Without this, dictating → pausing → saying "Jarvis send" would wipe
      // the textarea and send only the trailing partial that leaked through.
      const DRAIN_MS = 350;
      const endDictationThen = (action: (snapshot: string) => void) => {
        muteNow();
        const snapshot = (actions.getText?.() ?? "").trim();
        const s = useVoiceStore.getState();
        s.clearDictationSplit();
        s.setPartial("");
        actions.setText("");
        setTimeout(() => action(snapshot), DRAIN_MS);
      };
      switch (intent.kind) {
        case "Send":
          endDictationThen((snapshot) => {
            // Prefer the textarea snapshot: it's what the user SAW on screen
            // and includes prior commits from mid-dictation pause finalizes
            // plus any manually-typed content. intent.payload is only the
            // current chunk's residual — a subset. Fall back to it only
            // when the snapshot is empty (mute blocked all partials).
            const payload = snapshot || intent.payload?.trim() || "";
            if (payload) actions.send(payload);
            else actions.send();
          });
          break;
        case "Exit":
          endDictationThen(() => actions.exit());
          break;
        case "Rewrite":
          endDictationThen((snapshot) => {
            const payload = snapshot || intent.payload?.trim() || "";
            if (payload) actions.rewrite(payload);
            else actions.rewrite();
          });
          break;
        case "Dictation":
          actions.commitDictation(intent.payload || "");
          break;
      }
    };

    (async () => {
      const unIntent = await onVoiceIntent(handleIntent);
      if (cancelled) { unIntent(); return; }
      unlisteners.push(unIntent);

      const unPartial = await onVoicePartial((p) => {
        if (isMuted()) return;
        const text = p.text || "";
        useVoiceStore.getState().setPartial(text);
        // Legacy single-string rendering. Only drive the textarea via
        // applyPartial when the split events aren't landing — otherwise
        // we'd double-write and thrash. Gate on presence of committed/
        // tentative: if either is non-empty, assume split stream is live.
        const store = useVoiceStore.getState();
        if (store.activeSessionId && !store.committed && !store.tentative) {
          const actions = getChatInputVoiceActions(store.activeSessionId);
          actions?.applyPartial(text);
        }
      });
      if (cancelled) { unPartial(); return; }
      unlisteners.push(unPartial);

      // Backend emits committed then tentative per partial tick; we
      // apply only on tentative so each tick produces exactly one
      // textarea write with both fields in sync.
      const unCommitted = await onVoiceCommitted((p) => {
        if (isMuted()) return;
        const store = useVoiceStore.getState();
        if (store.state !== "dictating") return;
        store.setCommitted(p.text || "");
      });
      if (cancelled) { unCommitted(); return; }
      unlisteners.push(unCommitted);
      const unTentative = await onVoiceTentative((p) => {
        if (isMuted()) return;
        const store = useVoiceStore.getState();
        if (store.state !== "dictating") return;
        store.setTentative(p.text || "");
        if (!store.activeSessionId) return;
        const actions = getChatInputVoiceActions(store.activeSessionId);
        actions?.applyCommittedTentative(store.committed, p.text || "");
      });
      if (cancelled) { unTentative(); return; }
      unlisteners.push(unTentative);

      const unFinal = await onVoiceFinal((p) => {
        // Clear partial + split fields once a final transcript lands. The
        // matching intent event carries the actionable result.
        const store = useVoiceStore.getState();
        store.clearDictationSplit();
        void p;
      });
      if (cancelled) { unFinal(); return; }
      unlisteners.push(unFinal);

      const unState = await onVoiceState((p) => {
        useVoiceStore.getState().setState(p.state);
      });
      if (cancelled) { unState(); return; }
      unlisteners.push(unState);

      const unError = await onVoiceError((p) => {
        // Safety net per cerebrum.md: on ANY backend error, reset state to
        // 'idle' so the UI spinner / listening indicator never gets stuck.
        const store = useVoiceStore.getState();
        store.setError(p.message || "voice error");
        store.setState("idle");
        store.setPartial("");
      });
      if (cancelled) { unError(); return; }
      unlisteners.push(unError);

      const unProgress = await onVoiceDownloadProgress((p) => {
        if (p.progress >= 1) {
          useVoiceStore.getState().setModelsDownloaded({ [p.kind]: true });
        }
      });
      if (cancelled) { unProgress(); return; }
      unlisteners.push(unProgress);

      const unListenProg = await onVoiceListeningProgress((p) => {
        useVoiceStore.getState().setListeningProgress(p.progress);
      });
      if (cancelled) { unListenProg(); return; }
      unlisteners.push(unListenProg);
    })();

    return () => {
      cancelled = true;
      for (const u of unlisteners) {
        try { u(); } catch { /* ignore */ }
      }
    };
  }, []);
}
