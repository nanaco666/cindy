import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('remote Bot group push wiring', () => {
  it.each([
    ['app/bot-groups/[deviceId]/index.tsx', 'bot-groups:${deviceId}'],
    ['app/bot-groups/[deviceId]/[roomId].tsx', 'bot-group:${roomId}'],
  ])('%s owns the sessions subscription and Bot-group reseed callback', (path, owner) => {
    const screen = source(path);

    expect(screen).toContain(`subscribe(\`${owner}\`, deviceId, ['sessions'])`);
    expect(screen).toContain('remoteSessionStore.registerBotGroupReseedHandler');
    expect(screen).toContain(`unsubscribe(\`${owner}\`, deviceId, ['sessions'])`);
  });
});
