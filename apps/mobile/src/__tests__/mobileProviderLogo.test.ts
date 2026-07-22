/** Mobile provider logo render/wiring contract (pure source checks; no React Native runtime). */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8').replace(/\r\n/g, '\n');
}

describe('MobileProviderMark', () => {
  it('renders shared official paths and keeps unknown providers on the monogram fallback', () => {
    const source = readSource('src/session/MobileProviderMark.tsx');

    expect(source).toContain("from '@lizi/model-providers/branding';");
    expect(source).toContain("resolveProviderLogoKind(providerId ?? '', routing)");
    expect(source).toContain('<Path d={PROVIDER_LOGO_PATHS[kind]} fill={fill} />');
    expect(source).toContain('{providerMonogram(name)}');
    expect(source).not.toContain('switch (providerId)');
  });

  it('uses theme text color by default and the error status color for a disconnected source', () => {
    const source = readSource('src/session/MobileProviderMark.tsx');
    const session = readSource('app/sessions/[sessionId].tsx');

    expect(source).toContain('const fill = color ?? colors.textSecondary;');
    expect(source).toContain('fill={fill}');
    expect(source).toContain('color ? { color } : null');
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    expect(session).toContain('composerSelectedSourceDisconnected');
    expect(session).toContain('color={composerSelectedSourceDisconnected ? colors.statusError : undefined}');
    expect(session).toContain('providerId={composerPillSourceId}');
  });

  it('passes provider routing through model rows and both current-model entries', () => {
    const list = readSource('src/session/MobileModelPickerList.tsx');
    const draft = readSource('app/sessions/new.tsx');
    const session = readSource('app/sessions/[sessionId].tsx');

    expect(list).toContain('routing={row.provider.routing}');
    expect(draft).toContain('routing={activeSourceProvider.routing}');
    expect(session).toContain('routing={composerPillSourceProvider?.routing}');
  });
});
