/**
 * Regression coverage for local Markdown images whose paths contain spaces
 * or literal percent characters. react-markdown URL-encodes those paths
 * before invoking the custom img renderer; our xdt-file conversion must
 * decode that representation exactly once instead of double-encoding it.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import { describe, expect, it } from 'vitest';

import { normalizeMarkdownImageSrc } from '@/lib/localPathResolver';

function normalizedImageSrc(markdown: string, workingDir = '/repo'): string | undefined {
  let normalized: string | undefined;
  renderToStaticMarkup(
    createElement(ReactMarkdown, {
      components: {
        img: ({ src }) => {
          normalized = normalizeMarkdownImageSrc(src, workingDir, true);
          return null;
        },
      },
      urlTransform: defaultUrlTransform,
      children: markdown,
    }),
  );
  return normalized;
}

describe('Markdown local image path encoding', () => {
  it('loads a cindy-media blob absolute path containing Application Support', () => {
    const path =
      '/Users/test/Library/Application Support/Cindy/cindy-media/blobs/aa/' +
      `${'a'.repeat(64)}.png`;

    expect(normalizedImageSrc(`![work](<${path}>)`)).toBe(
      `xdt-file://local/?path=${encodeURIComponent(path)}`,
    );
  });

  it('preserves a literal percent character while decoding the Markdown URL once', () => {
    const path = '/tmp/100% done.png';

    expect(normalizedImageSrc(`![percent](<${path}>)`)).toBe(
      `xdt-file://local/?path=${encodeURIComponent(path)}`,
    );
  });

  it('does not alter already-routable media URLs', () => {
    for (const url of [
      `cindy-media://blobs/${'a'.repeat(64)}.png`,
      'xdt-file://local/?path=%2Ftmp%2Falready-routed.png',
      'https://example.com/image%20name.png',
      'data:image/png;base64,AAAA',
    ]) {
      expect(normalizeMarkdownImageSrc(url, '/repo', true)).toBe(url);
    }
  });

  it('keeps malformed percent sequences instead of throwing during render', () => {
    const path = '/tmp/100%done.png';
    expect(normalizeMarkdownImageSrc(path, '/repo', true)).toBe(
      `xdt-file://local/?path=${encodeURIComponent(path)}`,
    );
  });

  it('normalizes an encoded Windows file URL to a native xdt-file path', () => {
    const path = 'C:/Users/test/My Pictures/image.png';
    expect(
      normalizeMarkdownImageSrc('file:///C:/Users/test/My%20Pictures/image.png', '/repo', true),
    ).toBe(`xdt-file://local/?path=${encodeURIComponent(path)}`);
  });

  it('blocks privileged local paths in untrusted Markdown previews', () => {
    expect(normalizeMarkdownImageSrc('/tmp/private.png', '/repo', false)).toBeUndefined();
    expect(normalizeMarkdownImageSrc('https://example.com/public.png', '/repo', false)).toBe(
      'https://example.com/public.png',
    );
  });
});
