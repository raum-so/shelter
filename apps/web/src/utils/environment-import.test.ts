import { describe, expect, it } from 'vitest';
import {
  environmentImportCounts,
  mergeEnvironmentVariables,
  parseEnvironmentText,
} from './environment-import';

describe('parseEnvironmentText', () => {
  it('parses common dotenv syntax without evaluating values', () => {
    const result = parseEnvironmentText([
      '\uFEFF# local configuration',
      'export API_URL = https://example.test # comment',
      'QUOTED="line one\\nline two"',
      "SINGLE='value # stays'",
      'MULTILINE="first',
      'second"',
      'EMPTY=',
      'lower_case=kept',
    ].join('\r\n'));

    expect(result.errors).toEqual([]);
    expect(result.variables).toEqual([
      { key: 'API_URL', value: 'https://example.test', line: 2 },
      { key: 'QUOTED', value: 'line one\nline two', line: 3 },
      { key: 'SINGLE', value: 'value # stays', line: 4 },
      { key: 'MULTILINE', value: 'first\nsecond', line: 5 },
      { key: 'EMPTY', value: '', line: 7 },
      { key: 'lower_case', value: 'kept', line: 8 },
    ]);
  });

  it('reports structural errors by line without returning secret values', () => {
    const result = parseEnvironmentText([
      'VALID=fake-test-value',
      'INVALID LINE',
      'VALID=another-fake-value',
      'PORT=4000',
      'BLANK=',
      'OPEN="not-closed',
    ].join('\n'), { allowEmptyValues: false });

    expect(result.errors).toEqual([
      { code: 'invalid_assignment', line: 2 },
      { code: 'duplicate_key', line: 3, key: 'VALID' },
      { code: 'managed_key', line: 4, key: 'PORT' },
      { code: 'empty_value', line: 5, key: 'BLANK' },
      { code: 'unterminated_quote', line: 6, key: 'OPEN' },
    ]);
    expect(JSON.stringify(result.errors)).not.toContain('fake-test-value');
    expect(JSON.stringify(result.errors)).not.toContain('not-closed');
  });

  it('rejects characters after a closed quoted value', () => {
    const result = parseEnvironmentText('TOKEN="fake" trailing');
    expect(result.variables).toEqual([]);
    expect(result.errors).toEqual([{ code: 'unexpected_characters', line: 1, key: 'TOKEN' }]);
  });
});

describe('environment import merging', () => {
  it('replaces matching keys and appends new keys without removing untouched variables', () => {
    const imported = parseEnvironmentText('EXISTING=new-value\nADDED=added-value').variables;
    expect(mergeEnvironmentVariables([
      { key: 'EXISTING', value: undefined },
      { key: 'UNTOUCHED', value: undefined },
    ], imported)).toEqual([
      { key: 'EXISTING', value: 'new-value' },
      { key: 'UNTOUCHED', value: undefined },
      { key: 'ADDED', value: 'added-value' },
    ]);
    expect(environmentImportCounts(['EXISTING', 'UNTOUCHED'], imported)).toEqual({
      added: 1,
      replaced: 1,
      total: 3,
    });
  });
});
