import { describe, expect, it } from 'vitest';

import {
  applyRuntimeFillFields,
  buildRuntimeFillDiffs,
  type RuntimeFillDraft,
} from '@/lib/customProviderRuntimeFill';

function draft(overrides: Partial<RuntimeFillDraft> = {}): RuntimeFillDraft {
  return {
    baseUrl: '',
    apiKey: '',
    models: [{ id: '', name: '' }],
    headers: [{ name: '', value: '' }],
    modelsUrl: '',
    ...overrides,
  };
}

describe('custom provider runtime fill', () => {
  it('only offers meaningful source fields and omits API keys for OAuth', () => {
    const source = draft({
      baseUrl: ' https://api.example.com ',
      apiKey: 'sk-test-not-real',
      models: [{ id: 'model-a', name: 'Model A' }],
    });

    expect(buildRuntimeFillDiffs(source, draft(), { includeApiKey: false })).toEqual([
      { field: 'baseUrl', targetState: 'empty' },
      { field: 'models', targetState: 'empty' },
    ]);
  });

  it('distinguishes empty targets, equal values, and overwrite conflicts', () => {
    const source = draft({
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test-not-real',
      models: [{ id: 'model-a', name: 'Model A', contextWindow: 200_000 }],
      headers: [{ name: 'x-tenant', value: 'cindy' }],
      modelsUrl: 'https://api.example.com/models',
    });
    const target = draft({
      baseUrl: 'https://api.example.com',
      models: [{ id: 'model-b', name: 'Model B' }],
      headers: [{ name: 'x-other', value: 'value' }],
    });

    expect(buildRuntimeFillDiffs(source, target, { includeApiKey: true })).toEqual([
      { field: 'baseUrl', targetState: 'same' },
      { field: 'apiKey', targetState: 'empty' },
      { field: 'models', targetState: 'conflict' },
      { field: 'headers', targetState: 'conflict' },
      { field: 'modelsUrl', targetState: 'empty' },
    ]);
  });

  it('treats header order as equivalent while preserving model order', () => {
    const source = draft({
      models: [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ],
      headers: [
        { name: 'x-b', value: '2' },
        { name: 'x-a', value: '1' },
      ],
    });
    const target = draft({
      models: [
        { id: 'b', name: 'B' },
        { id: 'a', name: 'A' },
      ],
      headers: [
        { name: 'x-a', value: '1' },
        { name: 'x-b', value: '2' },
      ],
    });

    expect(buildRuntimeFillDiffs(source, target, { includeApiKey: true })).toEqual([
      { field: 'models', targetState: 'conflict' },
      { field: 'headers', targetState: 'same' },
    ]);
  });

  it('creates independent model and header snapshots and leaves unselected fields untouched', () => {
    const source = draft({
      baseUrl: 'https://source.example.com',
      apiKey: 'sk-test-not-real',
      models: [{ id: 'model-a', name: 'Model A' }],
      headers: [{ name: 'x-tenant', value: 'cindy' }],
    });
    const target = draft({
      baseUrl: 'https://target.example.com',
      apiKey: 'target-key',
      models: [{ id: 'old', name: 'Old' }],
      headers: [{ name: 'x-old', value: 'old' }],
    });

    const result = applyRuntimeFillFields(target, source, ['baseUrl', 'models', 'headers']);
    source.models[0]!.name = 'Changed later';
    source.headers[0]!.value = 'changed-later';

    expect(result).toEqual({
      ...target,
      baseUrl: 'https://source.example.com',
      models: [{ id: 'model-a', name: 'Model A' }],
      headers: [{ name: 'x-tenant', value: 'cindy' }],
    });
    expect(result.apiKey).toBe('target-key');
  });
});
