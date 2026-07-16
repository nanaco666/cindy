// 启动 JS 热更闸门 hook:冷启动时跑一次 runStartupOtaUpdate,期间返回 ready=false 让调用方渲染
// loading 门(避免先显示旧 UI 再 reload 的闪帧)。gate 不满足(非自建 / dev / updates 不可用)时
// 直接 ready=true,不阻塞、不发起任何网络。判定逻辑在 startupOtaUpdate.ts(纯函数、已单测)。

import { useEffect, useRef, useState } from 'react';
import * as Updates from 'expo-updates';
import { IS_OTA_SELFHOST } from '@/config/env';
import { runStartupOtaUpdate } from './startupOtaUpdate';

export function useStartupOtaGate(): boolean {
  // 仅自建变体 + 非 dev + expo-updates 运行时可用才走热更门;其余一律直接放行。
  const enabled = IS_OTA_SELFHOST && !__DEV__ && Updates.isEnabled;
  const [ready, setReady] = useState(!enabled);
  const started = useRef(false);

  useEffect(() => {
    if (!enabled || started.current) return;
    started.current = true; // 只冷启一次(不随 resume 重跑)
    let cancelled = false;
    void runStartupOtaUpdate({
      enabled,
      checkForUpdateAsync: () => Updates.checkForUpdateAsync(),
      fetchUpdateAsync: () => Updates.fetchUpdateAsync(),
      reloadAsync: () => Updates.reloadAsync(),
    }).then((outcome) => {
      // 'reloading' 时 app 正在重启,保持 loading 门直到重启;其余情况放行进 App。
      if (!cancelled && outcome !== 'reloading') setReady(true);
    }).catch(() => {
      // runStartupOtaUpdate 设计为永不 reject;万一意外 reject,兜底 fail-open 放行,
      // 否则 loading 门会永久卡住且不可自恢复(后续 OTA 也进不来),与全模块 fail-open 一致。
      if (!cancelled) setReady(true);
    });
    return () => { cancelled = true; };
  }, [enabled]);

  return ready;
}
