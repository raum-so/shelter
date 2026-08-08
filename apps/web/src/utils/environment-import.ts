import type { EnvironmentVariable } from '../types';

export const MAX_ENVIRONMENT_IMPORT_VARIABLES = 200;
export const MAX_ENVIRONMENT_IMPORT_VALUE_LENGTH = 65_536;
export const MAX_ENVIRONMENT_IMPORT_BYTES = 256 * 1024;
export const SHELTER_MANAGED_ENVIRONMENT_KEYS = new Set(['PORT', 'HOSTNAME', 'NODE_ENV']);

export interface ImportedEnvironmentVariable {
  key: string;
  value: string;
  line: number;
}

export type EnvironmentImportErrorCode =
  | 'invalid_assignment'
  | 'unterminated_quote'
  | 'unexpected_characters'
  | 'duplicate_key'
  | 'managed_key'
  | 'empty_value'
  | 'value_too_long'
  | 'too_many_variables'
  | 'too_large';

export interface EnvironmentImportError {
  code: EnvironmentImportErrorCode;
  line: number;
  key?: string;
}

export interface ParseEnvironmentOptions {
  allowEmptyValues?: boolean;
  managedKeys?: ReadonlySet<string>;
}

export interface ParseEnvironmentResult {
  variables: ImportedEnvironmentVariable[];
  errors: EnvironmentImportError[];
}

function decodeDoubleQuotedEscape(character: string): string {
  if (character === 'n') return '\n';
  if (character === 'r') return '\r';
  if (character === 't') return '\t';
  if (character === '"') return '"';
  if (character === '\\') return '\\';
  return `\\${character}`;
}

function parseQuotedValue(
  lines: string[],
  startLineIndex: number,
  initial: string,
  quote: '"' | "'",
): { value?: string; endLineIndex: number; error?: EnvironmentImportErrorCode } {
  let lineIndex = startLineIndex;
  let content = initial.slice(1);
  let value = '';

  while (true) {
    for (let index = 0; index < content.length; index += 1) {
      const character = content[index]!;
      if (quote === '"' && character === '\\') {
        const escaped = content[index + 1];
        if (escaped !== undefined) {
          value += decodeDoubleQuotedEscape(escaped);
          index += 1;
          continue;
        }
      }
      if (character !== quote) {
        value += character;
        continue;
      }

      const trailing = content.slice(index + 1).trim();
      if (trailing && !trailing.startsWith('#')) {
        return { endLineIndex: lineIndex, error: 'unexpected_characters' };
      }
      return { value, endLineIndex: lineIndex };
    }

    lineIndex += 1;
    if (lineIndex >= lines.length) {
      return { endLineIndex: lineIndex - 1, error: 'unterminated_quote' };
    }
    value += '\n';
    content = lines[lineIndex]!;
  }
}

function environmentBytes(variables: ReadonlyArray<Pick<ImportedEnvironmentVariable, 'key' | 'value'>>): number {
  const encoder = new TextEncoder();
  return variables.reduce((total, variable) => (
    total
    + encoder.encode(variable.key).byteLength
    + encoder.encode(variable.value).byteLength
    + 2
  ), 0);
}

export function parseEnvironmentText(
  source: string,
  options: ParseEnvironmentOptions = {},
): ParseEnvironmentResult {
  const allowEmptyValues = options.allowEmptyValues ?? true;
  const managedKeys = options.managedKeys ?? SHELTER_MANAGED_ENVIRONMENT_KEYS;
  const lines = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const variables: ImportedEnvironmentVariable[] = [];
  const errors: EnvironmentImportError[] = [];
  const seen = new Set<string>();

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    const assignmentLine = lineIndex + 1;
    if (!line.trim() || line.trimStart().startsWith('#')) continue;

    const assignment = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!assignment) {
      errors.push({ code: 'invalid_assignment', line: assignmentLine });
      continue;
    }

    const key = assignment[1]!;
    const rawValue = assignment[2] ?? '';
    let value: string;
    if (rawValue.startsWith('"') || rawValue.startsWith("'")) {
      const parsed = parseQuotedValue(lines, lineIndex, rawValue, rawValue[0] as '"' | "'");
      lineIndex = parsed.endLineIndex;
      if (parsed.error) {
        errors.push({ code: parsed.error, line: assignmentLine, key });
        continue;
      }
      value = parsed.value ?? '';
    } else {
      const commentIndex = rawValue.indexOf('#');
      value = (commentIndex >= 0 ? rawValue.slice(0, commentIndex) : rawValue).trim();
    }

    if (seen.has(key)) {
      errors.push({ code: 'duplicate_key', line: assignmentLine, key });
      continue;
    }
    seen.add(key);
    if (managedKeys.has(key)) {
      errors.push({ code: 'managed_key', line: assignmentLine, key });
      continue;
    }
    if (!allowEmptyValues && value === '') {
      errors.push({ code: 'empty_value', line: assignmentLine, key });
      continue;
    }
    if (value.length > MAX_ENVIRONMENT_IMPORT_VALUE_LENGTH) {
      errors.push({ code: 'value_too_long', line: assignmentLine, key });
      continue;
    }

    variables.push({ key, value, line: assignmentLine });
  }

  if (variables.length > MAX_ENVIRONMENT_IMPORT_VARIABLES) {
    errors.push({ code: 'too_many_variables', line: 1 });
  }
  if (environmentBytes(variables) > MAX_ENVIRONMENT_IMPORT_BYTES) {
    errors.push({ code: 'too_large', line: 1 });
  }

  return { variables, errors };
}

export function mergeEnvironmentVariables(
  current: ReadonlyArray<EnvironmentVariable>,
  imported: ReadonlyArray<Pick<ImportedEnvironmentVariable, 'key' | 'value'>>,
): EnvironmentVariable[] {
  const importedByKey = new Map(imported.map((variable) => [variable.key, variable.value]));
  const populated = current.filter((variable) => Boolean(variable.key.trim()));
  const merged = populated.map((variable) => importedByKey.has(variable.key)
    ? { key: variable.key, value: importedByKey.get(variable.key)! }
    : variable);
  const existingKeys = new Set(populated.map((variable) => variable.key));
  for (const variable of imported) {
    if (!existingKeys.has(variable.key)) merged.push({ key: variable.key, value: variable.value });
  }
  return merged;
}

export function environmentImportCounts(
  existingKeys: ReadonlyArray<string>,
  imported: ReadonlyArray<Pick<ImportedEnvironmentVariable, 'key'>>,
): { added: number; replaced: number; total: number } {
  const existing = new Set(existingKeys.filter(Boolean));
  let added = 0;
  let replaced = 0;
  for (const variable of imported) {
    if (existing.has(variable.key)) replaced += 1;
    else added += 1;
  }
  return { added, replaced, total: existing.size + added };
}
