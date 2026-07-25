/**
 * AddRemoteProjectDialog — pick a folder on a connected remote target.
 *
 * device-link 接入后,「远程目标」统一两类(顶部下拉 optgroup 区分):
 *   - SSH 远程主机(`remoteSsh.list()` 的 ready hosts)
 *   - device-link 同账号被控设备(`online && remoteControlEnabled && !isSelf`)
 * 选谁决定走哪套浏览适配器(见 remoteBrowseAdapters.ts);弹窗 UI 只认统一接口,
 * 导航一律用 entry.childPath / ListResult.parent,两类来源的路径差异封装在适配器里
 * (device-link 被控端可能是 Windows → 用 handler 回传的 native 路径,renderer 不拼接)。
 *
 * 工作流:
 *   1. 打开 → 拉 SSH ready hosts + 可控设备 → 默认选第一个目标,默认路径 `~`
 *   2. 路径变 / 目标变 → adapter.listDir(远端 ls / 隧道 fs:list-dir),渲染子目录
 *   3. 双击 entry → cd 进(用 entry.childPath);「返回上级」用 ListResult.parent
 *   4. 「添加项目」→ adapter.statPath 校验 → existing dir 直接 onProjectAdded(带 kind);
 *      missing → confirm 提示,同意则 adapter.mkdirP,失败 toast
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as Dialog from '@radix-ui/react-dialog';
import { X, Folder, FolderSymlink, ChevronLeft, RotateCw } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/lib/toast';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { mapIpcErrorToI18nKey } from '@/utils/ipcError';
import { useControllableDevices } from '@/hooks/useControllableDevices';
import { useCCSessions } from '@/hooks/useCCSessions';
import {
  sshBrowseAdapter,
  deviceLinkBrowseAdapter,
  type RemoteBrowseAdapter,
  type BrowseEntry,
} from './remoteBrowseAdapters';
import {
  sshExistingProjects,
  loadDeviceLinkExistingProjects,
  type ExistingRemoteProject,
} from './remoteExistingProjects';

/** 用户最终确认添加的远程项目,带来源 kind —— 调用方据此决定立即建会话(SSH)还是进草稿(device-link)。 */
export type RemoteProjectTarget =
  | { kind: 'ssh'; hostId: string; path: string }
  | { kind: 'device-link'; deviceId: string; deviceName: string; path: string };

/** 下拉里的一个可选远程目标(SSH 主机 / 被控设备)。 */
type RemoteTarget =
  | { key: string; kind: 'ssh'; hostId: string; label: string }
  | { key: string; kind: 'device'; deviceId: string; deviceName: string; label: string };

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** vendor 不在 dialog 里选 —— 由父层根据当前 draft / segmented switcher 决定。 */
  onProjectAdded: (target: RemoteProjectTarget) => void;
}

export function AddRemoteProjectDialog({ open, onOpenChange, onProjectAdded }: Props) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();

  // 可控设备走 live hook;SSH ready hosts 在打开时拉一次。
  const devices = useControllableDevices();
  const [sshHosts, setSshHosts] = useState<RemoteHostSnapshot[]>([]);
  // SSH「已有项目」数据源:本地 active 会话(按 host 过滤,见 sshExistingProjects)。
  const { sessions } = useCCSessions();

  const targets = useMemo<RemoteTarget[]>(() => {
    const ssh: RemoteTarget[] = sshHosts.map((h) => ({
      key: `ssh:${h.config.id}`,
      kind: 'ssh',
      hostId: h.config.id,
      label: `${h.config.id} (${h.config.user}@${h.config.hostname})`,
    }));
    const dev: RemoteTarget[] = devices.map((d) => ({
      key: `device:${d.deviceId}`,
      kind: 'device',
      deviceId: d.deviceId,
      deviceName: d.name,
      label: d.name,
    }));
    return [...ssh, ...dev];
  }, [sshHosts, devices]);

  const sshTargets = useMemo(() => targets.filter((tg) => tg.kind === 'ssh'), [targets]);
  const deviceTargets = useMemo(() => targets.filter((tg) => tg.kind === 'device'), [targets]);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selectedTarget = useMemo(
    () => targets.find((tg) => tg.key === selectedKey) ?? null,
    [targets, selectedKey],
  );

  // 默认「已有项目」模式,「浏览文件夹」为次要;切目标 / 重开都重置回 existing。
  const [mode, setMode] = useState<'existing' | 'browse'>('existing');
  const [deviceExisting, setDeviceExisting] = useState<ExistingRemoteProject[]>([]);
  const [existingLoading, setExistingLoading] = useState(false);
  // path 初始空 —— existing 模式下「添加」靠选中项目填充;进 browse 模式才置 `~` 并 ls。
  const [path, setPath] = useState<string>('');
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [busy, setBusy] = useState(false);
  // refreshList 请求序号 —— 快速切目标 / 双击进目录时旧请求晚到不得覆盖当前状态。
  const requestSeqRef = useRef(0);

  // 选中目标 → 取对应浏览适配器。key 变才重建(同 key 引用稳定,不触发浏览 effect 抖动)。
  const adapter = useMemo<RemoteBrowseAdapter | null>(() => {
    if (!selectedTarget) return null;
    return selectedTarget.kind === 'ssh'
      ? sshBrowseAdapter(selectedTarget.hostId)
      : deviceLinkBrowseAdapter(selectedTarget.deviceId);
  }, [selectedTarget?.key]);

  // SSH 已有项目:本地会话里该 host 的 project 会话去重(同步,随 sessions 实时重算);
  // device-link 已有项目走隧道异步拉(deviceExisting)。existing 列表取二者之一。
  const sshExisting = useMemo<ExistingRemoteProject[] | null>(() => {
    if (!selectedTarget || selectedTarget.kind !== 'ssh') return null;
    return sshExistingProjects(sessions, selectedTarget.hostId);
  }, [selectedTarget, sessions]);
  const existingProjects = sshExisting ?? deviceExisting;

  // 打开时拉 SSH ready hosts;重置选中(配置可能在设置里改过,不保留上次状态)。
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await window.electronAPI.remoteSsh.list();
        if (cancelled) return;
        setSshHosts(res.hosts.filter((h) => h.status === 'ready'));
      } catch {
        if (!cancelled) setSshHosts([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // 默认选中:打开时 / 目标集变化后若当前选中已失效,落到第一个可用目标。
  useEffect(() => {
    if (!open) {
      setSelectedKey(null);
      return;
    }
    if (selectedKey && targets.some((tg) => tg.key === selectedKey)) return;
    setSelectedKey(targets[0]?.key ?? null);
  }, [open, targets, selectedKey]);

  const refreshList = useCallback(
    async (browseApi: RemoteBrowseAdapter, targetPath: string) => {
      const mySeq = ++requestSeqRef.current;
      setLoadingList(true);
      try {
        const res = await browseApi.listDir(targetPath);
        if (mySeq !== requestSeqRef.current) return;
        setParent(res.parent);
        setEntries(res.entries);
      } catch (err) {
        if (mySeq !== requestSeqRef.current) return;
        toast.error(t(mapIpcErrorToI18nKey(err, { fallback: 'newChat.addRemoteProject.toast.listFailed' })));
        setEntries([]);
      } finally {
        if (mySeq === requestSeqRef.current) setLoadingList(false);
      }
    },
    [t],
  );

  // 切目标 / 打开:重置回「已有项目」模式 + 清浏览态(浏览的 ls 等进入 browse 模式才惰性触发)。
  useEffect(() => {
    if (!open) return;
    setMode('existing');
    setPath('');
    setEntries([]);
    setParent(null);
  }, [open, selectedTarget?.key]);

  // device-link「已有项目」:隧道拉被控端 recent_workdirs(SSH 走同步 memo,不进这里)。
  // 用局部 cancelled 作废旧请求,不动 requestSeqRef(那是 browse 的 ls 序号)。
  useEffect(() => {
    if (!open || !selectedTarget || selectedTarget.kind !== 'device') {
      setDeviceExisting([]);
      setExistingLoading(false);
      return;
    }
    let cancelled = false;
    setExistingLoading(true);
    setDeviceExisting([]);
    void (async () => {
      try {
        const projects = await loadDeviceLinkExistingProjects(selectedTarget.deviceId);
        if (!cancelled) setDeviceExisting(projects);
      } catch {
        if (!cancelled) setDeviceExisting([]);
      } finally {
        if (!cancelled) setExistingLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, selectedTarget?.key]);

  // 进入 browse 模式才 ls(惰性,省一次无谓远端往返)。bump seq 作废未落地的旧请求。
  useEffect(() => {
    if (!open || mode !== 'browse' || !adapter) return;
    requestSeqRef.current += 1;
    setEntries([]);
    setParent(null);
    setPath('~');
    void refreshList(adapter, '~');
  }, [open, mode, adapter, refreshList]);

  const handleEntryClick = useCallback((entry: BrowseEntry) => {
    // 单击 = 选中(把路径填进输入框),不进入。
    setPath(entry.childPath);
  }, []);

  const handleEntryDouble = useCallback(
    (entry: BrowseEntry) => {
      setPath(entry.childPath);
      if (adapter) void refreshList(adapter, entry.childPath);
    },
    [adapter, refreshList],
  );

  const isEntrySelected = useCallback((entry: BrowseEntry): boolean => path === entry.childPath, [path]);

  const handleParent = useCallback(() => {
    if (parent == null || !adapter) return;
    setPath(parent);
    void refreshList(adapter, parent);
  }, [parent, adapter, refreshList]);

  const handleAddProject = useCallback(async (explicitPath?: string) => {
    if (!selectedTarget || !adapter) return;
    const dir = (explicitPath ?? path).trim();
    if (!dir) {
      toast.error(t('newChat.addRemoteProject.toast.pathEmpty'));
      return;
    }
    setBusy(true);
    try {
      const stat = await adapter.statPath(dir);
      let finalPath = stat.resolvedPath;
      if (stat.kind === 'file') {
        toast.error(t('newChat.addRemoteProject.toast.pathIsFile', { path: finalPath }));
        return;
      }
      if (stat.kind === 'missing') {
        const ok = await confirm({
          title: t('newChat.addRemoteProject.confirmCreate.title'),
          description: t('newChat.addRemoteProject.confirmCreate.description', {
            path: finalPath,
            hostId: selectedTarget.label,
          }),
          confirmText: t('newChat.addRemoteProject.confirmCreate.ok'),
          cancelText: t('newChat.addRemoteProject.confirmCreate.cancel'),
        });
        if (!ok) return;
        const mk = await adapter.mkdirP(dir);
        finalPath = mk.resolvedPath;
      }
      if (selectedTarget.kind === 'ssh') {
        onProjectAdded({ kind: 'ssh', hostId: selectedTarget.hostId, path: finalPath });
      } else {
        onProjectAdded({
          kind: 'device-link',
          deviceId: selectedTarget.deviceId,
          deviceName: selectedTarget.deviceName,
          path: finalPath,
        });
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(t(mapIpcErrorToI18nKey(err, { fallback: 'newChat.addRemoteProject.toast.addFailed' })));
    } finally {
      setBusy(false);
    }
  }, [selectedTarget, adapter, path, confirm, onProjectAdded, onOpenChange, t]);

  const noTargets = targets.length === 0;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-50"
          style={{ backgroundColor: 'var(--overlay-modal, rgba(0,0,0,0.4))' }}
        />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-[560px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-xl flex flex-col"
          style={{
            backgroundColor: 'var(--surface-elevated, #ffffff)',
            border: '1px solid var(--border-default, #d4d4d4)',
            maxHeight: '88vh',
          }}
        >
          {/* Header */}
          <div
            className="flex flex-col gap-1 px-5 py-4"
            style={{ borderBottom: '1px solid var(--border-default, #d4d4d4)' }}
          >
            <div className="flex items-center justify-between">
              <Dialog.Title
                className="text-15 font-medium"
                style={{ color: 'var(--text-primary)' }}
              >
                {t('newChat.addRemoteProject.title')}
              </Dialog.Title>
              <Dialog.Close asChild>
                <button
                  type="button"
                  aria-label={t('newChat.addRemoteProject.cancel')}
                  className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-chip)]"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  <X size={16} />
                </button>
              </Dialog.Close>
            </div>
            <p className="text-12" style={{ color: 'var(--text-tertiary)' }}>
              {t('newChat.addRemoteProject.hint')}
            </p>
          </div>

          {/* Body */}
          <div className="flex flex-col gap-3 px-5 py-4">
            {noTargets ? (
              <div className="text-13 py-8 text-center" style={{ color: 'var(--text-secondary)' }}>
                {t('newChat.addRemoteProject.empty')}
              </div>
            ) : (
              <>
                {/* Target selector — optgroup 区分 SSH 主机 / 我的设备 */}
                <label className="flex flex-col gap-1">
                  <span
                    className="text-12 font-medium"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    {t('newChat.addRemoteProject.host')}
                  </span>
                  <select
                    value={selectedKey ?? ''}
                    onChange={(e) => setSelectedKey(e.target.value || null)}
                    disabled={busy}
                    className="h-9 rounded-lg border bg-transparent px-2 text-13 outline-none"
                    style={{
                      borderColor: 'var(--border-default)',
                      color: 'var(--text-primary)',
                    }}
                  >
                    {sshTargets.length > 0 && (
                      <optgroup label={t('newChat.addRemoteProject.sourceGroupSsh')}>
                        {sshTargets.map((tg) => (
                          <option key={tg.key} value={tg.key}>
                            {tg.label}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {deviceTargets.length > 0 && (
                      <optgroup label={t('newChat.addRemoteProject.sourceGroupDevice')}>
                        {deviceTargets.map((tg) => (
                          <option key={tg.key} value={tg.key}>
                            {tg.label}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                </label>

                {/* Mode toggle — 默认「已有项目」,「浏览文件夹」为次要入口 */}
                <div
                  className="flex items-center gap-1 rounded-lg border p-0.5"
                  style={{ borderColor: 'var(--border-default)' }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setMode('existing');
                      setPath('');
                    }}
                    disabled={busy}
                    className={cn(
                      'flex-1 h-7 rounded-md text-12 font-medium transition-colors',
                      busy && 'cursor-not-allowed opacity-60',
                    )}
                    style={
                      mode === 'existing'
                        ? { backgroundColor: 'var(--settings-menu-bg-selected)', color: 'var(--text-primary)' }
                        : { color: 'var(--text-secondary)' }
                    }
                  >
                    {t('newChat.addRemoteProject.tabExisting')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode('browse')}
                    disabled={busy}
                    className={cn(
                      'flex-1 h-7 rounded-md text-12 font-medium transition-colors',
                      busy && 'cursor-not-allowed opacity-60',
                    )}
                    style={
                      mode === 'browse'
                        ? { backgroundColor: 'var(--settings-menu-bg-selected)', color: 'var(--text-primary)' }
                        : { color: 'var(--text-secondary)' }
                    }
                  >
                    {t('newChat.addRemoteProject.tabBrowse')}
                  </button>
                </div>

                {mode === 'existing' ? (
                  /* 已有项目列表 — 单击选中、双击直接添加;空则给「浏览文件夹」兜底入口 */
                  <div
                    className="max-h-[340px] overflow-y-auto rounded-lg border"
                    style={{ borderColor: 'var(--border-default)' }}
                  >
                    {existingLoading ? (
                      <div className="text-12 py-8 text-center" style={{ color: 'var(--text-tertiary)' }}>
                        {t('newChat.addRemoteProject.existingLoading')}
                      </div>
                    ) : existingProjects.length === 0 ? (
                      <div className="flex flex-col items-center gap-2 py-8">
                        <span className="text-12 text-center px-4" style={{ color: 'var(--text-tertiary)' }}>
                          {t('newChat.addRemoteProject.existingEmpty')}
                        </span>
                        <button
                          type="button"
                          onClick={() => setMode('browse')}
                          className="text-12 font-medium underline-offset-2 hover:underline"
                          style={{ color: 'var(--text-secondary)' }}
                        >
                          {t('newChat.addRemoteProject.tabBrowse')}
                        </button>
                      </div>
                    ) : (
                      existingProjects.map((project) => {
                        const selected = path === project.path;
                        return (
                          <button
                            key={project.path}
                            type="button"
                            onClick={() => setPath(project.path)}
                            onDoubleClick={() => void handleAddProject(project.path)}
                            title={project.path}
                            disabled={busy}
                            className={cn(
                              'flex w-full items-center gap-2 px-3 py-2 text-left text-13 transition-colors',
                              !selected && 'hover:bg-[var(--surface-chip)]',
                              busy && 'cursor-not-allowed opacity-60',
                            )}
                            style={{
                              color: 'var(--text-primary)',
                              ...(selected ? { backgroundColor: 'var(--settings-menu-bg-selected)' } : {}),
                            }}
                          >
                            <Folder size={14} className="shrink-0" style={{ color: 'var(--text-tertiary)' }} />
                            <span className="flex min-w-0 flex-col">
                              <span className="truncate">{project.name}</span>
                              <span
                                className="truncate text-11"
                                style={{
                                  color: 'var(--text-tertiary)',
                                  fontFamily: 'var(--app-font-code, var(--app-font-code-default))',
                                }}
                              >
                                {project.path}
                              </span>
                            </span>
                          </button>
                        );
                      })
                    )}
                  </div>
                ) : (
                  <>
                    {/* Path bar */}
                    <label className="flex flex-col gap-1">
                      <span
                        className="text-12 font-medium"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        {t('newChat.addRemoteProject.path')}
                      </span>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={handleParent}
                          disabled={busy || loadingList || parent == null}
                          title={t('newChat.addRemoteProject.parent')}
                          className={cn(
                            'flex h-9 w-9 items-center justify-center rounded-lg border',
                            (busy || loadingList || parent == null) && 'cursor-not-allowed opacity-60',
                          )}
                          style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
                        >
                          <ChevronLeft size={14} />
                        </button>
                        <input
                          type="text"
                          value={path}
                          onChange={(e) => setPath(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.nativeEvent.isComposing && adapter) {
                              void refreshList(adapter, path);
                            }
                          }}
                          disabled={busy}
                          placeholder="~/projects/my-repo"
                          className="flex-1 h-9 rounded-lg border bg-transparent px-2 text-13 outline-none"
                          style={{
                            borderColor: 'var(--border-default)',
                            color: 'var(--text-primary)',
                            fontFamily: 'var(--app-font-code, var(--app-font-code-default))',
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => adapter && void refreshList(adapter, path)}
                          disabled={busy || loadingList}
                          title={t('newChat.addRemoteProject.refresh')}
                          className={cn(
                            'flex h-9 w-9 items-center justify-center rounded-lg border',
                            (busy || loadingList) && 'cursor-not-allowed opacity-60',
                          )}
                          style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
                        >
                          {loadingList ? <Spinner size={14} /> : <RotateCw size={14} />}
                        </button>
                      </div>
                    </label>

                    {/* Entries list */}
                    <div
                      className="max-h-[296px] overflow-y-auto rounded-lg border"
                      style={{ borderColor: 'var(--border-default)' }}
                    >
                      {entries.length === 0 ? (
                        <div
                          className="text-12 py-8 text-center"
                          style={{ color: 'var(--text-tertiary)' }}
                        >
                          {loadingList
                            ? t('newChat.addRemoteProject.loading')
                            : t('newChat.addRemoteProject.noSubdirs')}
                        </div>
                      ) : (
                        entries.map((entry) => {
                          const selected = isEntrySelected(entry);
                          return (
                            <button
                              key={entry.childPath}
                              type="button"
                              onClick={() => handleEntryClick(entry)}
                              onDoubleClick={() => handleEntryDouble(entry)}
                              title={t('newChat.addRemoteProject.doubleClickHint')}
                              disabled={busy}
                              className={cn(
                                'flex w-full items-center gap-2 px-3 py-2 text-left text-13 transition-colors',
                                !selected && 'hover:bg-[var(--surface-chip)]',
                                busy && 'cursor-not-allowed opacity-60',
                              )}
                              style={{
                                color: 'var(--text-primary)',
                                ...(selected ? { backgroundColor: 'var(--settings-menu-bg-selected)' } : {}),
                              }}
                            >
                              {entry.kind === 'symlink' ? (
                                <FolderSymlink size={14} style={{ color: 'var(--text-tertiary)' }} />
                              ) : (
                                <Folder size={14} style={{ color: 'var(--text-tertiary)' }} />
                              )}
                              <span className="truncate">{entry.name}</span>
                            </button>
                          );
                        })
                      )}
                    </div>
                  </>
                )}
              </>
            )}
          </div>

          {/* Footer */}
          <div
            className="flex justify-end gap-2 px-5 py-3"
            style={{ borderTop: '1px solid var(--border-default)' }}
          >
            <Dialog.Close asChild>
              <button
                type="button"
                className="flex h-8 items-center rounded-full px-[14px] text-13 leading-none font-medium border"
                style={{
                  backgroundColor: 'var(--settings-btn-secondary-bg)',
                  borderColor: 'var(--settings-btn-secondary-border)',
                  color: 'var(--settings-btn-secondary-text)',
                }}
              >
                <span className="relative top-px">{t('newChat.addRemoteProject.cancel')}</span>
              </button>
            </Dialog.Close>
            <button
              type="button"
              onClick={() => void handleAddProject()}
              disabled={busy || noTargets || !selectedTarget || !path.trim()}
              className={cn(
                'flex h-8 items-center gap-1 rounded-full px-[14px] text-13 leading-none font-medium border',
                (busy || noTargets || !selectedTarget || !path.trim()) && 'cursor-not-allowed opacity-60',
              )}
              style={{
                backgroundColor: 'var(--accent-cta-bg)',
                borderColor: 'var(--accent-cta-bg)',
                color: 'var(--accent-pure-cta-fg)',
              }}
            >
              {busy && <Spinner size={12} />}
              <span className="relative top-px">{t('newChat.addRemoteProject.add')}</span>
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
