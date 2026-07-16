/**
 * migration/electronRuntime — 品牌迁移编排的 Electron 胶水层(B′ 方案)。
 *
 * 唯一允许 import electron 的迁移模块:真实探测(进程枚举)、spawn(跳板 /
 * 安装器 / 拉起)、safeStorage 适配、下载器接入、bootstrap / updateService
 * 接线面。决策与状态推进全部在 orchestrator.ts / firstRun.ts / userDataCopy.ts
 * (纯逻辑,已单测),本层只做"把真实世界喂给纯函数、按指令执行副作用"。
 *
 * 接线点:
 *  - bootstrap ready 最前:maybeRunCindyFirstRun()(新 app 身份)→
 *    runTransitionStartupElectron()(老 app 身份);两者平时均惰性(无 marker /
 *    无 argv 标记时零副作用)。
 *  - updateService:isHotUpdateSuppressedNow()(执行窗口进行中)、
 *    handleMigrationBlock()(manifest migration 块 → stage)、
 *    isMigrationRelaunchReady() / executeMigrationRelaunch()(执行窗口:
 *    老 app 进程内静默安装 Cindy → 拉起 → forceQuit,无第三方执行器)。
 */

import { app, safeStorage } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allDbFilePrefixes, BRAND_IDENTITY } from '@lizi/maker-shared/brand-identity';

import { download } from '../downloader/index';
import { createLogger, maskPath } from '../logger';
import { USER_DATA_COPY_EXCLUDES } from './copyExcludes';
import {
  FIRST_RUN_SENTINEL_REL_PATH,
  RECEIPT_REL_PATH,
  cleanupConfirmedHandoffs,
  failFirstRunMigration,
  hasCompletedMigrationReceipt,
  inspectFirstRunFinalization,
  recordHealthyLaunch,
  runFirstRunHealthCheck,
  selectLegacyWindowsUninstallCommand,
  shouldUninstallOldApp,
  type WindowsUninstallEntry,
} from './firstRun';
import {
  deleteHandoffIfStale,
  exportHandoffSnapshot,
  type HandoffCrypto,
} from './handoff';
import { IDENTITY_ANCHOR_REL_PATH, upsertIdentityAnchor } from './identityAnchor';
import { captureLegacyInstallIdentity, matchesLegacyInstallIdentity } from './installIdentity';
import { probeMigrationLocalDbs } from './localDbProbe';
import { claimLegacyLocalDb } from './localDbClaim';
import { installMacPayloadAtomic, recoverInterruptedMacInstall } from './macosInstall';
import { readMarker, readReceipt } from './markerStore';
import { MigrationOperationGate } from './operationGate';
import {
  executeMigrationWindow,
  MARKER_REL_PATH,
  parseMigratedLaunchArgs,
  prepareMigrationCampaign,
  resolveLegacyLaunchPath,
  resolveLegacyProcessName,
  runTransitionStartup,
  type MigratedLaunchArgs,
} from './orchestrator';
import { CINDY_TARGET_BRAND, resolveTargetPaths } from './targetIdentity';
import { probeSafeStorageDirectory } from './safeStorageProbe';
import type { LegacyInstallIdentity, MigrationMarker } from './types';
import { resetCopyJournal, runLegacyDataCopy } from './userDataCopy';
import { cleanMigrationPayloadFiles, migrationPayloadTargetPath } from '../updateArtifacts';

const log = createLogger('brandMigration');

/** 老渠道 manifest 的 migration 块(manifestService.AppManifest.migration)。 */
export interface AppMigrationBlock {
  /** 目标品牌短名,必须与本构建内置的 campaign 目标一致(防误发)。 */
  targetApp: string;
  /** 目标(Cindy)版本。 */
  version: string;
  /** 完整安装包(win NSIS Setup.exe / mac .app zip),相对 baseUrl。 */
  file: string;
  sha256: string;
  size: number;
}

// ── host 注入(updateService 在 init 时提供,避免循环依赖) ────────────────

interface MigrationHost {
  /** campaign staged 完成后广播 ready 状态(复用热更 banner 的重启 UX)。 */
  notifyReady: (version: string) => void;
  /** 执行窗口拉起 Cindy 成功后的强退(绕过优雅退出链,同热更 forceQuit)。 */
  forceQuit: () => void;
  /** 下载 URL 前缀(manifestService.getBaseUrl,经注入避免网络探测状态分裂)。 */
  getBaseUrl: () => string;
}

let host: MigrationHost | null = null;

export function initMigrationRuntime(h: MigrationHost): void {
  host = h;
}

// ── 平台探测与 spawn 原语 ─────────────────────────────────────────────────

const TRAMPOLINE_OBSERVE_MS = 3_000;
/** NSIS 静默安装 / mac 解压的最长等待(超时按安装失败处理)。 */
const INSTALL_TIMEOUT_MS = 10 * 60_000;
/** Cindy 首启等老 app 退出的最长等待。 */
const WAIT_OLD_EXIT_TIMEOUT_MS = 30_000;

/** 按可执行名探测进程是否在跑(win tasklist / POSIX pgrep)。失败视为不在跑。 */
function probeProcessRunning(imageName: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile(
        'tasklist', ['/FI', `IMAGENAME eq ${imageName}`, '/NH', '/FO', 'CSV'],
        { timeout: 5_000, windowsHide: true },
        (err, stdout) => {
          resolve(!err && stdout.toLowerCase().includes(imageName.toLowerCase()));
        },
      );
      return;
    }
    // mac:进程名 = packager executableName；pgrep -x 精确匹配。
    execFile('pgrep', ['-x', imageName], { timeout: 5_000 }, (err, stdout) => {
      resolve(!err && stdout.trim().length > 0);
    });
  });
}

/** 目标进程探测(从 marker 的 target 身份推导可执行名)。 */
function probeTargetRunningFor(marker: MigrationMarker): () => Promise<boolean> {
  const imageName = process.platform === 'win32'
    ? marker.target.exeName
    : path.basename(marker.target.exeName, '.exe');
  return () => probeProcessRunning(imageName);
}

/**
 * 跳板 spawn:拉起目标并观察短窗。mac 走 `open <app>`(open 自身立即退出,
 * 存活以观察窗后的进程探测为准);win 直接 spawn exe。
 */
async function spawnTargetAndObserve(
  launchPath: string,
  probeRunning: () => Promise<boolean>,
  args: string[] = [],
): Promise<'alive' | 'exited' | 'spawn-error'> {
  const spawned = await spawnDetached(launchPath, args);
  if (!spawned) return 'spawn-error';
  await new Promise((r) => setTimeout(r, TRAMPOLINE_OBSERVE_MS));
  // 统一以观察窗后的系统级探测判存活(兼容 mac open 间接拉起 / win 单实例让位)。
  return (await probeRunning()) ? 'alive' : 'exited';
}

/** detached spawn(win 直接 exe;mac 经 open,--args 透传);spawn 成功即 true。 */
function spawnDetached(launchPath: string, args: string[]): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    try {
      const child = process.platform === 'win32'
        ? spawn(launchPath, args, { detached: true, stdio: 'ignore' })
        : spawn(
            'open',
            args.length > 0 ? [launchPath, '--args', ...args] : [launchPath],
            { detached: true, stdio: 'ignore' },
          );
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

/** mac safeStorage 交接加密后端;win 返回 null(DPAPI 拷贝即用,无交接环节)。 */
function platformHandoffCrypto(): HandoffCrypto | null {
  if (process.platform !== 'darwin') return null;
  return {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    decryptFromBase64: (b64) => safeStorage.decryptString(Buffer.from(b64, 'base64')),
    encryptToBase64: (plain) => safeStorage.encryptString(plain).toString('base64'),
  };
}

// ── 老 app:启动处理(bootstrap ready 最前调用) ──────────────────────────

/**
 * 过渡版启动时的迁移处理。返回 'quit' 表示跳板成功,调用方应立即
 * app.exit(0) 且不建窗口。无 marker 时零副作用。
 */
export async function runTransitionStartupElectron(): Promise<'continue' | 'quit'> {
  const oldUserDataDir = app.getPath('userData');
  const marker = readMarker(path.join(oldUserDataDir, MARKER_REL_PATH));
  if (process.platform === 'darwin' && marker != null) {
    try {
      const recovered = recoverInterruptedMacInstall(marker.target.installDir);
      if (recovered !== 'none') log.info('recovered interrupted macOS install: %s', recovered);
    } catch (err) {
      log.error('failed to recover interrupted macOS install:', err);
    }
  }
  const probe = marker == null ? async () => false : probeTargetRunningFor(marker);
  const outcome = await runTransitionStartup({
    platform: process.platform,
    oldUserDataDir,
    probeTargetRunning: probe,
    spawnTarget: (launchPath) => spawnTargetAndObserve(launchPath, probe),
    cleanupStaleHandoff: (markerState) => deleteHandoffIfStale({
      userDataDir: oldUserDataDir,
      markerState,
      nowMs: Date.now(),
    }),
    cleanupMigrationPayloads: () => cleanMigrationPayloadFiles(oldUserDataDir),
    log,
  });
  log.info(
    'transition startup: decision=%s action=%s %s',
    outcome.decision, outcome.action, outcome.detail ?? '',
  );
  return outcome.action;
}

// ── 老 app:身份锚埋点(bootstrap 的 auth 状态订阅接线) ──────────────────

/**
 * auth 状态就绪(登录成功 / 启动恢复登录态)时调用:把当前账号的身份锚
 * upsert 到 `<userData>/migration/identity-anchor.json`(账号系统切换的
 * 认领依据,见 identityAnchor.ts 顶注)。登出不清、未认证时 no-op;
 * 幂等(内容无变化跳过写盘),失败只记日志不影响任何流程。
 */
export function recordIdentityAnchor(user: {
  id: string;
  email?: string | null;
  feishuOpenId?: string | null;
} | null): void {
  if (user == null || !user.id) return;
  try {
    const filePath = path.join(app.getPath('userData'), IDENTITY_ANCHOR_REL_PATH);
    const result = upsertIdentityAnchor(filePath, {
      userId: user.id,
      email: user.email,
      feishuOpenId: user.feishuOpenId,
    });
    if (result === 'written') log.info('identity anchor updated for user %s', user.id);
  } catch (err) {
    log.warn('identity anchor write failed (non-fatal)', err);
  }
}

// ── 老 app:campaign(updateService 接线) ────────────────────────────────

const operationGate = new MigrationOperationGate();

/**
 * §3.5 热更抑制:仅在执行窗口(安装 + 拉起)进行中抑制普通热更检查。
 * B′ 下没有第三方执行器,in-flight 即本进程内的同步事实,无需 marker/锁探测。
 */
export function isHotUpdateSuppressedNow(): boolean {
  return operationGate.isExecutionActive;
}

/** Cindy 新账号 ensureReady 前按 identity anchor 唯一匹配并认领旧 UID 主库。 */
export async function claimLegacyLocalDbBeforeEnsureReady(user: {
  id: string;
  email?: string | null;
  feishuOpenId?: string | null;
}): Promise<void> {
  const userDataDir = app.getPath('userData');
  if (!hasCompletedMigrationReceipt(userDataDir)) {
    // 认领只属于已完成品牌迁移的新 profile。过渡版与 Cindy 全新安装均无 receipt，
    // 必须保持惰性，避免在同一 xdt-maker 前缀下按身份锚跨 UID 复制本地库。
    log.info('legacy local DB claim skipped for user %s: no migration receipt', user.id);
    return;
  }
  const result = await claimLegacyLocalDb({
    userDataDir,
    currentDbPrefix: BRAND_IDENTITY.dbFilePrefix,
    dbFilePrefixes: allDbFilePrefixes(BRAND_IDENTITY),
    newUserId: user.id,
    email: user.email,
    feishuOpenId: user.feishuOpenId,
  });
  if (result.status === 'failed') {
    // 认领是历史数据恢复，不得锁死新账号。失败时保留老库并放行 ensureReady 创建
    // 新库；目标一旦创建，后续调用自然走 target-exists，不会无限重试。
    log.warn('legacy local DB claim failed for user %s; continuing with a new DB: %s',
      user.id, result.error);
    return;
  }
  if (result.status === 'claimed') {
    log.info(
      'claimed legacy local DB for new user %s from old user %s',
      user.id,
      result.oldUserId,
    );
  } else {
    log.info('legacy local DB claim skipped for user %s: %s', user.id, result.reason);
  }
}

let stagedReady: MigrationMarker | null = null;

/**
 * manifest migration 块抵达(且本体版本已对齐)时调用:决策 → 下载 Cindy 完整
 * 包 → staged → handoff_ready → 广播 ready 状态等待执行窗口。幂等可重入,
 * 内置 in-flight 去重;跳过/失败静默(下轮 30min 轮询重试)。
 */
export async function handleMigrationBlock(block: AppMigrationBlock): Promise<void> {
  if (host == null) {
    log.warn('migration block received before initMigrationRuntime — ignored');
    return;
  }
  if (block.targetApp !== CINDY_TARGET_BRAND.app) {
    log.error('migration block targetApp=%s mismatches built-in %s — ignored',
      block.targetApp, CINDY_TARGET_BRAND.app);
    return;
  }
  const finishCampaign = operationGate.tryStartCampaign();
  if (finishCampaign == null) {
    log.info('migration campaign skipped: another campaign or execution window is active');
    return;
  }
  try {
    const oldUserDataDir = app.getPath('userData');
    const platform = process.platform;
    const targetPaths = resolveTargetPaths(CINDY_TARGET_BRAND, {
      platform,
      appDataDir: app.getPath('appData'),
      localAppDataDir: process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
    });
    // 老 app 安装根:win 为 exe 所在目录;mac 为 .app bundle 根。
    const sourceInstallDir = platform === 'darwin'
      ? path.dirname(path.dirname(path.dirname(app.getAppPath())))
      : path.dirname(app.getPath('exe'));

    const marker = readMarker(path.join(oldUserDataDir, MARKER_REL_PATH));
    const probe = marker != null
      ? probeTargetRunningFor(marker)
      : () => probeProcessRunning(targetPaths.exeName);

    const result = await prepareMigrationCampaign({
      platform,
      oldUserDataDir,
      source: {
        app: BRAND_IDENTITY.executableName,
        version: app.getVersion(),
        installDir: sourceInstallDir,
        userDataDir: oldUserDataDir,
        uninstallDisplayNamePrefix: BRAND_IDENTITY.uninstallDisplayNamePrefix,
      },
      target: {
        app: CINDY_TARGET_BRAND.app,
        installDir: targetPaths.installDir,
        userDataDir: targetPaths.userDataDir,
        exeName: targetPaths.exeName,
      },
      payload: {
        url: `${host.getBaseUrl()}/${block.file}`,
        sha256: block.sha256.toLowerCase(),
        version: block.version,
      },
      payloadTargetPath: migrationPayloadTargetPath(oldUserDataDir, block.file),
      download: ({ url, targetPath, sha256 }) => download({
        url, targetPath, sha256,
        expectedSize: typeof block.size === 'number' ? block.size : undefined,
        logger: {
          debug: () => {},
          info: (m) => log.info('[payload] %s', m),
          warn: (m) => log.warn('[payload] %s', m),
          error: (m) => log.error('[payload] %s', m),
        },
      }),
      handoffCrypto: platformHandoffCrypto(),
      probeTargetRunning: probe,
      newMigrationId: () => randomUUID(),
      log,
    });

    if (!result.ok) {
      if (result.skipped) {
        log.info('migration campaign skipped: %s', result.reason);
      } else {
        log.warn('migration campaign stage failed at %s: %s', result.step, result.error);
      }
      return;
    }
    stagedReady = result.marker;
    log.info(
      'migration staged: target v%s — awaiting relaunch window',
      result.marker.target.version,
    );
    host.notifyReady(result.marker.target.version);
  } finally {
    finishCampaign();
  }
}

/** 是否有已 staged 的迁移在等执行窗口(executeRelaunch 拦截判据)。 */
export function isMigrationRelaunchReady(): boolean {
  return stagedReady != null;
}

/**
 * 执行窗口(B′):老 app 进程内静默安装 Cindy(独立目录,零文件冲突)→
 * 落位验证 → 拉起 Cindy → forceQuit。返回 false 表示失败(marker 已按步
 * 写 failed,可经 campaign 重试)。
 */
export async function executeMigrationRelaunch(): Promise<boolean> {
  const finishExecution = await operationGate.tryStartExecution();
  if (finishExecution == null) return false;
  try {
    if (host == null || stagedReady == null) return false;
    const oldUserDataDir = app.getPath('userData');
    const probe = probeTargetRunningFor(stagedReady);
    const result = await executeMigrationWindow({
      platform: process.platform,
      oldUserDataDir,
      probeTargetRunning: probe,
      installPayload: (marker) => installPayloadReal(marker),
      refreshHandoff: async (marker) => {
        if (process.platform !== 'darwin') return null;
        const crypto = platformHandoffCrypto();
        if (crypto == null) throw new Error('macOS handoff crypto unavailable');
        const refreshed = exportHandoffSnapshot({
          userDataDir: oldUserDataDir,
          crypto,
          sourceApp: marker.source.app,
          sourceVersion: app.getVersion(),
          platform: process.platform,
        });
        if (!refreshed.ok) throw new Error(refreshed.error ?? 'handoff refresh failed');
        return refreshed.info;
      },
      launchTarget: async (launchPath, args) => (
        await spawnTargetAndObserve(launchPath, probe, args)
      ) === 'alive',
      log,
    });
    if (!result.ok) {
      log.error('migration execution failed: %s', result.reason);
      stagedReady = null;
      return false;
    }
    host.forceQuit();
    return true;
  } finally {
    finishExecution();
  }
}

/** 真实安装:win = spawn NSIS Setup.exe /S 等退出码;mac = ditto 解压 .app zip。 */
async function installPayloadReal(marker: MigrationMarker): Promise<void> {
  const payload = marker.target.payloadPath;
  if (process.platform === 'win32') {
    await execFileAsync(payload, ['/S'], INSTALL_TIMEOUT_MS);
    return;
  }
  await installMacPayloadAtomic({
    payloadPath: payload,
    destApp: marker.target.installDir,
    expectedExecutableName: marker.target.exeName,
    extractArchive: (archive, destinationDir) => execFileAsync(
      'ditto',
      ['-xk', archive, destinationDir],
      INSTALL_TIMEOUT_MS,
    ),
  });
}

function execFileAsync(file: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (err) => {
      if (err) reject(new Error(`${path.basename(file)} failed: ${err.message}`));
      else resolve();
    });
  });
}

// ── 新 app(Cindy 身份):首启自拷 + 健康检查 + 延迟卸载 ──────────────────

const UNINSTALL_CHECK_DELAY_MS = 3 * 60_000;

/**
 * 新 app 侧启动处理(bootstrap ready 最前调用,先于老 app 分支):
 *  - argv 带 `--migrated-from` 且尚无 sentinel → 等老 app 退出 → 自拷老
 *    userData → 首启健康检查(§5),失败返回 'quit'(调用方 app.exit(1),
 *    老 app 经 failed marker 重试);
 *  - 已有 sentinel / 无 argv 但有 receipt → 健康启动计数 + 延迟卸载检查;
 *  - 都没有 → 本机与迁移无关,零副作用。
 */
export async function maybeRunCindyFirstRun(): Promise<'continue' | 'quit'> {
  const newUserDataDir = app.getPath('userData');
  const launchArgs = parseMigratedLaunchArgs(process.argv);
  const sentinelPath = path.join(newUserDataDir, FIRST_RUN_SENTINEL_REL_PATH);
  const receiptPath = path.join(newUserDataDir, RECEIPT_REL_PATH);
  const finalization = inspectFirstRunFinalization(newUserDataDir);
  const receipt = finalization.receipt;

  if (finalization.state === 'partial') {
    log.error('incomplete migration finalization (sentinel/receipt mismatch) — resetting');
    let cleanupOk = true;
    for (const partialPath of [sentinelPath, receiptPath]) {
      try { fs.rmSync(partialPath, { force: true }); } catch (err) {
        cleanupOk = false;
        log.error('failed to clear partial finalization file %s: %s',
          maskPath(partialPath), (err as Error).message);
      }
    }
    resetCopyJournal(newUserDataDir);
    // 清理失败时不能把旧侧留在 launched：即使 sentinel 残留，旧 app 也只
    // 能看到 failed 并继续运行。receipt/sentinel 任一存在都携带老侧 userData，
    // 因此即便本次启动没有 argv 也能回拉旧安装。
    if (!cleanupOk || launchArgs == null) {
      const legacyUserDataDir = launchArgs?.legacyUserDataDir
        ?? finalization.receipt?.legacyUserDataDir
        ?? finalization.sentinel?.legacyUserDataDir;
      if (legacyUserDataDir != null) {
        await failFirstRunMigration({
          newUserDataDir,
          legacyUserDataDir,
          relaunchLegacy: () => relaunchLegacyFromOrigin({
            legacyUserDataDir,
            sourceApp: launchArgs?.sourceApp ?? finalization.receipt?.legacyApp,
            legacyInstallDir: launchArgs?.legacyInstallDir ?? finalization.receipt?.legacyInstallDir,
          }),
          log,
        }, 'partial-finalization', 'sentinel/receipt mismatch');
      }
      return 'quit';
    }
  } else if (launchArgs == null || finalization.state === 'complete') {
    // 非首启:有 receipt 才说明本机是迁移产物,计数 + 延迟卸载。
    if (receipt != null) {
      cleanupConfirmedHandoffs(newUserDataDir, receipt);
      recordHealthyLaunch(newUserDataDir, {
        onError: (err) => log.warn(
          'healthy launch receipt update failed (non-fatal): %s',
          err.message,
        ),
      });
      scheduleDelayedUninstallCheck(newUserDataDir);
    }
    return 'continue';
  }

  log.info('first run after migration from %s (legacy userData: %s)',
    launchArgs.sourceApp, maskPath(launchArgs.legacyUserDataDir));
  // 必须在 waitOldAppExit 之前捕获：此刻运行中的旧进程证明路径仍对应本次迁移来源；
  // 之后若用户重装/覆盖相同目录，文件身份变化会让延迟卸载 fail closed。
  const legacyInstallIdentity = captureLegacyInstallIdentity(
    launchArgs.legacyInstallDir,
    launchArgs.sourceApp,
    process.platform,
  );
  const result = await runFirstRunHealthCheck({
    newUserDataDir,
    legacyUserDataDir: launchArgs.legacyUserDataDir,
    legacyInstallDir: launchArgs.legacyInstallDir,
    legacyApp: launchArgs.sourceApp,
    legacyUninstallDisplayNamePrefix: launchArgs.legacyUninstallDisplayNamePrefix,
    ...(legacyInstallIdentity ? { legacyInstallIdentity } : {}),
    handoffCrypto: platformHandoffCrypto(),
    waitOldAppExit: () => waitOldAppExit(launchArgs),
    copyLegacyData: () => {
      const r = runLegacyDataCopy({
        legacyUserDataDir: launchArgs.legacyUserDataDir,
        newUserDataDir,
        targetDbFilePrefix: BRAND_IDENTITY.dbFilePrefix,
        excludes: USER_DATA_COPY_EXCLUDES,
        // 走到这里说明 first-run sentinel 尚未落盘；不能信任上次恰好在 journal=done
        // 后崩溃留下的副本，因为用户可能已被拉回老 app 并继续产生新数据。
        trustCompletedJournal: false,
        onProgress: (p) => {
          if (p.copiedFiles % 500 === 0 || p.copiedFiles === p.totalFiles) {
            log.info('[copy] %d/%d files', p.copiedFiles, p.totalFiles);
          }
        },
        log,
      });
      return r.ok ? { ok: true } : { ok: false, code: r.code, error: r.error };
    },
    openDb: async () => probeLocalDbs(newUserDataDir),
    verifySafeStorage: async () => probeSafeStorageReadable(newUserDataDir),
    relaunchLegacy: async () => {
      await relaunchLegacyFromOrigin(launchArgs);
    },
    // DB 内老 userData 绝对路径重写(§5 步骤 6,失败不阻塞):首版不启用,
    // 老目录永久保留兜底;后续按 telemetry 决定是否补定向重写。
    log,
  });
  if (!result.ok) {
    log.error('first-run health check failed at %s: %s — exiting to legacy app',
      result.failedStep, result.error);
    // 下次首启强制重拷:失败重入期间用户可能继续用老 app 产生增量。
    resetCopyJournal(newUserDataDir);
    return 'quit';
  }
  scheduleDelayedUninstallCheck(newUserDataDir);
  return 'continue';
}

/** 从首启参数或结构化 finalization 凭证回拉旧安装。 */
async function relaunchLegacyFromOrigin(origin: {
  legacyUserDataDir: string;
  sourceApp?: string;
  legacyInstallDir?: string;
  legacyUninstallDisplayNamePrefix?: string;
}): Promise<void> {
  const oldMarker = readMarker(path.join(origin.legacyUserDataDir, MARKER_REL_PATH));
  const launchArgs: MigratedLaunchArgs = {
    sourceApp: origin.sourceApp ?? oldMarker?.source.app ?? '',
    legacyUserDataDir: origin.legacyUserDataDir,
    ...(origin.legacyInstallDir != null ? { legacyInstallDir: origin.legacyInstallDir } : {}),
    ...(origin.legacyUninstallDisplayNamePrefix != null
      ? { legacyUninstallDisplayNamePrefix: origin.legacyUninstallDisplayNamePrefix }
      : {}),
  };
  if (launchArgs.sourceApp.length === 0) throw new Error('legacy app identity missing during rollback');
  const launchPath = resolveLegacyLaunchPath(launchArgs, oldMarker, process.platform);
  if (launchPath == null) throw new Error('legacy install directory missing during rollback');
  if (!(await spawnDetached(launchPath, []))) {
    throw new Error(`failed to spawn legacy app at ${maskPath(launchPath)}`);
  }
}

/** 等老 app 进程退出(自拷前置;老 app 拉起本进程后随即自杀,通常秒级)。 */
async function waitOldAppExit(launchArgs: MigratedLaunchArgs): Promise<void> {
  const oldMarker = readMarker(path.join(launchArgs.legacyUserDataDir, MARKER_REL_PATH));
  const imageName = resolveLegacyProcessName(launchArgs, oldMarker, process.platform);
  const deadline = Date.now() + WAIT_OLD_EXIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(await probeProcessRunning(imageName))) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`old app (${imageName}) still running after ${WAIT_OLD_EXIT_TIMEOUT_MS}ms`);
}

/**
 * openDb 探针:对新 userData 下的全部主库文件先以可写方式 checkpoint 复制来的 WAL,
 * 再跑 SQLite quick_check 做诊断。历史库损坏只告警，不阻断整机迁移；登录后的 ensureReady
 * 会对实际认领账号执行既有备份恢复 UX。无库文件(未登录用户)直接通过。
 */
async function probeLocalDbs(userDataDir: string): Promise<void> {
  const { default: Database } = await import('better-sqlite3');
  const warnings = probeMigrationLocalDbs(
    userDataDir,
    BRAND_IDENTITY.dbFilePrefix,
    (filePath) => new Database(filePath),
  );
  for (const warning of warnings) {
    log.warn('[migration-db-probe] %s; recovery deferred to ensureReady', warning);
  }
}

/**
 * verifySafeStorage 探针:safe-storage 下有 .enc 时,验证本机 safeStorage 后端可解密
 * 其一(win 校验 DPAPI 同用户可用;mac 校验交接重加密结果可读)。无 .enc
 * (从未存过密钥)直接通过。
 */
async function probeSafeStorageReadable(userDataDir: string): Promise<void> {
  const result = probeSafeStorageDirectory(userDataDir, {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    decryptFromBase64: (content) => {
      // .enc 编码契约:utf-8 文本,内容为 base64(encryptString(plain))。
      safeStorage.decryptString(Buffer.from(content, 'base64'));
    },
  });
  if (result.unreadableStores.length > 0) {
    log.warn(
      'safe-storage probe skipped %d/%d unreadable legacy stores: %s',
      result.unreadableStores.length,
      result.total,
      result.unreadableStores.join(', '),
    );
  }
}

// ── 延迟卸载(§5 缴械观察期) ─────────────────────────────────────────────

let uninstallCheckScheduled = false;

function scheduleDelayedUninstallCheck(newUserDataDir: string): void {
  if (uninstallCheckScheduled) return;
  uninstallCheckScheduled = true;
  const timer = setTimeout(() => {
    void runDelayedUninstallCheck(newUserDataDir).catch((err) => {
      log.warn('delayed uninstall check failed: %s', (err as Error).message);
    });
  }, UNINSTALL_CHECK_DELAY_MS);
  timer.unref();
}

async function runDelayedUninstallCheck(newUserDataDir: string): Promise<void> {
  const receipt = readReceipt(path.join(newUserDataDir, RECEIPT_REL_PATH));
  if (receipt == null) return;
  const oldMarker = readMarker(path.join(receipt.legacyUserDataDir, MARKER_REL_PATH));
  if (oldMarker == null || oldMarker.migrationId !== receipt.migrationId) {
    log.warn('delayed uninstall skipped: matching legacy migration marker is unavailable');
    return;
  }
  const legacyInstallDir = oldMarker.source.installDir;
  const legacyApp = oldMarker.source.app;
  const installIdentity = receipt.legacyInstallIdentity;
  if (installIdentity == null || !matchesLegacyInstallIdentity(legacyInstallDir, installIdentity)) {
    log.warn('delayed uninstall skipped: legacy install identity changed or is unavailable');
    return;
  }
  const oldAppRunning = await probeProcessRunning(
    process.platform === 'win32'
      ? `${legacyApp}.exe`
      : legacyApp,
  );

  const allowed = shouldUninstallOldApp({
    receipt,
    oldMarkerState: oldMarker?.state ?? null,
    oldAppRunning,
    nowMs: Date.now(),
  });
  if (!allowed) return;

  log.info('disarm window elapsed — uninstalling legacy app');
  if (process.platform === 'win32') {
    await uninstallLegacyWindows(
      oldMarker.source.uninstallDisplayNamePrefix,
      legacyInstallDir,
      installIdentity,
    );
  } else {
    uninstallLegacyMacOS(legacyInstallDir, installIdentity);
  }
}

/**
 * Windows 延迟卸载:只执行 DisplayName 前缀与 InstallLocation 精确匹配旧
 * marker 安装目录的唯一 QuietUninstallString；零/多候选均 fail closed。
 */
async function uninstallLegacyWindows(
  displayNamePrefix: string,
  legacyInstallDir: string,
  installIdentity: LegacyInstallIdentity,
): Promise<void> {
  const script = [
    '$ErrorActionPreference = "SilentlyContinue"',
    '$entries = @()',
    '$roots = @(',
    '  "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",',
    '  "HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",',
    '  "HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall")',
    'foreach ($root in $roots) {',
    '  Get-ChildItem $root | ForEach-Object {',
    '    $p = Get-ItemProperty $_.PSPath',
    '    $entries += [PSCustomObject]@{',
    '      displayName = [string]$p.DisplayName',
    '      installLocation = [string]$p.InstallLocation',
    '      quietUninstallString = [string]$p.QuietUninstallString',
    '    }',
    '  }',
    '}',
    'ConvertTo-Json -InputObject @($entries) -Compress',
  ].join('\n');
  const entries = await new Promise<WindowsUninstallEntry[]>((resolve) => {
    execFile(
      'powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 15_000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve([]);
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as WindowsUninstallEntry | WindowsUninstallEntry[];
          resolve(Array.isArray(parsed) ? parsed : [parsed]);
        } catch {
          resolve([]);
        }
      },
    );
  });
  const command = selectLegacyWindowsUninstallCommand(entries, {
    displayNamePrefix,
    installDir: legacyInstallDir,
  });
  if (command == null) {
    log.warn('legacy Windows uninstall skipped: no unique entry matched the install directory');
    return;
  }
  // 查询注册表后再次比对，缩小用户在检查与实际卸载之间重装应用的 TOCTOU 窗口。
  if (!matchesLegacyInstallIdentity(legacyInstallDir, installIdentity)) {
    log.warn('legacy Windows uninstall skipped: install identity changed before execution');
    return;
  }
  log.info('running quiet uninstall: %s', maskPath(command));
  const child = spawn(command, { shell: true, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

/** mac 延迟卸载:只删形如 *.app 的老 bundle,拒绝其它路径(防误删)。 */
function uninstallLegacyMacOS(
  legacyAppPath: string,
  installIdentity: LegacyInstallIdentity,
): void {
  if (!legacyAppPath.endsWith('.app')) {
    log.warn('legacy install dir %s is not a .app bundle — skip uninstall', maskPath(legacyAppPath));
    return;
  }
  const currentAppBundle = path.dirname(path.dirname(path.dirname(app.getAppPath())));
  if (path.resolve(legacyAppPath) === path.resolve(currentAppBundle)) {
    log.warn('legacy app path resolves to current app bundle — skip uninstall');
    return;
  }
  if (!matchesLegacyInstallIdentity(legacyAppPath, installIdentity)) {
    log.warn('legacy macOS uninstall skipped: install identity changed before deletion');
    return;
  }
  try {
    fs.rmSync(legacyAppPath, { recursive: true, force: true });
    log.info('removed legacy app bundle %s', maskPath(legacyAppPath));
  } catch (err) {
    log.warn('failed to remove legacy app: %s', (err as Error).message);
  }
}
