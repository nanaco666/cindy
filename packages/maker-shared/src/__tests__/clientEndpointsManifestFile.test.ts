/**
 * 仓内清单正本 config/endpoint.json(cn)与 config/endpoint.global.json(global)
 * 的 CI 守门测试。
 *
 * 发布方式是人肉上传各自 region 的 hotfix CDN(`<base>/endpoint.json`,暂无发布
 * 脚本),这条测试是上传前的唯一自动防线:改 CDN 前必须先改仓内正本并让本测试
 * 通过。客户端语义是**阻断式**——清单校验不过启动直接卡错误框,所以这里保证
 * 正本永远能被客户端 parser 接受。
 *
 * 注意:不校验与 production-endpoints.json 的一致性——清单的意义就是让线上
 * 端点可以偏离构建期值(如迁移到新域名)。清单即唯一事实源:全字段必填,
 * parser 通过即隐含所有字段齐备(缺任一字段客户端启动阻断)。
 *
 * `_` 前缀键约定为正本内注释(JSON 无注释语法;客户端 parser 按未知字段忽略),
 * 未知字段检查对其豁免。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CLIENT_ENDPOINT_KEYS,
  CLIENT_ENDPOINT_REVIEW_KEY,
  CLIENT_ENDPOINTS_SCHEMA_VERSION,
  parseClientEndpointManifest,
} from '../clientEndpoints';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const MANIFESTS = [
  { label: 'cn', filePath: path.join(REPO_ROOT, 'config', 'endpoint.json') },
  { label: 'global', filePath: path.join(REPO_ROOT, 'config', 'endpoint.global.json') },
] as const;

/**
 * 已从 CLIENT_ENDPOINT_KEYS 退役、但正本**必须暂时保值**的字段:正本是线上
 * CDN 清单的上传源,已发布老客户端的 parser 对这些字段仍是必填,删值 = 老
 * 版本全量启动阻断。等对应老版本消亡后,从正本与本白名单同批删除。
 *  - apiBaseUrl:老主 server(xdt-api),2026-07-18 四批收敛完成后代码侧退役。
 */
const RETIRED_RESIDUE_KEYS = ['apiBaseUrl'] as const;

describe.each(MANIFESTS)('config/endpoint*.json 守门($label)', ({ filePath }) => {
  const rawText = fs.readFileSync(filePath, 'utf8');

  it('必须能被客户端共享 parser 完整接受(阻断语义下坏正本 = 全量启动事故)', () => {
    const result = parseClientEndpointManifest(rawText);
    expect(result).toMatchObject({ ok: true });
  });

  it('schemaVersion 与客户端支持版本一致', () => {
    const parsed = JSON.parse(rawText) as { schemaVersion?: number };
    expect(parsed.schemaVersion).toBe(CLIENT_ENDPOINTS_SCHEMA_VERSION);
  });

  it('无未知字段(字段名拼错会被客户端当未知字段忽略,静默不生效)', () => {
    const parsed = JSON.parse(rawText) as Record<string, unknown>;
    const keys = Object.keys(parsed).filter(
      (key) => key !== 'schemaVersion' && !key.startsWith('_'),
    );
    const allowed = new Set<string>([
      ...CLIENT_ENDPOINT_KEYS,
      CLIENT_ENDPOINT_REVIEW_KEY,
      ...RETIRED_RESIDUE_KEYS,
    ]);
    expect(keys.filter((key) => !allowed.has(key))).toEqual([]);
  });

  it('退役残留字段仍保值(老客户端必填;删值前先确认对应老版本已消亡)', () => {
    const parsed = JSON.parse(rawText) as Record<string, unknown>;
    for (const key of RETIRED_RESIDUE_KEYS) {
      expect(typeof parsed[key], key).toBe('string');
      expect(String(parsed[key]).length, key).toBeGreaterThan(0);
    }
  });
});
