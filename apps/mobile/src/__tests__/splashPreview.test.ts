import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('mobile splash preview route', () => {
  it('is gated to dev visual mock and renders the production splash variant', () => {
    const source = readFileSync(resolve(process.cwd(), 'app/splash-preview.tsx'), 'utf8');

    expect(source).toContain("import { Redirect } from 'expo-router';");
    expect(source).toContain("import { CenteredScreen } from '@/components/CenteredScreen';");
    expect(source).toContain("import { MOBILE_VISUAL_MOCK_ENABLED } from '@/config/env';");
    expect(source).toContain('if (!MOBILE_VISUAL_MOCK_ENABLED) return <Redirect href="/" />;');
    expect(source).toContain('<CenteredScreen title="Cindy" variant="splash" />');
    expect(source).not.toContain('process.env.EXPO_PUBLIC_CINDY_MOBILE_VISUAL_MOCK');
  });

  it('uses the Figma-cut splash illustration with the bottom fade baked into the asset', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/CenteredScreen.tsx'), 'utf8');

    expect(source).toContain("require('../../assets/splash/cindy-splash-illustration-fade.webp')");
    expect(source).not.toContain("require('../../assets/splash/cindy-splash-illustration.webp')");
    expect(existsSync(resolve(process.cwd(), 'assets/splash/cindy-splash-illustration-fade.webp'))).toBe(true);
  });

  it('keeps the branded splash free of app loading spinner and status text', () => {
    const splashSource = readFileSync(resolve(process.cwd(), 'src/components/CenteredScreen.tsx'), 'utf8');
    const layoutSource = readFileSync(resolve(process.cwd(), 'app/_layout.tsx'), 'utf8');
    const indexSource = readFileSync(resolve(process.cwd(), 'app/index.tsx'), 'utf8');

    expect(splashSource).not.toContain('styles.splashLoadingArea');
    expect(splashSource).not.toContain('styles.splashSubtitle');
    expect(splashSource).not.toContain('colors.brandSplashMuted');
    expect(layoutSource).not.toContain('subtitle="正在检查更新" variant="splash"');
    expect(layoutSource).not.toContain('subtitle="正在启动" variant="splash"');
    expect(indexSource).not.toContain('subtitle="正在恢复登录状态" variant="splash"');
  });
});
