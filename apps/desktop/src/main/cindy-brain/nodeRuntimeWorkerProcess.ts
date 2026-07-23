/**
 * nodeRuntimeWorkerProcess — 随包 Node 插件的 Electron utilityProcess 入口。
 *
 * 正式包关闭 Electron RunAsNode fuse，不能靠 ELECTRON_RUN_AS_NODE 启动脚本。
 * 本入口由 utilityProcess.fork 以 Cindy 自带的 Node service process 运行：
 * main 通过 parentPort 送入 stdio 字节，本入口把它写进一条只存在于子进程内的
 * stdin；插件仍按逐行 JSON-RPC/MCP stdio 编写，stdout/stderr 则由 main 直接接管。
 *
 * 插件代码拥有当前系统用户级本机权限。这里提供的是进程隔离与通信收口，不是
 * OS 沙箱；安装时的主机原生二次确认仍是授权边界。
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { PassThrough } from 'node:stream';

interface ParentPortLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
}

interface StdinPushMessage {
  type: 'stdin';
  chunk: string;
}

function isStdinPushMessage(value: unknown): value is StdinPushMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return (
    message.type === 'stdin' &&
    typeof message.chunk === 'string' &&
    Buffer.byteLength(message.chunk, 'utf8') <= 1024 * 1024
  );
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
const entryPath = process.argv[2];

if (!parentPort) throw new Error('Node 插件工作进程缺少 parentPort');
if (
  typeof entryPath !== 'string' ||
  !path.isAbsolute(entryPath) ||
  !/\.(?:c?js)$/.test(entryPath)
) {
  throw new Error('Node 插件工作进程入口不合法');
}

const virtualStdin = new PassThrough();
Object.defineProperty(process, 'stdin', {
  configurable: true,
  enumerable: true,
  value: virtualStdin,
});

parentPort.on('message', (event) => {
  if (isStdinPushMessage(event.data)) virtualStdin.write(event.data.chunk);
});

// 主机只等这条固定就绪消息，不接收插件自发 parentPort 消息。随后把公开引用
// 从 process 上拿掉，插件的正式通信面只剩 stdin/stdout/stderr。
parentPort.postMessage({ type: 'ready' });
try {
  Object.defineProperty(process, 'parentPort', {
    configurable: true,
    value: undefined,
  });
} catch {
  // 部分 Electron 版本可能不允许重定义；main 仍不会处理插件自发消息。
}

const requireFromWorker = createRequire(__filename);
requireFromWorker(entryPath);
