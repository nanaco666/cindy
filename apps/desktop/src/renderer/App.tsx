import { RouterProvider } from 'react-router-dom';

import { useEffect } from 'react';

import { useCloseWindowFallbackShortcut } from '@/hooks/useCloseWindowShortcut';
import { useDisableContextMenu } from '@/hooks/useDisableContextMenu';
import { useDisableTab } from '@/hooks/useDisableTab';
import { ThemeProvider } from '@/hooks/useTheme';
import { FontSettingsProvider } from '@/hooks/useFontSettings';
import { LocaleProvider } from '@/hooks/useLocale';
import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { UserPreferencesProvider } from '@/contexts/UserPreferencesContext';
import { EnvCheckProvider, EnvCheckGuard } from '@/contexts/EnvCheckContext';
import { WorktreeProvider } from '@/contexts/WorktreeContext';
import { PrRefsProvider } from '@/contexts/PrRefsContext';
import { SplashScreen } from '@/components/splash/SplashScreen';
import { isSecondaryWindow } from '@/lib/secondaryWindow';
import { isSidebarWindow } from '@/lib/sidebarWindow';
import { ToastContainer } from '@/components/ui/toast';
import { BuiltinGhostProvisioningTip } from '@/components/cindy-brain/BuiltinGhostProvisioningTip';
import { Tooltip } from '@/components/ui/tooltip';
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog-provider';
import { FindInPageBar } from '@/components/find-in-page/FindInPageBar';
import { ProjectAutomationNotifyBridge } from '@/features/scheduler/components/ProjectAutomationNotifyBridge';
import { makerChatStore } from '@/lib/makerChatStore';
import { installSystemNetworkErrorToastListener } from '@/lib/systemNetworkErrorToast';
import { installSilentInstallToastListener } from '@/lib/silentInstallToast';
import { installProviderUpstreamErrorToastListener } from '@/lib/providerUpstreamErrorToast';
import { installCcMgrUpgradeListener } from '@/state/ccMgrUpgradeStore';
import { preloadAllCapabilities, refreshLocalCapabilities } from '@/hooks/useAgentCapabilities';
import { preloadProviders } from '@/hooks/useProviders';
import {
  useResyncAgentIslandSettingsAfterLogin,
} from '@/hooks/useAgentIslandSettings';
import {
  getDraft,
  subscribeDraft,
  setEffortForModel,
  setFastModeForModel,
  patchVendorPrefs,
  patchVendorPrefsPreservingModelChoice,
} from '@/state/newMakerDraft';
import {
  snapshotForSeed,
  setProviderModelChoice,
  setProviderModelFast,
  subscribeProviderModelMemory,
} from '@/state/providerModelMemory';
import { setSessionModelEffort, setSessionModelFast } from '@/state/sessionModelMemory';
import type { Effort } from '@/lib/userPreferences.types';

import { router } from './router';

function MakerBootstrap() {
  const { isAuthenticated } = useAuth();

  useResyncAgentIslandSettingsAfterLogin(isAuthenticated);

  useEffect(() => {
    makerChatStore.syncActiveTurnsFromMain();
    void preloadAllCapabilities();
    // 预热供应商快照 —— 让模型下拉首次打开即终态布局(双栏/单栏不再跳变,见 useProviders)。
    void preloadProviders();
    // main 在 Codex auth/discovery 收口后先原地更新 Maker capabilities，再发 auth push；
    // renderer 收到后重拉两个 agent，保持 scheduler / selector / context metadata 同步。
    const off = window.electronAPI.maker.auth.onStateChanged((payload) => {
      if (payload.agentKind === 'codex') void refreshLocalCapabilities();
    });
    return off;
  }, []);
  return null;
}

export function App() {
  useDisableContextMenu();
  useDisableTab();
  // mac ⌘W 根级兜底: splash / env check / 登录 / 迁移等壳外阶段关(隐藏)本窗口;
  // MainLayout / SidebarWindowLayout 挂载期间声明所有权, 本兜底让路给壳层的
  // 焦点分派消费点 (右侧栏 tab 优先)。见 useCloseWindowShortcut.ts。
  useCloseWindowFallbackShortcut();

  // F-PSI-4: install the single global CC Agent IPC listener exactly once,
  // regardless of which session view mounts first. The store itself is
  // idempotent, so StrictMode / HMR re-mounts don't double-subscribe.
  // NOTE: initGlobalListeners registers push-channel listeners only (ipcRenderer.on);
  // invoke-dependent calls (syncActiveTurnsFromMain, preloadAllCapabilities) are deferred
  // to <MakerBootstrap /> inside EnvCheckGuard to avoid the startup race where maker:*
  // IPC handlers aren't registered yet. syncPrefs below uses fire-and-forget send.
  useEffect(() => {
    makerChatStore.initGlobalListeners();

    // 启动时立刻推送一次 cc vendor 偏好 + 完整 newMakerDraft 快照给 main:
    //  - syncDesktopCcPrefs: 给飞书接管新建 session 用 (仅 cc vendor)
    //  - syncNewMakerDraft: 给 collab mode spawn worker 用 (双 vendor + 按模型记忆)
    // 都是 ipcRenderer.send fire-and-forget; handler 在 createWindow 前已注册。
    const syncPrefs = () => {
      const draft = getDraft();
      const cc = draft.lastByVendor.cc;
      window.electronAPI.syncDesktopCcPrefs({
        model: cc.model,
        effort: cc.effort,
        permissionMode: cc.permissionMode,
        fastMode: draft.fastModeByModel[cc.model] === true,
      });
      // main 缓存两用途:① collab worker spawn 读 model/effort/fastMode;② device-link 远程
      // 草稿镜像读全量(model/effort/fast/permission/source)。故 lastByVendor 每项带上
      // permissionMode + providerId(worker spawn 不消费这两项,远程草稿镜像才用)。仅 cc/codex,
      // 不带 orca。fire-and-forget。
      window.electronAPI.syncNewMakerDraft({
        lastByVendor: {
          cc: {
            model: draft.lastByVendor.cc.model,
            effort: draft.lastByVendor.cc.effort,
            permissionMode: draft.lastByVendor.cc.permissionMode,
            providerId: draft.lastByVendor.cc.providerId ?? null,
          },
          codex: {
            model: draft.lastByVendor.codex.model,
            effort: draft.lastByVendor.codex.effort,
            permissionMode: draft.lastByVendor.codex.permissionMode,
            providerId: draft.lastByVendor.codex.providerId ?? null,
          },
        },
        fastModeByModel: draft.fastModeByModel,
        effortByModel: draft.effortByModel,
      });
    };
    syncPrefs();
    return subscribeDraft(syncPrefs);
  }, []);

  // device-link 被控端单一真相:把 providerModelMemory(草稿模型列表行的真实读源)全量镜像给 main,
  // 让控制端经 maker:get-new-maker-defaults / NEW_MAKER_DRAFT_CHANGED 完整看到被控端草稿每个供应商
  // 每个模型的 effort/fast(旧 newMakerDraft.effortByModel 已不再写非选中行,故必须单独镜像这一层)。
  // 启动推一次 + 变化增量推,fire-and-forget;无控制者订阅时 main 端转发近似 no-op。
  useEffect(() => {
    const sync = () => window.electronAPI.syncProviderModelMemory(snapshotForSeed());
    sync();
    return subscribeProviderModelMemory(sync);
  }, []);

  // device-link 被控端:接收控制端写穿的「模型 effort/fast」pref,调**被控端原来的本地 setter**
  // 写真实草稿 / 会话记忆(控制端是纯显示,改动经隧道发来这里执行)。收到通知只写本地、不回通知 →
  // 单跳无环;写入触发既有 store emit + 上面的镜像 effect → 自动经 NEW_MAKER_DRAFT_CHANGED /
  // SYNC_SESSION_MODEL_PREF 回流控制端显示。控制端进程从不收到这两个 channel(只本地窗口),监听不误触发。
  useEffect(() => {
    const offDraft = window.electronAPI.onMakerDraftPrefApply(
      ({ agent, providerId, modelId, active, effort, fast, markModelChoice }) => {
        const vendor = agent === 'claude-code' ? 'cc' : 'codex';
        if (active) {
          const patch = markModelChoice === false ? patchVendorPrefsPreservingModelChoice : patchVendorPrefs;
          const shouldPatchActiveModel = markModelChoice !== false || effort !== undefined;
          if (shouldPatchActiveModel) {
            patch(vendor, {
              model: modelId,
              providerId: providerId || null,
              ...(effort !== undefined ? { effort: effort as Effort } : {}),
            });
          }
        }
        if (effort !== undefined) {
          setProviderModelChoice(agent, providerId, modelId, effort as Effort);
          if (active) setEffortForModel(modelId, effort as Effort); // 旧层兜底保持一致
        }
        if (fast !== undefined) {
          setProviderModelFast(agent, providerId, modelId, fast);
          if (active) setFastModeForModel(modelId, fast); // 旧层兜底保持一致
        }
      },
    );
    const offSession = window.electronAPI.onMakerSessionPrefApply(
      ({ sessionId, agent, providerId, model, effort, fast }) => {
        if (effort !== undefined) {
          setSessionModelEffort(sessionId, agent, providerId, model, effort as Effort);
        }
        if (fast !== undefined) setSessionModelFast(sessionId, agent, providerId, model, fast);
        // 被控端是 session pref 的唯一广播 hub:应用控制端写穿后**再回流一次**,使**其它**控制端
        // (多控制端同看一会话)也收敛(对齐草稿侧 providerModelMemory 的全局回流)。回到发起方控制端
        // 是同值幂等(其 mirror 同值短路、不重渲染、不回 invoke),不成环;被控端不收自己的 tap 转发。
        window.electronAPI.syncSessionModelPref({
          sessionId,
          agent,
          providerId,
          model,
          ...(effort !== undefined ? { effort } : {}),
          ...(fast !== undefined ? { fast } : {}),
        });
      },
    );
    return () => {
      offDraft();
      offSession();
    };
  }, []);

  // Lifecycle 在 main 进程兜底 catch 到瞬时网络错误 (VPN 抖动等) 时会推一次,
  // renderer 弹一条带节流的 warning toast 让用户感知到; 详见 systemNetworkErrorToast.ts。
  useEffect(() => {
    return installSystemNetworkErrorToastListener();
  }, []);

  // Phase D — maker:send 触发的远端 agent 静默安装 (codex 没装就自动跑 install)
  // 状态推到 renderer, 用一条 toast 反馈阶段性进度 + 失败提示。详见 silentInstallToast.ts。
  useEffect(() => {
    return installSilentInstallToastListener();
  }, []);

  // 自定义供应商上游错误 (proxy 观察器分类广播, main 侧已节流) → 分类人话 toast +
  // 修复引导。详见 providerUpstreamErrorToast.ts。
  useEffect(() => {
    return installProviderUpstreamErrorToastListener();
  }, []);

  // cc-mgr 版本不匹配的 UpgradeBanner: 订阅 main 的 CC_MGR_UPGRADE_AVAILABLE push +
  // 启动时拉一次 pending snapshot, 写进 ccMgrUpgradeStore。没挂这个 listener 的话
  // main 探到版本差异 broadcast 了也没人接, banner 永不显示。详见 ccMgrUpgradeStore.ts。
  useEffect(() => {
    return installCcMgrUpgradeListener();
  }, []);

  return (
    <ThemeProvider>
      <FontSettingsProvider>
        <LocaleProvider>
          <ConfirmDialogProvider>
            <EnvCheckProvider>
              <AuthProvider>
                <UserPreferencesProvider>
                  <WorktreeProvider>
                    <PrRefsProvider>
                      <Tooltip.Provider>
                        {/* 副窗口(「在新窗口打开」)/ 右侧栏子窗口跳过 splash:env/热更检查
                            由主窗启动时完成,附属窗 EnvCheckProvider 初始即 'passed',
                            不需要也不应再走 splash 流程。 */}
                        {!isSecondaryWindow() && !isSidebarWindow() && <SplashScreen />}
                        <EnvCheckGuard>
                          <MakerBootstrap />
                          <ProjectAutomationNotifyBridge />
                          <RouterProvider router={router} />
                        </EnvCheckGuard>
                        <FindInPageBar />
                        <ToastContainer />
                        <BuiltinGhostProvisioningTip />
                      </Tooltip.Provider>
                    </PrRefsProvider>
                  </WorktreeProvider>
                </UserPreferencesProvider>
              </AuthProvider>
            </EnvCheckProvider>
          </ConfirmDialogProvider>
        </LocaleProvider>
      </FontSettingsProvider>
    </ThemeProvider>
  );
}
