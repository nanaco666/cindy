import { useCallback, useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleAlert, Eye, EyeOff, ExternalLink } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { useApiKey } from '@/hooks/useApiKey';

/** XD 网关控制台(与 API 密钥页同一处,用户在此创建 / 查看 key)。 */
const XD_GATEWAY_CONSOLE_URL = 'https://console.tapsvc.com/nova/#/ai-gateway?tab=keys';

interface XdGatewayKeyDialogProps {
  /** 保存成功后回调(关闭弹窗 + 刷新供应商连接态)。 */
  onSaved: () => void;
  /** 关闭弹窗(不保存)。 */
  onClose: () => void;
}

/**
 * XdGatewayKeyDialog —— XD 网关 API Key 录入弹窗(从供应商页 XD 行的「连接 / 更换 key」触发)。
 *
 * 取代旧的「跳转到 API 密钥页」:XD 网关 key 的录入 / 更换就地弹窗完成 —— API 密钥页
 * 后续不再承载 XD 配置(A5)。复用 useApiKey 的保存链路(test 通过才落盘);
 * 「打开控制台」链接与 API 密钥页完全一致(同一个 XD 网关控制台 + 文案)。
 *
 * 两个动作:保存(主)/ 关闭(次),**无「暂时跳过」**—— 启动不再强制配 key。
 * 本组件随调用方的 open 状态挂载 / 卸载,故 useApiKey 的 saveSuccess 初值为 false,
 * 只会因本次保存翻 true → useEffect 触发 onSaved(关闭 + 刷新)。
 */
export function XdGatewayKeyDialog({ onSaved, onClose }: XdGatewayKeyDialogProps) {
  const { t } = useTranslation();
  const { key, setKey, saveKey, isSaving, errorMessage, validationError, saveSuccess } = useApiKey();
  const [showKey, setShowKey] = useState(false);

  const errText = validationError || errorMessage;
  const hasError = !!errText;
  const canSave = key.startsWith('sk-') && !isSaving;

  useEffect(() => {
    if (saveSuccess) onSaved();
  }, [saveSuccess, onSaved]);

  const handleSave = useCallback(() => {
    if (!canSave) return;
    void saveKey();
  }, [canSave, saveKey]);

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && canSave) {
        e.preventDefault();
        handleSave();
      }
    },
    [canSave, handleSave],
  );

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-[var(--overlay-modal)]">
      <div
        className={cn(
          'flex w-[480px] flex-col gap-5 rounded-[16px] p-6',
          'border border-[var(--login-card-border)] bg-[var(--login-card-bg)]',
          'shadow-[var(--shadow-menu)]',
        )}
      >
        {/* Header */}
        <div className="flex flex-col gap-1.5">
          <h2 className="text-18 font-semibold leading-[1.3] text-[var(--settings-section-title)]">
            {t('settings.providers.xd.keyDialog.title')}
          </h2>
          <p className="text-13 font-normal leading-[1.55] text-[var(--settings-section-desc)]">
            {t('settings.providers.xd.keyDialog.description')}
          </p>
        </div>

        {/* Form */}
        <div className="flex flex-col gap-[10px]">
          {/* Label row + 打开控制台(与 API 密钥页同链接 + 同文案) */}
          <div className="flex items-center justify-between">
            <span className="text-13 font-medium text-[var(--settings-section-title)]">
              {t('settings.apiKey.title')}
            </span>
            <button
              type="button"
              onClick={() => window.electronAPI.openExternal(XD_GATEWAY_CONSOLE_URL)}
              className="inline-flex items-center gap-1 text-12 font-medium text-[var(--settings-source-link)] hover:underline"
            >
              {t('settings.apiKey.openConsole')}
              <ExternalLink size={12} />
            </button>
          </div>

          {/* Input with eye toggle */}
          <div className="relative">
            <input
              type={showKey ? 'text' : 'password'}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('settings.providers.xd.keyDialog.placeholder')}
              aria-label={t('settings.apiKey.inputAria')}
              autoFocus
              className={cn(
                'h-[44px] w-full rounded-[10px] pl-[14px] pr-10 text-14 outline-none transition-colors',
                'text-[var(--settings-input-text)] placeholder:text-[var(--settings-input-placeholder)]',
                hasError
                  ? 'border-[1.5px] border-[var(--error-border)] bg-[var(--error-bg)]'
                  : 'border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] focus:border-[var(--settings-input-border-focus)]',
              )}
              style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              className="absolute right-[12px] top-1/2 -translate-y-1/2 text-[var(--settings-eye-icon)] transition-colors hover:text-[var(--settings-eye-icon-hover)]"
              aria-label={showKey ? t('settings.apiKey.hideKey') : t('settings.apiKey.showKey')}
            >
              {showKey ? <Eye size={16} /> : <EyeOff size={16} />}
            </button>
          </div>

          {/* Error message — conditional */}
          {hasError && (
            <div className="flex items-start gap-[6px]" role="alert">
              <CircleAlert size={14} className="mt-[2px] shrink-0 text-[var(--error-fg)]" />
              <p className="text-12 leading-[1.5] text-[var(--error-fg)]">{errText}</p>
            </div>
          )}
        </div>

        {/* Button row —— 复用项目标准 confirm/cancel 按钮样式(见 ui/confirm-dialog.tsx):
            次操作(关闭)= 描边 pill 在左,主操作(保存)= 实心 pill 在右。 */}
        <div className="flex justify-end gap-2.5">
          <button
            type="button"
            onClick={onClose}
            className={cn(
              'inline-flex items-center justify-center rounded-full px-6 py-2.5 text-13 font-medium',
              'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
              'active:scale-[0.98]',
              'border bg-transparent',
              'border-[var(--confirm-btn-secondary-border)] text-[var(--confirm-btn-secondary-text)]',
              'hover:bg-[var(--confirm-btn-secondary-hover)]',
              'focus-visible:ring-[var(--confirm-btn-secondary-border)]',
            )}
          >
            {t('settings.providers.xd.keyDialog.close')}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            className={cn(
              'inline-flex items-center justify-center gap-2 rounded-full px-6 py-2.5 text-13 font-medium',
              'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
              'active:scale-[0.98]',
              'bg-[var(--confirm-btn-primary-bg)] text-[var(--confirm-btn-primary-text)]',
              'hover:bg-[var(--confirm-btn-primary-hover)]',
              'focus-visible:ring-[var(--confirm-btn-primary-bg)]',
              !canSave && 'cursor-not-allowed opacity-50',
            )}
          >
            {isSaving && <Spinner size={14} />}
            {saveSuccess ? t('settings.apiKey.saved') : t('settings.apiKey.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
