import { describe, expect, it } from 'vitest';

import { replaceCustomProviderModelId } from '../customProviders';

describe('replaceCustomProviderModelId', () => {
  it('drops hidden metadata when the model id changes', () => {
    expect(replaceCustomProviderModelId({
      id: 'MiniMax-M3',
      name: 'MiniMax M3',
      contextWindow: 1_000_000,
    }, 'another-model')).toEqual({
      id: 'another-model',
      name: 'MiniMax M3',
    });
  });

  it('preserves the original model when the id is unchanged', () => {
    const model = {
      id: 'MiniMax-M3',
      name: 'MiniMax M3',
      contextWindow: 1_000_000,
    };
    expect(replaceCustomProviderModelId(model, model.id)).toBe(model);
  });
});
