import { describe, expect, it } from 'vitest';
import { resolveVibrancyConfig } from '../vibrancyConfig';

describe('E4D resolveVibrancyConfig(familyId→vibrancy/backgroundColor 映射)', () => {
  it('CINDY mac light → vibrancy sidebar + 透明底', () => {
    const c = resolveVibrancyConfig('cindy', false, 'darwin');
    expect(c.vibrancy).toBe('sidebar');
    expect(c.backgroundColor).toBe('#00000000');
  });
  it('CINDY mac dark → vibrancy sidebar + 透明底', () => {
    const c = resolveVibrancyConfig('cindy', true, 'darwin');
    expect(c.vibrancy).toBe('sidebar');
    expect(c.backgroundColor).toBe('#00000000');
  });
  it('其他 family(default)mac → vibrancy null + 不透明底', () => {
    const c = resolveVibrancyConfig('default', false, 'darwin');
    expect(c.vibrancy).toBeNull();
    expect(c.backgroundColor).toBe('#f8f8f6');
    const d = resolveVibrancyConfig('atom-one', true, 'darwin');
    expect(d.vibrancy).toBeNull();
    expect(d.backgroundColor).toBe('#1f1f1e');
  });
  it('CINDY Windows → vibrancy null + 不透明(回退,无 vibrancy 等价)', () => {
    const c = resolveVibrancyConfig('cindy', false, 'win32');
    expect(c.vibrancy).toBeNull();
    expect(c.backgroundColor).toBe('#f8f8f6');
  });
  it('非 CINDY Windows → null + 不透明', () => {
    const c = resolveVibrancyConfig('default', true, 'win32');
    expect(c.vibrancy).toBeNull();
    expect(c.backgroundColor).toBe('#1f1f1e');
  });
});
