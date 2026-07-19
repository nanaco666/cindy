/**
 * HookConnectionsSection —— 「Tina」页的「Slack 连接」块(原「远程控制」页
 * 子块, 迁移后 i18n key 刻意留在 settings.remoteControl.hook.* 命名空间 ——
 * 50+ 条 × 4 语言的纯搬家徒增 diff 与漏改风险)。
 * ---------------------------------------------------------------------------
 * 中心 slack-hook-server 的接入面(单条内置连接, 零凭证配置):
 *
 *   - 固定一行「Slack」+ 总开关: 地址内置、鉴权走登录 JWT, 没有
 *     服务器地址 / 密钥表单;
 *   - 开关即绑定: 开 = 连接, main 自动发起 Sign in with Slack(OIDC)弹系统
 *     浏览器, 授权后自动变「已绑定」; 关 = 解除绑定并断开(再开需重新授权)。
 *     取消授权 / 超时(关掉浏览器) / 被顶, main 会自动关开关(toggle 弹回),
 *     这里只按推送渲染。授权中顶部行临时给「复制链接」(远程控制时浏览器落
 *     被控机, 复制到本机完成授权是兜底通路, 规则 26); 失败态显示原因一行;
 *   - toggle 视觉开态 = 绑定 confirmed(不是 enabled 意图): 连接中 / 授权中 /
 *     待安装等在途态一律显示为关, 进度由状态行文案(连接中… / 授权中… /
 *     待安装 App)承载 —— 开着但没绑定的样子会被误读为"已可用"。在途态再点
 *     toggle = 取消本轮流程(关回), 与"未安装 App"确认框的取消同语义;
 *   - workspace 未装 App(failed + not-installed): 弹确认框问要不要安装,
 *     确认开安装授权页、等 server 装完自动补完绑定(免二次授权), 取消关回
 *     开关; 等待期显示引导行(安装/复制链接 + 等待提示);
 *   - 开启后展开: 绑定状态行 + 工作目录清单(别名 -> 本地目录, 系统目录
 *     选择器添加, 别名可改, 变更即保存)。目录清单**整块可折叠**(标题行即
 *     开关, 默认收起); 展开后每张目录卡直接显示偏好编辑行(不再有单卡折叠);
 *   - 状态经 onStatusChanged 推送实时刷新; 数据先取后渲染, 无 loading 态,
 *     状态迁移不增删提示行避免布局跳动(规则 7)。
 *
 * 颜色全部走主题 token; 状态点沿用 --remote-status-* 语义色(已备案例外)。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react';

import { Switch } from '@/components/ui/switch';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import {
  HOOK_BIND_REASON_NOT_INSTALLED,
  HOOK_CHAT_WORKSPACE_ALIAS,
  slackHookInstallUrl,
  type SlackHookView,
} from '../../../shared/hookControlIpc';
import { useHookWorkspacePrefs, WorkspacePrefsEditor } from './HookWorkspacePrefsEditor';

/** 状态点颜色(语义同 SSH 主机行)。 */
function statusDot(status: SlackHookView['status']): string {
  switch (status) {
    case 'connected':
      return 'var(--remote-status-ready)';
    case 'connecting':
      return 'var(--remote-status-progress)';
    case 'error':
      return 'var(--remote-status-failed)';
    default:
      return 'var(--remote-status-disconnected)';
  }
}

/** 小号胶囊按钮(「复制链接 / 安装 Slack App」共用)。 */
const pillBtn =
  'flex h-6 shrink-0 items-center rounded-full border border-[var(--border-default)] px-2.5 text-11 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] disabled:opacity-50';

/** 目录名 -> 合法别名: 只留 [A-Za-z0-9_-], 其余折叠成 '-', 撞名加序号(含保留名 chat)。 */
function deriveAlias(dir: string, taken: ReadonlySet<string>): string {
  const base = dir.split(/[\\/]/).filter(Boolean).pop() ?? 'ws';
  let alias =
    base
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'ws';
  if (taken.has(alias)) {
    for (let i = 2; ; i++) {
      const candidate = `${alias.slice(0, 32 - String(i).length - 1)}-${i}`;
      if (!taken.has(candidate)) {
        alias = candidate;
        break;
      }
    }
  }
  return alias;
}

export function HookConnectionsSection() {
  const { t } = useTranslation();
  const [hook, setHook] = useState<SlackHookView | null>(null);
  /** 工作目录行的本地编辑态(别名输入中不被状态推送打断, blur 时提交)。 */
  const [rows, setRows] = useState<Array<{ alias: string; dir: string }>>([]);
  /** 最近一次与 main 对齐的 workspaces 序列化(判断外部变更用)。 */
  const syncedRef = useRef<string>('');
  /**
   * 「工作目录映射」整块的折叠(标题行即开关): 默认收起 —— 目录清单是低频
   * 配置, 折叠标题自带目录数摘要; 收起时提示语 / 卡片 / 添加按钮全部隐藏。
   */
  const [workspacesOpen, setWorkspacesOpen] = useState(false);

  const applyView = useCallback((view: SlackHookView) => {
    setHook(view);
    const serialized = JSON.stringify(view.workspaces);
    if (serialized !== syncedRef.current) {
      syncedRef.current = serialized;
      setRows(Object.entries(view.workspaces).map(([alias, dir]) => ({ alias, dir })));
    }
  }, []);

  useEffect(() => {
    void window.electronAPI.hookControl
      .get()
      .then((res) => applyView(res.hook))
      .catch(() => {});
    return window.electronAPI.hookControl.onStatusChanged(applyView);
  }, [applyView]);

  const saveWorkspaces = useCallback(
    async (next: Array<{ alias: string; dir: string }>) => {
      const workspaces: Record<string, string> = {};
      for (const row of next) {
        // 保留名 chat 是内置伪目录, 不允许成为真实目录别名(main 侧校验兜底)
        if (row.alias.trim() === HOOK_CHAT_WORKSPACE_ALIAS) continue;
        if (row.alias.trim() && row.dir.trim()) workspaces[row.alias.trim()] = row.dir.trim();
      }
      // 无变更的 blur(点进输入框又点出去)不发保存 —— 避免无谓 IPC 与状态刷新
      if (JSON.stringify(workspaces) === syncedRef.current) return;
      try {
        const res = await window.electronAPI.hookControl.setWorkspaces(workspaces);
        applyView(res.hook);
      } catch (err) {
        toast.error(
          extractIpcError(err)?.message ?? t('settings.remoteControl.hook.toast.saveFailed'),
        );
      }
    },
    [applyView, t],
  );

  /**
   * 开关即绑定(即时生效): 开 = 连接, main 连上后自动拉起浏览器 Slack 授权;
   * 关 = 解除绑定并断开(main 发 bind.revoke), 再开需重新授权。
   */
  const handleToggle = (enabled: boolean) => {
    void window.electronAPI.hookControl
      .setEnabled(enabled)
      .then((res) => applyView(res.hook))
      .catch(() => toast.error(t('settings.remoteControl.hook.toast.toggleFailed')));
  };

  // "等安装"确认框: binding 转入 failed + not-installed(且开关开着)时弹一次 ——
  // 确认则打开安装授权页(装完 server 自动补完绑定、推 confirmed, 免二次授权);
  // 取消则关回开关(无事发生; main 的关分支会发 bind.revoke, 作废 server 侧
  // 等安装登记, 之后即使有人装了 App 也不会偷偷绑上)。ref 记录已弹, 只在
  // false→true 转变沿弹一次, 状态广播的重渲染不重复弹。
  const { confirm } = useConfirmDialog();
  const installPromptShownRef = useRef(false);
  const awaitingInstall =
    hook !== null &&
    hook.enabled &&
    hook.binding?.state === 'failed' &&
    hook.binding?.reason === HOOK_BIND_REASON_NOT_INSTALLED;
  /**
   * 确认框是异步的, 弹着期间状态可能已翻页(典型: 用户已在浏览器里装完 App,
   * server 推回 confirmed): 确认/取消回调只能对"仍在等安装"的现状生效 ——
   * 陈旧弹窗上点「取消」不得误杀刚建立的绑定, 点「安装」也不再重复开安装页。
   * 用 ref 存最新值, 避免回调闭包捕获弹窗时刻的旧快照。
   */
  const awaitingInstallRef = useRef(false);
  awaitingInstallRef.current = awaitingInstall;
  // 安装链接: 优先 server 按 workspace 定制的(带 team 参数, 安装页预选到刚
  // 授权的工作区), 老 server 不下发时回退通用 /slack/install
  const installUrl =
    hook?.binding?.installUrl ?? (hook !== null ? slackHookInstallUrl(hook.url) : null);
  useEffect(() => {
    if (!awaitingInstall) {
      installPromptShownRef.current = false;
      return;
    }
    if (installPromptShownRef.current) return;
    installPromptShownRef.current = true;
    void (async () => {
      const ok = await confirm({
        title: t('settings.remoteControl.hook.notInstalled.confirmTitle'),
        description: t('settings.remoteControl.hook.notInstalled.confirmDescription'),
        confirmText: t('settings.remoteControl.hook.notInstalled.confirmInstall'),
        cancelText: t('settings.remoteControl.hook.notInstalled.confirmCancel'),
      });
      // 弹窗期间状态已翻页(装完自动 confirmed / 超时弹回)则本次选择作废:
      // 取消不关刚绑好的开关, 确认不重复开安装页
      if (!awaitingInstallRef.current) return;
      if (ok) {
        if (installUrl) void window.electronAPI.openExternal(installUrl);
      } else {
        handleToggle(false);
      }
    })();
    // installUrl 随触发 awaitingInstall 的同一帧广播更新(定制链接与 failed 帧
    // 同帧到达), effect 重跑时闭包已是新值; handleToggle 每渲染新建但行为恒定
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaitingInstall, confirm, t]);

  const handleAddWorkspace = async () => {
    const res = await window.electronAPI.showOpenDirectoryDialog();
    if (res.canceled || !res.path) return;
    const dir = res.path as string;
    if (rows.some((r) => r.dir === dir)) return;
    const next = [
      ...rows,
      {
        alias: deriveAlias(dir, new Set([HOOK_CHAT_WORKSPACE_ALIAS, ...rows.map((r) => r.alias)])),
        dir,
      },
    ];
    setRows(next);
    await saveWorkspaces(next);
  };

  const handleRemoveWorkspace = async (index: number) => {
    const next = rows.filter((_, i) => i !== index);
    setRows(next);
    await saveWorkspaces(next);
  };

  /** 更换某行的目录(保留别名 —— 偏好按别名归属, 换目录不丢偏好)。 */
  const handleChangeDir = async (index: number) => {
    const res = await window.electronAPI.showOpenDirectoryDialog();
    if (res.canceled || !res.path) return;
    const dir = res.path as string;
    if (rows.some((r, i) => i !== index && r.dir === dir)) return;
    const next = rows.slice();
    next[index] = { ...next[index], dir };
    setRows(next);
    await saveWorkspaces(next);
  };

  // 每目录会话偏好(与 Slack /model 卡同一份数据): 单订阅共享状态,
  // 编辑行内嵌在下方每个目录卡片里
  const prefsState = useHookWorkspacePrefs(hook);

  /** 复制授权链接(远程控制兜底: 到本机浏览器打开, 规则 26)。 */
  const handleCopyLink = async () => {
    const url = hook?.binding?.authorizeUrl;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t('settings.remoteControl.hook.binding.copied'));
    } catch {
      /* 剪贴板不可用时静默(极少见); 本机场景浏览器已自动弹出, 不阻断 */
    }
  };

  /** 复制 App 安装链接(未安装引导行的远程控制兜底, 规则 26)。 */
  const handleCopyInstallLink = async () => {
    if (installUrl === null) return;
    try {
      await navigator.clipboard.writeText(installUrl);
      toast.success(t('settings.remoteControl.hook.binding.copied'));
    } catch {
      /* 剪贴板不可用时静默; 本机场景「安装 Slack App」按钮即可直达 */
    }
  };

  // 数据未就绪不渲染任何内容(规则 7: 无 loading 态、不闪空状态)
  if (hook === null) return null;

  const bindingState = hook.binding?.state ?? 'none';
  /**
   * toggle 视觉开态 = 绑定已确认(连接 + 绑定齐备才算"开"): enabled 只是持久化
   * 的意图, 连接中 / 授权中 / 待安装期间开关显示为关, 避免"开着 · 未绑定"的
   * 假可用观感; 断线重连的瞬时抖动不弹开关(binding 快照保持 confirmed,
   * 连接状态由左侧状态点与状态行表达, 规则 7 不跳变)。
   */
  const toggleChecked = hook.enabled && hook.binding?.state === 'confirmed';
  /** 在途态(意图已开但绑定未确认): 此时再点 toggle = 取消本轮流程(关回)。 */
  const toggleInProgress = hook.enabled && hook.binding?.state !== 'confirmed';
  /** 授权检出 workspace 未安装 App: 走专属安装引导行(结构化 reason, 规则 9)。 */
  const isNotInstalled =
    bindingState === 'failed' && hook.binding?.reason === HOOK_BIND_REASON_NOT_INSTALLED;
  /** 失败/被顶态: 用一行错误说明呈现(而非并进顶部状态行)。 */
  const isBindingFailure =
    bindingState === 'denied' ||
    bindingState === 'expired' ||
    bindingState === 'failed' ||
    bindingState === 'revoked';
  // 顶部状态行合并的绑定态(仅连上时有意义; 失败态走下方错误行, 不并进这里;
  // "等安装"是保持在线的中间态, 单独给「待安装 App」)
  const bindingLabel =
    hook.status !== 'connected'
      ? null
      : bindingState === 'confirmed'
        ? hook.binding?.teamName
          ? t('settings.remoteControl.hook.statusBoundTeam', {
              name: hook.binding?.slackUserName ?? hook.binding?.slackUserId ?? '',
              team: hook.binding.teamName,
            })
          : t('settings.remoteControl.hook.statusBound', {
              name: hook.binding?.slackUserName ?? hook.binding?.slackUserId ?? '',
            })
        : bindingState === 'pending'
          ? t('settings.remoteControl.hook.authorizing')
          : isNotInstalled
            ? t('settings.remoteControl.hook.notInstalled.status')
            : t('settings.remoteControl.hook.statusUnbound');
  // 未登录的连接错误换成人话(transport 上报固定串 'not logged in')
  const errorText =
    hook.lastError === 'not logged in'
      ? t('settings.remoteControl.hook.loginRequired')
      : hook.lastError;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-12 text-[var(--text-tertiary)]">
        {t('settings.remoteControl.hook.description')}
      </p>

      <div className="rounded-xl border border-[var(--border-default)] px-4 py-3">
        {/* 固定一行: Slack + 状态 + 总开关(无任何地址/密钥表单); 品牌名跨语言
            一致, 与「Tina」同理不走 i18n */}
        <div className="flex items-center gap-3">
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: statusDot(hook.status) }}
            aria-hidden
          />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-13 font-medium text-[var(--text-primary)]">Slack</span>
            <span className="truncate text-11 text-[var(--text-tertiary)]">
              {[t(`settings.remoteControl.hook.status.${hook.status}`), bindingLabel]
                .filter(Boolean)
                .join(' · ')}
            </span>
            {hook.status === 'error' && errorText ? (
              <span className="truncate text-11 text-[var(--error-fg)]">{errorText}</span>
            ) : null}
          </div>
          {/* 授权进行中的唯一附加动作: 复制授权链接 —— 远程控制时 openExternal
              落被控机, 复制到本机浏览器完成授权是兜底通路(规则 26)。浏览器已
              自动弹出, 不再放整块提示; 状态行的「授权中…」即进度反馈 */}
          {hook.enabled && bindingState === 'pending' && hook.binding?.authorizeUrl ? (
            <button type="button" onClick={() => void handleCopyLink()} className={pillBtn}>
              {t('settings.remoteControl.hook.binding.copyLink')}
            </button>
          ) : null}
          <Switch
            checked={toggleChecked}
            onCheckedChange={(next) => {
              // 在途态(视觉关、意图开)点击会回传 next=true, 语义是"取消本轮
              // 授权/等待"而非重复开启 —— 统一关回; 其余情况按点击意图直传
              handleToggle(toggleInProgress ? false : next);
            }}
            aria-label={t('settings.remoteControl.hook.toggleAria')}
          />
        </div>

        {/* 授权检出 workspace 未安装 App(bind.update failed + reason=not-installed):
            专属引导行 —— 安装是能用的前提, 给「安装 Slack App」按钮(302 直跳
            Slack 安装授权页)+ 说明。安装成功与否无从主动探测, 装完重开开关走
            新一轮授权即验证。授权成功 = workspace 必已安装(server 绑定时校验),
            所以已绑定/平时都不出现安装入口。远程控制时 openExternal 落被控机,
            「复制链接」到本机浏览器完成安装是兜底通路(规则 26) */}
        {isNotInstalled ? (
          <div className="mt-3 flex flex-col gap-1.5 border-t border-[var(--border-default)] pt-3">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 text-11 leading-relaxed text-[var(--error-fg)]">
                {t('settings.remoteControl.hook.notInstalled.title')}
              </span>
              <button
                type="button"
                onClick={() => {
                  if (installUrl) void window.electronAPI.openExternal(installUrl);
                }}
                className={pillBtn}
              >
                {t('settings.remoteControl.hook.installApp')}
              </button>
              <button
                type="button"
                onClick={() => void handleCopyInstallLink()}
                className={pillBtn}
              >
                {t('settings.remoteControl.hook.binding.copyLink')}
              </button>
            </div>
            <span className="text-11 leading-relaxed text-[var(--text-tertiary)]">
              {hook.enabled
                ? t('settings.remoteControl.hook.notInstalled.waitingHint')
                : t('settings.remoteControl.hook.notInstalled.hint')}
            </span>
          </div>
        ) : null}

        {/* 取消授权 / 授权失败 / 超时 / 被新设备顶掉: 开关已自动弹回, 显示原因;
            绑定记录保留, 重新打开开关即自动重连并(未绑定时)重新发起授权 */}
        {isBindingFailure && !isNotInstalled ? (
          <div className="mt-3 flex flex-col gap-1 border-t border-[var(--border-default)] pt-3">
            <span className="text-11 leading-relaxed text-[var(--error-fg)]">
              {hook.binding?.message ??
                t(`settings.remoteControl.hook.binding.state.${bindingState}`)}
            </span>
            <span className="text-11 leading-relaxed text-[var(--text-tertiary)]">
              {t('settings.remoteControl.hook.binding.retryHint')}
            </span>
          </div>
        ) : null}

        {hook.enabled ? (
          <>
            {/* 工作目录清单: 整块可折叠(标题行即开关, 默认收起);
                展开后系统目录选择器添加, 别名 blur 提交, 变更即保存 */}
            <div className="mt-3 flex flex-col gap-1.5 border-t border-[var(--border-default)] pt-3">
              <button
                type="button"
                onClick={() => setWorkspacesOpen((v) => !v)}
                aria-expanded={workspacesOpen}
                className="flex w-fit items-center gap-1 text-left text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)]"
              >
                {workspacesOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span className="text-12 font-medium text-[var(--text-secondary)]">
                  {t('settings.remoteControl.hook.form.workspaces')}
                </span>
                {/* 目录数摘要并进折叠标题(「已绑定 N 个本地工作目录」), 收起时也能看到规模 */}
                <span className="text-12 text-[var(--text-tertiary)]">
                  ·{' '}
                  {t('settings.remoteControl.hook.form.workspacesBoundCount', {
                    count: Object.keys(hook.workspaces).length,
                  })}
                </span>
              </button>
              {workspacesOpen && (
                <>
                  {prefsState.hint !== null && (
                    <div className="flex items-center gap-2 text-11 text-[var(--text-tertiary)]">
                      <span>{prefsState.hint}</span>
                      {prefsState.retry !== null && (
                        <button
                          type="button"
                          onClick={prefsState.retry}
                          className="rounded-md border border-[var(--border-default)] px-2 py-0.5 text-11 text-[var(--text-secondary)]"
                        >
                          {t('settings.tina.prefs.retry')}
                        </button>
                      )}
                    </div>
                  )}
                  {/* 内置「对话」伪目录: 与真实目录同级, 常驻第一位, 不可改名/删除;
                  Slack 那头对应保留别名 chat, 偏好与 /model 选 chat 同一份 */}
                  <div className="flex flex-col gap-2 rounded-xl border border-[var(--border-default)] p-2.5">
                    <div className="flex items-center gap-1.5">
                      <span className="w-36 shrink-0 px-2.5 py-1.5 text-13 font-medium text-[var(--text-primary)]">
                        {t('settings.tina.chat.title')}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-12 text-[var(--text-tertiary)]">
                        {t('settings.tina.chat.description')}
                      </span>
                    </div>
                    <WorkspacePrefsEditor alias={HOOK_CHAT_WORKSPACE_ALIAS} state={prefsState} />
                  </div>
                  {rows.map((row, i) => (
                    <div
                      key={row.dir}
                      className="flex flex-col gap-2 rounded-xl border border-[var(--border-default)] p-2.5"
                    >
                      <div className="flex items-center gap-1.5">
                        <input
                          value={row.alias}
                          onChange={(e) => {
                            const next = rows.slice();
                            next[i] = { ...next[i], alias: e.target.value };
                            setRows(next);
                          }}
                          onBlur={() => void saveWorkspaces(rows)}
                          maxLength={32}
                          className="shrink-0 w-36 rounded-lg border border-transparent px-2.5 py-1.5 text-13 text-[var(--settings-input-text)] bg-transparent outline-none hover:border-[var(--border-default)] focus:border-[var(--border-default)] transition-colors"
                        />
                        <button
                          type="button"
                          onClick={() => void handleChangeDir(i)}
                          title={t('settings.remoteControl.hook.form.changeDir')}
                          className="min-w-0 flex-1 truncate text-left text-12 text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)]"
                        >
                          {row.dir}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleRemoveWorkspace(i)}
                          aria-label={t('settings.remoteControl.hook.form.removeWorkspace')}
                          className="shrink-0 rounded-md p-1.5 text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)]"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                      {/* 会话偏好编辑行: 偏好按别名归属(与 Slack /model 卡同键) */}
                      <WorkspacePrefsEditor alias={row.alias.trim()} state={prefsState} />
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => void handleAddWorkspace()}
                    className="flex h-7 w-fit items-center gap-1.5 rounded-full border border-[var(--border-default)] px-3 text-12 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
                  >
                    <Plus size={12} />
                    {t('settings.remoteControl.hook.form.addWorkspace')}
                  </button>
                </>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
