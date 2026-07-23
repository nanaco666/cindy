/** nodeRuntimePackaging.test — 正式包保留安全 Fuses，同时带上 utilityProcess 入口。 */

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const desktopRoot = path.resolve(process.cwd());

describe('Node runtime packaging contract', () => {
  it('使用独立 utilityProcess bundle，且不重新打开 RunAsNode / Node 参数开关', () => {
    const forge = fs.readFileSync(path.join(desktopRoot, 'forge.config.ts'), 'utf8');
    expect(forge).toContain("entry: 'src/main/cindy-brain/nodeRuntimeWorkerProcess.ts'");
    expect(forge).toContain("target: 'preload'");
    expect(forge).toContain('[FuseV1Options.RunAsNode]: false');
    expect(forge).toContain('[FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false');
    expect(forge).toContain('[FuseV1Options.EnableNodeCliInspectArguments]: false');
    expect(forge).toContain('[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true');
    expect(forge).toContain('[FuseV1Options.OnlyLoadAppFromAsar]: true');
  });

  it('工作入口通过 parentPort 接收虚拟 stdin，不启动外部 node 命令', () => {
    const worker = fs.readFileSync(
      path.join(desktopRoot, 'src/main/cindy-brain/nodeRuntimeWorkerProcess.ts'),
      'utf8',
    );
    const broker = fs.readFileSync(
      path.join(desktopRoot, 'src/main/cindy-brain/nodeRuntimeBroker.ts'),
      'utf8',
    );
    expect(worker).toContain("type: 'stdin'");
    expect(worker).toContain('requireFromWorker(entryPath)');
    expect(broker).toContain('utilityProcess.fork');
    expect(broker).not.toContain("ELECTRON_RUN_AS_NODE: '1'");
  });
});
