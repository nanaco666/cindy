/**
 * migration/stage — 过渡版的迁移准备编排:下载 Cindy 完整包 → `staged` →
 * (mac)导出交接文件 → `handoff_ready`(§3.3 前两个转移)。
 *
 * 职责边界:本模块只推进 marker 到 handoff_ready(此后才允许 UX 弹"重启完成
 * 升级");spawn 执行器、热更抑制、bootstrap 接线在编排服务层(依赖 Electron,
 * 单独实现)。下载复用 unified-downloader(resolve 即 sha256 已验证),经
 * 注入便于测试。
 *
 * 幂等语义(§3.4 重入):
 *  - 每次重入都经过 unified-downloader；在盘文件会先重算 sha256，匹配才走
 *    本地 fast path，不匹配则重新下载，避免复用 staging 后损坏的 payload;
 *  - 版本不符(老渠道发过 N+2)→ 作废重下、重写 target 并重置旧包 attempt(评审 P1-5);
 *  - handoff 每次进入前无条件重新导出(评审 P1-3),Windows 传 null crypto
 *    直接推进。
 */

import path from 'node:path';
import {
  HANDOFF_REL_PATH,
  deleteHandoff,
  exportHandoffSnapshot,
  type HandoffCrypto,
} from './handoff';
import { transitionMarker } from './markerStore';
import { cleanMigrationPayloadFiles } from '../updateArtifacts';
import type {
  MigrationMarker,
  MigrationSourceInfo,
  MigrationTargetInfo,
} from './types';
import { DEFAULT_MAX_ATTEMPTS } from './types';

/** 下载依赖(unified-downloader 门面的最小切面)。resolve 即 sha256 校验通过。 */
export type StageDownloadFn = (args: {
  url: string;
  targetPath: string;
  sha256: string;
}) => Promise<unknown>;

export interface StagePayloadSpec {
  /** Cindy 完整包下载地址(老渠道 manifest 的 migration 块下发,见任务 #8)。 */
  url: string;
  sha256: string;
  version: string;
}

export interface StageMigrationArgs {
  markerPath: string;
  source: MigrationSourceInfo;
  /** 目标身份(payloadPath 由本函数按下载落点填写)。 */
  target: Omit<MigrationTargetInfo, 'payloadPath' | 'payloadSha256' | 'version'>;
  payload: StagePayloadSpec;
  /** 下载落点(老 userData 的 updates/ 下,随排除清单不被拷到新侧)。 */
  payloadTargetPath: string;
  download: StageDownloadFn;
  /**
   * mac 传 safeStorage 加密后端;Windows 传 null(DPAPI 无需交接,直接推进)。
   */
  handoffCrypto: HandoffCrypto | null;
  /** handoff 内容读取注入口；默认 readFileSync，测试可注入 AV/权限故障。 */
  readHandoffContent?: (filePath: string) => string;
  /** marker 写入注入点；用于验证最终 ready 写盘失败的清理契约。 */
  transitionState?: typeof transitionMarker;
  newMigrationId: () => string;
  /** 真失败重入(startupDecision 判 countAttempt)时置 true:staged 写回时 attempt+1。 */
  bumpAttempt?: boolean;
  nowIso?: () => string;
}

export type StageMigrationResult =
  | { ok: true; marker: MigrationMarker }
  | { ok: false; step: 'download' | 'stage' | 'handoff'; error: string };

/**
 * 把迁移推进到 handoff_ready。可从任意合法起点(无 marker / failed / staged /
 * fallback_active)重入;非法起点(in-progress)由转移矩阵拒绝并原样返回错误,
 * 调用方应先过 startupDecision 决策,不要盲调。
 */
export async function stageMigration(args: StageMigrationArgs): Promise<StageMigrationResult> {
  const nowIso = args.nowIso ?? (() => new Date().toISOString());
  const transitionState = args.transitionState ?? transitionMarker;

  // ── 1. 确保 payload 就位。即使 marker 元数据与文件路径完全匹配，也必须
  // 重新进入 downloader 的本地 sha256 fast path；文件可能在 staging 后损坏。
  // downloader resolve 的契约即“目标文件已通过 sha256 校验”。
  cleanMigrationPayloadFiles(args.source.userDataDir, args.payloadTargetPath);
  try {
    await args.download({
      url: args.payload.url,
      targetPath: args.payloadTargetPath,
      sha256: args.payload.sha256,
    });
  } catch (err) {
    // 下载失败不写 marker(§3.3:staged 之前无状态),静默等下轮重试。
    return { ok: false, step: 'download', error: (err as Error).message };
  }

  // ── 2. staged(创建或重写 marker;migrationId 一场迁移一个,重试不换)
  const stagedResult = transitionState(args.markerPath, {
    to: 'staged',
    by: 'old-app',
    nowIso: nowIso(),
    create: () => ({
      schemaVersion: 1,
      migrationId: args.newMigrationId(),
      state: 'staged',
      attempt: 0,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      updatedAt: nowIso(),
      updatedBy: 'old-app',
      source: args.source,
      target: {
        ...args.target,
        version: args.payload.version,
        payloadPath: args.payloadTargetPath,
        payloadSha256: args.payload.sha256,
      },
      handoff: null,
      lastError: null,
    }),
    mutate: (current) => ({
      source: args.source,
      target: {
        ...args.target,
        version: args.payload.version,
        payloadPath: args.payloadTargetPath,
        payloadSha256: args.payload.sha256,
      },
      lastError: null,
      // 同版本重入保留并按真实失败递增；新 payload 版本是独立修复通道，
      // 重置预算，避免旧坏包 give-up 后永远无法恢复。
      attempt: current != null && current.target.version !== args.payload.version
        ? 0
        : (current?.attempt ?? 0) + (args.bumpAttempt ? 1 : 0),
    }),
  });
  if (!stagedResult.ok) {
    return { ok: false, step: 'stage', error: stagedResult.reason ?? 'illegal transition' };
  }

  // ── 3. handoff:mac 无条件重新导出;win 直接推进(handoff=null)
  let handoffInfo: MigrationMarker['handoff'] = null;
  const failHandoff = (error: string): StageMigrationResult => {
    // export 成功后的任何后续失败都不能把 plaintextB64 留给仍在运行的旧 app；
    // retry 会重新导出，删除不存在的文件也是幂等 no-op。
    deleteHandoff(path.join(args.source.userDataDir, HANDOFF_REL_PATH));
    try {
      transitionState(args.markerPath, {
        to: 'failed',
        by: 'old-app',
        nowIso: nowIso(),
        mutate: () => ({
          lastError: {
            code: 'HANDOFF_EXPORT_FAILED',
            message: error,
            at: nowIso(),
          },
        }),
      });
    } catch {
      // 返回契约优先；marker 写失败由下一轮从盘上事实重新决策。
    }
    return { ok: false, step: 'handoff', error };
  };
  if (args.handoffCrypto != null) {
    try {
      const exported = exportHandoffSnapshot({
        userDataDir: args.source.userDataDir,
        crypto: args.handoffCrypto,
        sourceApp: args.source.app,
        sourceVersion: args.source.version,
        nowIso: nowIso(),
        readHandoffContent: args.readHandoffContent,
      });
      if (!exported.ok) {
        return failHandoff(exported.error ?? 'handoff export failed');
      }
      handoffInfo = exported.info;
    } catch (err) {
      return failHandoff((err as Error).message);
    }
  }

  try {
    const readyResult = transitionState(args.markerPath, {
      to: 'handoff_ready',
      by: 'old-app',
      nowIso: nowIso(),
      mutate: () => ({ handoff: handoffInfo }),
    });
    if (!readyResult.ok) {
      return failHandoff(readyResult.reason ?? 'illegal transition');
    }
    return { ok: true, marker: readyResult.marker! };
  } catch (err) {
    return failHandoff((err as Error).message);
  }
}
