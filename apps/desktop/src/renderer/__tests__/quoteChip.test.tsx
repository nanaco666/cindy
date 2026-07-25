// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuoteChip } from '@/components/chat/QuoteChip';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('QuoteChip', () => {
  it('collapses multiline quote text into a single-line summary', () => {
    const { container } = render(<QuoteChip quote={{ text: 'first line\n\nsecond line' }} />);

    const chip = container.querySelector<HTMLElement>('[aria-label]');
    expect(chip?.getAttribute('aria-label')).toBe('first line\n\nsecond line');
    expect(chip?.textContent).toBe('first line second line');
    expect(chip?.className).toContain('select-none');
  });

  it('keeps the remove affordance optional for sent-message reuse', () => {
    const onRemove = vi.fn();
    const { rerender } = render(<QuoteChip quote={{ text: 'quoted' }} />);
    expect(screen.queryByRole('button')).toBeNull();

    rerender(
      <QuoteChip
        quote={{ text: 'quoted' }}
        onRemove={onRemove}
        removeLabel="Remove quote"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove quote' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
