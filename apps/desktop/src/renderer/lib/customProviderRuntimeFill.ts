import type { ProviderRuntimeModelConfig } from '@cindy/model-providers';

export interface RuntimeFillHeaderRow {
  name: string;
  value: string;
}

/**
 * Renderer-only runtime draft used by the explicit one-time fill action.
 * Secrets stay in the existing in-memory form state and are never added to
 * CustomProviderConfig or any persisted sync relationship.
 */
export interface RuntimeFillDraft {
  baseUrl: string;
  apiKey: string;
  models: ProviderRuntimeModelConfig[];
  headers: RuntimeFillHeaderRow[];
  modelsUrl: string;
}

export type RuntimeFillField = 'baseUrl' | 'apiKey' | 'models' | 'headers' | 'modelsUrl';

export type RuntimeFillTargetState = 'empty' | 'same' | 'conflict';

export interface RuntimeFillFieldDiff {
  field: RuntimeFillField;
  targetState: RuntimeFillTargetState;
}

export const RUNTIME_FILL_FIELD_ORDER: readonly RuntimeFillField[] = [
  'baseUrl',
  'apiKey',
  'models',
  'headers',
  'modelsUrl',
];

function normalizedModels(models: ProviderRuntimeModelConfig[]): ProviderRuntimeModelConfig[] {
  return models
    .map((model) => ({
      id: model.id.trim(),
      name: model.name.trim(),
      ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    }))
    .filter(
      (model) => model.id.length > 0 || model.name.length > 0 || model.contextWindow !== undefined,
    );
}

function normalizedHeaders(headers: RuntimeFillHeaderRow[]): Array<[string, string]> {
  return headers
    .map((header) => [header.name.trim(), header.value.trim()] as [string, string])
    .filter(([name, value]) => name.length > 0 || value.length > 0)
    .sort(([leftName, leftValue], [rightName, rightValue]) => {
      const nameOrder = leftName.localeCompare(rightName);
      return nameOrder !== 0 ? nameOrder : leftValue.localeCompare(rightValue);
    });
}

function normalizedFieldValue(field: RuntimeFillField, draft: RuntimeFillDraft): unknown {
  switch (field) {
    case 'baseUrl':
      return draft.baseUrl.trim();
    case 'apiKey':
      return draft.apiKey.trim();
    case 'models':
      return normalizedModels(draft.models);
    case 'headers':
      return normalizedHeaders(draft.headers);
    case 'modelsUrl':
      return draft.modelsUrl.trim();
  }
}

export function runtimeFillFieldHasValue(
  field: RuntimeFillField,
  draft: RuntimeFillDraft,
): boolean {
  const value = normalizedFieldValue(field, draft);
  return Array.isArray(value) ? value.length > 0 : value !== '';
}

export function buildRuntimeFillDiffs(
  source: RuntimeFillDraft,
  target: RuntimeFillDraft,
  options: { includeApiKey: boolean },
): RuntimeFillFieldDiff[] {
  return RUNTIME_FILL_FIELD_ORDER.filter(
    (field) =>
      (options.includeApiKey || field !== 'apiKey') && runtimeFillFieldHasValue(field, source),
  ).map((field) => {
    const sourceValue = normalizedFieldValue(field, source);
    const targetValue = normalizedFieldValue(field, target);
    const same = JSON.stringify(sourceValue) === JSON.stringify(targetValue);
    return {
      field,
      targetState: same ? 'same' : runtimeFillFieldHasValue(field, target) ? 'conflict' : 'empty',
    };
  });
}

function cloneModels(models: ProviderRuntimeModelConfig[]): ProviderRuntimeModelConfig[] {
  return models.map((model) => ({ ...model }));
}

function cloneHeaders(headers: RuntimeFillHeaderRow[]): RuntimeFillHeaderRow[] {
  return headers.map((header) => ({ ...header }));
}

/** Materialize a one-time snapshot without leaving references back to the source runtime draft. */
export function applyRuntimeFillFields(
  target: RuntimeFillDraft,
  source: RuntimeFillDraft,
  fields: readonly RuntimeFillField[],
): RuntimeFillDraft {
  const selected = new Set(fields);
  return {
    baseUrl: selected.has('baseUrl') ? source.baseUrl : target.baseUrl,
    apiKey: selected.has('apiKey') ? source.apiKey : target.apiKey,
    models: selected.has('models') ? cloneModels(source.models) : target.models,
    headers: selected.has('headers') ? cloneHeaders(source.headers) : target.headers,
    modelsUrl: selected.has('modelsUrl') ? source.modelsUrl : target.modelsUrl,
  };
}
