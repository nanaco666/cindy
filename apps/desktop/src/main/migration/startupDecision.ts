/**
 * migration/startupDecision — 老 app(过渡版)启动时的迁移决策(§3.4,B′)。
 *
 * 纯函数:输入是 marker + 新侧进程探测结果,输出一个明确的动作指令,由
 * orchestration 层执行。B′ 下没有执行器,活性判定只剩一条:**Cindy 进程
 * 是否在跑**(首启自拷期间进程必然存活,进程探测即活性;无锁 / 心跳 /
 * 30 分钟粗筛)。评审确认的规则:
 *  - finalization 铁律:新侧有与 marker 匹配的 receipt + sentinel 时以新侧为准,
 *    禁止任何破坏
 *    (fallback_active 豁免:它是 confirmed 之后的已知状态,出路是重装);
 *  - staged/installed 的纯中断重入不计 attempt;launched 后目标消失且无
 *    sentinel 说明交棒失败,必须计入预算防止坏包无限循环;
 *  - payload 版本作废:marker 里的目标版本 ≠ 当前期望 → 优先于 give-up 重新 stage，
 *    并由 stage 重置旧版本消耗的 attempt。
 */

import {
  IN_PROGRESS_STATES,
  type MigrationMarker,
} from './types';

/** 决策输入。全部由 orchestration 层探测好传入,本模块零 IO。 */
export interface StartupDecisionInput {
  marker: MigrationMarker | null;
  /** 新侧(Cindy)进程探测:进程枚举命中即 true。 */
  cindyRunning: boolean;
  /** 新侧 userData 是否存在与当前 migrationId 匹配的完整 finalization。 */
  newSideSentinel: boolean;
  /** 当前构建期望的 Cindy 目标版本(brand/release 配置注入)。 */
  expectedTargetVersion: string;
}

export type StartupDecision =
  /** 无迁移上下文,正常启动(未到迁移窗口或本机不参与)。 */
  | { kind: 'none' }
  /** marker=confirmed:跳板模式(探测→拉起→验证;失败走 fallback 转移)。 */
  | { kind: 'trampoline' }
  /** fallback 逃生舱:先重试跳板,失败则本次以老 app 正常运行。 */
  | { kind: 'fallback-retry' }
  /** 新侧已有完整 finalization 而 marker 未 confirmed:以新侧为准,置 confirmed 后转跳板。 */
  | { kind: 'reconcile-confirm' }
  /** 从头/断点重入迁移。countAttempt=true 表示真失败(attempt+1)。 */
  | { kind: 'retry'; countAttempt: boolean; restage: boolean }
  /** Cindy 正在跑(首启自拷/确认中):不介入,老 app 正常运行等它确认。 */
  | { kind: 'wait'; reason: string }
  /** 自动重试预算耗尽:UI 报错 + 日志路径,等人工/热更修复(不抑制热更)。 */
  | { kind: 'give-up' };

export function decideStartupAction(input: StartupDecisionInput): StartupDecision {
  const { marker } = input;
  if (marker == null) return { kind: 'none' };

  // 铁律最优先:新侧已健康启用过,一切以新侧为准(含 §5 中两件 finalization 凭证
  // 落盘后、confirmed 回写前崩溃的常规窗口)。
  // fallback_active 豁免:它是 confirmed 之后的已知状态,凭证存在是预期
  // 而非分歧——拉回 confirmed 只会跳板再失败空转,出路是 §3.4 的重装重入。
  if (
    input.newSideSentinel &&
    marker.state !== 'confirmed' &&
    marker.state !== 'fallback_active'
  ) {
    return { kind: 'reconcile-confirm' };
  }

  switch (marker.state) {
    case 'confirmed':
      return { kind: 'trampoline' };
    case 'fallback_active':
      return { kind: 'fallback-retry' };
    case 'staged':
    case 'handoff_ready': {
      // stage/handoff 完成但尚未进入执行窗口——这两个状态始终归老 app 所有,
      // 正常继续编排;目标版本已过期则重下。
      const restage = marker.target.version !== input.expectedTargetVersion;
      return { kind: 'retry', countAttempt: false, restage };
    }
    case 'failed': {
      const restage = marker.target.version !== input.expectedTargetVersion;
      // 新 payload 是独立修复通道：版本变化必须先于旧版本的 give-up 判定，
      // 并由 stage 重置 attempt，重新给修正版一份完整预算。
      if (restage) return { kind: 'retry', countAttempt: false, restage: true };
      if (marker.attempt >= marker.maxAttempts) return { kind: 'give-up' };
      // failed 必然带 lastError(写 failed 的一方同时写错误);防御:缺失时
      // 仍按真失败计数,宁可少试不可无限重试。
      return { kind: 'retry', countAttempt: true, restage };
    }
    default:
      break;
  }

  // in-progress(installed/launched):上一实例执行到一半死了,或 Cindy 尚在
  // 首启确认中。Cindy 进程在跑 → 不介入;不在跑 → 立即重入(B′ 下不存在
  // 第三方执行器,无需 stale 时限等待)。
  if ((IN_PROGRESS_STATES as readonly string[]).includes(marker.state)) {
    if (input.cindyRunning) return { kind: 'wait', reason: 'target app running' };
    // installed 可能只是老 app 在 launch 前被强杀,不计预算；launched 已确认
    // spawn 成功,此后目标消失且无 sentinel/failed 回写就是一次交棒失败。
    const countAttempt = marker.state === 'launched' || marker.lastError != null;
    const restage = marker.target.version !== input.expectedTargetVersion;
    if (restage) return { kind: 'retry', countAttempt: false, restage: true };
    if (countAttempt && marker.attempt >= marker.maxAttempts) return { kind: 'give-up' };
    return { kind: 'retry', countAttempt, restage };
  }

  // 未知状态(未来 schema 扩展):保守不介入。
  return { kind: 'wait', reason: `unknown state "${marker.state}"` };
}
