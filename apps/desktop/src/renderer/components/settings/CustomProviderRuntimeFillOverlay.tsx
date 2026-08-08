import { Check, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import {
  runtimeFillFieldHasValue,
  type RuntimeFillDraft,
  type RuntimeFillField,
  type RuntimeFillFieldDiff,
} from '@/lib/customProviderRuntimeFill';

import type { AgentKind } from '@cindy/model-providers';

export interface RuntimeFillTargetPlan {
  agent: AgentKind;
  diffs: RuntimeFillFieldDiff[];
}

export interface RuntimeFillDialogState {
  source: AgentKind;
  stage: 'review' | 'confirm';
  targets: RuntimeFillTargetPlan[];
  selected: Partial<Record<AgentKind, RuntimeFillField[]>>;
}

function runtimeFillUrlSummary(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  try {
    const url = new URL(trimmed);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '') || fallback;
  } catch {
    // Avoid echoing an arbitrary unfinished string that may contain a token-like query value.
    return fallback;
  }
}

export function CustomProviderRuntimeFillOverlay({
  state,
  drafts,
  runtimeNames,
  onClose,
  onContinue,
  onBack,
  onToggleField,
  onApply,
}: {
  state: RuntimeFillDialogState;
  drafts: Record<AgentKind, RuntimeFillDraft>;
  runtimeNames: Record<AgentKind, string>;
  onClose: () => void;
  onContinue: () => void;
  onBack: () => void;
  onToggleField: (agent: AgentKind, field: RuntimeFillField) => void;
  onApply: () => void;
}) {
  const { t } = useTranslation();
  const sourceName = runtimeNames[state.source];
  const sourceDraft = drafts[state.source];
  const hasSelectedOverwrite = state.targets.some((target) =>
    target.diffs.some(
      (diff) =>
        diff.targetState === 'conflict' &&
        (state.selected[target.agent]?.includes(diff.field) ?? false),
    ),
  );
  const hasSelection = state.targets.some(
    (target) => (state.selected[target.agent]?.length ?? 0) > 0,
  );

  const summaryFor = (field: RuntimeFillField, draft: RuntimeFillDraft): string => {
    switch (field) {
      case 'baseUrl':
      case 'modelsUrl':
        return runtimeFillUrlSummary(
          field === 'baseUrl' ? draft.baseUrl : draft.modelsUrl,
          runtimeFillFieldHasValue(field, draft)
            ? t('settings.providers.custom.runtimeFill.values.configured')
            : t('settings.providers.custom.runtimeFill.values.default'),
        );
      case 'apiKey':
        return runtimeFillFieldHasValue(field, draft)
          ? t('settings.providers.custom.runtimeFill.values.secretSet')
          : t('settings.providers.custom.runtimeFill.values.empty');
      case 'models': {
        const count = draft.models.filter(
          (model) =>
            model.id.trim().length > 0 ||
            model.name.trim().length > 0 ||
            model.contextWindow !== undefined,
        ).length;
        return count > 0
          ? t('settings.providers.custom.runtimeFill.values.models', { count })
          : t('settings.providers.custom.runtimeFill.values.empty');
      }
      case 'headers': {
        const count = draft.headers.filter(
          (header) => header.name.trim().length > 0 || header.value.trim().length > 0,
        ).length;
        return count > 0
          ? t('settings.providers.custom.runtimeFill.values.headers', { count })
          : t('settings.providers.custom.runtimeFill.values.empty');
      }
    }
  };

  const fieldLabel = (field: RuntimeFillField): string =>
    t(`settings.providers.custom.runtimeFill.fields.${field}`);

  return (
    <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-[var(--overlay-modal)] px-4">
      <div
        className={cn(
          'flex max-h-[78vh] w-[520px] max-w-full flex-col rounded-[16px]',
          'border border-[var(--border-default)] bg-[var(--surface-elevated)]',
          'shadow-[var(--shadow-menu)]',
        )}
      >
        <div className="flex items-start justify-between gap-4 px-5 pb-2 pt-4">
          <div className="min-w-0">
            <h3 className="text-15 font-semibold text-[var(--settings-section-title)]">
              {state.stage === 'review'
                ? t('settings.providers.custom.runtimeFill.reviewTitle')
                : t('settings.providers.custom.runtimeFill.confirmTitle')}
            </h3>
            <p className="mt-0.5 text-12 leading-snug text-[var(--text-tertiary)]">
              {state.stage === 'review'
                ? t('settings.providers.custom.runtimeFill.reviewSubtitle')
                : t('settings.providers.custom.runtimeFill.confirmSubtitle', {
                    source: sourceName,
                  })}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('settings.providers.custom.cancel')}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)]"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 pb-2 pt-2">
          <div
            className="mb-3 flex items-center justify-between gap-3 rounded-[10px] px-3 py-2.5"
            style={{ backgroundColor: 'var(--surface)' }}
          >
            <span className="text-12 text-[var(--text-tertiary)]">
              {t('settings.providers.custom.runtimeFill.source')}
            </span>
            <span className="text-13 font-medium text-[var(--settings-section-title)]">
              {sourceName}
            </span>
          </div>

          <div className="flex flex-col gap-4">
            {state.targets.map((target) => {
              const targetName = runtimeNames[target.agent];
              const conflictCount = target.diffs.filter(
                (diff) => diff.targetState === 'conflict',
              ).length;
              const changedDiffs = target.diffs.filter((diff) => diff.targetState !== 'same');
              const targetDraft = drafts[target.agent];
              return (
                <section key={target.agent} className="flex flex-col gap-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <h4 className="truncate text-13 font-medium text-[var(--settings-section-title)]">
                        {targetName}
                      </h4>
                      <p className="mt-0.5 text-11 text-[var(--text-tertiary)]">
                        {conflictCount > 0
                          ? t('settings.providers.custom.runtimeFill.targetConflict', {
                              count: conflictCount,
                            })
                          : t('settings.providers.custom.runtimeFill.targetReady', {
                              count: changedDiffs.length,
                            })}
                      </p>
                    </div>
                    <span className="shrink-0 text-11 font-medium text-[var(--text-secondary)]">
                      {conflictCount > 0
                        ? t('settings.providers.custom.runtimeFill.status.needsConfirm')
                        : t('settings.providers.custom.runtimeFill.status.ready')}
                    </span>
                  </div>

                  {state.stage === 'review' ? (
                    <div className="overflow-hidden rounded-[10px] border border-[var(--border-default)]">
                      <div
                        className="grid grid-cols-[0.8fr_1fr_1fr] gap-2 px-3 py-2 text-10 text-[var(--text-tertiary)]"
                        style={{ backgroundColor: 'var(--surface)' }}
                      >
                        <span>{t('settings.providers.custom.runtimeFill.columns.field')}</span>
                        <span>{t('settings.providers.custom.runtimeFill.columns.source')}</span>
                        <span>{t('settings.providers.custom.runtimeFill.columns.target')}</span>
                      </div>
                      {target.diffs.map((diff) => (
                        <div
                          key={diff.field}
                          className="grid grid-cols-[0.8fr_1fr_1fr] items-center gap-2 border-t border-[var(--border-default)] px-3 py-2.5 text-11"
                        >
                          <span className="font-medium text-[var(--settings-section-title)]">
                            {fieldLabel(diff.field)}
                          </span>
                          <span
                            className="truncate text-[var(--text-secondary)]"
                            title={summaryFor(diff.field, sourceDraft)}
                          >
                            {summaryFor(diff.field, sourceDraft)}
                          </span>
                          <span
                            className={cn(
                              'truncate',
                              diff.targetState === 'same'
                                ? 'text-[var(--text-tertiary)]'
                                : 'font-medium text-[var(--settings-section-title)]',
                            )}
                            title={summaryFor(diff.field, targetDraft)}
                          >
                            {summaryFor(diff.field, targetDraft)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      {changedDiffs.map((diff) => {
                        const selected =
                          state.selected[target.agent]?.includes(diff.field) ?? false;
                        return (
                          <button
                            key={diff.field}
                            type="button"
                            role="checkbox"
                            aria-checked={selected}
                            onClick={() => onToggleField(target.agent, diff.field)}
                            className="flex w-full items-center gap-2.5 rounded-[9px] border border-[var(--border-default)] px-3 py-2.5 text-left hover:bg-[var(--surface-hover)]"
                          >
                            <span
                              className={cn(
                                'flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors',
                                selected
                                  ? 'border-[var(--settings-input-border-focus)] bg-[var(--surface-elevated)] text-[var(--settings-section-title)]'
                                  : 'border-[var(--settings-input-border)] text-transparent',
                              )}
                            >
                              <Check size={12} strokeWidth={3} />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block text-12 font-medium text-[var(--settings-section-title)]">
                                {fieldLabel(diff.field)}
                              </span>
                              <span className="mt-0.5 block truncate text-11 text-[var(--text-tertiary)]">
                                {diff.field === 'apiKey'
                                  ? t('settings.providers.custom.runtimeFill.secretIndependent', {
                                      target: targetName,
                                    })
                                  : diff.targetState === 'conflict'
                                    ? t('settings.providers.custom.runtimeFill.overwriteCurrent')
                                    : t('settings.providers.custom.runtimeFill.fillEmpty')}
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  <p className="text-11 leading-[1.5] text-[var(--text-tertiary)]">
                    {t('settings.providers.custom.runtimeFill.protocolNote', {
                      target: targetName,
                    })}
                  </p>
                </section>
              );
            })}
          </div>

          <p className="mt-4 text-11 leading-[1.5] text-[var(--text-tertiary)]">
            {t('settings.providers.custom.runtimeFill.independentNote')}
          </p>
        </div>

        <div className="flex justify-end gap-2.5 px-5 py-3.5">
          <button
            type="button"
            onClick={state.stage === 'review' ? onClose : onBack}
            className={cn(
              'inline-flex items-center justify-center rounded-full border bg-transparent px-5 py-2 text-13 font-medium transition-colors active:scale-[0.98]',
              'border-[var(--confirm-btn-secondary-border)] text-[var(--confirm-btn-secondary-text)] hover:bg-[var(--confirm-btn-secondary-hover)]',
            )}
          >
            {state.stage === 'review'
              ? t('settings.providers.custom.cancel')
              : t('settings.providers.custom.runtimeFill.back')}
          </button>
          <button
            type="button"
            onClick={state.stage === 'review' ? onContinue : onApply}
            disabled={state.stage === 'confirm' && !hasSelection}
            className={cn(
              'inline-flex items-center justify-center rounded-full px-5 py-2 text-13 font-medium transition-colors active:scale-[0.98]',
              'bg-[var(--confirm-btn-primary-bg)] text-[var(--confirm-btn-primary-text)] hover:bg-[var(--confirm-btn-primary-hover)]',
              state.stage === 'confirm' && !hasSelection && 'cursor-not-allowed opacity-50',
            )}
          >
            {state.stage === 'review'
              ? hasSelectedOverwrite
                ? t('settings.providers.custom.runtimeFill.continue')
                : t('settings.providers.custom.runtimeFill.apply')
              : t('settings.providers.custom.runtimeFill.applyOverwrite')}
          </button>
        </div>
      </div>
    </div>
  );
}
