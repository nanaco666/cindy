import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('mobile account deletion', () => {
  it('lets auth-server eligibility exclusively control settings visibility', () => {
    const settings = source('app/settings.tsx');
    const visibilityBlock = settings.slice(
      settings.indexOf('void auth\n      .getAccountDeletionAvailability()'),
      settings.indexOf('const copyRow'),
    );

    expect(settings).toContain("testID: 'settings.deleteAccountButton'");
    expect(settings).toContain('...(accountDeletionAvailable');
    expect(visibilityBlock).toContain(
      'availability.enabled && availability.available',
    );
    expect(visibilityBlock).not.toContain('membershipKind');
  });

  it('persists the receipt before confirmation and clears local credentials without logout', () => {
    const context = source('src/auth/AuthContext.tsx');
    const requestStart = context.indexOf(
      'const requestAccountDeletionChallenge = useCallback',
    );
    const confirmStart = context.indexOf(
      'const confirmAccountDeletion = useCallback',
    );
    const requestBody = context.slice(requestStart, confirmStart);
    const confirmBody = context.slice(
      confirmStart,
      context.indexOf('const getAccountDeletionStatus', confirmStart),
    );

    expect(context).toContain(
      "'cindy.mobile.auth.accountDeletionReceipt'",
    );
    expect(requestBody.indexOf('persistAccountDeletionReceipt')).toBeLessThan(
      requestBody.indexOf('return challenge'),
    );
    expect(confirmBody).toContain('await clearLocalSession();');
    expect(confirmBody).not.toContain('.logout(');
    expect(confirmBody).toContain("'REQUEST_TIMEOUT'");
    expect(confirmBody).toContain(
      '.getAccountDeletionStatus(input.receiptToken)',
    );
  });

  it('requires a six-digit code and explicit acknowledgement', () => {
    const deletion = source('app/account-deletion.tsx');

    expect(deletion).toContain('testID="accountDeletion.codeInput"');
    expect(deletion).toContain('testID="accountDeletion.acknowledgement"');
    expect(deletion).toContain(
      'disabled: busy || code.length !== 6 || !acknowledged',
    );
    expect(deletion).toContain("testID: 'accountDeletion.confirmButton'");
    expect(deletion).toContain('30 天内重新登录可撤销');
  });

  it('shows persisted status on login and sends Apple authorization codes', () => {
    const login = source('app/(auth)/login.tsx');
    const nativeSocial = source('src/auth/nativeSocial.ts');

    expect(login).toContain('testID="login.accountDeletionStatus"');
    expect(login).toContain('现在重新登录即可取消注销');
    expect(nativeSocial).toContain('!credential.authorizationCode');
    expect(nativeSocial).toContain(
      'authorizationCode: credential.authorizationCode',
    );
  });
});
