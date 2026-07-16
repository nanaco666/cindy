/**
 * migration/firstRun — 新 app(Cindy)首启健康检查与延迟卸载决策(§5)。
 *
 * 触发条件:启动参数带 `--migrated-from=<app> --legacy-user-data=<path>`
 * (老 app 执行窗口拉起时注入,评审 P1-4:老侧路径只从参数来,不硬编码推导)。
 *
 * 步骤(全部通过才 confirmed;任何一步失败 → 删新侧交接文件 → 老 marker 置
 * failed(带对应错误码)→ 自杀退出拉回老 app):
 *   0. 等老 app 进程退出(注入;老 app 拉起 Cindy 后随即自杀,通常秒级);
 *   1. B′ 自拷:老 userData → 新 userData(注入,userDataCopy.ts;
 *      已有 sentinel 的非首启不会走到这里,天然 install-only);
 *   2. localDb 打开探针(经注入的 openDb);
 *   3. (mac)交接文件导入(重加密,importHandoff);
 *   4. safe-storage 可解密探针(集成凭证完整性,非登录态);
 *   5. receipt → structured sentinel → 老 marker confirmed → 删两侧交接文件;
 *   6. DB 绝对路径重写(注入,失败不阻塞 confirmed);
 *
 * **健康检查 = 纯数据完整性验收,不含登录态**(2026-07-14 拍板:Cindy 1.0
 * 直接接新 auth server,老账号凭证对新 server 无效,登录不能作为迁移成败
 * 判据)。用户可见后果:首启 confirmed 后进入新账号系统登录页重新登录
 * (升级公告项),登录成功钩子里按身份锚认领老库(identityAnchor.ts 顶注);
 * 登录/认领失败不回滚迁移——数据已 confirmed,那是应用层流程。handoff
 * 仍保留:mac safe-storage 交接的是飞书/Slack 等第三方集成凭证(机器级,
 * 与账号系统无关),不交接才是真丢数据。
 *
 * 依赖全注入,零 Electron,可单测。编排层(bootstrap)负责:解析 argv、
 * 提供 electron safeStorage crypto、真实 openDb 探针、卸载执行。
 */

import path from 'node:path';
import { deleteHandoff, HANDOFF_REL_PATH, importHandoff, type HandoffCrypto } from './handoff';
import {
  readMarker,
  readReceipt,
  transitionMarker,
  writeJsonAtomic,
  writeReceipt,
} from './markerStore';
import type {
  LegacyInstallIdentity,
  MigrationErrorCode,
  MigrationReceipt,
  MigrationSentinel,
} from './types';
import fs from 'node:fs';
import { cleanMigrationPayloadFiles } from '../updateArtifacts';

export const FIRST_RUN_SENTINEL_REL_PATH = path.join('migration', 'first-run-ok');
export const RECEIPT_REL_PATH = path.join('migration', 'receipt.json');

/** 延迟卸载双条件(§5;评审确认的缴械观察期参数)。 */
export const UNINSTALL_MIN_DAYS_MS = 7 * 24 * 60 * 60_000;
export const UNINSTALL_MIN_HEALTHY_LAUNCHES = 3;

/** 读取结构化 sentinel；旧的纯文本/损坏内容一律视作不可信。 */
export function readFirstRunSentinel(filePath: string): MigrationSentinel | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as MigrationSentinel;
    if (parsed?.schemaVersion !== 1) return null;
    if (typeof parsed.migrationId !== 'string' || parsed.migrationId.length === 0) return null;
    if (typeof parsed.legacyUserDataDir !== 'string' || parsed.legacyUserDataDir.length === 0) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** sentinel 与 receipt 必须同在且 migrationId/老侧目录一致。 */
export function classifyFirstRunFinalization(
  hasSentinelFile: boolean,
  sentinel: MigrationSentinel | null,
  receipt: MigrationReceipt | null,
): 'none' | 'complete' | 'partial' {
  if (!hasSentinelFile && receipt == null) return 'none';
  if (
    hasSentinelFile &&
    sentinel != null &&
    receipt != null &&
    sentinel.migrationId === receipt.migrationId &&
    sentinel.legacyUserDataDir === receipt.legacyUserDataDir
  ) {
    return 'complete';
  }
  return 'partial';
}

export interface FirstRunFinalization {
  state: 'none' | 'complete' | 'partial';
  sentinel: MigrationSentinel | null;
  receipt: MigrationReceipt | null;
}

/** 从磁盘读取并交叉校验首启 finalization 两件套。 */
export function inspectFirstRunFinalization(userDataDir: string): FirstRunFinalization {
  const sentinelPath = path.join(userDataDir, FIRST_RUN_SENTINEL_REL_PATH);
  const receipt = readReceipt(path.join(userDataDir, RECEIPT_REL_PATH));
  const hasSentinelFile = fs.existsSync(sentinelPath);
  const sentinel = readFirstRunSentinel(sentinelPath);
  return {
    state: classifyFirstRunFinalization(hasSentinelFile, sentinel, receipt),
    sentinel,
    receipt,
  };
}

/** 老侧 reconcile 只接受与当前 marker migrationId 匹配的完整两件套。 */
export function hasCompletedFinalizationForMigration(
  userDataDir: string,
  migrationId?: string,
): boolean {
  const finalization = inspectFirstRunFinalization(userDataDir);
  return finalization.state === 'complete'
    && (migrationId == null || finalization.receipt?.migrationId === migrationId);
}

/** 只有已完成品牌迁移的新 profile 才允许按身份锚认领旧 UID 本地库。 */
export function hasCompletedMigrationReceipt(userDataDir: string): boolean {
  return hasCompletedFinalizationForMigration(userDataDir);
}

export interface FirstRunDeps {
  /** 新侧 userData 根。 */
  newUserDataDir: string;
  /** `--legacy-user-data` 传入的老侧 userData 根。 */
  legacyUserDataDir: string;
  /** `--legacy-install-dir` 传入的老 app 安装根；不依赖首启时 marker 仍存在。 */
  legacyInstallDir?: string;
  /** `--migrated-from` 传入的老 app 可执行身份。 */
  legacyApp?: string;
  /** `--legacy-uninstall-prefix` 传入的 Windows 老品牌卸载前缀。 */
  legacyUninstallDisplayNamePrefix?: string;
  /** 等旧进程退出前捕获的安装文件身份；缺失时延迟自动卸载 fail closed。 */
  legacyInstallIdentity?: LegacyInstallIdentity;
  /** mac 传新 app 的 safeStorage 后端;Windows 传 null(无交接环节)。 */
  handoffCrypto: HandoffCrypto | null;
  /** 等老 app 进程退出(超时抛错 → OLD_APP_WONT_EXIT);不传则跳过。 */
  waitOldAppExit?: () => Promise<void>;
  /** B′ 自拷(userDataCopy.runLegacyDataCopy 的闭包);不传则跳过(测试/未来共库场景)。 */
  copyLegacyData?: () =>
    | { ok: true }
    | {
        ok: false;
        code: 'COPY_FAILED' | 'INSUFFICIENT_DISK' | 'TARGET_PROFILE_EXISTS';
        error: string;
      };
  /** 打开主库探针;失败抛错。 */
  openDb: () => Promise<void>;
  /**
   * safe-storage 可解密探针(数据完整性,**非登录态校验**):win 验 DPAPI
   * 同用户可用、mac 验 handoff 重加密结果可读;失败抛错(消息进 lastError)。
   * 前身叫 verifyAuth——Cindy 1.0 接新 auth server 后登录态不再是迁移判据,
   * 但集成凭证(safe-storage)的可读性仍是"数据没白拷"的验收项。
   */
  verifySafeStorage: () => Promise<void>;
  /** DB 内老 userData 绝对路径重写(§4.1);失败仅告警不阻塞。 */
  rewriteAbsolutePaths?: () => Promise<void>;
  /** 健康检查失败且老 app 已退出时，主动拉回旧安装；失败只记日志。 */
  relaunchLegacy?: () => Promise<void>;
  /** receipt 持久化注入口；默认原子写盘，测试可注入故障。 */
  persistReceipt?: (filePath: string, receipt: MigrationReceipt) => void;
  /** marker 转移注入口；默认 transitionMarker，测试可注入写盘故障。 */
  transitionState?: typeof transitionMarker;
  log: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
  nowIso?: () => string;
}

export type FirstRunResult =
  | { ok: true; receipt: MigrationReceipt }
  | { ok: false; failedStep: string; error: string };

/** confirmed/receipt 已落盘后的幂等清理；Cindy 后续启动也会补调用，覆盖清理前崩溃。 */
export function cleanupConfirmedHandoffs(
  newUserDataDir: string,
  receipt: MigrationReceipt,
): void {
  deleteHandoff(path.join(newUserDataDir, HANDOFF_REL_PATH));
  if (typeof receipt.legacyUserDataDir === 'string' && receipt.legacyUserDataDir.length > 0) {
    deleteHandoff(path.join(receipt.legacyUserDataDir, HANDOFF_REL_PATH));
  }
}

export interface FirstRunFailureDeps {
  newUserDataDir: string;
  legacyUserDataDir: string;
  relaunchLegacy?: () => Promise<void>;
  transitionState?: typeof transitionMarker;
  log: FirstRunDeps['log'];
  nowIso?: () => string;
}

/**
 * 首启失败的统一回退：销毁两侧明文 handoff、把旧 marker 降级为 failed，
 * 再主动拉回旧安装。partial finalization 的恢复路径也复用此函数。
 */
export async function failFirstRunMigration(
  deps: FirstRunFailureDeps,
  failedStep: string,
  error: string,
  code: MigrationErrorCode = 'HEALTH_CHECK_FAILED',
): Promise<FirstRunResult> {
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const transitionState = deps.transitionState ?? transitionMarker;
  const oldMarkerPath = path.join(deps.legacyUserDataDir, 'migration', 'state.json');
  deps.log.error(`[migration-first-run] ${failedStep} failed: ${error}`);
  deleteHandoff(path.join(deps.newUserDataDir, HANDOFF_REL_PATH));
  deleteHandoff(path.join(deps.legacyUserDataDir, HANDOFF_REL_PATH));
  try {
    const r = transitionState(oldMarkerPath, {
      to: 'failed',
      by: 'new-app',
      nowIso: nowIso(),
      mutate: () => ({
        lastError: { code, message: `${failedStep}: ${error}`, at: nowIso() },
      }),
    });
    if (!r.ok) deps.log.warn(`[migration-first-run] failed-transition rejected: ${r.reason}`);
  } catch (markerError) {
    deps.log.warn(`[migration-first-run] failed-transition write failed: ${(markerError as Error).message}`);
  }
  if (failedStep !== 'wait-old-exit' && deps.relaunchLegacy) {
    try {
      await deps.relaunchLegacy();
    } catch (relaunchError) {
      deps.log.error(`[migration-first-run] legacy relaunch failed: ${(relaunchError as Error).message}`);
    }
  }
  return { ok: false, failedStep, error };
}

/** 新 app 首启健康检查主流程。 */
export async function runFirstRunHealthCheck(deps: FirstRunDeps): Promise<FirstRunResult> {
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const transitionState = deps.transitionState ?? transitionMarker;
  const oldMarkerPath = path.join(deps.legacyUserDataDir, 'migration', 'state.json');

  const fail = async (
    failedStep: string,
    error: string,
    code: MigrationErrorCode = 'HEALTH_CHECK_FAILED',
  ): Promise<FirstRunResult> => {
    return failFirstRunMigration(deps, failedStep, error, code);
  };

  // 0. 等老 app 退出(自拷前置:拷贝窗口内老侧必须无写入者)
  if (deps.waitOldAppExit) {
    try {
      await deps.waitOldAppExit();
    } catch (err) {
      return await fail('wait-old-exit', (err as Error).message, 'OLD_APP_WONT_EXIT');
    }
  }

  // 1. B′ 自拷:老 userData → 新 userData(journal 幂等,半途崩溃整体重拷)
  if (deps.copyLegacyData) {
    const copied = deps.copyLegacyData();
    if (!copied.ok) {
      return await fail('copy-data', copied.error, copied.code);
    }
  }

  // 2. 主库可用
  try {
    await deps.openDb();
  } catch (err) {
    return await fail('open-db', (err as Error).message);
  }

  // 3. (mac)交接导入;交接文件不存在但平台需要它 → 失败(数据不完整)
  if (deps.handoffCrypto != null) {
    const imported = importHandoff({ newUserDataDir: deps.newUserDataDir, crypto: deps.handoffCrypto });
    if (!imported.ok) {
      return await fail('handoff-import', imported.error ?? 'unknown');
    }
    if (imported.driftWarnings.length > 0) {
      deps.log.warn(`[migration-first-run] handoff drift (imported anyway): ${imported.driftWarnings.join(', ')}`);
    }
    if (imported.pathWarnings.length > 0) {
      deps.log.warn(`[migration-first-run] handoff paths rejected: ${imported.pathWarnings.join(', ')}`);
    }
  }

  // 4. safe-storage 可解密(集成凭证完整性;登录态验收已移出——见顶注)
  try {
    await deps.verifySafeStorage();
  } catch (err) {
    return await fail('verify-safe-storage', (err as Error).message);
  }

  // 5. receipt → sentinel → confirmed → 删两侧交接
  const sentinelPath = path.join(deps.newUserDataDir, FIRST_RUN_SENTINEL_REL_PATH);
  const oldMarker = readMarker(oldMarkerPath);
  if (oldMarker == null) {
    // 无可信 migrationId/source/target 时不能制造 confirmed；拉回旧 app 继续使用老数据。
    return await fail('confirm-marker', 'legacy migration marker missing or corrupt');
  }
  const receipt: MigrationReceipt = {
    schemaVersion: 1,
    migrationId: oldMarker.migrationId,
    legacyUserDataDir: deps.legacyUserDataDir,
    legacyApp: deps.legacyApp ?? oldMarker.source.app,
    legacyInstallDir: deps.legacyInstallDir ?? oldMarker.source.installDir,
    legacyUninstallDisplayNamePrefix: deps.legacyUninstallDisplayNamePrefix
      ?? oldMarker.source.uninstallDisplayNamePrefix,
    legacyInstallIdentity: deps.legacyInstallIdentity,
    confirmedAt: nowIso(),
    healthyLaunchCount: 1,
  };
  const receiptPath = path.join(deps.newUserDataDir, RECEIPT_REL_PATH);
  try {
    fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
    (deps.persistReceipt ?? writeReceipt)(receiptPath, receipt);
    writeJsonAtomic(sentinelPath, {
      schemaVersion: 1,
      migrationId: receipt.migrationId,
      legacyUserDataDir: receipt.legacyUserDataDir,
    } satisfies MigrationSentinel);
  } catch (err) {
    // finalization 只有 sentinel + receipt 都落盘才算成功；否则清掉任一半成品，
    // 进入统一失败路径拉回老 app，避免下次启动被 sentinel 误判为已确认。
    for (const partialPath of [sentinelPath, receiptPath]) {
      try {
        fs.rmSync(partialPath, { force: true });
      } catch (cleanupError) {
        deps.log.warn(`[migration-first-run] failed to remove partial finalization file: ${(cleanupError as Error).message}`);
      }
    }
    return await fail('persist-finalization', (err as Error).message);
  }

  let confirmed;
  try {
    confirmed = transitionState(oldMarkerPath, {
      to: 'confirmed',
      by: 'new-app',
      nowIso: nowIso(),
      mutate: () => ({ lastError: null }),
    });
  } catch (err) {
    for (const partialPath of [sentinelPath, receiptPath]) {
      try { fs.rmSync(partialPath, { force: true }); } catch { /* best-effort */ }
    }
    return await fail('confirm-marker', (err as Error).message);
  }
  if (!confirmed.ok) {
    if (readMarker(oldMarkerPath) == null) {
      for (const partialPath of [sentinelPath, receiptPath]) {
        try { fs.rmSync(partialPath, { force: true }); } catch { /* best-effort */ }
      }
      return await fail('confirm-marker', confirmed.reason ?? 'marker disappeared before confirmation');
    }
    // 非 launched 前驱(如老 app 崩在 launched 写盘前)——sentinel 已落盘,老 app 的
    // reconcile 铁律会以新侧为准置 confirmed,这里只记日志不失败。
    deps.log.warn(`[migration-first-run] confirmed-transition rejected (${confirmed.reason}); old app will reconcile via sentinel`);
  }
  cleanupConfirmedHandoffs(deps.newUserDataDir, receipt);
  cleanMigrationPayloadFiles(deps.legacyUserDataDir);

  // 6. 绝对路径重写(失败不阻塞:老目录永久保留兜底)
  if (deps.rewriteAbsolutePaths) {
    try {
      await deps.rewriteAbsolutePaths();
    } catch (err) {
      deps.log.warn(`[migration-first-run] path rewrite failed (non-blocking): ${(err as Error).message}`);
    }
  }

  deps.log.info('[migration-first-run] health check passed, migration confirmed');
  return { ok: true, receipt };
}

export interface HealthyLaunchRecordDeps {
  persistReceipt?: typeof writeReceipt;
  onError?: (error: Error) => void;
}

/** 非首启的健康启动:receipt 计数 +1(延迟卸载条件之一)。写失败不得阻断启动。 */
export function recordHealthyLaunch(
  newUserDataDir: string,
  deps: HealthyLaunchRecordDeps = {},
): void {
  const receiptPath = path.join(newUserDataDir, RECEIPT_REL_PATH);
  const receipt = readReceipt(receiptPath);
  if (receipt == null) return;
  try {
    (deps.persistReceipt ?? writeReceipt)(receiptPath, {
      ...receipt,
      healthyLaunchCount: receipt.healthyLaunchCount + 1,
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    // 错误报告本身也不能把纯 bookkeeping 失败升级成启动失败。
    try { deps.onError?.(error); } catch { /* best-effort */ }
  }
}

export interface UninstallDecisionInput {
  receipt: MigrationReceipt | null;
  /** 老侧 marker 当前状态(读不到传 null)。 */
  oldMarkerState: string | null;
  /** 老 app 进程是否在跑(跳板可能正活着,评审 P2-3)。 */
  oldAppRunning: boolean;
  nowMs: number;
}

/**
 * 延迟卸载决策(§5):缴械观察期双条件 + fallback 逃生舱保护 + 老进程保护。
 * 返回 true 才允许执行 QuietUninstallString / 删老 .app。
 */
export function shouldUninstallOldApp(input: UninstallDecisionInput): boolean {
  const { receipt } = input;
  if (receipt == null) return false;
  const confirmedMs = Date.parse(receipt.confirmedAt);
  if (!Number.isFinite(confirmedMs)) return false;
  if (input.nowMs - confirmedMs < UNINSTALL_MIN_DAYS_MS) return false;
  if (receipt.healthyLaunchCount < UNINSTALL_MIN_HEALTHY_LAUNCHES) return false;
  // marker 是本次迁移仍拥有旧安装的归属凭证。缺失时用户可能已重新安装旧 app，
  // receipt 里的历史路径不足以证明归属，必须 fail closed。
  if (input.oldMarkerState !== 'confirmed') return false;
  if (input.oldAppRunning) return false;
  return true;
}

/** Windows 卸载注册表候选的最小字段。 */
export interface WindowsUninstallEntry {
  displayName?: string;
  installLocation?: string;
  quietUninstallString?: string;
}

/** Windows 旧安装的精确匹配条件。 */
export interface LegacyWindowsUninstallIdentity {
  displayNamePrefix: string;
  installDir: string;
}

/**
 * 只选择“品牌前缀 + 精确安装目录”均匹配的唯一卸载命令。零或多候选都
 * fail closed，避免同品牌组件或后来重装到其它位置的应用被批量卸载。
 */
export function selectLegacyWindowsUninstallCommand(
  entries: readonly WindowsUninstallEntry[],
  identity: LegacyWindowsUninstallIdentity,
): string | null {
  const expectedPrefix = identity.displayNamePrefix.trim().toLocaleLowerCase('en-US');
  const expectedInstallDir = normalizeWindowsInstallDir(identity.installDir);
  if (!expectedPrefix || !expectedInstallDir) return null;
  const matches = entries.filter((entry) => {
    const displayName = entry.displayName?.trim().toLocaleLowerCase('en-US') ?? '';
    const installDir = normalizeWindowsInstallDir(entry.installLocation ?? '');
    const command = entry.quietUninstallString?.trim() ?? '';
    return displayName.startsWith(expectedPrefix)
      && installDir === expectedInstallDir
      && command.length > 0;
  });
  return matches.length === 1 ? matches[0].quietUninstallString!.trim() : null;
}

function normalizeWindowsInstallDir(value: string): string {
  const trimmed = value.trim().replace(/^"(.*)"$/, '$1');
  if (!path.win32.isAbsolute(trimmed)) return '';
  return path.win32.normalize(trimmed).replace(/[\\/]+$/, '').toLocaleLowerCase('en-US');
}
