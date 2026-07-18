import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveVibrancyConfig } from '../vibrancyConfig';

const MATERIAL_VALUES = [
  'sidebar',
  'hud',
  'under-window',
  'fullscreen-ui',
  'popover',
  'menu',
  'none',
] as const;

describe('E4D resolveVibrancyConfig(familyId→vibrancy/backgroundColor 映射)', () => {
  beforeEach(() => {
    delete process.env.XDT_VIBRANCY_MATERIAL;
    delete process.env.XDT_BACKDROP_MATERIAL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.XDT_VIBRANCY_MATERIAL;
    delete process.env.XDT_BACKDROP_MATERIAL;
  });

  it('darwin × CINDY × vibrancy 材质旋钮:保持原 macOS 映射', () => {
    for (const material of MATERIAL_VALUES) {
      process.env.XDT_VIBRANCY_MATERIAL = material;
      expect(resolveVibrancyConfig('cindy', false, 'darwin')).toEqual({
        vibrancy: material === 'none' ? null : material,
        backgroundColor: '#00000000',
      });
      expect(resolveVibrancyConfig('cindy', true, 'darwin')).toEqual({
        vibrancy: material === 'none' ? null : material,
        backgroundColor: '#00000000',
      });
    }
  });

  it('darwin × 非 CINDY × vibrancy 材质旋钮:保持原 macOS 不透明回退', () => {
    for (const material of MATERIAL_VALUES) {
      process.env.XDT_VIBRANCY_MATERIAL = material;
      expect(resolveVibrancyConfig('default', false, 'darwin')).toEqual({
        vibrancy: null,
        backgroundColor: '#f8f8f6',
      });
      expect(resolveVibrancyConfig('atom-one', true, 'darwin')).toEqual({
        vibrancy: null,
        backgroundColor: '#1f1f1e',
      });
    }
  });

  it('win32 × Win11 × CINDY:默认 acrylic + 透明底', () => {
    expect(
      resolveVibrancyConfig('cindy', false, 'win32', {
        getSystemVersion: () => '10.0.22631',
      }),
    ).toEqual({
      vibrancy: null,
      backgroundColor: '#00000000',
      backgroundMaterial: 'acrylic',
    });
  });

  it('win32 × Win11 × CINDY:支持 mica 材质旋钮', () => {
    process.env.XDT_BACKDROP_MATERIAL = 'mica';
    expect(
      resolveVibrancyConfig('cindy', true, 'win32', {
        getSystemVersion: () => '10.0.22631.2861',
      }),
    ).toEqual({
      vibrancy: null,
      backgroundColor: '#00000000',
      backgroundMaterial: 'mica',
    });
  });

  it('win32 × Win11 × CINDY:支持 none 材质旋钮', () => {
    process.env.XDT_BACKDROP_MATERIAL = 'none';
    expect(
      resolveVibrancyConfig('cindy', false, 'win32', {
        getSystemVersion: () => '10.0.22000',
      }),
    ).toEqual({
      vibrancy: null,
      backgroundColor: '#00000000',
      backgroundMaterial: 'none',
    });
  });

  it('win32 × Win11 × CINDY:非法材质 warn 后回落 acrylic', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env.XDT_BACKDROP_MATERIAL = 'glass';
    expect(
      resolveVibrancyConfig('cindy', true, 'win32', {
        getSystemVersion: () => '10.0.22631',
      }),
    ).toEqual({
      vibrancy: null,
      backgroundColor: '#00000000',
      backgroundMaterial: 'acrylic',
    });
    expect(warn).toHaveBeenCalledWith(
      "[main] Invalid XDT_BACKDROP_MATERIAL 'glass', falling back to acrylic.",
    );
  });

  it('win32 × Win10:回退不透明 surface', () => {
    process.env.XDT_BACKDROP_MATERIAL = 'mica';
    expect(
      resolveVibrancyConfig('cindy', false, 'win32', {
        getSystemVersion: () => '10.0.19045',
      }),
    ).toEqual({
      vibrancy: null,
      backgroundColor: '#f8f8f6',
      backgroundMaterial: 'none',
    });
  });

  it('win32 × 非 CINDY:回退不透明 surface', () => {
    process.env.XDT_BACKDROP_MATERIAL = 'mica';
    expect(
      resolveVibrancyConfig('default', true, 'win32', {
        getSystemVersion: () => '10.0.22631',
      }),
    ).toEqual({
      vibrancy: null,
      backgroundColor: '#1f1f1e',
      backgroundMaterial: 'none',
    });
  });

  it('win32 × 版本读取异常/解析失败:回退不透明 surface', () => {
    expect(
      resolveVibrancyConfig('cindy', false, 'win32', {
        getSystemVersion: () => {
          throw new Error('boom');
        },
      }),
    ).toEqual({
      vibrancy: null,
      backgroundColor: '#f8f8f6',
      backgroundMaterial: 'none',
    });
    expect(
      resolveVibrancyConfig('cindy', true, 'win32', {
        getSystemVersion: () => 'Windows 11',
      }),
    ).toEqual({
      vibrancy: null,
      backgroundColor: '#1f1f1e',
      backgroundMaterial: 'none',
    });
  });

  it('linux:维持不透明 surface 且不读取 backgroundMaterial 旋钮', () => {
    process.env.XDT_BACKDROP_MATERIAL = 'mica';
    expect(resolveVibrancyConfig('cindy', false, 'linux')).toEqual({
      vibrancy: null,
      backgroundColor: '#f8f8f6',
    });
  });
});
