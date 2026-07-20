// @vitest-environment jsdom

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AnthropicMark } from '@/components/icons/AnthropicMark';
import { ClaudeMark } from '@/components/icons/ClaudeMark';
import { CodexMark } from '@/components/icons/CodexMark';
import { OpenAIMark } from '@/components/icons/OpenAIMark';
import { ModelIconMark, ProviderMark } from '@/components/new-chat/ModelSelector';

function firstPath(ui: React.ReactNode): string | null {
  return render(ui).container.querySelector('path')?.getAttribute('d') ?? null;
}

describe('model mark semantics', () => {
  it('keeps the model-vendor marks monochrome and preserves the size/className API', () => {
    const anthropic = render(<AnthropicMark size={18} className="brand-mark" />);
    const anthropicSvg = anthropic.container.querySelector('svg');
    expect(anthropicSvg?.getAttribute('width')).toBe('18');
    expect(anthropicSvg?.getAttribute('height')).toBe('18');
    expect(anthropicSvg?.getAttribute('class')).toBe('brand-mark');
    expect(anthropic.container.querySelector('path')?.getAttribute('fill')).toBe('currentColor');

    const openai = render(<OpenAIMark size={16} className="brand-mark" />);
    expect(openai.container.querySelector('svg')?.getAttribute('width')).toBe('16');
    expect(openai.container.querySelector('path')?.getAttribute('fill')).toBe('currentColor');
  });

  it('uses vendor marks for provider/model metadata and keeps Agent glyphs distinct', () => {
    const anthropicPath = firstPath(<AnthropicMark />);
    const openaiPath = firstPath(<OpenAIMark />);

    expect(firstPath(<ProviderMark providerId="anthropic" />)).toBe(anthropicPath);
    expect(firstPath(<ProviderMark providerId="openai" />)).toBe(openaiPath);
    expect(firstPath(<ModelIconMark icon="claude" providerId="xd" />)).toBe(anthropicPath);
    expect(firstPath(<ModelIconMark icon="openai" providerId="xd" />)).toBe(openaiPath);

    expect(firstPath(<ClaudeMark />)).not.toBe(anthropicPath);
    expect(firstPath(<CodexMark />)).not.toBe(openaiPath);
  });
});
