import { useCallback, useLayoutEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import { useThemeStore } from "../../stores/themeStore";
import { isAbsolutePath, joinPath } from "../../lib/platform";
import { languageDiagnosticsToMonacoMarkers, type LanguageDiagnosticRunResult } from "../../lib/languageDiagnostics";
import { clearLuauModelContext, registerLuauMonacoLanguage, setLuauModelContext } from "../../lib/luauMonacoLanguage";
import { useEditorLanguageDiagnostics } from "../../hooks/useLanguageDiagnostics";

export interface ChatEditOverlayState {
  tcId: string;
  filePath: string;
  fullContent: string;
  changedLines: Set<number>;
}

interface UseChatEditOverlayOptions {
  effectiveCwd: string | undefined;
  getScrollEl: () => HTMLDivElement | null;
  readFileContent: (filePath: string) => Promise<string>;
}

interface ChatEditOverlayProps {
  overlay: ChatEditOverlayState;
  saveFileContent: (filePath: string, content: string) => Promise<void>;
  rememberContent: (tcId: string, content: string) => void;
  onClose: (content: string | null) => void;
  cwd?: string | undefined;
}

let monacoThemeForBg = "";

function changedLinesFor(content: string, changedText: string): Set<number> {
  const exact = changedLinesFromExactText(content, changedText);
  if (exact.size > 0) return exact;

  const unified = changedLinesFromUnifiedDiff(changedText);
  if (unified.size > 0) return unified;

  return changedLinesFromAddedDiffText(content, changedText);
}

function changedLinesFromExactText(content: string, changedText: string): Set<number> {
  const changed = new Set<number>();
  if (!changedText) return changed;
  const idx = content.indexOf(changedText);
  if (idx < 0) return changed;

  const startLine = content.substring(0, idx).split("\n").length;
  const numLines = changedText.split("\n").length;
  for (let i = 0; i < numLines; i += 1) changed.add(startLine + i);
  return changed;
}

function changedLinesFromUnifiedDiff(diff: string): Set<number> {
  const changed = new Set<number>();
  let newLine: number | null = null;
  for (const line of diff.split("\n")) {
    const header = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      newLine = Number(header[1]);
      continue;
    }
    if (newLine === null) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      changed.add(newLine);
      newLine += 1;
      continue;
    }
    if (line.startsWith(" ") || line === "") {
      newLine += 1;
    }
  }
  return changed;
}

function changedLinesFromAddedDiffText(content: string, diff: string): Set<number> {
  const changed = new Set<number>();
  const contentLines = content.split("\n");
  const addedLines = diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1));
  let searchStart = 0;
  for (const added of addedLines) {
    const idx = contentLines.findIndex((line, lineIdx) => lineIdx >= searchStart && line === added);
    if (idx >= 0) {
      changed.add(idx + 1);
      searchStart = idx + 1;
    }
  }
  return changed;
}

function guessLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    rs: "rust", py: "python", go: "go", java: "java", json: "json",
    css: "css", scss: "scss", html: "html", md: "markdown", yaml: "yaml",
    yml: "yaml", toml: "toml", sh: "shell", bash: "shell", zsh: "shell",
    sql: "sql", xml: "xml", swift: "swift", kt: "kotlin", rb: "ruby",
    c: "c", cpp: "cpp", h: "c", hpp: "cpp", lua: "lua", luau: "lua",
  };
  return map[ext] || "plaintext";
}

export function useChatEditOverlay({
  effectiveCwd,
  getScrollEl,
  readFileContent,
}: UseChatEditOverlayOptions) {
  const [editOverlay, setEditOverlay] = useState<ChatEditOverlayState | null>(null);
  const editOverrides = useRef<Record<string, string>>({});
  const savedScrollTop = useRef<number>(0);

  const rememberScrollPosition = useCallback(() => {
    const el = getScrollEl();
    if (el) savedScrollTop.current = el.scrollTop;
  }, [getScrollEl]);

  const restoreScrollPosition = useCallback(() => {
    requestAnimationFrame(() => {
      const el = getScrollEl();
      if (el) el.scrollTop = savedScrollTop.current;
    });
  }, [getScrollEl]);

  const rememberContent = useCallback((tcId: string, content: string) => {
    editOverrides.current[tcId] = content;
  }, []);

  const openEditOverlay = useCallback(async (tcId: string, filePath: string, _oldStr: string, newStr: string) => {
    const resolvedFilePath = filePath && !isAbsolutePath(filePath) && effectiveCwd
      ? joinPath(effectiveCwd, filePath)
      : filePath;

    rememberScrollPosition();

    const cached = editOverrides.current[tcId];
    if (cached) {
      setEditOverlay({
        tcId,
        filePath: resolvedFilePath,
        fullContent: cached,
        changedLines: changedLinesFor(cached, newStr),
      });
      return;
    }

    try {
      const content = await readFileContent(resolvedFilePath);
      setEditOverlay({
        tcId,
        filePath: resolvedFilePath,
        fullContent: content,
        changedLines: changedLinesFor(content, newStr),
      });
    } catch {
      const lines = newStr.split("\n");
      setEditOverlay({
        tcId,
        filePath: resolvedFilePath,
        fullContent: newStr,
        changedLines: new Set(lines.map((_, i) => i + 1)),
      });
    }
  }, [effectiveCwd, readFileContent, rememberScrollPosition]);

  const openFileOverlay = useCallback(async (filePath: string) => {
    rememberScrollPosition();
    try {
      const content = await readFileContent(filePath);
      setEditOverlay({ tcId: `file:${filePath}`, filePath, fullContent: content, changedLines: new Set() });
    } catch (e) {
      console.warn("[claude] Failed to read file for preview:", e);
    }
  }, [readFileContent, rememberScrollPosition]);

  const closeEditOverlay = useCallback((content: string | null) => {
    if (content !== null && editOverlay) {
      editOverrides.current[editOverlay.tcId] = content;
    }
    setEditOverlay(null);
    restoreScrollPosition();
  }, [editOverlay, restoreScrollPosition]);

  return {
    editOverlay,
    openEditOverlay,
    openFileOverlay,
    rememberContent,
    closeEditOverlay,
  };
}

export default function ChatEditOverlay({
  overlay,
  saveFileContent,
  rememberContent,
  onClose,
  cwd,
}: ChatEditOverlayProps) {
  const modifiedEditorRef = useRef<import("monaco-editor").editor.IStandaloneCodeEditor | null>(null);
  const diagnosticTargetRef = useRef<{
    monaco: typeof import("monaco-editor");
    model: import("monaco-editor").editor.ITextModel;
    markerOwner: string;
  } | null>(null);
  const editorSavedVersionId = useRef<number>(0);
  const [editorDirty, setEditorDirty] = useState(false);
  const [editorSaving, setEditorSaving] = useState(false);
  const [editorSaveError, setEditorSaveError] = useState<string | null>(null);
  const [monacoOverflowRoot] = useState<HTMLElement | null>(() => {
    if (typeof document === "undefined") return null;
    const node = document.createElement("div");
    node.className = "cc-monaco-overflow-root monaco-editor vs-dark";
    node.setAttribute("data-terminal64", "monaco-overflow-root");
    return node;
  });

  useLayoutEffect(() => {
    if (!monacoOverflowRoot) return;
    document.body.appendChild(monacoOverflowRoot);
    return () => {
      monacoOverflowRoot.remove();
    };
  }, [monacoOverflowRoot]);

  const clearDiagnosticMarkers = useCallback(() => {
    const target = diagnosticTargetRef.current;
    if (target) target.monaco.editor.setModelMarkers(target.model, target.markerOwner, []);
  }, []);

  const applyDiagnosticMarkers = useCallback((result: LanguageDiagnosticRunResult) => {
    const target = diagnosticTargetRef.current;
    if (!target) return;
    target.monaco.editor.setModelMarkers(
      target.model,
      result.markerOwner,
      languageDiagnosticsToMonacoMarkers(target.monaco, result),
    );
  }, []);

  const {
    status: diagnosticsStatus,
    label: diagnosticsLabel,
    markerOwner: diagnosticsMarkerOwner,
    requestDiagnostics,
    clearScheduledDiagnostics,
  } = useEditorLanguageDiagnostics({
    filePath: overlay.filePath,
    cwd,
    onResult: applyDiagnosticMarkers,
    onUnavailable: clearDiagnosticMarkers,
    logPrefix: "[chat-edit-overlay]",
  });

  const handleSave = useCallback(async () => {
    const editor = modifiedEditorRef.current;
    const model = editor?.getModel();
    if (!editor || !model || !editorDirty || editorSaving) return;

    const content = editor.getValue();
    setEditorSaving(true);
    setEditorSaveError(null);
    try {
      await saveFileContent(overlay.filePath, content);
      rememberContent(overlay.tcId, content);
      editorSavedVersionId.current = model.getAlternativeVersionId();
      setEditorDirty(false);
    } catch (error) {
      setEditorSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setEditorSaving(false);
    }
  }, [editorDirty, editorSaving, overlay.filePath, overlay.tcId, rememberContent, saveFileContent]);

  const handleClose = useCallback(() => {
    onClose(null);
  }, [onClose]);

  const diagnosticsTone =
    diagnosticsStatus.state === "issues"
      ? diagnosticsStatus.errorCount > 0 ? "error" : "neutral"
      : diagnosticsStatus.state;

  const saveStateClass = editorSaveError
    ? "cc-edit-overlay-tag--save-error"
    : editorSaving
      ? "cc-edit-overlay-tag--saving"
      : editorDirty
        ? "cc-edit-overlay-tag--unsaved"
        : "cc-edit-overlay-tag--saved";
  const saveStateLabel = editorSaveError
    ? "Save failed"
    : editorSaving
      ? "Saving..."
      : editorDirty
        ? "Unsaved"
        : "Saved";

  return (
    <div className="cc-messages cc-edit-overlay">
      <div className="cc-edit-overlay-header">
        <span className="cc-edit-overlay-path">{overlay.filePath}</span>
        <div className="cc-edit-overlay-actions">
          {diagnosticsLabel && (
            <span className={`cc-edit-overlay-tag cc-edit-overlay-tag--lint cc-edit-overlay-tag--lint-${diagnosticsTone}`}>
              {diagnosticsLabel}
            </span>
          )}
          <span className={`cc-edit-overlay-tag ${saveStateClass}`} title={editorSaveError ?? undefined}>{saveStateLabel}</span>
          <button className="cc-edit-overlay-btn cc-edit-overlay-save" onClick={handleSave} disabled={!editorDirty || editorSaving}><svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M12.5 2H3.5C2.67 2 2 2.67 2 3.5V12.5C2 13.33 2.67 14 3.5 14H12.5C13.33 14 14 13.33 14 12.5V3.5C14 2.67 13.33 2 12.5 2ZM8 12C6.9 12 6 11.1 6 10S6.9 8 8 8S10 8.9 10 10S9.1 12 8 12ZM11 6H4V3H11V6Z" fill="currentColor"/></svg></button>
          <button className="cc-edit-overlay-btn cc-edit-overlay-close" onClick={handleClose}>Close</button>
        </div>
      </div>
      <div className="cc-edit-overlay-editor">
        <Editor
          key={overlay.tcId}
          value={overlay.fullContent}
          language={guessLanguage(overlay.filePath)}
          theme="terminal64"
          beforeMount={(monaco) => {
            registerLuauMonacoLanguage(monaco);
            const ui = useThemeStore.getState().currentTheme.ui;
            if (monacoThemeForBg !== ui.bg) {
              monaco.editor.defineTheme("terminal64", {
                base: "vs-dark",
                inherit: true,
                rules: [
                  { token: "keyword", foreground: "89b4fa" },
                  { token: "type", foreground: "89dceb" },
                  { token: "class", foreground: "89dceb" },
                  { token: "enum", foreground: "89dceb" },
                  { token: "interface", foreground: "89dceb" },
                  { token: "struct", foreground: "89dceb" },
                  { token: "typeParameter", foreground: "f9e2af" },
                  { token: "function", foreground: "cba6f7" },
                  { token: "method", foreground: "cba6f7" },
                  { token: "property", foreground: "a6e3a1" },
                  { token: "enumMember", foreground: "a6e3a1" },
                  { token: "parameter", foreground: "f9e2af" },
                  { token: "variable", foreground: "cdd6f4" },
                  { token: "comment", foreground: "6a9955" },
                  { token: "string", foreground: "a6e3a1" },
                  { token: "number", foreground: "fab387" },
                  { token: "operator", foreground: "89dceb" },
                ],
                colors: {
                  "editor.background": ui.bg,
                  "editor.foreground": ui.fg,
                  "editorLineNumber.foreground": ui.fgMuted,
                  "editor.selectionBackground": ui.accent + "44",
                  "editor.lineHighlightBackground": ui.bgSecondary,
                  "editorWidget.background": ui.bgSecondary,
                  "editorWidget.border": ui.border,
                },
              });
              monacoThemeForBg = ui.bg;
            }
          }}
          onMount={(editor, monaco) => {
            modifiedEditorRef.current = editor;
            editorSavedVersionId.current = editor.getModel()!.getAlternativeVersionId();
            setEditorDirty(false);
            const model = editor.getModel();
            if (model && diagnosticsMarkerOwner) {
              diagnosticTargetRef.current = {
                monaco,
                model,
                markerOwner: diagnosticsMarkerOwner,
              };
              setLuauModelContext(model, { filePath: overlay.filePath, cwd });
            }
            const scheduleDiagnostics = () => requestDiagnostics(editor.getValue());
            const editorDomNode = editor.getDomNode();
            const handleEditorHistoryKey = (event: KeyboardEvent) => {
              const key = event.key.toLowerCase();
              const mod = event.metaKey || event.ctrlKey;
              const undo = mod && !event.altKey && !event.shiftKey && key === "z";
              const redo = mod && !event.altKey && ((event.shiftKey && key === "z") || (!event.shiftKey && key === "y"));
              if (!undo && !redo) return;

              event.preventDefault();
              event.stopPropagation();
              editor.trigger("keyboard", undo ? "undo" : "redo", null);
            };
            editorDomNode?.addEventListener("keydown", handleEditorHistoryKey, true);

            if (overlay.changedLines.size > 0) {
              editor.createDecorationsCollection(
                [...overlay.changedLines].map((line) => ({
                  range: new monaco.Range(line, 1, line, 1),
                  options: {
                    isWholeLine: true,
                    className: "cc-editor-changed-line",
                    glyphMarginClassName: "cc-editor-changed-gutter",
                  },
                }))
              );
              const sorted = [...overlay.changedLines].sort((a, b) => a - b);
              const mid = sorted[Math.floor(sorted.length / 2)];
              if (mid !== undefined) {
                requestAnimationFrame(() => {
                  editor.revealLineInCenter(mid, monaco.editor.ScrollType.Immediate);
                });
              }
            }

            editor.onDidChangeModelContent(() => {
              setEditorSaveError(null);
              setEditorDirty(editor.getModel()!.getAlternativeVersionId() !== editorSavedVersionId.current);
              scheduleDiagnostics();
            });
            editor.onDidDispose(() => {
              editorDomNode?.removeEventListener("keydown", handleEditorHistoryKey, true);
              clearScheduledDiagnostics();
              clearDiagnosticMarkers();
              const model = editor.getModel();
              if (model) clearLuauModelContext(model);
              diagnosticTargetRef.current = null;
            });
            scheduleDiagnostics();
          }}
          options={{
            minimap: { enabled: false },
            fontSize: 12,
            fontFamily: "'Cascadia Code', Consolas, monospace",
            scrollBeyondLastLine: false,
            lineNumbers: "on",
            lineNumbersMinChars: 3,
            wordWrap: "on",
            glyphMargin: false,
            folding: false,
            lineDecorationsWidth: 6,
            renderLineHighlight: "none",
            padding: { top: 8, bottom: 8 },
            quickSuggestions: { other: true, comments: false, strings: false },
            suggestOnTriggerCharacters: true,
            hover: { enabled: true },
            parameterHints: { enabled: true },
            "semanticHighlighting.enabled": true,
            fixedOverflowWidgets: Boolean(monacoOverflowRoot),
            ...(monacoOverflowRoot ? { overflowWidgetsDomNode: monacoOverflowRoot } : {}),
          }}
        />
      </div>
    </div>
  );
}
