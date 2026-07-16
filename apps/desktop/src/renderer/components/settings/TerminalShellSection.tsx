/**
 * TerminalShellSection — Settings → 个性化 下的 RSB 默认终端 shell 选择。
 *
 * UI:
 *   ┌─ 默认终端 shell ──────────────────────────┐
 *   │ 新建终端 tab 时使用此 shell                │
 *   │ ┌─────────────────────────────────────┐  │
 *   │ │ 自动选择 (zsh)                  ▼   │  │
 *   │ └─────────────────────────────────────┘  │
 *   └─────────────────────────────────────────┘
 *
 * - 列表在下拉打开瞬间才调 `listAvailableShells()`（main 端 memo,不会反复 probe）。
 * - `'auto'` 永远是第一项;后面是当前机器实际装了的 shell（zsh / bash / pwsh / cmd / ...)，
 *   未装的不展示。
 * - 用户选 `'auto'` 之外 = 已 customize（rule 20），右侧出现「恢复默认」按钮 → 一键回 auto。
 * - 改变默认只影响**新建**的 terminal tab,已有 tab 不动（要切就 Settings 改 + 新建 tab）。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import type { AvailableShell, ShellId } from '../../../shared/terminal-bridge';
import { DefaultOverrideControls } from './DefaultOverrideControls';

export function TerminalShellSection() {
  const { t } = useTranslation();

  const [pref, setPref] = useState<ShellId | null>(null);
  const [shells, setShells] = useState<AvailableShell[] | null>(null);
  const [resetting, setResetting] = useState(false);

  // 首次 mount 拉 pref;shell 列表懒加载(用户聚焦下拉时再拉)
  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.terminal
      .getDefaultShellPref()
      .then((value) => {
        if (!cancelled) setPref(value);
      })
      .catch(() => {
        if (!cancelled) setPref('auto');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const ensureShellsLoaded = useCallback(() => {
    if (shells != null) return;
    void window.electronAPI.terminal
      .listAvailableShells()
      .then((list) => setShells(list))
      .catch(() => setShells([]));
  }, [shells]);

  const autoTargetLabel = useMemo(() => {
    return shells?.find((s) => s.isAutoDetectTarget)?.displayName ?? '';
  }, [shells]);

  const isCustomized = pref != null && pref !== 'auto';

  const onChange = useCallback(
    (value: ShellId) => {
      const prev = pref;
      setPref(value); // 乐观更新
      void window.electronAPI.terminal
        .setDefaultShellPref(value)
        .catch((err) => {
          setPref(prev);
          toast.error(err instanceof Error ? err.message : String(err));
        });
    },
    [pref],
  );

  const onReset = useCallback(async () => {
    if (resetting) return;
    setResetting(true);
    const prev = pref;
    setPref('auto');
    try {
      await window.electronAPI.terminal.setDefaultShellPref('auto');
      toast.success(t('settings.defaults.restored'));
    } catch (err) {
      setPref(prev);
      toast.error(err instanceof Error ? err.message : t('settings.defaults.restoreFailed'));
    } finally {
      setResetting(false);
    }
  }, [resetting, pref, t]);

  if (pref === null) return null; // 加载中,不闪空 UI

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex flex-col gap-1">
        <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
          {t('settings.terminalShell.title')}
        </h2>
        <p className="text-13 leading-[1.5] text-[var(--settings-section-desc)]">
          {t('settings.terminalShell.description')}
        </p>
      </div>

      <div className="flex flex-col gap-[14px] rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] p-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-14 font-medium leading-none text-[var(--text-primary)]">
            {t('settings.terminalShell.card.label')}
          </p>
          <DefaultOverrideControls
            isCustomized={isCustomized}
            disabled={resetting}
            onReset={() => void onReset()}
          />
        </div>

        <p className="text-12 leading-[1.5] text-[var(--text-secondary)]">
          {t('settings.terminalShell.card.description')}
        </p>

        <div className="relative min-w-0">
          <select
            value={pref}
            onFocus={ensureShellsLoaded}
            onMouseDown={ensureShellsLoaded}
            onChange={(e) => onChange(e.target.value as ShellId)}
            className={cn(
              'h-9 w-full min-w-0 appearance-none rounded-full border py-0 pl-3 pr-9 text-12 outline-none',
              'bg-[var(--settings-input-bg)] text-[var(--settings-input-text)]',
              'border-[var(--settings-input-border)] focus:ring-2 focus:ring-[var(--focus-ring-soft)]',
            )}
            aria-label={t('settings.terminalShell.card.selectAria')}
          >
            <option value="auto">
              {autoTargetLabel
                ? t('settings.terminalShell.autoWithTarget', { target: autoTargetLabel })
                : t('settings.terminalShell.auto')}
            </option>
            {shells?.map((shell) => (
              <option key={shell.id} value={shell.id}>
                {shell.displayName}
              </option>
            ))}
            {/* 用户上次选的 shell 当前不可用(卸了)时,仍要显示让用户可以切回 auto */}
            {pref !== 'auto' && shells != null && !shells.some((s) => s.id === pref) && (
              <option value={pref}>{pref}</option>
            )}
          </select>
          <ChevronDown
            size={15}
            className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-[var(--settings-input-text)] opacity-75"
            aria-hidden="true"
          />
        </div>
      </div>
    </div>
  );
}
