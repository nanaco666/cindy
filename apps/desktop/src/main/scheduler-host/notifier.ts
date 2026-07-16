/**
 * Phase 3: DesktopNotifier
 *
 * 实现 `Notifier` 接口（来自 @lizi/maker-scheduler）。
 *
 * 桌面通道：复用 notificationService 的 `notification:show-session-event` 频道。
 * 飞书通道：Phase 3 暂时只 log 一行（owner openId 解析逻辑要等 Phase 4 IPC
 * 时补充 schedule.notifyFeishuTarget 字段 + ownerGuard 暴露 owner 接口）。
 *
 * **硬规则**：notify() 不能 throw —— 通知失败不能中断 run。所有 try/catch 包好。
 */

import type { BrowserWindow } from 'electron';
import type { Notifier, Schedule, ScheduleRun } from '@lizi/maker-scheduler';
import type { FeishuIM } from 'lizi-im';

import type { Logger } from '@lizi/maker-scheduler';

import { stripTrailingPathSeparators } from '../../shared/pathText';

export interface DesktopNotifierDeps {
  getMainWindow: () => BrowserWindow | null;
  feishuIm: FeishuIM;
  /**
   * 当前登录用户的飞书 open_id (来自 authManager.getAuthState().user?.feishuOpenId)。
   * 用于把 schedule 完成通知**精准发给登录用户本人**，而不是 bot 的 TOFU owner
   * (绝大多数场景下两者是同一人,但概念上独立 — 切账号场景必须走登录用户)。
   */
  getCurrentUserFeishuOpenId: () => string | null;
  logger: Logger;
}

export class DesktopNotifier implements Notifier {
  constructor(private readonly deps: DesktopNotifierDeps) {}

  async notify(schedule: Schedule, run: ScheduleRun): Promise<void> {
    if (schedule.notify.desktop) {
      try {
        this.notifyDesktop(schedule, run);
      } catch (err) {
        this.deps.logger.warn?.('desktop notify failed', err);
      }
    }
    if (schedule.notify.feishu) {
      try {
        await this.notifyFeishu(schedule, run);
      } catch (err) {
        this.deps.logger.warn?.('feishu notify failed', err);
      }
    }
  }

  private notifyDesktop(schedule: Schedule, run: ScheduleRun): void {
    const win = this.deps.getMainWindow();
    if (!win || win.isDestroyed()) return;
    const title =
      run.status === 'failed'
        ? `[Schedule 失败] ${schedule.name}`
        : `[Schedule] ${schedule.name}`;
    win.webContents.send('notification:show-session-event', {
      sessionId: run.sessionId ?? '',
      title,
      kind: 'done' as const,
    });
  }

  private async notifyFeishu(schedule: Schedule, run: ScheduleRun): Promise<void> {
    // 必须用 bot owner — 飞书 open_id 是 per-app 的: 用户登录 desktop 时 OAuth
    // 拿到的 feishuOpenId 属于构建配置指定的主 app，跟用户自建的 bot app
    // 不互通; 拿主 app 的 open_id 调 bot 的 IM API 会 400 (user_not_found)。
    // ownerGuard 在用户私聊 bot 时 TOFU 记录的才是 bot app 内的合法 open_id。
    // 假设用户用同一个飞书账号登录 desktop 又私聊了 bot, 这两个实际是同一个人。
    const ownerOpenId = this.deps.feishuIm.getOwnerOpenId();
    if (!ownerOpenId) {
      this.deps.logger.warn?.(
        `[scheduler-notifier] feishu notify skipped: no bot owner bound — user must DM the bot once first (schedule=${schedule.id})`,
      );
      return;
    }
    const text = renderFeishuMessage(schedule, run);
    try {
      await this.deps.feishuIm.sendMarkdownText(ownerOpenId, text);
    } catch (err) {
      // 飞书 SDK 包了一层 axios; 400 等业务错误的真正 message 在 response.data.code/msg
      // 里, axios.toString() 看不到。显式拆出来 log, 否则只看到 'Request failed
      // with status code 400' 跟没说一样。
      const r = (err as { response?: { data?: unknown; status?: number } }).response;
      this.deps.logger.warn?.(
        `[scheduler-notifier] feishu sendMarkdownText failed status=${r?.status ?? 'n/a'} body=${JSON.stringify(r?.data ?? null)} target=...${ownerOpenId.slice(-8)}`,
      );
      throw err;
    }
  }
}

/**
 * 把 ScheduleRun 渲染成飞书 lark_md 卡片文案。
 *
 * 视觉布局（从上到下）:
 *   1. 状态标题 — `<emoji> <schedule name>` 加粗,emoji 据 status 区分
 *   2. （失败时）错误原因 — 截断到 200 字符
 *   3. 元信息 — 时间 · 耗时 · agent · 工作目录(短)
 *
 * 格式约束:
 *   - 用 `**bold**`、列表、emoji,这些 lark_md(div tag) 都支持
 *   - URL 直接写,飞书自动识别成可点击链接
 *   - 不要带 `code` (cards.ts 里 stripInlineCode 会把 backtick 整对剥掉)
 */
function renderFeishuMessage(schedule: Schedule, run: ScheduleRun): string {
  const lines: string[] = [`${statusEmoji(run.status)} **${schedule.name}**`];

  if (run.status === 'failed' && run.errorMsg) {
    lines.push('', `⚠️ ${truncate(run.errorMsg, 200)}`);
  } else if (run.status === 'success' && run.resultText) {
    // prompt 类成功：把 agent 这一轮 turn 的最终文本贴出来 — 与飞书正常对话
    // 气泡显示同源（runner 按 text 事件 isFinal 语义聚合）。截断防卡片体积过大,
    // 完整内容用户可点 "Open session" 看。
    lines.push('', truncate(run.resultText, 1500));
  }

  // ── 元信息行（时间 / 耗时 / agent / cwd）────────────────────────────────
  const metaParts: string[] = [];
  metaParts.push(`⏰ ${formatTime(run.firedAt)}`);
  if (typeof run.finishedAt === 'number' && run.finishedAt > run.firedAt) {
    metaParts.push(`⏱️ ${formatDuration(run.finishedAt - run.firedAt)}`);
  }
  metaParts.push(`🤖 ${schedule.agentKind}${schedule.model ? ` · ${schedule.model}` : ''}`);
  const wd = shortDir(schedule.workingDir);
  if (wd) metaParts.push(`📂 ${wd}`);
  lines.push('', metaParts.join('  ·  '));

  return lines.join('\n');
}

function statusEmoji(s: ScheduleRun['status']): string {
  switch (s) {
    case 'success': return '✅';
    case 'failed': return '❌';
    case 'aborted': return '⏹️';
    case 'interrupted': return '⏹️';
    case 'running': return '⏳';
    default: return 'ℹ️';
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function formatTime(ms: number): string {
  // 飞书内本就显示当地时区,不再写 timezone;格式 5/9 15:46
  const d = new Date(ms);
  const mm = d.getMonth() + 1;
  const dd = d.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${mi}`;
}

function formatDuration(diffMs: number): string {
  if (diffMs < 1000) return `${diffMs}ms`;
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

function shortDir(p?: string): string | null {
  if (!p) return null;
  const segs = stripTrailingPathSeparators(p).split(/[\\/]/);
  if (segs.length <= 2) return p;
  return `…/${segs.slice(-2).join('/')}`;
}
