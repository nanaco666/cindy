export type VoiceInputMicrophonePermissionCache =
  | { ok: true; status: string }
  | { ok: false; status: string; error: string };

export function isExplicitMicrophonePermissionDenied(status: string): boolean {
  return status === 'denied' || status === 'restricted';
}

export function resolveMicrophonePermissionSnapshot(
  status: string,
  rendererVerified: boolean,
): VoiceInputMicrophonePermissionCache {
  if (status === 'granted' || (rendererVerified && !isExplicitMicrophonePermissionDenied(status))) {
    return { ok: true, status };
  }
  return {
    ok: false,
    status,
    error: 'Microphone permission is required for voice input. Enable it in macOS System Settings.',
  };
}
