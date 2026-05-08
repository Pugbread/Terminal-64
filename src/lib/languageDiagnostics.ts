import { lintLuauFile } from "./tauriApi";
import { isAbsolutePath, joinPath } from "./platform";
import type { LuauDiagnostic, LuauLintResult } from "./types";

export type LanguageDiagnosticId = "luau";
export type LanguageDiagnostic = LuauDiagnostic;
export type LanguageDiagnosticStatusState = "idle" | "checking" | "clean" | "issues" | "unavailable";

export interface LanguageDiagnosticStatus {
  state: LanguageDiagnosticStatusState;
  count: number;
  errorCount: number;
}

export interface LanguageDiagnosticsCapability {
  id: LanguageDiagnosticId;
  label: string;
  extensions: readonly string[];
  markerOwner: string;
}

export interface LanguageDiagnosticRunResult extends LuauLintResult {
  languageId: LanguageDiagnosticId;
  label: string;
  markerOwner: string;
}

export interface LanguageDiagnosticBadge {
  visible: boolean;
  label: string;
  title: string;
  tone: "error" | "neutral";
  displayCount: number;
  errorCount: number;
  totalCount: number;
}

export interface LanguageDiagnosticBatchResult {
  paths: string[];
  diagnostics: LanguageDiagnostic[];
}

const LUAU_DIAGNOSTICS: LanguageDiagnosticsCapability = {
  id: "luau",
  label: "Luau",
  extensions: [".luau", ".lua"],
  markerOwner: "terminal64-luau",
};

export const LANGUAGE_DIAGNOSTICS_CAPABILITIES: readonly LanguageDiagnosticsCapability[] = [
  LUAU_DIAGNOSTICS,
];

function extensionFor(filePath: string): string {
  const lower = filePath.toLowerCase();
  const slashIndex = Math.max(lower.lastIndexOf("/"), lower.lastIndexOf("\\"));
  const fileName = lower.slice(slashIndex + 1);
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex >= 0 ? fileName.slice(dotIndex) : "";
}

export function getLanguageDiagnosticsCapability(filePath: string): LanguageDiagnosticsCapability | null {
  const extension = extensionFor(filePath);
  return LANGUAGE_DIAGNOSTICS_CAPABILITIES.find((capability) =>
    capability.extensions.includes(extension)
  ) ?? null;
}

export function supportsLanguageDiagnostics(filePath: string): boolean {
  return getLanguageDiagnosticsCapability(filePath) !== null;
}

export function resolveLanguageDiagnosticPath(path: string, cwd: string): string {
  if (!path || isAbsolutePath(path) || !cwd || cwd === ".") return path;
  return joinPath(cwd, path);
}

export function resolveLanguageDiagnosticPaths(paths: string[], cwd: string): string[] {
  return [...new Set(
    paths
      .map((path) => resolveLanguageDiagnosticPath(path, cwd))
      .filter(supportsLanguageDiagnostics),
  )];
}

export async function lintLanguageFile(
  path: string,
  content?: string,
  cwd?: string,
): Promise<LanguageDiagnosticRunResult | null> {
  const capability = getLanguageDiagnosticsCapability(path);
  if (!capability) return null;

  switch (capability.id) {
    case "luau": {
      const result = await lintLuauFile(path, content, cwd);
      return {
        ...result,
        languageId: capability.id,
        label: capability.label,
        markerOwner: capability.markerOwner,
      };
    }
  }
}

export async function lintLanguageFiles(paths: string[], cwd: string): Promise<LanguageDiagnosticBatchResult> {
  const diagnosticPaths = resolveLanguageDiagnosticPaths(paths, cwd);
  if (diagnosticPaths.length === 0) return { paths: [], diagnostics: [] };

  const groups = await Promise.all(
    diagnosticPaths.map((path) =>
      lintLanguageFile(path, undefined, cwd)
        .then((result) => result?.diagnostics ?? [])
        .catch((error) => {
          console.warn("[language-diagnostics] Diagnostics failed:", error);
          return [] as LanguageDiagnostic[];
        })
    ),
  );

  return {
    paths: diagnosticPaths,
    diagnostics: groups.flat(),
  };
}

export function mergeLanguageDiagnosticsForPaths(
  existing: LanguageDiagnostic[],
  paths: string[],
  diagnostics: LanguageDiagnostic[],
): LanguageDiagnostic[] {
  const changed = new Set(paths);
  return [
    ...existing.filter((diagnostic) => !changed.has(diagnostic.path)),
    ...diagnostics,
  ];
}

export function languageDiagnosticTitle(diagnostics: LanguageDiagnostic[], label = "Diagnostics"): string {
  if (diagnostics.length === 0) return `No ${label} diagnostics`;
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  const warnings = diagnostics.length - errors;
  const summary = [
    `${label} diagnostics`,
    errors > 0 ? `${errors} error${errors === 1 ? "" : "s"}` : "",
    warnings > 0 ? `${warnings} warning${warnings === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(" · ");
  const details = diagnostics.slice(0, 6).map((diagnostic) => {
    const file = diagnostic.path.split(/[\\/]/).pop() || diagnostic.path;
    return `${file}:${diagnostic.line}:${diagnostic.startColumn} ${diagnostic.code}: ${diagnostic.message}`;
  });
  const suffix = diagnostics.length > details.length ? [`+${diagnostics.length - details.length} more`] : [];
  return [summary, ...details, ...suffix].join("\n");
}

export function countLanguageDiagnosticErrors(diagnostics: LanguageDiagnostic[]): number {
  return diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
}

export function languageDiagnosticBadge(diagnostics: LanguageDiagnostic[], label = "Luau"): LanguageDiagnosticBadge {
  const errorCount = countLanguageDiagnosticErrors(diagnostics);
  return {
    visible: diagnostics.length > 0,
    label,
    title: languageDiagnosticTitle(diagnostics, label),
    tone: "neutral",
    displayCount: diagnostics.length,
    errorCount,
    totalCount: diagnostics.length,
  };
}

export function languageDiagnosticStatusLabel(
  capability: LanguageDiagnosticsCapability | null,
  status: LanguageDiagnosticStatus,
): string | null {
  if (!capability) return null;
  if (status.state === "checking") return `${capability.label}...`;
  if (status.state === "clean") return `${capability.label} clean`;
  if (status.state === "issues") return `${capability.label} ${status.count}`;
  if (status.state === "unavailable") return `${capability.label} off`;
  return capability.label;
}

function markerSeverity(monaco: typeof import("monaco-editor"), diagnostic: LanguageDiagnostic) {
  return diagnostic.severity === "error" ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning;
}

export function languageDiagnosticsToMonacoMarkers(
  monaco: typeof import("monaco-editor"),
  result: LanguageDiagnosticRunResult,
): import("monaco-editor").editor.IMarkerData[] {
  return result.diagnostics.map((diagnostic) => ({
    startLineNumber: Math.max(1, diagnostic.line),
    startColumn: Math.max(1, diagnostic.startColumn),
    endLineNumber: Math.max(1, diagnostic.endLine),
    endColumn: Math.max(Math.max(1, diagnostic.startColumn) + 1, diagnostic.endColumn + 1),
    message: `${diagnostic.code}: ${diagnostic.message}`,
    severity: markerSeverity(monaco, diagnostic),
    source: result.analyzer,
  }));
}
