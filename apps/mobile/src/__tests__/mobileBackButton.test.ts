import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readTextLf = (...args: Parameters<typeof readFileSync>): string =>
  String(readFileSync(...args)).replace(/\r\n/g, '\n');

describe('mobile top-level back buttons', () => {
  it('uses one shared page-header back button treatment across top-level screens', () => {
    const primitives = readTextLf(resolve(process.cwd(), 'src/components/MobilePrimitives.tsx'), 'utf8');
    const session = readTextLf(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');
    const newSession = readTextLf(resolve(process.cwd(), 'app/sessions/new.tsx'), 'utf8');
    const files = readTextLf(resolve(process.cwd(), 'app/files/[sessionId].tsx'), 'utf8');

    const backButtonStart = primitives.indexOf('backButton: {');
    const backButtonEnd = primitives.indexOf('backButtonCompact:', backButtonStart);
    const backButtonStyle = primitives.slice(backButtonStart, backButtonEnd);

    expect(primitives).toContain('export function ScreenBackButton');
    expect(backButtonStyle).toContain('backgroundColor: colors.surfaceElevated');
    expect(backButtonStyle).toContain('borderColor: colors.border');
    expect(backButtonStyle).toContain('borderRadius: radius.pill');
    expect(backButtonStyle).toContain('borderWidth: StyleSheet.hairlineWidth');
    expect(backButtonStyle).toContain('height: 40');
    expect(backButtonStyle).toContain('width: 40');
    expect(primitives).toContain('<ChevronLeft color={colors.textPrimary} size={iconSize.md} strokeWidth={iconStroke.medium} />');

    expect(session).toContain("import { ScreenBackButton } from '@/components/MobilePrimitives';");
    expect(session).toContain('testID="session.backButton"');
    expect(newSession).toContain("import { ScreenBackButton } from '@/components/MobilePrimitives';");
    expect(newSession).toContain('testID="newSession.backButton"');
    expect(files).toContain("import { ScreenBackButton } from '@/components/MobilePrimitives';");
    expect(files).toContain('testID="files.backButton"');

    expect(session).not.toContain('<ChevronLeft color={colors.textPrimary} size={iconSize.md}');
    expect(newSession).not.toContain('<ChevronLeft color={colors.textPrimary}');
    expect(files).not.toContain('<ChevronLeft color={colors.textPrimary}');
  });
});
