import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Package, Puzzle, ServerCog, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { BuiltinToolRow } from '@/components/settings/BuiltinToolsSection';
import { listCustomMcpServers } from '@/lib/customMcpServers';
import * as sessionService from '@/lib/sessionService';
import { cn } from '@/lib/utils';
import { isBotToolsetAvailableOnTarget } from '../../../shared/botRemoteCapabilities';

import {
  canonicalBotSessionId,
  type BotCapabilities,
  type BotProfile,
  type BotSessionProjection,
} from './botStore';
import { BotSettingsBlock } from './BotSettingsBlock';

interface BotSkillOption {
  name: string;
  description?: string;
  enabled?: boolean;
  runtimeStatus?: 'discovered' | 'approved' | 'loaded' | 'failed' | 'unknown';
  runtimeCommandName?: string;
}

interface BotToolsetOption {
  id: string;
  name: string;
  description: string;
  effectiveEnabled: boolean;
}

interface BotMcpOption {
  id: string;
  name: string;
}

type CatalogState = 'loading' | 'ready' | 'error';

const COLLAPSED_SKILL_LIMIT = 8;

function runtimeAgentKindForHarness(
  harness: BotCapabilities['harness'],
): 'claude-code' | 'codex' | 'pi' {
  return harness === 'claude' ? 'claude-code' : harness;
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function SelectionMark({ selected }: { selected: boolean }) {
  return (
    <span
      className={cn(
        'mt-1 flex size-5 shrink-0 items-center justify-center rounded-md border transition-colors',
        selected
          ? 'border-[var(--focus-ring)] bg-[var(--focus-ring)] text-white'
          : 'border-[var(--border-default)] bg-[var(--surface-elevated)] text-transparent',
      )}
      aria-hidden="true"
    >
      <Check size={13} strokeWidth={2.25} />
    </span>
  );
}

function CapabilityModeSelect({
  value,
  onChange,
}: {
  value: 'inherit' | 'allowlist';
  onChange: (value: 'inherit' | 'allowlist') => void;
}) {
  const { t } = useTranslation();
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value as 'inherit' | 'allowlist')}
      className="h-8 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-2 text-11 text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]"
    >
      <option value="inherit">{t('bots.capabilityMode.inherit')}</option>
      <option value="allowlist">{t('bots.capabilityMode.allowlist')}</option>
    </select>
  );
}

export function BotCapabilitySettings({
  bot,
  capabilities,
  selectedSkills,
  runtimeSnapshot,
  remoteHostId,
  onCapabilitiesChange,
  onSelectedSkillsChange,
}: {
  bot: BotProfile;
  capabilities: BotCapabilities;
  selectedSkills: string[];
  runtimeSnapshot?: BotSessionProjection['runtimeSnapshot'];
  remoteHostId?: string | null;
  onCapabilitiesChange: (value: BotCapabilities) => void;
  onSelectedSkillsChange: (value: string[]) => void;
}) {
  const { t } = useTranslation();
  const [skillCatalog, setSkillCatalog] = useState<BotSkillOption[]>([]);
  const [toolsetCatalog, setToolsetCatalog] = useState<BotToolsetOption[]>([]);
  const [mcpCatalog, setMcpCatalog] = useState<BotMcpOption[]>([]);
  const [skillState, setSkillState] = useState<CatalogState>('loading');
  const [toolsetState, setToolsetState] = useState<CatalogState>('loading');
  const [mcpState, setMcpState] = useState<CatalogState>('loading');
  const [skillsExpanded, setSkillsExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSkillsExpanded(false);
    setSkillState('loading');
    setToolsetState('loading');
    setMcpState('loading');
    void (async () => {
      const canonicalSessionId = canonicalBotSessionId(bot);
      const workingDir = canonicalSessionId
        ? await sessionService
            .get(canonicalSessionId)
            .then((session) => session.workingDir ?? undefined)
            .catch(() => undefined)
        : undefined;
      const [skills, toolsets, mcps] = await Promise.allSettled([
        window.electronAPI.maker.listAgentSkills(runtimeAgentKindForHarness(capabilities.harness), {
          workingDir,
          remoteHostId: remoteHostId ?? undefined,
        }),
        window.electronAPI.maker.plugins.list(workingDir),
        listCustomMcpServers(),
      ]);
      if (cancelled) return;
      if (skills.status === 'fulfilled' && skills.value.success) {
        setSkillCatalog(
          (skills.value.skills ?? []).filter(
            (skill) => skill.enabled !== false && skill.runtimeStatus !== 'failed',
          ),
        );
        setSkillState('ready');
      } else {
        setSkillCatalog([]);
        setSkillState('error');
      }
      if (toolsets.status === 'fulfilled') {
        setToolsetCatalog(
          toolsets.value.map((item) => ({
            id: item.id,
            name: item.name,
            description: item.description,
            effectiveEnabled:
              item.effectiveEnabled &&
              isBotToolsetAvailableOnTarget({
                agentKind: runtimeAgentKindForHarness(capabilities.harness),
                remoteHostId,
                toolsetId: item.id,
              }),
          })),
        );
        setToolsetState('ready');
      } else {
        setToolsetCatalog([]);
        setToolsetState('error');
      }
      if (mcps.status === 'fulfilled') {
        setMcpCatalog(mcps.value.map((item) => ({ id: item.id, name: item.name })));
        setMcpState('ready');
      } else {
        setMcpCatalog([]);
        setMcpState('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bot.sessions, capabilities.harness, remoteHostId]);

  const resolved = runtimeSnapshot?.resolved;
  const appliedSkills = useMemo(() => new Set(readStringList(resolved?.skills)), [resolved]);
  const appliedToolsets = useMemo(() => new Set(readStringList(resolved?.toolsets)), [resolved]);
  const appliedMcpServers = useMemo(
    () => new Set(readStringList(resolved?.mcpServers)),
    [resolved],
  );
  const unavailableSkills = useMemo(
    () => new Set(readStringList(resolved?.unavailableSkills)),
    [resolved],
  );
  const unavailableToolsets = useMemo(
    () => new Set(readStringList(resolved?.unavailableToolsets)),
    [resolved],
  );
  const unavailableMcpServers = useMemo(
    () => new Set(readStringList(resolved?.unavailableMcpServers)),
    [resolved],
  );
  const uniqueSkillCatalog = useMemo(() => {
    const byReference = new Map<string, BotSkillOption>();
    for (const skill of skillCatalog) {
      const reference = skill.runtimeCommandName?.trim() || skill.name;
      const previous = byReference.get(reference);
      if (!previous || (!previous.description && skill.description)) {
        byReference.set(reference, skill);
      }
    }
    return [...byReference.values()];
  }, [skillCatalog]);
  const visibleSkillCatalog = skillsExpanded
    ? uniqueSkillCatalog
    : uniqueSkillCatalog.slice(0, COLLAPSED_SKILL_LIMIT);
  const hiddenSkillCount = Math.max(0, uniqueSkillCatalog.length - COLLAPSED_SKILL_LIMIT);

  const updateCapability = <K extends keyof BotCapabilities>(key: K, value: BotCapabilities[K]) =>
    onCapabilitiesChange({ ...capabilities, [key]: value });

  const toggleSkill = (reference: string) => {
    if (capabilities.skillMode === 'inherit') {
      /*
        跟随全局时关掉一项 —— 记的是**排除项**,不是把此刻的清单快照成白名单。

        原先这里会切成 allowlist 并把今天的目录整个写死。用户的心理动作只是
        「我不想要这一个」,系统实际做的却是「把这个伙伴的能力面永久冻结在今天」:
        以后 Cindy 内置新技能、用户装新插件、加新 MCP,这个伙伴一个都吃不到,
        而且没有任何提示。

        抄 Hermes 的存法(plugin.js 8949+):技能面存 disabled 而不是 enabled。
      */
      const excluded = capabilities.skillsExcluded;
      updateCapability(
        'skillsExcluded',
        excluded.includes(reference)
          ? excluded.filter((item) => item !== reference)
          : [...excluded, reference],
      );
      return;
    }
    onSelectedSkillsChange(
      selectedSkills.includes(reference)
        ? selectedSkills.filter((item) => item !== reference)
        : [...selectedSkills, reference],
    );
  };

  const toggleToolset = (id: string, enabled: boolean) => {
    const inherited = toolsetCatalog.filter((item) => item.effectiveEnabled).map((item) => item.id);
    const current = capabilities.toolsetMode === 'inherit' ? inherited : capabilities.toolsets;
    onCapabilitiesChange({
      ...capabilities,
      toolsetMode: 'allowlist',
      toolsets: enabled
        ? current.includes(id)
          ? current
          : [...current, id]
        : current.filter((item) => item !== id),
    });
  };

  const toggleMcp = (id: string) => {
    const inherited = mcpCatalog.map((item) => item.id);
    const current = capabilities.mcpMode === 'inherit' ? inherited : capabilities.mcpServers;
    onCapabilitiesChange({
      ...capabilities,
      mcpMode: 'allowlist',
      mcpServers: current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    });
  };

  const catalogMessage = (state: CatalogState, emptyKey: string) => {
    if (state === 'loading') return t('bots.capabilityCatalogLoading');
    if (state === 'error') return t('bots.capabilityCatalogError');
    return t(emptyKey);
  };

  return (
    <>
      <BotSettingsBlock
        icon={Sparkles}
        title={t('bots.skillsLabel')}
        hint={t('bots.skillsDescription')}
        action={
          <CapabilityModeSelect
            value={capabilities.skillMode}
            onChange={(mode) => {
              updateCapability('skillMode', mode);
              if (mode === 'inherit') onSelectedSkillsChange([]);
            }}
          />
        }
      >
        <div className="flex flex-col gap-2 text-12 text-[var(--text-secondary)]">
          {/*
          白名单模式是「钉死这几项」—— 以后新增的技能不会进来。这本身是合法选择,
          但用户看不出自己处在这个状态:界面上它和「跟随全局」长得一模一样,只是
          某几个格子没亮。

          存量里还有一批伙伴是被旧的勾选逻辑**误切**进来的(取消勾选任何一项都会
          把当下目录快照成白名单),他们从没打算钉死任何东西。这里不做静默的数据
          迁移 —— 落盘的配置分不出「用户存心只要这三项」和「用户只是关掉了一项」,
          猜错就是替用户改主意。改成把状态说出来,并指向那个本来就在的出口。

          同 Hermes 的 routineFilterHint(plugin.js 10150+):存储里明明有东西却什么
          都没显示时,说清楚为什么、以及怎么办,而不是留一个让人发呆的空态。
        */}
          {capabilities.skillMode === 'allowlist' && skillState === 'ready' ? (
            <p className="text-[var(--text-tertiary)]">{t('bots.skillAllowlistFrozenHint')}</p>
          ) : null}
          {skillState !== 'ready' || skillCatalog.length === 0 ? (
            <p className="rounded-xl border border-dashed border-[var(--border-default)] px-3 py-3 text-[var(--text-tertiary)]">
              {catalogMessage(skillState, 'bots.skillCatalogEmpty')}
            </p>
          ) : (
            <div
              className={cn(
                'grid grid-cols-1 gap-3 md:grid-cols-2',
                skillsExpanded && 'max-h-[360px] overflow-y-auto pr-1 [scrollbar-gutter:stable]',
              )}
            >
              {visibleSkillCatalog.map((skill) => {
                const reference = skill.runtimeCommandName?.trim() || skill.name;
                // 跟随全局时默认全亮,被明确关掉的那几项熄灭;白名单模式仍按选中集算。
                const selected =
                  capabilities.skillMode === 'inherit'
                    ? !capabilities.skillsExcluded.includes(reference)
                    : selectedSkills.includes(reference);
                return (
                  <button
                    type="button"
                    key={`${skill.name}:${reference}`}
                    onClick={() => toggleSkill(reference)}
                    aria-pressed={selected}
                    className={cn(
                      'group flex min-h-[64px] w-full items-start gap-3 rounded-[12px] border-[0.5px] border-[var(--border-default)] px-3 py-2.5 text-left',
                      'bg-[var(--surface-elevated)] shadow-[var(--plugin-card-shadow)]',
                      'transition-[background-color,border-color,transform] duration-150 ease-out',
                      'hover:-translate-y-0.5 hover:border-[var(--text-tertiary)]',
                      'active:translate-y-0 active:scale-[0.992]',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                    )}
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-[22%] border-[0.5px] border-[var(--border-default)] bg-[var(--surface-elevated)] text-[var(--text-primary)] shadow-[var(--plugin-card-shadow)]">
                      <Package size={17} strokeWidth={1.75} />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5">
                      <span className="block truncate text-13 font-medium text-[var(--text-primary)]">
                        {skill.name}
                      </span>
                      {skill.description ? (
                        <span className="block truncate text-12 leading-4 text-[var(--text-secondary)]">
                          {skill.description}
                        </span>
                      ) : null}
                    </span>
                    {appliedSkills.has(reference) ? (
                      <span className="mt-1 shrink-0 text-10 text-[var(--text-tertiary)]">
                        {t('bots.capabilityApplied')}
                      </span>
                    ) : null}
                    <SelectionMark selected={selected} />
                  </button>
                );
              })}
            </div>
          )}
          {hiddenSkillCount > 0 ? (
            <button
              type="button"
              onClick={() => setSkillsExpanded((expanded) => !expanded)}
              aria-expanded={skillsExpanded}
              className="inline-flex h-8 w-fit items-center gap-1.5 rounded-lg px-2 text-11 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
            >
              {skillsExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              {skillsExpanded
                ? t('bots.skillCatalogCollapse')
                : t('bots.skillCatalogExpand', { count: hiddenSkillCount })}
            </button>
          ) : null}
          {selectedSkills
            .filter(
              (name) =>
                !skillCatalog.some(
                  (skill) => skill.name === name || skill.runtimeCommandName === name,
                ),
            )
            .map((name) => (
              <button
                type="button"
                key={name}
                onClick={() => toggleSkill(name)}
                className="flex items-center justify-between rounded-lg border border-[var(--border-default)] px-3 py-2 text-left text-11 text-[var(--text-secondary)]"
              >
                <span className="truncate">{name}</span>
                <span className="shrink-0 text-[var(--text-tertiary)]">
                  {unavailableSkills.has(name)
                    ? t('bots.capabilityUnavailable')
                    : t('bots.skillConfiguredUnavailable')}
                </span>
              </button>
            ))}
        </div>
      </BotSettingsBlock>

      <BotSettingsBlock
        icon={Puzzle}
        title={t('bots.toolsetsLabel')}
        hint={t('bots.toolsetsDescription')}
        action={
          <CapabilityModeSelect
            value={capabilities.toolsetMode}
            onChange={(mode) =>
              onCapabilitiesChange({
                ...capabilities,
                toolsetMode: mode,
                toolsets: mode === 'inherit' ? [] : capabilities.toolsets,
              })
            }
          />
        }
      >
        <div className="flex flex-col gap-2 text-12 text-[var(--text-secondary)]">
          {toolsetState !== 'ready' || toolsetCatalog.length === 0 ? (
            <p className="rounded-xl border border-dashed border-[var(--border-default)] px-3 py-3 text-[var(--text-tertiary)]">
              {catalogMessage(toolsetState, 'bots.toolsetCatalogEmpty')}
            </p>
          ) : (
            <div className="flex flex-col overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
              {toolsetCatalog.map((toolset, index) => {
                const selected =
                  capabilities.toolsetMode === 'inherit'
                    ? toolset.effectiveEnabled
                    : capabilities.toolsets.includes(toolset.id);
                return (
                  <BuiltinToolRow
                    key={toolset.id}
                    plugin={{
                      ...toolset,
                      description: toolset.effectiveEnabled
                        ? toolset.description
                        : t('bots.capabilityDisabledBySystem'),
                    }}
                    divider={index > 0}
                    disabled={!toolset.effectiveEnabled}
                    projectScope={false}
                    checked={selected}
                    showSource={false}
                    badge={
                      appliedToolsets.has(toolset.id) ? t('bots.capabilityApplied') : undefined
                    }
                    onToggle={(id, next) => toggleToolset(id, next)}
                  />
                );
              })}
            </div>
          )}
          {capabilities.toolsets
            .filter((id) => !toolsetCatalog.some((item) => item.id === id))
            .map((id) => (
              <div
                key={id}
                className="flex items-center justify-between rounded-lg border border-[var(--border-default)] px-3 py-2 text-11 text-[var(--text-secondary)]"
              >
                <span className="truncate">{id}</span>
                <span className="shrink-0 text-[var(--text-tertiary)]">
                  {unavailableToolsets.has(id)
                    ? t('bots.capabilityUnavailable')
                    : t('bots.capabilityNotInstalled')}
                </span>
              </div>
            ))}
        </div>
      </BotSettingsBlock>

      <BotSettingsBlock
        icon={ServerCog}
        title={t('bots.mcpServersLabel')}
        hint={t('bots.mcpServersDescription')}
        action={
          <CapabilityModeSelect
            value={capabilities.mcpMode}
            onChange={(mode) =>
              onCapabilitiesChange({
                ...capabilities,
                mcpMode: mode,
                mcpServers: mode === 'inherit' ? [] : capabilities.mcpServers,
              })
            }
          />
        }
      >
        <div className="flex flex-col gap-2 text-12 text-[var(--text-secondary)]">
          {mcpState !== 'ready' || mcpCatalog.length === 0 ? (
            <p className="rounded-xl border border-dashed border-[var(--border-default)] px-3 py-3 text-[var(--text-tertiary)]">
              {catalogMessage(mcpState, 'bots.mcpCatalogEmpty')}
            </p>
          ) : (
            <div className="grid gap-2 md:grid-cols-2">
              {mcpCatalog.map((server) => {
                const selected =
                  capabilities.mcpMode === 'inherit' || capabilities.mcpServers.includes(server.id);
                return (
                  <button
                    type="button"
                    key={server.id}
                    onClick={() => toggleMcp(server.id)}
                    className={cn(
                      'flex min-h-10 items-center gap-2 rounded-xl border px-3 py-2 text-left',
                      selected
                        ? 'border-[var(--focus-ring-soft)] bg-[var(--surface-chip)]'
                        : 'border-[var(--border-default)] hover:bg-[var(--surface-hover)]',
                    )}
                  >
                    <SelectionMark selected={selected} />
                    <span className="min-w-0 flex-1 truncate text-12 font-medium text-[var(--text-primary)]">
                      {server.name}
                    </span>
                    {appliedMcpServers.has(server.id) ? (
                      <span className="text-10 text-[var(--text-tertiary)]">
                        {t('bots.capabilityApplied')}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          )}
          {capabilities.mcpServers
            .filter((id) => !mcpCatalog.some((item) => item.id === id))
            .map((id) => (
              <div
                key={id}
                className="flex items-center justify-between rounded-lg border border-[var(--border-default)] px-3 py-2 text-11 text-[var(--text-secondary)]"
              >
                <span className="truncate">{id}</span>
                <span className="shrink-0 text-[var(--text-tertiary)]">
                  {unavailableMcpServers.has(id)
                    ? t('bots.capabilityUnavailable')
                    : t('bots.capabilityNotInstalled')}
                </span>
              </div>
            ))}
        </div>
      </BotSettingsBlock>

      {/* 记忆恢复在“记忆和成长”；自动化和协作不在此处提供重复开关。 */}
    </>
  );
}
