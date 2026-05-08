import { luauLspCompletion, luauLspHover, luauLspSemanticTokens, luauLspSignatureHelp } from "./tauriApi";

type Monaco = typeof import("monaco-editor");
type MonacoModel = import("monaco-editor").editor.ITextModel;
type SemanticTokensChangeEvent = NonNullable<
  import("monaco-editor").languages.DocumentSemanticTokensProvider["onDidChange"]
>;

interface LuauModelContext {
  filePath: string;
  cwd?: string | undefined;
}

const modelContexts = new WeakMap<MonacoModel, LuauModelContext>();
let registered = false;
const semanticTokenListeners = new Set<() => void>();

const LUAU_SEMANTIC_TOKEN_TYPES = [
  "namespace",
  "type",
  "class",
  "enum",
  "interface",
  "struct",
  "typeParameter",
  "parameter",
  "variable",
  "property",
  "enumMember",
  "event",
  "function",
  "method",
  "macro",
  "keyword",
  "modifier",
  "comment",
  "string",
  "number",
  "regexp",
  "operator",
  "decorator",
];

const LUAU_SEMANTIC_TOKEN_MODIFIERS = [
  "declaration",
  "definition",
  "readonly",
  "static",
  "deprecated",
  "abstract",
  "async",
  "modification",
  "documentation",
  "defaultLibrary",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function lspCompletionItems(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result.filter(isRecord);
  if (isRecord(result) && Array.isArray(result.items)) return result.items.filter(isRecord);
  return [];
}

function lspText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.value === "string") return value.value;
  return null;
}

function lspDocumentation(value: unknown): { value: string } | undefined {
  const text = lspText(value);
  return text ? { value: text } : undefined;
}

function lspCompletionKind(monaco: Monaco, kind: unknown): import("monaco-editor").languages.CompletionItemKind {
  switch (kind) {
    case 2: return monaco.languages.CompletionItemKind.Method;
    case 3: return monaco.languages.CompletionItemKind.Function;
    case 4: return monaco.languages.CompletionItemKind.Constructor;
    case 5: return monaco.languages.CompletionItemKind.Field;
    case 6: return monaco.languages.CompletionItemKind.Variable;
    case 7: return monaco.languages.CompletionItemKind.Class;
    case 8: return monaco.languages.CompletionItemKind.Interface;
    case 9: return monaco.languages.CompletionItemKind.Module;
    case 10: return monaco.languages.CompletionItemKind.Property;
    case 13: return monaco.languages.CompletionItemKind.Enum;
    case 14: return monaco.languages.CompletionItemKind.Keyword;
    case 15: return monaco.languages.CompletionItemKind.Snippet;
    case 20: return monaco.languages.CompletionItemKind.EnumMember;
    case 21: return monaco.languages.CompletionItemKind.Constant;
    case 22: return monaco.languages.CompletionItemKind.Struct;
    case 24: return monaco.languages.CompletionItemKind.Operator;
    case 25: return monaco.languages.CompletionItemKind.TypeParameter;
    default: return monaco.languages.CompletionItemKind.Text;
  }
}

function hoverContents(value: unknown): { value: string }[] {
  if (typeof value === "string") return [{ value }];
  if (Array.isArray(value)) return value.flatMap(hoverContents);
  if (!isRecord(value)) return [];
  if (typeof value.language === "string" && typeof value.value === "string") {
    return [{ value: `\`\`\`${value.language}\n${value.value}\n\`\`\`` }];
  }
  if (typeof value.value === "string") return [{ value: value.value }];
  return [];
}

function signatureParameterLabel(value: unknown): string | [number, number] {
  if (typeof value === "string") return value;
  if (
    Array.isArray(value) &&
    typeof value[0] === "number" &&
    typeof value[1] === "number"
  ) {
    return [value[0], value[1]];
  }
  return "";
}

function signatureHelpValue(result: unknown): import("monaco-editor").languages.SignatureHelp | null {
  if (!isRecord(result) || !Array.isArray(result.signatures)) return null;
  const signatures = result.signatures.filter(isRecord).map((signature) => {
    const label = asString(signature.label) ?? "";
    const next: import("monaco-editor").languages.SignatureInformation = {
      label,
      parameters: [],
    };
    const documentation = lspDocumentation(signature.documentation);
    if (documentation) next.documentation = documentation;
    if (Array.isArray(signature.parameters)) {
      next.parameters = signature.parameters.filter(isRecord).map((parameter) => {
        const item: import("monaco-editor").languages.ParameterInformation = {
          label: signatureParameterLabel(parameter.label),
        };
        const parameterDocumentation = lspDocumentation(parameter.documentation);
        if (parameterDocumentation) item.documentation = parameterDocumentation;
        return item;
      });
    }
    return next;
  });
  if (signatures.length === 0) return null;
  return {
    signatures,
    activeSignature: asNumber(result.activeSignature) ?? 0,
    activeParameter: asNumber(result.activeParameter) ?? 0,
  };
}

function semanticTokensPayload(result: unknown): Record<string, unknown> | null {
  if (!isRecord(result)) return null;
  const tokens = result.tokens;
  return isRecord(tokens) ? tokens : null;
}

function semanticTokensData(result: unknown): Uint32Array | null {
  const tokens = semanticTokensPayload(result);
  if (!tokens || !Array.isArray(tokens.data)) return null;
  const data = tokens.data
    .map((value) => asNumber(value))
    .filter((value): value is number => value !== null);
  return new Uint32Array(data);
}

const onDidChangeSemanticTokens: SemanticTokensChangeEvent = (listener, thisArg) => {
  const wrapped = () => listener.call(thisArg, undefined);
  semanticTokenListeners.add(wrapped);
  const disposable = {
    dispose: () => {
      semanticTokenListeners.delete(wrapped);
    },
  };
  return disposable;
};

export function refreshLuauSemanticTokens(): void {
  for (const listener of [...semanticTokenListeners]) listener();
}

export function registerLuauMonacoLanguage(monaco: Monaco): void {
  if (registered) return;
  registered = true;

  monaco.languages.registerCompletionItemProvider("lua", {
    triggerCharacters: [".", ":", "\"", "'", "/"],
    async provideCompletionItems(model, position) {
      const context = modelContexts.get(model);
      if (!context) return { suggestions: [] };
      const result = await luauLspCompletion(
        context.filePath,
        model.getValue(),
        context.cwd,
        position.lineNumber,
        position.column,
      ).catch(() => null);
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      return {
        suggestions: lspCompletionItems(result).map((item) => {
          const labelValue = item.label;
          const label = typeof labelValue === "string"
            ? labelValue
            : isRecord(labelValue) && typeof labelValue.label === "string"
              ? labelValue.label
              : "completion";
          const insertText = asString(item.insertText) ?? label;
          const suggestion: import("monaco-editor").languages.CompletionItem = {
            label,
            kind: lspCompletionKind(monaco, item.kind),
            insertText,
            range,
          };
          const detail = asString(item.detail);
          if (detail) suggestion.detail = detail;
          const documentation = lspDocumentation(item.documentation);
          if (documentation) suggestion.documentation = documentation;
          const sortText = asString(item.sortText);
          if (sortText) suggestion.sortText = sortText;
          const filterText = asString(item.filterText);
          if (filterText) suggestion.filterText = filterText;
          if (item.insertTextFormat === 2) {
            suggestion.insertTextRules =
              monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
          }
          return suggestion;
        }),
      };
    },
  });

  monaco.languages.registerHoverProvider("lua", {
    async provideHover(model, position) {
      const context = modelContexts.get(model);
      if (!context) return null;
      const result = await luauLspHover(
        context.filePath,
        model.getValue(),
        context.cwd,
        position.lineNumber,
        position.column,
      ).catch(() => null);
      if (!isRecord(result)) return null;
      const contents = hoverContents(result.contents);
      return contents.length > 0 ? { contents } : null;
    },
  });

  monaco.languages.registerSignatureHelpProvider("lua", {
    signatureHelpTriggerCharacters: ["(", ",", ":"],
    signatureHelpRetriggerCharacters: [","],
    async provideSignatureHelp(model, position) {
      const context = modelContexts.get(model);
      if (!context) return null;
      const result = await luauLspSignatureHelp(
        context.filePath,
        model.getValue(),
        context.cwd,
        position.lineNumber,
        position.column,
      ).catch(() => null);
      const value = signatureHelpValue(result);
      return value ? { value, dispose: () => {} } : null;
    },
  });

  monaco.languages.registerDocumentSemanticTokensProvider("lua", {
    onDidChange: onDidChangeSemanticTokens,
    getLegend() {
      return {
        tokenTypes: LUAU_SEMANTIC_TOKEN_TYPES,
        tokenModifiers: LUAU_SEMANTIC_TOKEN_MODIFIERS,
      };
    },
    async provideDocumentSemanticTokens(model) {
      const context = modelContexts.get(model);
      if (!context) return null;
      const result = await luauLspSemanticTokens(
        context.filePath,
        model.getValue(),
        context.cwd,
      ).catch(() => null);
      const data = semanticTokensData(result);
      if (!data) return null;
      return { data };
    },
    releaseDocumentSemanticTokens() {},
  });
}

export function setLuauModelContext(model: MonacoModel, context: LuauModelContext): void {
  modelContexts.set(model, context);
  refreshLuauSemanticTokens();
}

export function clearLuauModelContext(model: MonacoModel): void {
  modelContexts.delete(model);
}
