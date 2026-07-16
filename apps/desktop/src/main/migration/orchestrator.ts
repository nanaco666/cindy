/**
 * migration/orchestrator — 迁移编排的决策执行层(零 Electron,全依赖注入)。
 *
 * 职责分工:
 *  - startupDecision.ts / trampoline.ts:纯决策函数(输入观测,输出指令);
 *  - 本模块:把决策指令执行到 marker/文件系统(读盘 → 决策 → 转移 marker →
 *    产出"编排层该干什么"的动作),探测/spawn/下载/安装全部注入;
 *  - electronRuntime.ts:Electron 胶水(真实探测、spawn、bootstrap 接线)。
 *
 * 三个入口(B′ 方案,无第三方执行器):
 *  1. runTransitionStartup — 老 app 每次启动的 marker 处理(§3.4:跳板 /
 *     reconcile / 重入判定);
 *  2. prepareMigrationCampaign — manifest migration 块抵达后的 stage 编排
 *     (下载 → staged → handoff_ready),不执行安装;
 *  3. executeMigrationWindow — 执行窗口(用户点"重启完成升级"):老 app
 *     进程内静默安装 Cindy(装到不同目录,无文件冲突)→ 落位验证 →
 *     installed → 拉起 Cindy → launched;调用方随即 forceQuit。
 *     userData 拷贝不在此发生——Cindy 首启自拷(userDataCopy.ts)。
 */

import fs from 'node:fs';
import path from 'node:path';
import { hasCompletedFinalizationForMigration } from './firstRun';
import { deleteHandoff, HANDOFF_REL_PATH, type HandoffCrypto } from './handoff';
import { readMarker, transitionMarker } from './markerStore';
import { stageMigration, type StageDownloadFn, type StagePayloadSpec } from './stage';
import { decideStartupAction, type StartupDecision } from './startupDecision';
import { decideTrampolineOutcome, type TrampolineOutcome } from './trampoline';
import {
  IN_PROGRESS_STATES,
  type MigrationErrorCode,
  type MigrationMarker,
  type MigrationSourceInfo,
  type MigrationTargetInfo,
} from './types';

export interface OrchestratorLog {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export const MARKER_REL_PATH = path.join('migration', 'state.json');

function markerPathOf(oldUserDataDir: string): string {
  return path.join(oldUserDataDir, MARKER_REL_PATH);
}

// ── 1. 老 app 启动处理 ─────────────────────────────────────────────────────

export interface TransitionStartupDeps {
  platform: NodeJS.Platform;
  oldUserDataDir: string;
  /** 目标(Cindy)进程探测。仅在有 marker 时才会被调用。 */
  probeTargetRunning: () => Promise<boolean>;
  /**
   * 跳板 spawn:拉起目标并观察短窗(约 3s)。'alive'=存活;'exited'=短时退出;
   * 'spawn-error'=起都没起来。mac 实现应走 `open <app>`。
   */
  spawnTarget: (launchPath: string) => Promise<'alive' | 'exited' | 'spawn-error'>;
  log: OrchestratorLog;
  nowIso?: () => string;
  /** 老 app 每次启动时清理 failed/confirmed/超期的明文 handoff。 */
  cleanupStaleHandoff?: (markerState: MigrationMarker['state'] | null) => boolean;
  /** confirmed / fallback / give-up 后清理已无用途的迁移完整包。 */
  cleanupMigrationPayloads?: () => void;
}

export interface TransitionStartupOutcome {
  /** quit = 跳板成功,老 app 应立即退出(勿建窗口)。 */
  action: 'continue' | 'quit';
  decision: StartupDecision['kind'] | 'no-marker';
  /** decision=retry 时带回:campaign 到达时按此重入(countAttempt/restage)。 */
  pendingRetry?: { countAttempt: boolean; restage: boolean };
  detail?: string;
}

/** 老 app(过渡版)每次启动调用:读 marker → 决策 → 执行跳板/reconcile。 */
export async function runTransitionStartup(
  deps: TransitionStartupDeps,
): Promise<TransitionStartupOutcome> {
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const markerPath = markerPathOf(deps.oldUserDataDir);
  const marker = readMarker(markerPath);
  if (deps.cleanupStaleHandoff?.(marker?.state ?? null)) {
    deps.log.info('[migration-startup] removed stale handoff');
  }
  if (marker == null) return { action: 'continue', decision: 'no-marker' };

  const cindyRunning = await deps.probeTargetRunning();
  const decision = decideStartupAction({
    marker,
    cindyRunning,
    newSideSentinel: hasCompletedFinalizationForMigration(
      marker.target.userDataDir,
      marker.migrationId,
    ),
    // 启动期不知道 campaign 期望版本,用 marker 自身版本(restage 由 campaign 判)。
    expectedTargetVersion: marker.target.version,
  });
  deps.log.info(`[migration-startup] marker=${marker.state} decision=${decision.kind}`);

  switch (decision.kind) {
    case 'none':
      return { action: 'continue', decision: decision.kind };

    case 'reconcile-confirm': {
      // 铁律:新侧 sentinel 在,以新侧为准置 confirmed(合法矩阵外,走 override)。
      const r = transitionMarker(markerPath, {
        to: 'confirmed', by: 'old-app', nowIso: nowIso(), sentinelOverride: true,
        mutate: () => ({ lastError: null }),
        // marker 可能在本轮读盘与确认写回之间被外部清理/损坏。此处只用已经
        // 完成 sentinel 归属判断的内存快照重建，不为启动时原本就缺失的 marker 猜身份。
        create: () => marker,
      });
      if (!r.ok) deps.log.warn(`[migration-startup] reconcile-confirm rejected: ${r.reason}`);
      deps.cleanupMigrationPayloads?.();
      return runTrampoline(deps, r.marker ?? { ...marker, state: 'confirmed' }, markerPath, nowIso, {
        alreadyRunning: cindyRunning,
        decision: decision.kind,
      });
    }

    case 'trampoline':
    case 'fallback-retry':
      deps.cleanupMigrationPayloads?.();
      return runTrampoline(deps, marker, markerPath, nowIso, {
        alreadyRunning: cindyRunning,
        decision: decision.kind,
      });

    case 'retry':
      // 实际重入(下载/stage/执行)由 campaign 路径承接——payload spec 来自
      // 老渠道 manifest 的 migration 块;这里只透传决策。
      return {
        action: 'continue',
        decision: decision.kind,
        pendingRetry: { countAttempt: decision.countAttempt, restage: decision.restage },
      };

    case 'wait':
      deps.log.info(`[migration-startup] waiting: ${decision.reason}`);
      return { action: 'continue', decision: decision.kind, detail: decision.reason };

    case 'give-up':
      deps.cleanupMigrationPayloads?.();
      deps.log.error(
        '[migration-startup] auto-retry budget exhausted; manual/hot-update fix required',
      );
      return { action: 'continue', decision: decision.kind };

    default:
      return { action: 'continue', decision: (decision as StartupDecision).kind };
  }
}

async function runTrampoline(
  deps: TransitionStartupDeps,
  marker: MigrationMarker,
  markerPath: string,
  nowIso: () => string,
  ctx: { alreadyRunning: boolean; decision: string },
): Promise<TransitionStartupOutcome> {
  const launchPath = deps.platform === 'win32'
    ? path.join(marker.target.installDir, marker.target.exeName)
    : marker.target.installDir;

  let spawnOutcome: 'alive' | 'exited' | 'spawn-error' | null = null;
  let runningAfterExit = false;
  if (!ctx.alreadyRunning) {
    spawnOutcome = await deps.spawnTarget(launchPath);
    if (spawnOutcome === 'exited') {
      // 短时退出 → 复测让位(评审 P0-1)。
      runningAfterExit = await deps.probeTargetRunning();
    }
  }
  const outcome: TrampolineOutcome = decideTrampolineOutcome({
    alreadyRunningBefore: ctx.alreadyRunning,
    spawnOutcome,
    runningAfterExit,
  });

  if (outcome.kind === 'success') {
    deps.log.info(`[migration-trampoline] success via ${outcome.via}`);
    if (marker.state === 'fallback_active') {
      // 逃生舱重试成功 → 回写 confirmed(§3.4)。
      const r = transitionMarker(markerPath, {
        to: 'confirmed', by: 'old-app', nowIso: nowIso(), mutate: () => ({ lastError: null }),
      });
      if (!r.ok) deps.log.warn(`[migration-trampoline] confirmed writeback rejected: ${r.reason}`);
    }
    return { action: 'quit', decision: 'trampoline', detail: outcome.via };
  }

  deps.log.error(`[migration-trampoline] target launch failed: ${outcome.reason}`);
  if (marker.state !== 'fallback_active') {
    const r = transitionMarker(markerPath, {
      to: 'fallback_active', by: 'old-app', nowIso: nowIso(),
    });
    if (!r.ok) deps.log.warn(`[migration-trampoline] fallback transition rejected: ${r.reason}`);
  }
  return { action: 'continue', decision: 'fallback-retry', detail: outcome.reason };
}

// ── 2. campaign:stage 编排(manifest migration 块抵达时) ──────────────────

export interface MigrationCampaignDeps {
  platform: NodeJS.Platform;
  oldUserDataDir: string;
  source: MigrationSourceInfo;
  target: Omit<MigrationTargetInfo, 'payloadPath' | 'payloadSha256' | 'version'>;
  payload: StagePayloadSpec;
  /** 下载落点(老 userData 的 updates/ 下,不入 Cindy 首启拷贝范围)。 */
  payloadTargetPath: string;
  download: StageDownloadFn;
  handoffCrypto: HandoffCrypto | null;
  probeTargetRunning: () => Promise<boolean>;
  newMigrationId: () => string;
  log: OrchestratorLog;
  nowIso?: () => string;
}

export type CampaignResult =
  /** staged + handoff_ready 完成,可进入执行窗口。 */
  | { ok: true; marker: MigrationMarker }
  /** 本轮跳过(已迁移完 / Cindy 在跑 / 预算耗尽 / 新侧已激活)。 */
  | { ok: false; skipped: true; reason: string }
  /** stage 失败(下载 / 转移 / handoff),下轮轮询重试。 */
  | { ok: false; skipped: false; step: string; error: string };

/** manifest migration 块抵达后调用:决策 → 下载 → staged → handoff_ready。 */
export async function prepareMigrationCampaign(
  deps: MigrationCampaignDeps,
): Promise<CampaignResult> {
  const markerPath = markerPathOf(deps.oldUserDataDir);
  const marker = readMarker(markerPath);
  const newSideSentinel = marker == null
    ? hasCompletedFinalizationForMigration(deps.target.userDataDir)
    : hasCompletedFinalizationForMigration(deps.target.userDataDir, marker.migrationId);

  // 防覆盖铁律的 campaign 侧推论:无 marker 但新侧已健康启用(用户手清了老
  // userData 的 migration/)→ 不再发起任何迁移动作。
  if (marker == null && newSideSentinel) {
    return { ok: false, skipped: true, reason: 'new side already active without marker' };
  }
  if (marker == null && await deps.probeTargetRunning()) {
    return { ok: false, skipped: true, reason: 'target app already running without marker' };
  }

  let bumpAttempt = false;
  if (marker != null) {
    const decision = decideStartupAction({
      marker,
      cindyRunning: await deps.probeTargetRunning(),
      newSideSentinel,
      expectedTargetVersion: deps.payload.version,
    });
    deps.log.info(`[migration-campaign] marker=${marker.state} decision=${decision.kind}`);

    switch (decision.kind) {
      case 'retry':
        bumpAttempt = decision.countAttempt;
        // handoff_ready 快速重挂只复用已校验 payload；仍需经 failed → staged
        // 重新导出 handoff，避免用户在下载后轮换的机器级凭证丢失。
        // 重入需要回到 staged,而矩阵不允许 staged ← handoff_ready/in-progress
        // ——先经合法的 failed 降级(lastError 原样保留,attempt 由 bumpAttempt
        // 语义决定,纯中断不计数)。
        if (
          marker.state === 'handoff_ready' ||
          (IN_PROGRESS_STATES as readonly string[]).includes(marker.state)
        ) {
          const demoted = demoteToFailed(markerPath, deps, 'reentry from non-staged state');
          if (!demoted) return { ok: false, skipped: true, reason: 'reentry demote rejected' };
        }
        break;
      case 'fallback-retry':
        // P0-3 逃生舱出路:修复版过渡版经热更抵达后,fallback_active 重入重装
        // (staged ← fallback_active 合法)。Cindy 首启看到已有 sentinel 会跳过
        // 自拷,天然 install-only,无需模式区分。
        break;
      case 'none':
        break;
      case 'trampoline':
      case 'reconcile-confirm':
        return { ok: false, skipped: true, reason: 'already confirmed (startup handles trampoline)' };
      case 'wait':
        return { ok: false, skipped: true, reason: decision.reason };
      case 'give-up':
        return { ok: false, skipped: true, reason: 'retry budget exhausted' };
      default:
        return { ok: false, skipped: true, reason: 'unhandled decision' };
    }
  }

  const staged = await stageMigration({
    markerPath,
    source: deps.source,
    target: deps.target,
    payload: deps.payload,
    payloadTargetPath: deps.payloadTargetPath,
    download: deps.download,
    handoffCrypto: deps.handoffCrypto,
    newMigrationId: deps.newMigrationId,
    bumpAttempt,
    nowIso: deps.nowIso,
  });
  if (!staged.ok) {
    return { ok: false, skipped: false, step: staged.step, error: staged.error };
  }
  return { ok: true, marker: staged.marker };
}

/**
 * 重入/作废场景下把 handoff_ready/in-progress marker 合法降级到 failed
 * (staged 的合法前驱),lastError 原样保留。
 */
function demoteToFailed(
  markerPath: string,
  deps: Pick<MigrationCampaignDeps, 'oldUserDataDir' | 'log' | 'nowIso'>,
  why: string,
): boolean {
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  let r: ReturnType<typeof transitionMarker>;
  try {
    r = transitionMarker(markerPath, {
      to: 'failed', by: 'old-app', nowIso: nowIso(),
    });
  } catch (err) {
    // 写盘异常时本轮 handoff 同样已失效；先删明文，下一轮会重新导出。
    deleteHandoff(path.join(deps.oldUserDataDir, HANDOFF_REL_PATH));
    deps.log.warn(
      `[migration-campaign] demote-to-failed (${why}) threw: ${(err as Error).message}`,
    );
    return false;
  }
  if (!r.ok) {
    deleteHandoff(path.join(deps.oldUserDataDir, HANDOFF_REL_PATH));
    deps.log.warn(`[migration-campaign] demote-to-failed (${why}) rejected: ${r.reason}`);
    return false;
  }
  deleteHandoff(path.join(deps.oldUserDataDir, HANDOFF_REL_PATH));
  deps.log.info(`[migration-campaign] demoted to failed (${why})`);
  return true;
}

// ── 3. 执行窗口:安装 + 拉起(老 app 进程内,B′) ─────────────────────────

export interface ExecutionWindowDeps {
  platform: NodeJS.Platform;
  oldUserDataDir: string;
  /** 安装前复测:Cindy 已在跑(上轮 launched 的进程还活着)→ 放弃本轮。 */
  probeTargetRunning: () => Promise<boolean>;
  /**
   * 静默安装 payload:win = spawn `Setup.exe /S` 等退出码 0;mac = 解压
   * .app zip 到 /Applications。失败抛错(消息进 lastError)。
   */
  installPayload: (marker: MigrationMarker) => Promise<void>;
  /** 执行窗口开始时重新导出 macOS handoff；Windows 返回 null。 */
  refreshHandoff: (marker: MigrationMarker) => Promise<MigrationMarker['handoff']>;
  /** 拉起目标并经过短窗存活探测；确认目标仍在运行才返回 true。 */
  launchTarget: (launchPath: string, args: string[]) => Promise<boolean>;
  /** 落位验证注入口(默认 fs.existsSync,测试替身用)。 */
  fileExists?: (p: string) => boolean;
  /** marker 写入注入点；用于验证 failed 写盘异常时仍清理 handoff。 */
  transitionState?: typeof transitionMarker;
  log: OrchestratorLog;
  nowIso?: () => string;
}

export type ExecutionWindowResult =
  /** launched 已写,调用方应立即 forceQuit(老 app 退场,等 Cindy 首启确认)。 */
  | { ok: true }
  | { ok: false; reason: string };

/** 目标安装的落位验证文件(win: exe;mac: bundle 内二进制)。 */
export function expectedInstallFile(marker: MigrationMarker, platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? path.join(marker.target.installDir, marker.target.exeName)
    : path.join(marker.target.installDir, 'Contents', 'MacOS', marker.target.exeName);
}

/** Cindy 拉起参数(§5 契约:老侧数据/安装路径只从参数来,新 app 不硬编码推导)。 */
export function migratedLaunchArgsFor(marker: MigrationMarker): string[] {
  return [
    `--migrated-from=${marker.source.app}`,
    `--legacy-user-data=${marker.source.userDataDir}`,
    `--legacy-install-dir=${marker.source.installDir}`,
    `--legacy-uninstall-prefix=${marker.source.uninstallDisplayNamePrefix}`,
  ];
}

/**
 * 执行窗口主流程:handoff_ready 前置校验 → 安装 → installed → 拉起 →
 * launched。任一步失败写 failed(带错误码)并返回 { ok:false },老 app
 * 继续正常运行(下轮 campaign 重入)。
 */
export async function executeMigrationWindow(
  deps: ExecutionWindowDeps,
): Promise<ExecutionWindowResult> {
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const fileExists = deps.fileExists ?? ((p: string) => fs.existsSync(p));
  const transitionState = deps.transitionState ?? transitionMarker;
  const markerPath = markerPathOf(deps.oldUserDataDir);

  // 以盘上 marker 为准(可能被并发方推进);非 handoff_ready 一律放弃。
  let marker = readMarker(markerPath);
  if (marker == null || marker.state !== 'handoff_ready') {
    return { ok: false, reason: `marker state=${marker?.state ?? '(absent)'}` };
  }
  if (await deps.probeTargetRunning()) {
    // 本轮执行已放弃；旧侧仍在运行且不会经过启动清扫，不能把 macOS
    // handoff 中的 plaintextB64 留在盘上。下一轮 stage 会重新导出。
    deleteHandoff(path.join(deps.oldUserDataDir, HANDOFF_REL_PATH));
    return { ok: false, reason: 'target app already running' };
  }

  const fail = (code: MigrationErrorCode, message: string): ExecutionWindowResult => {
    deps.log.error(`[migration-exec] ${code}: ${message}`);
    try {
      const r = transitionState(markerPath, {
        to: 'failed', by: 'old-app', nowIso: nowIso(),
        mutate: () => ({ lastError: { code, message, at: nowIso() } }),
      });
      if (!r.ok) {
        deleteHandoff(path.join(deps.oldUserDataDir, HANDOFF_REL_PATH));
        deps.log.warn(`[migration-exec] failed-transition rejected: ${r.reason}`);
        return { ok: false, reason: `${code}: ${message}` };
      }
      // failed 已落盘后本轮 handoff 即失效；旧 app 会继续运行，不能依赖下次启动
      // 才清理其中的 macOS 明文凭证。deleteHandoff 同时清除原子写临时文件。
      deleteHandoff(path.join(deps.oldUserDataDir, HANDOFF_REL_PATH));
    } catch (err) {
      // state.json 被锁/不可写时仍不能把明文留给继续运行的旧 app；retry 会重导出。
      deleteHandoff(path.join(deps.oldUserDataDir, HANDOFF_REL_PATH));
      deps.log.warn(`[migration-exec] failed-transition threw: ${(err as Error).message}`);
    }
    return { ok: false, reason: `${code}: ${message}` };
  };

  // stage 与点击执行之间可能隔很久；macOS safe-storage 凭证必须以执行窗口
  // 开始时的最新内容为准，不能把旧 handoff 交给 Cindy 覆盖窗口期更新。
  if (deps.platform === 'darwin') {
    try {
      const handoff = await deps.refreshHandoff(marker);
      if (handoff == null) {
        return fail('HANDOFF_EXPORT_FAILED', 'handoff refresh returned no handoff');
      }
      const refreshed = transitionState(markerPath, {
        to: 'handoff_ready',
        by: 'old-app',
        nowIso: nowIso(),
        mutate: () => ({ handoff }),
      });
      if (!refreshed.ok || refreshed.marker == null) {
        return fail('HANDOFF_EXPORT_FAILED', refreshed.reason ?? 'handoff refresh transition rejected');
      }
      marker = refreshed.marker;
    } catch (err) {
      return fail('HANDOFF_EXPORT_FAILED', (err as Error).message);
    }
  }

  // 安装(Cindy 装到独立目录,与运行中的老 app 零文件冲突)
  try {
    await deps.installPayload(marker);
  } catch (err) {
    return fail('INSTALL_FAILED', (err as Error).message);
  }
  const expectFile = expectedInstallFile(marker, deps.platform);
  if (!fileExists(expectFile)) {
    return fail('INSTALL_FAILED', `expected file missing after install: ${expectFile}`);
  }
  try {
    const installedR = transitionState(markerPath, {
      to: 'installed', by: 'old-app', nowIso: nowIso(), mutate: () => ({ lastError: null }),
    });
    if (!installedR.ok) {
      const result = fail('INSTALL_FAILED', `installed transition rejected: ${installedR.reason}`);
      // 安装已经发生但 marker 没能记账；无论 failed 降级是否也被拒绝，
      // handoff 都必须清掉，避免旧 app 继续持有本轮明文凭证。
      deleteHandoff(path.join(deps.oldUserDataDir, HANDOFF_REL_PATH));
      return result;
    }
  } catch (err) {
    const result = fail('INSTALL_FAILED', `installed transition failed: ${(err as Error).message}`);
    deleteHandoff(path.join(deps.oldUserDataDir, HANDOFF_REL_PATH));
    return result;
  }

  // 拉起(带 --migrated-from 参数;Cindy 首启据此自拷 + 健康检查)
  const launchPath = deps.platform === 'win32'
    ? path.join(marker.target.installDir, marker.target.exeName)
    : marker.target.installDir;
  const launched = await deps.launchTarget(launchPath, migratedLaunchArgsFor(marker));
  if (!launched) {
    return fail('LAUNCH_FAILED', `spawn failed: ${launchPath}`);
  }
  try {
    const launchedR = transitionState(markerPath, {
      to: 'launched', by: 'old-app', nowIso: nowIso(),
    });
    if (!launchedR.ok) {
      // Without a durable launched marker, keep the attempt retryable and remove handoff secrets.
      return fail('LAUNCH_FAILED', `launched transition rejected: ${launchedR.reason}`);
    }
  } catch (err) {
    // A marker write error is an execution failure, even if the target process is already alive.
    return fail('LAUNCH_FAILED', `launched transition failed: ${(err as Error).message}`);
  }
  deps.log.info('[migration-exec] target installed & launched — old app should quit now');
  return { ok: true };
}

// ── Cindy 侧:argv 解析(纯函数,胶水层调用) ─────────────────────────────

export interface MigratedLaunchArgs {
  sourceApp: string;
  legacyUserDataDir: string;
  /** 新版老 app 必传；保持可选以兼容已拉起但尚未升级的旧过渡版。 */
  legacyInstallDir?: string;
  /** Windows 老品牌卸载 DisplayName 前缀；旧版启动参数缺失时保持可选。 */
  legacyUninstallDisplayNamePrefix?: string;
}

/**
 * 回滚时解析老 app 的真实启动路径。marker 可能在交棒窗口被清理，启动参数
 * 是同一身份信息的持久兜底；两者都缺安装目录时返回 null 交由胶水层报错。
 */
export function resolveLegacyLaunchPath(
  launchArgs: MigratedLaunchArgs,
  oldMarker: MigrationMarker | null,
  platform: NodeJS.Platform,
): string | null {
  const legacyInstallDir = oldMarker?.source.installDir ?? launchArgs.legacyInstallDir;
  if (!legacyInstallDir) return null;
  const legacyApp = oldMarker?.source.app ?? launchArgs.sourceApp;
  return platform === 'win32'
    ? path.win32.join(legacyInstallDir, `${legacyApp}.exe`)
    : legacyInstallDir;
}

/** 旧 app 进程名始终来自 packager executableName(source.app)，不等于 macOS bundle 展示名。 */
export function resolveLegacyProcessName(
  launchArgs: MigratedLaunchArgs,
  oldMarker: MigrationMarker | null,
  platform: NodeJS.Platform,
): string {
  const legacyApp = oldMarker?.source.app ?? launchArgs.sourceApp;
  if (platform === 'win32') return `${legacyApp}.exe`;
  return legacyApp;
}

/** 解析老 app 注入的迁移来源身份、userData 与安装路径参数。 */
export function parseMigratedLaunchArgs(argv: readonly string[]): MigratedLaunchArgs | null {
  let sourceApp: string | null = null;
  let legacyUserDataDir: string | null = null;
  let legacyInstallDir: string | null = null;
  let legacyUninstallDisplayNamePrefix: string | null = null;
  for (const arg of argv) {
    if (arg.startsWith('--migrated-from=')) sourceApp = arg.slice('--migrated-from='.length);
    else if (arg.startsWith('--legacy-user-data=')) {
      legacyUserDataDir = arg.slice('--legacy-user-data='.length);
    } else if (arg.startsWith('--legacy-install-dir=')) {
      legacyInstallDir = arg.slice('--legacy-install-dir='.length);
    } else if (arg.startsWith('--legacy-uninstall-prefix=')) {
      legacyUninstallDisplayNamePrefix = arg.slice('--legacy-uninstall-prefix='.length);
    }
  }
  if (!sourceApp || !legacyUserDataDir) return null;
  return {
    sourceApp,
    legacyUserDataDir,
    ...(legacyInstallDir ? { legacyInstallDir } : {}),
    ...(legacyUninstallDisplayNamePrefix ? { legacyUninstallDisplayNamePrefix } : {}),
  };
}
