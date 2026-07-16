/**
 * OAuth login window regression tests.
 *
 * These are source-contract tests because the behavior depends on native
 * Electron BrowserWindow chrome and cannot be exercised in the node test
 * environment without launching Electron.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourcePath = resolve(__dirname, '..', 'authManager.ts');
const source = readFileSync(sourcePath, 'utf8').replace(/\r\n?/g, '\n');

function oauthBrowserWindowOptionsSource(): string {
  const match = source.match(
    /const authWindow = new BrowserWindow\(\{[\s\S]*?\n\s*\}\);/,
  );
  if (!match) throw new Error('OAuth BrowserWindow options block not found');
  return match[0];
}

describe('OAuth login window', () => {
  it('keeps the Feishu OAuth window non-modal so close and quit remain available', () => {
    const block = oauthBrowserWindowOptionsSource();

    expect(block).toContain('modal: false');
    expect(block).toContain('closable: true');
    expect(block).toContain('minimizable: true');
    expect(block).not.toContain('modal: true');
  });

  it('installs keyboard and app-command fallbacks for close and back navigation', () => {
    expect(source).toContain('installOAuthWindowInputFallbacks(authWindow)');
    expect(source).toContain("input.key === 'Escape'");
    expect(source).toContain('authWindow.close();');
    expect(source).toContain("input.key === 'BrowserBack'");
    expect(source).toContain("key === 'arrowleft'");
    expect(source).toContain("key === '['");
    expect(source).toContain('if (wantsBack) {\n      event.preventDefault();\n      goBack();');
    expect(source).toContain("'browser-backward'");
    expect(source).toContain('authWindow.webContents.goBack();');
  });
});
