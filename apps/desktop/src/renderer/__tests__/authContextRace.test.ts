import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Guards renderer auth state against late product-role responses. */
describe('AuthContext role hydration race', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/renderer/contexts/AuthContext.tsx'),
    'utf8',
  );

  it('renders identity immediately and rejects stale same-account and cross-account responses', () => {
    expect(source).toContain('const revision = ++activeUserRevisionRef.current;');
    expect(source).toContain('setUser(visibleUser);');
    expect(source).toContain('activeUserIdRef.current !== incoming.id');
    expect(source).toContain('activeUserRevisionRef.current !== revision');
  });

  it('ignores initialize results after a newer pushed auth event', () => {
    expect(source).toContain('authStateVersionRef.current += 1;');
    expect(source).toContain('authStateVersionRef.current !== initializeVersion');
  });

  it('clears login progress and cached product roles at auth boundaries', () => {
    expect(source).toContain('roleByUserRef.current.clear();');
    expect(source).toContain('setLoginState(null);');
  });

  it('projects browser waiting state before the main-process loopback request settles', () => {
    expect(source).toContain("if (action.type === 'start-browser')");
    expect(source).toContain("setLoginState({ step: 'browser-redirect', label: action.label });");
  });
});
