import { deleteSecureItem, getSecureItem, setSecureItem } from '@/auth/secureStorage';

const STORAGE_KEY = 'xdt.mobileVoiceServiceMode.v1';

/**
 * Which credential plane powers mobile voice dictation.
 * - 'cindy': the managed Cindy voice service (login token → one-shot tickets).
 * - 'byok': the user's own LiteLLM key saved in settings
 *   (mobileVoiceLiteLlmSettings), restoring the pre-managed direct-dial path.
 *
 * Storage keeps only the explicit 'byok' override; absence means "follow the
 * product default" (currently 'cindy') so future default changes reach users
 * who never customized the mode. The two planes never fall back into each
 * other: BYOK failures surface as errors instead of silently switching to the
 * managed service, and managed mode never spends the user's own key.
 */
export type MobileVoiceServiceMode = 'cindy' | 'byok';

export const DEFAULT_MOBILE_VOICE_SERVICE_MODE: MobileVoiceServiceMode = 'cindy';

export async function getMobileVoiceServiceMode(): Promise<MobileVoiceServiceMode> {
  const raw = (await getSecureItem(STORAGE_KEY))?.trim().toLowerCase();
  return raw === 'byok' ? 'byok' : DEFAULT_MOBILE_VOICE_SERVICE_MODE;
}

export async function setMobileVoiceServiceMode(mode: MobileVoiceServiceMode): Promise<void> {
  // Selecting the default clears the override instead of snapshotting it.
  if (mode === 'byok') {
    await setSecureItem(STORAGE_KEY, 'byok');
  } else {
    await deleteSecureItem(STORAGE_KEY);
  }
}

export const __testing = {
  storageKey: STORAGE_KEY,
};
