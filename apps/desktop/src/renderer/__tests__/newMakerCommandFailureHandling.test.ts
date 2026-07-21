import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(__dirname, '..', 'components', 'layout', 'MainLayout.tsx'),
  'utf8',
);

describe('MainLayout new-maker command failure handling', () => {
  it('logs rejected sidebar routing before releasing the in-flight guard', () => {
    const handlerStart = source.indexOf('const handleNewMakerCommand = useCallback');
    const routeStart = source.indexOf('void routeNewMakerCommand({', handlerStart);
    const catchStart = source.indexOf(".catch((err: unknown) => {", routeStart);
    const warning = source.indexOf("applicationMenuLog.warn('new-maker routing failed', err)", catchStart);
    const finallyStart = source.indexOf('.finally(() => {', catchStart);

    expect(handlerStart).toBeGreaterThan(-1);
    expect(routeStart).toBeGreaterThan(handlerStart);
    expect(catchStart).toBeGreaterThan(routeStart);
    expect(warning).toBeGreaterThan(catchStart);
    expect(finallyStart).toBeGreaterThan(warning);
  });
});
