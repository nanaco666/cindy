/**
 * migration/trampoline — confirmed 后跳板模式的拉起判定(§3.4,评审 P0-1)。
 *
 * 必现竞态:Cindy 已在运行时用户点老快捷方式,跳板 spawn 的第二个 Cindy 实例
 * 会因单实例锁**立即让位退出**——朴素的"进程还活着吗"验证必然误判为拉起
 * 失败,把用户推进 fallback,而 Cindy 正在另一边跑,双开分叉。
 *
 * 判定流程(纯函数,探测由编排层注入):
 *   1. spawn 前探测:Cindy 已在运行 → 直接成功,不 spawn;
 *   2. spawn 后短窗观察:进程存活 → 成功;
 *   3. 进程短时退出 → **再探测一次**:系统中有 Cindy 在跑 = 单实例让位,
 *      视为成功;确实没有 → 真失败,进 fallback_active。
 */

/** 一次跳板尝试的观测输入(全部由编排层探测好传入)。 */
export interface TrampolineObservation {
  /** spawn 前:Cindy 是否已在运行(进程枚举 / 单实例锁探测)。 */
  alreadyRunningBefore: boolean;
  /** spawn 结果:进程在观察窗内保持存活,还是短时退出。null = 未执行 spawn。 */
  spawnOutcome: 'alive' | 'exited' | 'spawn-error' | null;
  /** spawn 短时退出后复测:系统中是否有 Cindy 进程(让位判定,评审 P0-1)。 */
  runningAfterExit: boolean;
}

export type TrampolineOutcome =
  /** Cindy 已在运行(spawn 前命中),跳板静默退出。 */
  | { kind: 'success'; via: 'already-running' }
  /** spawn 的进程存活验证通过。 */
  | { kind: 'success'; via: 'spawned' }
  /** spawn 的实例因单实例锁让位退出,但 Cindy 确在运行。 */
  | { kind: 'success'; via: 'yielded-to-running-instance' }
  /** 确认拉不起来:转 fallback_active,老 app 以逃生舱模式运行。 */
  | { kind: 'fallback'; reason: string };

export function decideTrampolineOutcome(obs: TrampolineObservation): TrampolineOutcome {
  if (obs.alreadyRunningBefore) return { kind: 'success', via: 'already-running' };

  switch (obs.spawnOutcome) {
    case 'alive':
      return { kind: 'success', via: 'spawned' };
    case 'exited':
      if (obs.runningAfterExit) {
        // 竞窗:探测(1)与 spawn 之间 Cindy 恰好起来了,新实例让位退出。
        return { kind: 'success', via: 'yielded-to-running-instance' };
      }
      return { kind: 'fallback', reason: 'spawned process exited and no running instance found' };
    case 'spawn-error':
      return { kind: 'fallback', reason: 'spawn failed (binary missing or not executable)' };
    case null:
      // 未 spawn 且 spawn 前探测未命中——编排层逻辑错误,保守进 fallback。
      return { kind: 'fallback', reason: 'no spawn attempted and target not running' };
    default:
      return { kind: 'fallback', reason: 'unknown spawn outcome' };
  }
}
