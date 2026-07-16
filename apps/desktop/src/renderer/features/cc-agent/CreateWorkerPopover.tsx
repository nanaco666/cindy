import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

import { FastModeToggle } from '@/components/new-chat/FastModeToggle';
import { ModelSelector } from '@/components/new-chat/ModelSelector';
import { useAgentCapabilities } from '@/hooks/useAgentCapabilities';
import { useProviders } from '@/hooks/useProviders';
import { cn } from '@/lib/utils';
import type { Effort } from '@/lib/userPreferences.types';

const PREDEFINED_ROLES = ['developer', 'designer', 'reviewer', 'tester', 'merger'] as const;
const PREFS_KEY = 'workerCreationPrefs';

interface WorkerAgentPrefs {
  model: string;
  effort: Effort;
  fast: boolean;
}

interface WorkerPrefs {
  lastAgent: 'codex' | 'claude-code';
  codex: WorkerAgentPrefs;
  'claude-code': WorkerAgentPrefs;
}

const DEFAULT_PREFS: WorkerPrefs = {
  lastAgent: 'codex',
  codex: { model: 'codex/gpt-5.5', effort: 'high', fast: false },
  'claude-code': { model: 'claude-opus-4-7', effort: 'high', fast: false },
};

function readWorkerPrefs(): WorkerPrefs {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<WorkerPrefs>;
    return {
      lastAgent: parsed.lastAgent === 'claude-code' ? 'claude-code' : 'codex',
      codex: {
        ...DEFAULT_PREFS.codex,
        ...(parsed.codex ?? {}),
        fast: parsed.codex?.fast === true,
      },
      'claude-code': {
        ...DEFAULT_PREFS['claude-code'],
        ...(parsed['claude-code'] ?? {}),
        fast: parsed['claude-code']?.fast === true,
      },
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function writeWorkerPrefs(prefs: WorkerPrefs): void {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // localStorage can be unavailable in restricted contexts; prefs are best-effort.
  }
}

export interface CreateWorkerForm {
  role: string;
  agent: 'claude-code' | 'codex';
  model: string;
  effort?: Effort;
  fast?: boolean;
  initialTask: string;
}

export interface CreateWorkerPopoverProps {
  open: boolean;
  onClose: () => void;
  onCreate: (form: CreateWorkerForm) => void;
  title?: string;
  submitLabel?: string;
  className?: string;
}

export function CreateWorkerPopover({
  open,
  onClose,
  onCreate,
  title,
  submitLabel,
  className,
}: CreateWorkerPopoverProps) {
  const { t } = useTranslation();
  const [role, setRole] = useState('developer');
  const [customRole, setCustomRole] = useState('');
  const [agent, setAgent] = useState<'claude-code' | 'codex'>('codex');
  const [model, setModel] = useState(DEFAULT_PREFS.codex.model);
  const [effort, setEffort] = useState<Effort>(DEFAULT_PREFS.codex.effort);
  const [fast, setFast] = useState(DEFAULT_PREFS.codex.fast);
  const [initialTask, setInitialTask] = useState('');
  const [prefs, setPrefs] = useState<WorkerPrefs>(DEFAULT_PREFS);

  const ccCaps = useAgentCapabilities('claude-code');
  const codexCaps = useAgentCapabilities('codex');
  // codex/ 骨折模型是「XD 网关来源」:连了 XD 网关(有 key)即可选用,与是否登录 OAuth 无关。
  const { providers, loading: providersLoading } = useProviders();
  const xdConnected = providers.some((p) => p.id === 'xd' && p.connected);
  const activeModels = useMemo(() => {
    const caps = agent === 'codex' ? codexCaps.capabilities : ccCaps.capabilities;
    const models = caps?.availableModels ?? [];
    if (agent !== 'codex') return models;
    return models.filter((m) => xdConnected || !m.id.startsWith('codex/'));
  }, [agent, xdConnected, ccCaps.capabilities, codexCaps.capabilities]);
  const activeCaps = agent === 'codex' ? codexCaps.capabilities : ccCaps.capabilities;
  const currentModel = activeModels.find((m) => m.id === model);
  const currentModelSupportsFast = Boolean(
    agent === 'codex' && activeCaps?.hasFastMode && currentModel?.supportsFastMode,
  );

  // 打开弹窗时恢复上次选择；initial task 不记忆，避免把旧任务误带到下一次创建。
  useEffect(() => {
    if (!open) return;
    const stored = readWorkerPrefs();
    const agentPrefs = stored[stored.lastAgent];
    setPrefs(stored);
    setAgent(stored.lastAgent);
    setModel(agentPrefs.model);
    setEffort(agentPrefs.effort);
    setFast(agentPrefs.fast);
    setInitialTask('');
  }, [open]);

  // capabilities 可能尚未加载或模型被移除；加载后把当前选择收敛到可用模型和 effort。
  useEffect(() => {
    if (agent === 'codex' && providersLoading) return;
    const models = activeModels;
    if (models.length === 0) return;
    const selected = models.find((m) => m.id === model) ?? models[0];
    if (selected.id !== model) {
      setModel(selected.id);
    }
    if (selected.efforts.length > 0 && !selected.efforts.includes(effort)) {
      setEffort(selected.defaultEffort ?? selected.efforts[selected.efforts.length - 1]);
    }
  }, [activeModels, agent, providersLoading, effort, model]);

  useEffect(() => {
    if (currentModel && !currentModelSupportsFast && fast) {
      setFast(false);
    }
  }, [currentModel, currentModelSupportsFast, fast]);

  const vendorKey = agent === 'codex' ? 'codex' : 'cc';
  const updateAgent = useCallback((nextAgent: 'claude-code' | 'codex') => {
    setAgent(nextAgent);
    const remembered = prefs[nextAgent];
    setModel(remembered.model);
    setEffort(remembered.effort);
    setFast(remembered.fast);
  }, [prefs]);

  const updateModel = useCallback((nextModel: string) => {
    setModel(nextModel);
    const available = activeModels.find((m) => m.id === nextModel);
    if (available && available.efforts.length > 0 && !available.efforts.includes(effort)) {
      setEffort(available.defaultEffort ?? available.efforts[available.efforts.length - 1]);
    }
    if (!available?.supportsFastMode) {
      setFast(false);
    }
  }, [activeModels, effort]);

  const updateEffort = setEffort;

  const activeRole = customRole || role;
  const customRoleError = customRole.length > 0 && PREDEFINED_ROLES.includes(customRole as typeof PREDEFINED_ROLES[number])
    ? t('orca.createWorker.customRolePredefinedError')
    : null;
  const canCreate = activeRole.length >= 1 && activeRole.length <= 32 && !customRoleError && !!currentModel;
  const resolvedTitle = title ?? t('orca.createWorker.title');
  const resolvedSubmitLabel = submitLabel ?? t('orca.createWorker.submit');

  const handleCreate = useCallback(() => {
    if (!canCreate) return;
    const nextPrefs: WorkerPrefs = {
      ...prefs,
      lastAgent: agent,
      [agent]: { model, effort, fast },
    };
    setPrefs(nextPrefs);
    writeWorkerPrefs(nextPrefs);
    onCreate({
      role: activeRole,
      agent,
      model,
      effort: currentModel && currentModel.efforts.length > 0 ? effort : undefined,
      fast: currentModelSupportsFast ? fast : undefined,
      initialTask,
    });
  }, [
    canCreate,
    prefs,
    activeRole,
    agent,
    model,
    effort,
    fast,
    currentModel,
    currentModelSupportsFast,
    initialTask,
    onCreate,
  ]);

  if (!open) return null;

  return (
    <div className={cn('fixed inset-0 z-50 flex items-start justify-center pt-[10vh]', className)}>
      <div className="absolute inset-0 bg-[var(--overlay-modal)]" onClick={onClose} />
      <div
        className="relative z-10 w-[500px] rounded-2xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-6"
        style={{ boxShadow: 'var(--shadow-menu)' }}
      >
        <div className="mb-5 flex items-center justify-between">
          <span className="text-17 font-medium text-[var(--text-primary)]">{resolvedTitle}</span>
          <button
            type="button"
            aria-label={t('orca.createWorker.closeAria')}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </div>

        <div className="mb-4">
          <div className="mb-2 text-12 font-medium uppercase tracking-[0.5px] text-[var(--text-tertiary)]">{t('orca.createWorker.roleLabel')}</div>
          <div className="flex flex-wrap gap-2">
            {PREDEFINED_ROLES.map((r) => (
              <button
                key={r}
                type="button"
                className={cn(
                  'rounded-full px-3 py-1.5 text-13 leading-none border transition-colors',
                  activeRole === r
                    ? 'bg-[var(--surface-chip)] border-transparent text-[var(--text-primary)] font-medium'
                    : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--surface-chip)]',
                )}
                onClick={() => { setRole(r); setCustomRole(''); }}
              >
                {r}
              </button>
            ))}
          </div>
          <input
            type="text"
            className="mt-2 w-full rounded-full border border-[var(--border-default)] bg-transparent px-3 py-1.5 text-13 leading-none text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none focus:border-[var(--text-secondary)]"
            placeholder={t('orca.createWorker.customRolePlaceholder')}
            value={customRole}
            maxLength={32}
            onChange={(e) => { setCustomRole(e.target.value); setRole(''); }}
          />
          {customRoleError && (
            <div className="mt-1 text-11 text-[var(--error-fg)]">{customRoleError}</div>
          )}
        </div>

        <div className="mb-4">
          <div className="mb-2 text-12 font-medium uppercase tracking-[0.5px] text-[var(--text-tertiary)]">{t('orca.createWorker.agentLabel')}</div>
          <div className="inline-flex rounded-lg bg-[var(--surface-elevated)] border border-[var(--border-default)] p-1">
            {(['codex', 'claude-code'] as const).map((a) => (
              <button
                key={a}
                type="button"
                className={cn(
                  'rounded-md px-4 py-1.5 text-13 leading-none transition-colors',
                  agent === a
                    ? 'bg-[var(--surface-chip)] text-[var(--text-primary)] font-medium'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
                )}
                onClick={() => updateAgent(a)}
              >
                {a === 'codex' ? 'Codex' : 'Claude Code'}
              </button>
            ))}
          </div>
        </div>

        <div className="mb-4">
          <div className="mb-2 text-12 font-medium uppercase tracking-[0.5px] text-[var(--text-tertiary)]">
            {t('orca.createWorker.modelLabel')}
          </div>
          <div className="flex items-center gap-2">
            {currentModelSupportsFast && (
              <FastModeToggle enabled={fast} onToggle={() => setFast((v) => !v)} />
            )}
            <ModelSelector
              modelId={model}
              effort={effort}
              onModelChange={updateModel}
              onEffortChange={updateEffort}
              vendorKey={vendorKey}
              popoverSide="bottom"
            />
          </div>
        </div>

        <div className="mb-5">
          <div className="mb-2 text-12 font-medium uppercase tracking-[0.5px] text-[var(--text-tertiary)]">
            {t('orca.createWorker.initialTaskLabel')} <span className="font-normal normal-case tracking-normal">{t('orca.createWorker.optional')}</span>
          </div>
          <textarea
            className="h-[96px] w-full resize-none rounded-xl border border-[var(--border-default)] bg-transparent px-3.5 py-2.5 text-13 leading-snug text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none"
            placeholder={t('orca.createWorker.initialTaskPlaceholder')}
            value={initialTask}
            onChange={(e) => setInitialTask(e.target.value)}
          />
        </div>

        <button
          type="button"
          className={cn(
            'w-full rounded-full py-3 text-14 font-medium leading-none transition-colors',
            canCreate
              ? 'bg-[var(--confirm-btn-primary-bg)] text-[var(--confirm-btn-primary-text)] hover:bg-[var(--confirm-btn-primary-hover)]'
              : 'bg-[var(--surface-chip)] text-[var(--text-tertiary)] cursor-not-allowed',
          )}
          disabled={!canCreate}
          onClick={handleCreate}
        >
          {resolvedSubmitLabel}
        </button>
      </div>
    </div>
  );
}
