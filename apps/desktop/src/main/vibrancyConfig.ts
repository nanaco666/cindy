/**
 * E4D 毛玻璃 vibrancy 配置(R1 audit,用户裁决透壁纸 2026-07-17)。
 * 仅 CINDY family 启用 macOS vibrancy + 透明底(透出桌面壁纸);其他 family 恢复
 * 不透明。Windows/Linux 无 vibrancy 等价,本轮回退不透明(留 TODO backgroundMaterial)。
 */
export interface VibrancyConfig {
  vibrancy: string | null;
  backgroundColor: string;
}

export function resolveVibrancyConfig(
  familyId: string,
  isDark: boolean,
  platform: string,
): VibrancyConfig {
  const isCindy = familyId === 'cindy';
  const opaqueBg = isDark ? '#1f1f1e' : '#f8f8f6';
  if (platform === 'darwin') {
    return {
      vibrancy: isCindy ? 'under-window' : null,
      backgroundColor: isCindy ? '#00000000' : opaqueBg,
    };
  }
  // Windows/Linux:无 vibrancy,不透明底
  return { vibrancy: null, backgroundColor: opaqueBg };
}
