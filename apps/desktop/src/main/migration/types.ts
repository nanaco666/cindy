/**
 * migration/types — 品牌迁移 marker 状态机的共享契约类型(schema v1,B′ 方案)。
 *
 * 两方(老 app 过渡版 / 新 app Cindy)读写同一份
 * `<old-userData>/migration/state.json`,本文件是唯一类型来源。
 *
 * B′ 方案(2026-07-13 拍板)要点:没有独立迁移执行器——Cindy 装到**不同
 * 安装目录**,与老 app 零文件冲突,安装 + 拉起由老 app 进程内同步完成;
 * userData 拷贝(xdt-maker → Cindy)由 **Cindy 首启自拷**(单写入者,
 * 半途崩溃即整体重拷),因此跨进程锁 / 心跳 / 接管判定整体不存在。
 *
 * ⚠️ 契约稳定性:schemaVersion 只增不改,字段只加不删不重命名——发布后
 * 用户机器上可能长期存在旧版本写出的 marker,读取方必须容忍未知字段。
 * 完整设计:docs/cindy-rebrand/migration-state-machine.md §3。
 */

/** marker 状态全集。语义与转移规则见 transitions.ts 的写入者矩阵。 */
export type MigrationState =
  | 'staged'          // Cindy 完整包下载 + sha256 校验通过
  | 'handoff_ready'   // (mac)safeStorage 交接文件已导出;Win 无条件推进
  | 'installed'       // 老 app 已静默安装 Cindy 且落位验证通过(expectFile 存在)
  | 'launched'        // 老 app 已拉起 Cindy(随即自杀;等 Cindy 首启确认)
  | 'confirmed'       // Cindy 首启自拷 + 健康检查通过(终态;跳板期可转 fallback_active)
  | 'failed'          // 某一步失败,等待老 app 重入重试
  | 'fallback_active';// 跳板拉起新 app 失败,老 app 以逃生舱模式运行

/** marker 的两类合法写入者(B′ 无执行器,migrator 角色不存在)。 */
export type MigrationWriter = 'old-app' | 'new-app';

/** 迁移过程的标准错误码(lastError.code)。 */
export type MigrationErrorCode =
  | 'HANDOFF_EXPORT_FAILED'
  | 'OLD_APP_WONT_EXIT'
  | 'INSTALL_FAILED'
  | 'COPY_FAILED'
  | 'INSUFFICIENT_DISK'
  | 'TARGET_PROFILE_EXISTS'
  | 'LAUNCH_FAILED'
  | 'HEALTH_CHECK_FAILED';

/** 迁移来源侧(老 app)的身份快照,由过渡版在 stage 时写入。 */
export interface MigrationSourceInfo {
  app: string;
  version: string;
  installDir: string;
  userDataDir: string;
  /** Windows 卸载注册表条目 DisplayName 前缀,新 app 定位老卸载键用。 */
  uninstallDisplayNamePrefix: string;
}

/** 迁移目标侧(新 app)的身份与产物信息。 */
export interface MigrationTargetInfo {
  app: string;
  /** 重入时与当前构建期望版本比对,不符则作废 payload 重新 stage(§3.3)。 */
  version: string;
  payloadPath: string;
  payloadSha256: string;
  installDir: string;
  userDataDir: string;
  exeName: string;
}

/** (mac)safeStorage 交接文件的登记信息;Windows 恒为 null。 */
export interface MigrationHandoffInfo {
  path: string;
  createdAt: string;
  sha256: string;
}

export interface MigrationError {
  code: MigrationErrorCode;
  message: string;
  at: string;
}

/** 首启完成凭证中的新侧哨兵；必须与 receipt 使用同一个 migrationId。 */
export interface MigrationSentinel {
  schemaVersion: 1;
  migrationId: string;
  legacyUserDataDir: string;
}

/**
 * 迁移首启时捕获的旧安装可执行文件身份。延迟卸载只接受同一个文件对象；
 * 路径相同但被重装/覆盖后的应用必须 fail closed。
 */
export interface LegacyInstallIdentity {
  schemaVersion: 1;
  /** 相对旧安装根的 POSIX 风格路径，读取时仍需做越界校验。 */
  executableRelativePath: string;
  dev: string;
  ino: string;
  size: string;
  mtimeNs: string;
  birthtimeNs: string;
}

/** `<old-userData>/migration/state.json` 的完整形状(schema v1)。 */
export interface MigrationMarker {
  schemaVersion: 1;
  /** 一场迁移一个 uuid,重试不换;换目标版本重 stage 时也保持不变。 */
  migrationId: string;
  state: MigrationState;
  /** 真失败重试次数(纯中断重入不计,见 startupDecision.ts)。 */
  attempt: number;
  maxAttempts: number;
  /** 最近一次写入时间。 */
  updatedAt: string;
  updatedBy: MigrationWriter;
  source: MigrationSourceInfo;
  target: MigrationTargetInfo;
  handoff: MigrationHandoffInfo | null;
  lastError: MigrationError | null;
}

/** `<new-userData>/migration/receipt.json`:新 app 健康启动凭证与计数。 */
export interface MigrationReceipt {
  schemaVersion: 1;
  migrationId: string;
  legacyUserDataDir: string;
  /** 首启参数中的老 app 可执行身份，仅作兼容/诊断；不单独授权延迟卸载。 */
  legacyApp?: string;
  /** 首启参数中的老 app 安装根；路径本身不证明安装归属。 */
  legacyInstallDir?: string;
  /** Windows 老品牌卸载前缀，仅作兼容/诊断；卸载仍要求匹配老 marker。 */
  legacyUninstallDisplayNamePrefix?: string;
  /** 延迟卸载的安装归属凭证；缺失或与当前文件身份不一致时永久跳过自动卸载。 */
  legacyInstallIdentity?: LegacyInstallIdentity;
  confirmedAt: string;
  /** 健康启动累计次数;与 confirmedAt 一起构成延迟卸载双条件(§5)。 */
  healthyLaunchCount: number;
}

/** 默认自动重试上限(真失败计数,纯中断重入不计)。 */
export const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * in-progress 状态集合:老 app 上一实例执行到一半(installed)或已把控制权
 * 交给 Cindy(launched)。老 app 重启后仅当 Cindy 进程不在跑时才允许重入
 * (Cindy 首启自拷期间进程必然存活,进程探测即活性判定,无需锁/心跳)。
 */
export const IN_PROGRESS_STATES: readonly MigrationState[] = Object.freeze([
  'installed',
  'launched',
]);
