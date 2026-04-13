import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { SlashCommand } from "../../lib/types";
import { searchFiles } from "../../lib/tauriApi";

interface ChatInputProps {
  onSend: (text: string) => void;
  onCancel: () => void;
  onAttach?: () => void;
  onRewrite?: (text: string, setText: (t: string) => void) => void;
  isRewriting?: boolean;
  isStreaming: boolean;
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
}

export default function ChatInput({ onSend, onCancel, onAttach, onRewrite, isRewriting, isStreaming, streamingStartedAt, disabled, slashCommands, initialText, onInitialTextConsumed, permLabel, permColor, onCyclePerm, sessionName, cwd, queueCount, draftPrompt, onDraftChange, onPasteImage }: ChatInputProps) {
  const [text, setText] = useState(draftPrompt || "");
  const [elapsed, setElapsed] = useState("");

  // Save draft prompt debounced
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!onDraftChange) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => onDraftChange(text), 1000);
    return () => { if (draftTimer.current) clearTimeout(draftTimer.current); };
  }, [text, onDraftChange]);

  useEffect(() => {
    return () => { if (blurTimer.current) clearTimeout(blurTimer.current); };
  }, []);

  // Thinking timer — ticks every second while streaming
  useEffect(() => {
    if (!isStreaming || !streamingStartedAt) { setElapsed(""); return; }
    const tick = () => {
      const secs = Math.floor((Date.now() - streamingStartedAt) / 1000);
      if (secs < 60) setElapsed(`${secs}s`);
      else setElapsed(`${Math.floor(secs / 60)}m ${secs % 60}s`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [isStreaming, streamingStartedAt]);

  // Handle pre-filled text from rewind
  useEffect(() => {
    if (initialText) {
      setText(initialText);
      textareaRef.current?.focus();
      onInitialTextConsumed?.();
    }
  }, [initialText]);
  const [showSlash, setShowSlash] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  // @ file autocomplete
  const [showFiles, setShowFiles] = useState(false);
  const [fileResults, setFileResults] = useState<string[]>([]);
  const [fileIdx, setFileIdx] = useState(0);
  const [atStart, setAtStart] = useState(-1); // cursor position of the @
  const fileSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const slashRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLDivElement>(null);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText("");
    setShowSlash(false);
    setShowFiles(false);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [text, disabled, onSend]);

  const filteredCommands = useMemo(() => {
    if (!slashCommands || !showSlash) return [];
    if (!slashFilter) return slashCommands;
    const lower = slashFilter.toLowerCase();
    return slashCommands.filter(
      (c) => c.name.toLowerCase().includes(lower) || c.description.toLowerCase().includes(lower)
    );
  }, [slashCommands, showSlash, slashFilter]);

  // Detect @ file references in the text
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
    if (atStart < 0) return;
    const cursorPos = textareaRef.current?.selectionStart ?? text.length;
    const before = text.slice(0, atStart);
    const after = text.slice(cursorPos);
    setText(before + file + " " + after);
    setShowFiles(false);
    setAtStart(-1);
    textareaRef.current?.focus();
  }, [text, atStart]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const val = e.target.value;
      setText(val);

      // Detect slash command typing
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

      // Check for @ file mention
      const cursorPos = e.target.selectionStart ?? val.length;
      checkForAtMention(val, cursorPos);
    },
    [checkForAtMention]
  );

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
      setText("/" + cmd.name + " ");
      setShowSlash(false);
      textareaRef.current?.focus();
    },
    []
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // @ file autocomplete navigation
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

      // Slash command navigation
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

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend, showSlash, filteredCommands, selectedIdx, selectCommand, showFiles, fileResults, fileIdx, selectFile, isStreaming, onCancel]
  );

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 150) + "px";
  }, [text]);

  // Scroll selected slash item into view
  useEffect(() => {
    if (!showSlash || !slashRef.current) return;
    const items = slashRef.current.querySelectorAll(".cc-slash-item");
    items[selectedIdx]?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx, showSlash]);

  // Scroll selected file item into view
  useEffect(() => {
    if (!showFiles || !fileRef.current) return;
    const items = fileRef.current.querySelectorAll(".cc-file-item");
    items[fileIdx]?.scrollIntoView({ block: "nearest" });
  }, [fileIdx, showFiles]);

  return (
    <div className="cc-input-container">
      {/* Slash command autocomplete */}
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

      {/* @ file autocomplete */}
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

      {/* Toolbar */}
      {text.trim() && onRewrite && (
        <div className="cc-toolbar">
          <button
            className={`cc-toolbar-btn ${isRewriting ? "cc-toolbar-btn--active" : ""}`}
            onClick={() => onRewrite(text, setText)}
            disabled={isRewriting || !text.trim()}
            title="AI Rewrite (enhance prompt)"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M6 1L7 4L10 4.5L7.5 7L8.5 11L6 9L3.5 11L4.5 7L2 4.5L5 4L6 1Z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" fill={isRewriting ? "currentColor" : "none"}/>
            </svg>
            <span>{isRewriting ? "Rewriting..." : "Rewrite"}</span>
          </button>
        </div>
      )}

      {/* Input row — CLI-style with > prompt */}
      <div className="cc-input-row" style={{ position: "relative" }}>
        <span className="cc-prompt">&gt;</span>
        <textarea
          ref={textareaRef}
          className="cc-textarea"
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={isStreaming ? "Queue a message..." : "Type a message, / for commands, @ for files"}
          rows={1}
          disabled={disabled}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onBlur={() => {
            if (blurTimer.current) clearTimeout(blurTimer.current);
            blurTimer.current = setTimeout(() => { setShowSlash(false); setShowFiles(false); }, 200);
          }}
        />
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

      {/* Status line below input — permission mode + streaming + context bar */}
      <div className="cc-status-line">
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
    </div>
  );
}
