import { useEffect, useState } from 'react';

import type { InstalledGhost } from '../../shared/ghost';

/**
 * 已装意识清单(意识系统 C2c):首帧 listSync 同步拉(规则 7,无 loading 态)
 * + ghosts:changed 订阅热更新。设置页导航子项 / 意识总览 / 单意识页共用,
 * 三处永远看到同一份清单。
 */
export function useInstalledGhosts(): InstalledGhost[] {
  // 防御式首帧:listSync 是 sendSync,正常同步返回;但本 hook 现在也被聊天
  // 动作行(ghost_call 意识化渲染)无条件调用,某些精简渲染环境 / 单测
  // harness 未挂 ghosts 桥时 listSync 缺席——此时空清单兜底(意识行回退
  // 通用图形),绝不让缺 API 把整行渲染炸掉。
  const [ghosts, setGhosts] = useState<InstalledGhost[]>(() => {
    try {
      return window.electronAPI.ghosts.listSync().ghosts;
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try {
      return window.electronAPI.ghosts.onChanged(({ ghosts: next }) => setGhosts(next));
    } catch {
      return undefined;
    }
  }, []);
  return ghosts;
}
