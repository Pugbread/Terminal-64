import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import type { SlashCommand } from "../../lib/types";
import { searchFiles, readFileBase64 } from "../../lib/tauriApi";
import { formatDuration } from "../../lib/constants";
import { isAbsolutePath, joinPath } from "../../lib/platform";
import { onVoiceWaveform } from "../../lib/voiceApi";
import {
  useVoiceStore,
  type ChatInputVoiceActions,
} from "../../stores/voiceStore";

const IMAGE_EXTS = /\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?)$/i;

/**
 * Truncate a partial transcript at the last standalone "jarvis" (with
 * optional "hey"/"ok"/"yo" filler before it). Whisper renders this
 * address with variable punctuation ("Jarvis,", "Jarvis.", " jarvis ")
 * so we strip word-boundary-delimited matches and drop trailing punct.
 *
 * Returns both the trimmed head and the matched wake-word span so the UI
 * can animate the eaten word (Agent 3 §5 — "word gets eaten" affordance).
 */
function trimAtJarvis(text: string): { trimmed: string; eaten: string | null } {
  const re = /(?:\b(?:hey|ok|okay|yo)[\s,]+)?\bjarvis\b/gi;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    last = m;
  }
  if (!last) return { trimmed: text, eaten: null };
  const head = text.slice(0, last.index).replace(/[\s,.\-!?:;]+$/, "");
  // Grow the eaten span to the next whitespace so we include any trailing
  // punctuation/filler the user's utterance attached ("jarvis,", "jarvis."),
  // matching what the animation will fade out.
  const tailStart = last.index + last[0].length;
  let tailEnd = tailStart;
  while (tailEnd < text.length && /[\s,.\-!?:;]/.test(text[tailEnd])) tailEnd++;
  const eaten = text.slice(last.index, tailEnd);
  return { trimmed: head, eaten };
}

interface ChatInputProps {
  onSend: (text: string) => void;
  onCancel: () => void;
  onAttach?: () => void;
  onRewrite?: (text: string, setText: (t: string) => void, opts?: { isVoice?: boolean }) => void | Promise<void>;
  isRewriting?: boolean;
  isStreaming: boolean;
  accentColor?: string;
  streamingStartedAt?: number | null;
  disabled?: boolean;
  slashCommands?: SlashCommand[];
  initialText?: string | null;
  onInitialTextConsumed?: () => void;
  permLabel?: string;
  permColor?: string;
  onCyclePerm?: () => void;
  sessionName?: string;
  cwd?: string;
  queueCount?: number;
  draftPrompt?: string;
  onDraftChange?: (text: string) => void;
  onPasteImage?: (file: File) => void;
  contextPct?: number;
  autoCompactAt?: number;
  onRegisterVoiceActions?: (actions: ChatInputVoiceActions | null) => void;
  sessionId?: string;
}

export default function ChatInput({ onSend, onCancel, onAttach, onRewrite, isRewriting, isStreaming, accentColor, streamingStartedAt, disabled, slashCommands, initialText, onInitialTextConsumed, permLabel, permColor, onCyclePerm, sessionName, cwd, queueCount, draftPrompt, onDraftChange, onPasteImage, contextPct, autoCompactAt, onRegisterVoiceActions, sessionId }: ChatInputProps) {
  const [text, setText] = useState(draftPrompt || "");
  const [elapsed, setElapsed] = useState("");
  const [inlineFiles, setInlineFiles] = useState<Set<string>>(new Set());
  const [imagePreviews, setImagePreviews] = useState<Record<string, string>>({});

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const waveformPathRef = useRef<SVGPathElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const textRef = useRef(draftPrompt || "");

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 400) + "px";
  }, []);

  // Voice dictation state: live partials render on top of a "committed" base
  // without persisting; final (Dictation intent) flattens into the base.
  const committedBaseRef = useRef<string | null>(null);
  // LocalAgreement-2 tentative tail — rendered as a dimmed sibling span in the
  // overlay so the user can see the unstable suffix without it flipping into
  // the committed textarea text. Cleared on commit / user edit / rollback.
  const [tentativeText, setTentativeText] = useState<string>("");
  const tentativeRef = useRef<string>("");
  tentativeRef.current = tentativeText;

  const setTextDirect = useCallback((val: string) => {
    if (textareaRef.current) textareaRef.current.value = val;
    textRef.current = val;
    setText(val);
    // Re-run auto-resize so voice/rewrite-driven text expands the input
    // the same way as human typing does.
    requestAnimationFrame(() => autoResize());
  }, [autoResize]);

  const applyPartial = useCallback((partialText: string) => {
    const el = textareaRef.current;
    if (!el) return;
    if (committedBaseRef.current === null) {
      committedBaseRef.current = el.value;
    }
    const base = committedBaseRef.current;
    const { trimmed } = trimAtJarvis(partialText);
    const pt = trimmed.trim();
    const combined = pt.length === 0 ? base : base ? `${base} ${pt}` : pt;
    el.value = combined;
    textRef.current = combined;
    setText(combined);
    requestAnimationFrame(() => autoResize());
  }, [autoResize]);

  /**
   * LocalAgreement-2 two-span render.
   *
   * The backend emits `voice-committed` (stable, cumulative for the utterance)
   * and `voice-tentative` (unstable tail — may disappear or change on the next
   * partial tick). We write the stable committed text into the textarea
   * (source of truth, caret-editable) and render the tentative tail as a
   * dimmed sibling span via the overlay. Per Agent 3 §2: tentative text
   * disappearing on disagreement is correct behavior, not a glitch.
   */
  const applyCommittedTentative = useCallback((committed: string, tentative: string) => {
    const el = textareaRef.current;
    if (!el) return;
    if (committedBaseRef.current === null) {
      committedBaseRef.current = el.value;
    }
    const base = committedBaseRef.current;
    const { trimmed } = trimAtJarvis(committed);
    const committedClean = trimmed.trim();
    const combined = committedClean.length === 0
      ? base
      : base
        ? `${base} ${committedClean}`
        : committedClean;
    el.value = combined;
    textRef.current = combined;
    setText(combined);
    setTentativeText(tentative.trim());
    requestAnimationFrame(() => autoResize());
  }, [autoResize]);

  const commitDictation = useCallback((finalText: string) => {
    const base = committedBaseRef.current ?? textareaRef.current?.value ?? "";
    const ft = finalText.trim();
    // Trust the backend's final transcript — it already handles trailing
    // keywords (e.g. "jarvis send" is stripped so `ft` is the clean
    // residual). Replacing the live partial with the authoritative final
    // prevents stray "jarvis"/"send" tokens from leaking into the prompt.
    const next = ft.length === 0 ? base : base ? `${base} ${ft}` : ft;
    committedBaseRef.current = null;
    setTentativeText("");
    setTextDirect(next);
  }, [setTextDirect]);

  const getTextDirect = useCallback(() => {
    return textareaRef.current?.value ?? textRef.current;
  }, []);

  // Sync external draft changes
  const lastExternalDraft = useRef(draftPrompt || "");
  useEffect(() => {
    if (draftPrompt !== undefined && draftPrompt !== lastExternalDraft.current && draftPrompt !== textRef.current) {
      setTextDirect(draftPrompt);
      lastExternalDraft.current = draftPrompt;
      textareaRef.current?.focus();
    }
  }, [draftPrompt, setTextDirect]);

  // Save draft prompt debounced
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!onDraftChange) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      onDraftChange(textRef.current);
      lastExternalDraft.current = textRef.current;
    }, 1000);
    return () => { if (draftTimer.current) clearTimeout(draftTimer.current); };
  }, [text, onDraftChange]);

  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => { if (blurTimer.current) clearTimeout(blurTimer.current); };
  }, []);

  // Arrow key + garbage character protection
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const arrowKeys = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);
    const captureArrows = (e: KeyboardEvent) => {
      if (arrowKeys.has(e.key)) e.stopPropagation();
    };
    const blockGarbage = (e: InputEvent) => {
      if (e.data && /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(e.data)) e.preventDefault();
    };
    el.addEventListener("keydown", captureArrows, true);
    el.addEventListener("beforeinput", blockGarbage as EventListener, true);
    return () => {
      el.removeEventListener("keydown", captureArrows, true);
      el.removeEventListener("beforeinput", blockGarbage as EventListener, true);
    };
  }, []);

  // Load image previews for @-mentioned image files
  useEffect(() => {
    for (const file of inlineFiles) {
      if (IMAGE_EXTS.test(file) && !imagePreviews[file]) {
        const fullPath = cwd ? (isAbsolutePath(file) ? file : joinPath(cwd, file)) : file;
        readFileBase64(fullPath).then((b64) => {
          const ext = file.split(".").pop()?.toLowerCase() || "png";
          const mime = ext === "svg" ? "image/svg+xml" : `image/${ext.replace("jpg", "jpeg")}`;
          setImagePreviews((prev) => ({ ...prev, [file]: `data:${mime};base64,${b64}` }));
        }).catch(() => {});
      }
    }
    // Clean up previews for removed files
    setImagePreviews((prev) => {
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(prev)) {
        if (inlineFiles.has(k)) next[k] = v;
      }
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, [inlineFiles, cwd]);

  // Thinking timer
  useEffect(() => {
    if (!isStreaming || !streamingStartedAt) { setElapsed(""); return; }
    const tick = () => setElapsed(formatDuration(Math.floor((Date.now() - streamingStartedAt) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [isStreaming, streamingStartedAt]);

  useEffect(() => {
    if (initialText) {
      setTextDirect(initialText);
      textareaRef.current?.focus();
      onInitialTextConsumed?.();
    }
  }, [initialText, setTextDirect]);

  const voiceState = useVoiceStore((s) => s.state);
  const activeVoiceSessionId = useVoiceStore((s) => s.activeSessionId);
  const isActiveVoiceSession = !!sessionId && sessionId === activeVoiceSessionId;
  const isDictating = voiceState === "dictating" && isActiveVoiceSession;

  // Live voice waveform driven by the backend's `voice-waveform` event
  // (32 peak-amplitude buckets per 80ms mic frame); rolling buffer
  // renders as a scrolling squiggle behind the textarea text.
  const WAVE_POINTS = 96;
  const waveBufRef = useRef<Float32Array>(new Float32Array(WAVE_POINTS));
  useEffect(() => {
    if (!isDictating) {
      // Reset to flat baseline when this session stops dictating.
      waveBufRef.current.fill(0);
      if (waveformPathRef.current) {
        waveformPathRef.current.setAttribute("d", "M 0 20 L 400 20");
      }
      return;
    }
    let unlisten: (() => void) | null = null;
    let raf = 0;
    let cancelled = false;
    // Decouple paint from event cadence so the squiggle interpolates smoothly
    // even if frames land irregularly.
    const paint = () => {
      if (cancelled || !waveformPathRef.current) return;
      const buf = waveBufRef.current;
      const midY = 20;
      const dx = 400 / (WAVE_POINTS - 1);
      let d = "";
      for (let i = 0; i < WAVE_POINTS; i++) {
        // Oscillate around the midline: alternate sign by index so a single
        // loud sample produces a v-shaped spike, like a real oscilloscope.
        const sign = i % 2 === 0 ? 1 : -1;
        const y = midY + sign * buf[i] * 18;
        d += (i === 0 ? "M " : " L ") + (i * dx).toFixed(1) + " " + y.toFixed(2);
      }
      waveformPathRef.current.setAttribute("d", d);
      raf = requestAnimationFrame(paint);
    };
    raf = requestAnimationFrame(paint);
    onVoiceWaveform(({ samples }) => {
      if (!samples || !samples.length) return;
      const buf = waveBufRef.current;
      const n = samples.length;
      buf.copyWithin(0, n);
      for (let i = 0; i < n; i++) {
        buf[WAVE_POINTS - n + i] = Math.max(0, Math.min(1, samples[i]));
      }
    }).then((un) => {
      if (cancelled) { un(); return; }
      unlisten = un;
    });
    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      if (unlisten) unlisten();
    };
  }, [isDictating]);

  const [showSlash, setShowSlash] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [showFiles, setShowFiles] = useState(false);
  const [fileResults, setFileResults] = useState<string[]>([]);
  const [fileIdx, setFileIdx] = useState(0);
  const [atStart, setAtStart] = useState(-1);
  const fileSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const slashRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLDivElement>(null);

  const handleSend = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const trimmed = el.value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    el.value = "";
    textRef.current = "";
    setText("");
    setInlineFiles(new Set());
    setImagePreviews({});
    setShowSlash(false);
    setShowFiles(false);
    el.style.height = "auto";
  }, [disabled, onSend]);

  // Register voice actions — reuses existing submit/setText/rewrite paths
  const onRewriteRef = useRef(onRewrite);
  onRewriteRef.current = onRewrite;
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;
  // Roll back an in-flight voice partial so the control-word utterance
  // ("send" / "exit" / "rewrite") doesn't end up in the submitted prompt.
  const rollbackPartial = useCallback(() => {
    if (committedBaseRef.current !== null) {
      const base = committedBaseRef.current;
      committedBaseRef.current = null;
      if (textareaRef.current) textareaRef.current.value = base;
      textRef.current = base;
      setText(base);
      requestAnimationFrame(() => autoResize());
    }
    // Always clear the tentative tail — even if no base was snapshotted
    // (e.g. control-word-only utterance), we still want the dimmed tail
    // to vanish from the UI on intent fire.
    if (tentativeRef.current) setTentativeText("");
  }, [autoResize]);

  useEffect(() => {
    if (!onRegisterVoiceActions) return;
    const actions: ChatInputVoiceActions = {
      send: (text?: string) => {
        // `text` is the residual from the FINAL dictation chunk (the part
        // before "jarvis send"). Earlier chunks were already committed to
        // the textarea via intermediate Dictation intents whenever the
        // user paused >1.5s mid-sentence. Append the residual to the
        // accumulated textarea so the full prompt gets sent, not just
        // the last chunk.
        rollbackPartial();
        const base = getTextDirect().trim();
        const residual = (text ?? "").trim();
        const payload = base && residual ? `${base} ${residual}` : base || residual;
        setTextDirect("");
        if (payload) onSendRef.current(payload);
        setTextDirect("");
      },
      exit: () => {
        rollbackPartial();
        setTextDirect("");
        onCancelRef.current();
      },
      rewrite: (text?: string) => {
        rollbackPartial();
        const base = getTextDirect().trim();
        const residual = (text ?? "").trim();
        const full = base && residual ? `${base} ${residual}` : base || residual;
        setTextDirect(full);
        const res = onRewriteRef.current?.(full, (t: string) => setTextDirect(t), { isVoice: true });
        Promise.resolve(res as unknown as Promise<void> | void).then(() => {
          const final = getTextDirect().trim();
          setTextDirect("");
          if (final) onSendRef.current(final);
          setTextDirect("");
        });
      },
      setText: setTextDirect,
      getText: getTextDirect,
      applyPartial,
      applyCommittedTentative,
      commitDictation,
    };
    onRegisterVoiceActions(actions);
    return () => { onRegisterVoiceActions(null); };
  }, [onRegisterVoiceActions, setTextDirect, getTextDirect, applyPartial, applyCommittedTentative, commitDictation, rollbackPartial]);

  const filteredCommands = useMemo(() => {
    if (!slashCommands || !showSlash) return [];
    if (!slashFilter) return slashCommands;
    const lower = slashFilter.toLowerCase();
    return slashCommands.filter(
      (c) => c.name.toLowerCase().includes(lower) || c.description.toLowerCase().includes(lower)
    );
  }, [slashCommands, showSlash, slashFilter]);

  const checkForAtMention = useCallback((val: string, cursorPos: number) => {
    let i = cursorPos - 1;
    while (i >= 0 && val[i] !== '@' && val[i] !== ' ' && val[i] !== '\n') i--;
    if (i >= 0 && val[i] === '@' && (i === 0 || val[i - 1] === ' ' || val[i - 1] === '\n')) {
      const query = val.slice(i + 1, cursorPos);
      setAtStart(i);
      if (cwd && query.length >= 0) {
        if (fileSearchTimer.current) clearTimeout(fileSearchTimer.current);
        fileSearchTimer.current = setTimeout(() => {
          searchFiles(cwd, query).then((results) => {
            setFileResults(results);
            setFileIdx(0);
            setShowFiles(results.length > 0);
          }).catch(() => setShowFiles(false));
        }, query.length === 0 ? 0 : 150);
        return;
      }
    }
    setShowFiles(false);
  }, [cwd]);

  const selectFile = useCallback((file: string) => {
    const el = textareaRef.current;
    if (!el || atStart < 0) return;
    const cursorPos = el.selectionStart ?? textRef.current.length;
    const val = el.value;
    const before = val.slice(0, atStart);
    const after = val.slice(cursorPos);
    const mention = "@" + file;
    const newText = before + mention + " " + after;
    el.value = newText;
    textRef.current = newText;
    setText(newText);
    setShowFiles(false);
    setAtStart(-1);
    setInlineFiles((prev) => new Set(prev).add(file));
    const pos = before.length + mention.length + 1;
    el.selectionStart = el.selectionEnd = pos;
    el.focus();
  }, [atStart]);

  const removeFile = useCallback((file: string) => {
    setInlineFiles((prev) => {
      const next = new Set(prev);
      next.delete(file);
      return next;
    });
    const el = textareaRef.current;
    if (el) {
      const val = el.value;
      const mention = "@" + file;
      const idx = val.indexOf(mention);
      if (idx >= 0) {
        let end = idx + mention.length;
        if (val[end] === " ") end++;
        const newVal = val.slice(0, idx) + val.slice(end);
        el.value = newVal;
        textRef.current = newVal;
        setText(newVal);
      }
    }
    textareaRef.current?.focus();
  }, []);

  // Sync overlay scroll with textarea
  const handleScroll = useCallback(() => {
    if (overlayRef.current && textareaRef.current) {
      overlayRef.current.scrollTop = textareaRef.current.scrollTop;
      overlayRef.current.scrollLeft = textareaRef.current.scrollLeft;
    }
  }, []);

  // onInput handler
  const handleInput = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    // Strip control characters
    const raw = el.value;
    const cleaned = raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
    if (cleaned !== raw) {
      const pos = el.selectionStart - (raw.length - cleaned.length);
      el.value = cleaned;
      el.selectionStart = el.selectionEnd = Math.max(0, pos);
    }
    const val = el.value;
    textRef.current = val;
    setText(val);
    // User typed — drop any in-flight partial base so the next voice partial
    // re-snapshots from the current (post-edit) textarea contents. Also clear
    // the tentative tail; once the user edits, it's semantically invalid.
    committedBaseRef.current = null;
    if (tentativeRef.current) setTentativeText("");

    // Prune inline files — check @file mentions
    setInlineFiles((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set<string>();
      for (const f of prev) {
        if (val.includes("@" + f)) next.add(f);
      }
      return next.size === prev.size ? prev : next;
    });

    // Detect slash commands
    if (val.startsWith("/")) {
      const query = val.slice(1);
      if (!query.includes(" ")) {
        setShowSlash(true);
        setSlashFilter(query);
        setSelectedIdx(0);
        setShowFiles(false);
        return;
      }
    }
    setShowSlash(false);

    const cursorPos = el.selectionStart ?? val.length;
    checkForAtMention(val, cursorPos);

    autoResize();
  }, [checkForAtMention, autoResize]);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (!onPasteImage) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) onPasteImage(file);
          return;
        }
      }
    },
    [onPasteImage]
  );

  const selectCommand = useCallback(
    (cmd: SlashCommand) => {
      setTextDirect("/" + cmd.name + " ");
      setShowSlash(false);
      textareaRef.current?.focus();
    },
    [setTextDirect]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (showFiles && fileResults.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setFileIdx((i) => Math.min(i + 1, fileResults.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setFileIdx((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
          e.preventDefault();
          if (fileIdx < fileResults.length) selectFile(fileResults[fileIdx]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setShowFiles(false);
          return;
        }
      }

      if (showSlash && filteredCommands.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSelectedIdx((i) => Math.min(i + 1, filteredCommands.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSelectedIdx((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
          e.preventDefault();
          if (selectedIdx < filteredCommands.length) selectCommand(filteredCommands[selectedIdx]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setShowSlash(false);
          return;
        }
      }

      if (e.key === "Escape" && isStreaming) {
        e.preventDefault();
        onCancel();
        return;
      }

      // Atomic deletion of @file mentions (Backspace: cursor inside or at end; Delete: cursor inside or at start)
      if ((e.key === "Backspace" || e.key === "Delete") && inlineFiles.size > 0) {
        const el = textareaRef.current;
        if (el && el.selectionStart === el.selectionEnd) {
          const pos = el.selectionStart;
          const val = el.value;
          for (const file of inlineFiles) {
            const mention = "@" + file;
            const idx = val.indexOf(mention);
            if (idx < 0) continue;
            const end = idx + mention.length;
            const hit = e.key === "Backspace"
              ? (pos > idx && pos <= end)
              : (pos >= idx && pos < end);
            if (hit) {
              e.preventDefault();
              let removeEnd = end;
              if (val[removeEnd] === " ") removeEnd++;
              const newVal = val.slice(0, idx) + val.slice(removeEnd);
              el.value = newVal;
              el.selectionStart = el.selectionEnd = idx;
              textRef.current = newVal;
              setText(newVal);
              setInlineFiles((prev) => {
                const next = new Set(prev);
                next.delete(file);
                return next;
              });
              return;
            }
          }
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend, showSlash, filteredCommands, selectedIdx, selectCommand, showFiles, fileResults, fileIdx, selectFile, isStreaming, onCancel, inlineFiles]
  );

  useEffect(() => {
    if (!showSlash || !slashRef.current) return;
    const items = slashRef.current.querySelectorAll(".cc-slash-item");
    items[selectedIdx]?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx, showSlash]);

  useEffect(() => {
    if (!showFiles || !fileRef.current) return;
    const items = fileRef.current.querySelectorAll(".cc-file-item");
    items[fileIdx]?.scrollIntoView({ block: "nearest" });
  }, [fileIdx, showFiles]);

  // Overlay only highlights @file mentions; tentative dictation text is
  // not rendered here (it stays in the store for the status badge).
  const overlayContent = useMemo(() => {
    const val = text;
    const hasAtMentions = inlineFiles.size > 0 && val.length > 0;
    if (!hasAtMentions) return null;

    // Build @mention ranges (only relevant if there are inlineFiles AND text).
    const ranges: { start: number; end: number; file: string }[] = [];
    if (hasAtMentions) {
      for (const file of inlineFiles) {
        const mention = "@" + file;
        let searchFrom = 0;
        while (true) {
          const idx = val.indexOf(mention, searchFrom);
          if (idx < 0) break;
          ranges.push({ start: idx, end: idx + mention.length, file });
          searchFrom = idx + mention.length;
        }
      }
      ranges.sort((a, b) => a.start - b.start);
    }

    const parts: React.ReactNode[] = [];
    if (val.length > 0) {
      let cursor = 0;
      for (const r of ranges) {
        if (r.start > cursor) {
          parts.push(<span key={`t${cursor}`} className="cc-dictation-committed">{val.slice(cursor, r.start)}</span>);
        }
        const mentionText = val.slice(r.start, r.end);
        parts.push(
          <span key={`f${r.start}`} className="cc-at-highlight">{mentionText}</span>
        );
        cursor = r.end;
      }
      if (cursor < val.length) {
        parts.push(<span key={`t${cursor}`} className="cc-dictation-committed">{val.slice(cursor)}</span>);
      }
    }
    // Trailing space to match textarea (so overlay doesn't shift)
    parts.push(<span key="tail">{" "}</span>);
    return parts.length > 0 ? parts : null;
  }, [text, inlineFiles]);

  // Image thumbnails for @-mentioned images
  const imageFiles = useMemo(() => {
    return [...inlineFiles].filter((f) => IMAGE_EXTS.test(f) && imagePreviews[f]);
  }, [inlineFiles, imagePreviews]);

  return (
    <div className="cc-input-container">

      {showSlash && filteredCommands.length > 0 && (
        <div className="cc-slash-menu" ref={slashRef}>
          {filteredCommands.map((cmd, i) => (
            <button
              key={cmd.name}
              className={`cc-slash-item ${i === selectedIdx ? "cc-slash-item--active" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                selectCommand(cmd);
              }}
            >
              <div className="cc-slash-row">
                <span className="cc-slash-name">/{cmd.name}</span>
                {cmd.description && (
                  <span className="cc-slash-desc">{cmd.description}</span>
                )}
                {cmd.source && cmd.source !== "unknown" && cmd.source !== "built-in" && (
                  <span className="cc-slash-source">{cmd.source}</span>
                )}
              </div>
              {i === selectedIdx && cmd.usage && (
                <div className="cc-slash-usage">{cmd.usage}</div>
              )}
            </button>
          ))}
        </div>
      )}

      {showFiles && fileResults.length > 0 && (
        <div className="cc-slash-menu" ref={fileRef}>
          {fileResults.map((file, i) => (
            <button
              key={file}
              className={`cc-file-item ${i === fileIdx ? "cc-file-item--active" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                selectFile(file);
              }}
            >
              <span className="cc-file-icon">@</span>
              <span className="cc-file-path">{file}</span>
            </button>
          ))}
        </div>
      )}

      {/* Image thumbnails for @-mentioned images */}
      {imageFiles.length > 0 && (
        <div className="cc-image-strip">
          {imageFiles.map((file) => (
            <div key={file} className="cc-image-thumb" onClick={() => removeFile(file)} title={`@${file} — click to remove`}>
              <img src={imagePreviews[file]} alt="" />
              <div className="cc-image-thumb-x">&times;</div>
            </div>
          ))}
        </div>
      )}

      <div className="cc-toolbar">
          {text.trim() && onRewrite && (
            <button
              className={`cc-toolbar-btn ${isRewriting ? "cc-toolbar-btn--active" : ""}`}
              onClick={() => onRewrite(getTextDirect(), (t: string) => setTextDirect(t))}
              disabled={isRewriting || !text.trim()}
              title="AI Rewrite (enhance prompt)"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M6 1L7 4L10 4.5L7.5 7L8.5 11L6 9L3.5 11L4.5 7L2 4.5L5 4L6 1Z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" fill={isRewriting ? "currentColor" : "none"}/>
              </svg>
              <span>{isRewriting ? "Rewriting..." : "Rewrite"}</span>
            </button>
          )}
        </div>

      <div
        className={`cc-input-wrap ${isStreaming ? "cc-input-wrap--streaming" : ""} ${isDictating ? "cc-input-wrap--dictating" : ""} ${isRewriting ? "cc-input-wrap--rewriting" : ""}`}
        style={accentColor ? { ['--beam-color' as string]: accentColor } as React.CSSProperties : undefined}
      >
        <svg className="cc-beam-svg" aria-hidden="true" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <filter id="cc-beam-blur" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="3" />
            </filter>
          </defs>
          <rect className="cc-beam-halo" x="0" y="0" width="100%" height="100%" rx="6" ry="6" pathLength="100" vectorEffect="non-scaling-stroke" filter="url(#cc-beam-blur)" />
          <rect className="cc-beam-mid" x="0" y="0" width="100%" height="100%" rx="6" ry="6" pathLength="100" vectorEffect="non-scaling-stroke" />
          <rect className="cc-beam-core" x="0" y="0" width="100%" height="100%" rx="6" ry="6" pathLength="100" vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="cc-input-row">
          <span className="cc-prompt">&gt;</span>
          <div className="cc-textarea-wrap">
            {isDictating && (
              <svg
                className="cc-waveform"
                viewBox="0 0 400 40"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <path ref={waveformPathRef} d="M 0 20 L 400 20" />
              </svg>
            )}
            {isRewriting && (
              <div className="cc-rewriting" aria-hidden="true">
                <svg
                  className="cc-rewriting-ring"
                  viewBox="0 0 32 32"
                  width="24"
                  height="24"
                >
                  <circle cx="16" cy="16" r="12" className="cc-rewriting-track" />
                  <circle cx="16" cy="16" r="12" className="cc-rewriting-fill" />
                </svg>
              </div>
            )}
            {/* Styled overlay — renders behind the textarea */}
            {overlayContent && (
              <div ref={overlayRef} className="cc-textarea-overlay" aria-hidden="true">
                {overlayContent}
              </div>
            )}
            <textarea
              ref={textareaRef}
              className={`cc-textarea ${overlayContent ? "cc-textarea--has-overlay" : ""}`}
              defaultValue={draftPrompt || ""}
              onInput={handleInput}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              onScroll={handleScroll}
              placeholder={isStreaming ? "Queue a message..." : "Type a message, / for commands, @ for files"}
              rows={1}
              disabled={disabled}
              onBlur={() => {
                if (blurTimer.current) clearTimeout(blurTimer.current);
                blurTimer.current = setTimeout(() => { setShowSlash(false); setShowFiles(false); }, 200);
              }}
            />
          </div>
          {sessionName && (
            <span className="cc-session-badge">{sessionName}</span>
          )}
          {onAttach && (
            <button
              className="cc-attach-btn"
              onClick={onAttach}
              title="Attach files"
              type="button"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M7 1V10M7 1L4 4M7 1L10 4M2 9V12H12V9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          )}
          {isStreaming && (
            <button
              className="cc-cancel-btn-inline"
              onClick={onCancel}
              title="Cancel (Esc)"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <rect x="2" y="2" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.5"/>
              </svg>
            </button>
          )}
        </div>
      </div>

      <div className="cc-status-line">
        <div className="cc-status-left">
          {isStreaming ? (
            <>
              <span className="cc-streaming-dot" />
              <span className="cc-streaming-label">Thinking{elapsed ? ` · ${elapsed}` : "..."}</span>
              {(queueCount ?? 0) > 0 && <span className="cc-queue-badge">{queueCount} queued</span>}
            </>
          ) : permLabel ? (
            <span className="cc-perm-line" onClick={onCyclePerm} title="Click or Shift+Tab to cycle">
              <span className="cc-perm-chevrons" style={{ color: permColor }}>&#x203a;&#x203a;</span>
              {" "}{permLabel}{" "}
              <span className="cc-perm-hint">(shift+tab to cycle)</span>
            </span>
          ) : null}
        </div>
        {contextPct != null && contextPct > 0 && (
          <div className="cc-status-right">
            <span className={`cc-ctx-badge ${contextPct >= 80 ? "cc-ctx-badge--warn" : ""}`}>
              Context {contextPct}%
            </span>
            {autoCompactAt != null && autoCompactAt > 0 && (
              <span className="cc-ctx-compact-hint">Auto compact at {autoCompactAt}%</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
