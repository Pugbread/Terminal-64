import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  countLanguageDiagnosticErrors,
  getLanguageDiagnosticsCapability,
  languageDiagnosticStatusLabel,
  lintLanguageFile,
  type LanguageDiagnosticRunResult,
  type LanguageDiagnosticStatus,
} from "../lib/languageDiagnostics";

interface UseEditorLanguageDiagnosticsOptions {
  filePath: string;
  cwd?: string | undefined;
  debounceMs?: number;
  onResult: (result: LanguageDiagnosticRunResult) => void;
  onUnavailable: () => void;
  logPrefix?: string;
}

interface UseEditorLanguageDiagnosticsResult {
  status: LanguageDiagnosticStatus;
  label: string | null;
  markerOwner: string | null;
  requestDiagnostics: (content: string) => void;
  clearScheduledDiagnostics: () => void;
}

export function useEditorLanguageDiagnostics({
  filePath,
  cwd,
  debounceMs = 700,
  onResult,
  onUnavailable,
  logPrefix = "[language-diagnostics]",
}: UseEditorLanguageDiagnosticsOptions): UseEditorLanguageDiagnosticsResult {
  const capability = useMemo(() => getLanguageDiagnosticsCapability(filePath), [filePath]);
  const runRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const [status, setStatus] = useState<LanguageDiagnosticStatus>({
    state: capability ? "checking" : "idle",
    count: 0,
    errorCount: 0,
  });

  const clearScheduledDiagnostics = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  useEffect(() => {
    setStatus({ state: capability ? "checking" : "idle", count: 0, errorCount: 0 });
    return () => {
      clearScheduledDiagnostics();
      runRef.current += 1;
    };
  }, [capability, clearScheduledDiagnostics, filePath]);

  const requestDiagnostics = useCallback((content: string) => {
    if (!capability) return;
    clearScheduledDiagnostics();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      const runId = runRef.current + 1;
      runRef.current = runId;
      setStatus({ state: "checking", count: 0, errorCount: 0 });
      lintLanguageFile(filePath, content, cwd)
        .then((result) => {
          if (runRef.current !== runId || !result) return;
          onResult(result);
          const errorCount = countLanguageDiagnosticErrors(result.diagnostics);
          setStatus(
            result.diagnostics.length > 0
              ? { state: "issues", count: result.diagnostics.length, errorCount }
              : { state: "clean", count: 0, errorCount: 0 },
          );
        })
        .catch((error) => {
          if (runRef.current !== runId) return;
          console.warn(`${logPrefix} ${capability.label} diagnostics failed:`, error);
          onUnavailable();
          setStatus({ state: "unavailable", count: 0, errorCount: 0 });
        });
    }, debounceMs);
  }, [capability, clearScheduledDiagnostics, cwd, debounceMs, filePath, logPrefix, onResult, onUnavailable]);

  const label = useMemo(
    () => languageDiagnosticStatusLabel(capability, status),
    [capability, status],
  );

  return {
    status,
    label,
    markerOwner: capability?.markerOwner ?? null,
    requestDiagnostics,
    clearScheduledDiagnostics,
  };
}
