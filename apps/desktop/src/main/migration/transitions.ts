/**
 * migration/transitions — marker 状态机的合法写入者矩阵(§3.3,B′ 方案)。
 *
 * 每次状态写入前必须过 isLegalTransition:当前 state 是目标转移的合法前驱、
 * 且写入方是该转移的合法执行者,否则放弃写入(防两方并发下的状态回跳 /
 * attempt 覆盖)。矩阵是纯数据 + 纯函数,便于穷举单测。
 *
 * B′ 执行链条:staged → handoff_ready → installed → launched 全部由老 app
 * 进程内推进(安装到不同目录,无文件冲突,无需第三方执行器);confirmed 由
 * Cindy 首启自拷 + 健康检查通过后回写。
 */

import type { MigrationState, MigrationWriter } from './types';

/** 一条合法转移:谁(writer)可以把 marker 从哪些前驱(from)写成 to。 */
interface TransitionRule {
  to: MigrationState;
  writer: MigrationWriter;
  /** null 表示"marker 不存在"也是合法前驱(首次 stage)。 */
  from: readonly (MigrationState | null)[];
}

const FAILABLE_STATES: readonly MigrationState[] = [
  'staged', 'handoff_ready', 'installed', 'launched',
];

/**
 * 合法转移全集。同一 to 可有多条规则(不同 writer / 前驱组)。
 * 铁律例外(sentinel override)不在矩阵内,见 isLegalTransition 参数。
 */
const RULES: readonly TransitionRule[] = [
  // 老 app:首次 stage / 失败重入 / 重新 stage(payload 版本作废)/ fallback 降级重入
  { to: 'staged', writer: 'old-app', from: [null, 'failed', 'staged', 'fallback_active'] },
  { to: 'handoff_ready', writer: 'old-app', from: ['staged', 'handoff_ready'] },
  // 执行窗口(老 app 进程内):静默安装 + 落位验证 → 拉起 Cindy → 自杀
  { to: 'installed', writer: 'old-app', from: ['handoff_ready'] },
  { to: 'launched', writer: 'old-app', from: ['installed'] },
  // 新 app 首启自拷 + 健康检查通过;或老 app 跳板重试拉起成功(fallback 恢复)
  { to: 'confirmed', writer: 'new-app', from: ['launched'] },
  { to: 'confirmed', writer: 'old-app', from: ['fallback_active'] },
  // 跳板拉起验证失败(已排除单实例让位场景)
  { to: 'fallback_active', writer: 'old-app', from: ['confirmed'] },
  // 任一步失败;写入方 = 当步执行方(staged~launched 归老 app,
  // launched 之后的首启失败归新 app)
  { to: 'failed', writer: 'old-app', from: FAILABLE_STATES },
  { to: 'failed', writer: 'new-app', from: FAILABLE_STATES },
];

export interface TransitionCheck {
  ok: boolean;
  /** ok=false 时的拒绝原因(进日志,便于并发问题定位)。 */
  reason?: string;
}

/**
 * 校验一次状态写入是否合法。
 *
 * @param from 当前 marker 状态(marker 不存在传 null)
 * @param to 目标状态
 * @param writer 写入方身份
 * @param opts.sentinelOverride 防覆盖铁律的例外通道(§3.4):老 app 发现新侧
 *   已有 first-run sentinel 时,以新侧事实为准,允许从任意状态直接置
 *   confirmed。仅 old-app + to=confirmed 时生效。
 */
export function isLegalTransition(
  from: MigrationState | null,
  to: MigrationState,
  writer: MigrationWriter,
  opts?: { sentinelOverride?: boolean },
): TransitionCheck {
  if (opts?.sentinelOverride && to === 'confirmed' && writer === 'old-app') {
    return { ok: true };
  }
  const matched = RULES.filter((r) => r.to === to);
  if (matched.length === 0) {
    return { ok: false, reason: `no rule targets state "${to}"` };
  }
  for (const rule of matched) {
    if (rule.writer !== writer) continue;
    if (rule.from.includes(from)) return { ok: true };
  }
  return {
    ok: false,
    reason: `"${writer}" may not transition "${from ?? '(absent)'}" -> "${to}"`,
  };
}
