export const MAX_FUNCTION_SOURCE_BYTES = 262_144;
export interface FunctionDraft { name: string; source: string; }
export const functionSourceBytes = (source: string) => new TextEncoder().encode(source).byteLength;
export const validFunctionName = (name: string) => /^[a-z][a-z0-9_-]{0,62}$/.test(name) && name !== "main";
export const changedFunctionDraft = (draft: FunctionDraft, saved: FunctionDraft) => draft.name !== saved.name || draft.source !== saved.source;
export const functionDownloadName = (name: string) => `${validFunctionName(name) ? name : "function"}.ts`;
export function importedFunctionName(filename: string, current: string): string {
  const candidate = filename.replace(/\.ts$/i, "");
  return candidate !== "index" && validFunctionName(candidate) ? candidate : current;
}
