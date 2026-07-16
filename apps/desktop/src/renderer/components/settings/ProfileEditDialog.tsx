import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

/**
 * ProfileEditDialog — 设置页用户卡片的「编辑名字 / 头像」弹窗。
 *
 * 业务全在 main(profileEdit.ts):这里只收集输入并经 IPC 提交,保存成功后
 * main 会重广播 auth:state-change,卡片 / 侧边栏经 AuthContext 自动刷新。
 * 覆写仅本设备生效(服务端资料仍是默认真源),弹窗内有文案说明。
 *
 * 头像动作三态:keep(没动)/ set(选了新图,预览用 data URL)/ reset(恢复默认)。
 * 名字输入留空 = 恢复默认名字(placeholder 展示服务端名字)。
 */
interface ProfileEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type AvatarDraft =
  | { type: 'keep' }
  | { type: 'set'; filePath: string; previewDataUrl: string }
  | { type: 'reset' };

interface ProfileState {
  serverName: string;
  serverAvatar: string | null;
  overrideName: string | null;
  overrideAvatarUrl: string | null;
}

export function ProfileEditDialog({ open, onOpenChange }: ProfileEditDialogProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<ProfileState | null>(null);
  const [name, setName] = useState('');
  const [avatarDraft, setAvatarDraft] = useState<AvatarDraft>({ type: 'keep' });
  const [saving, setSaving] = useState(false);
  // Radix AlertDialog.Action 在点击的同一事件里**同步**触发 onOpenChange(false),
  // 彼时 setSaving(true) 还没重渲染、闭包里的 saving 仍是 false——守卫必须走 ref
  // 才拦得住(同款踩坑与修法见 WindowControls.tsx 的 closingRef)。
  const savingRef = useRef(false);

  // 打开时拉预填数据并复位草稿(异步取数期间不渲染内容,避免半空帧;
  // 数据都在本地 main,毫秒级返回,无需 loading 态 —— 规则 7)。
  useEffect(() => {
    if (!open) return;
    let stale = false;
    void window.electronAPI
      .profileGetState()
      .then((s) => {
        if (stale) return;
        setState(s);
        setName(s.overrideName ?? '');
        setAvatarDraft({ type: 'keep' });
      })
      .catch(() => {
        if (!stale) onOpenChange(false);
      });
    return () => {
      stale = true;
    };
  }, [open, onOpenChange]);

  const handleChooseAvatar = useCallback(async () => {
    try {
      const result = await window.electronAPI.profileChooseAvatar();
      if (result.canceled || !result.filePath || !result.previewDataUrl) return;
      setAvatarDraft({
        type: 'set',
        filePath: result.filePath,
        previewDataUrl: result.previewDataUrl,
      });
    } catch {
      toast.error(t('settings.userProfile.edit.avatarInvalid'));
    }
  }, [t]);

  const handleSave = useCallback(async () => {
    if (!state || savingRef.current) return;
    savingRef.current = true; // await 之前同步置位,拦住 Radix Action 的同步关闭
    setSaving(true);
    try {
      const trimmed = name.trim();
      await window.electronAPI.profileUpdate({
        name: trimmed === '' ? null : trimmed,
        avatar:
          avatarDraft.type === 'set'
            ? { type: 'set', filePath: avatarDraft.filePath }
            : { type: avatarDraft.type },
      });
      savingRef.current = false;
      setSaving(false);
      onOpenChange(false);
    } catch {
      savingRef.current = false;
      setSaving(false);
      toast.error(t('settings.userProfile.edit.saveFailed'));
    }
  }, [state, name, avatarDraft, onOpenChange, t]);

  if (!state) return null;

  // 预览优先级:新选的图 > 现有覆写(未 reset 时)> 服务端头像 > 首字母。
  const previewUrl =
    avatarDraft.type === 'set'
      ? avatarDraft.previewDataUrl
      : avatarDraft.type === 'reset'
        ? state.serverAvatar
        : (state.overrideAvatarUrl ?? state.serverAvatar);
  const effectiveName =
    name.trim() !== '' ? name.trim() : state.serverName || t('settings.userProfile.fallbackName');
  const initial = effectiveName.charAt(0).toUpperCase();
  const hasCustomAvatar =
    avatarDraft.type === 'set' || (avatarDraft.type === 'keep' && state.overrideAvatarUrl !== null);

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (savingRef.current && !next) return; // 保存中不允许关(ref 守卫,见 savingRef 注释)
        onOpenChange(next);
      }}
      title={t('settings.userProfile.edit.title')}
      confirmText={t('settings.userProfile.edit.save')}
      cancelText={t('settings.userProfile.edit.cancel')}
      autoFocusConfirm
      loading={saving}
      onConfirm={() => void handleSave()}
      content={
        <div className="flex flex-col gap-4">
          {/* 头像行:预览 + 更换 / 恢复默认 */}
          <div className="flex items-center gap-4">
            {previewUrl ? (
              <img
                src={previewUrl}
                alt={effectiveName}
                className={cn(
                  'h-[52px] w-[52px] shrink-0 rounded-full object-cover',
                  'border border-[var(--settings-profile-card-border)]',
                )}
              />
            ) : (
              <div
                className={cn(
                  'flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-full',
                  'bg-[var(--settings-profile-avatar-bg)]',
                  'border border-[var(--settings-profile-card-border)]',
                  'text-18 font-medium text-[var(--settings-profile-avatar-text)]',
                )}
              >
                {initial}
              </div>
            )}
            <div className="flex flex-col items-start gap-1.5">
              <button
                type="button"
                onClick={() => void handleChooseAvatar()}
                className={cn(
                  'rounded-full border border-[var(--settings-input-border)] px-3 py-1 text-12',
                  'text-[var(--settings-input-text)] transition-colors',
                  'hover:bg-[var(--confirm-btn-secondary-hover)]',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
                )}
              >
                {t('settings.userProfile.edit.changeAvatar')}
              </button>
              {hasCustomAvatar && (
                <button
                  type="button"
                  onClick={() => setAvatarDraft({ type: 'reset' })}
                  className={cn(
                    'px-1 text-12 text-[var(--text-tertiary)] transition-colors',
                    'hover:text-[var(--text-primary)]',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
                  )}
                >
                  {t('settings.userProfile.edit.resetAvatar')}
                </button>
              )}
            </div>
          </div>

          {/* 名字行:留空 = 恢复默认(placeholder 即服务端名字) */}
          <label className="flex flex-col gap-1.5">
            <span className="text-12 text-[var(--text-secondary)]">
              {t('settings.userProfile.edit.nameLabel')}
            </span>
            <input
              type="text"
              value={name}
              maxLength={40}
              placeholder={state.serverName}
              onChange={(e) => setName(e.target.value)}
              className={cn(
                'h-8 rounded-lg border border-[var(--settings-input-border)]',
                'bg-[var(--settings-input-bg)] px-3 text-13 text-[var(--settings-input-text)]',
                'outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]',
              )}
            />
            <span className="text-11 text-[var(--text-tertiary)]">
              {t('settings.userProfile.edit.nameHint')}
            </span>
          </label>

          {/* 覆写只在本设备生效的透明化说明 */}
          <p className="text-11 leading-relaxed text-[var(--text-tertiary)]">
            {t('settings.userProfile.edit.localOnlyHint')}
          </p>
        </div>
      }
    />
  );
}
