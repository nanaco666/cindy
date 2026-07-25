/**
 * imageModelCatalogSync.test.ts — 图像模型两份打包源的同源守卫。
 *
 * 运行时以 providers.json 目录(getActiveCatalog)为准;lizi-mcps 的
 * XDPROXY_IMAGE_MODELS 是意识 cindy 槽白名单与目录缺区时的打包兜底。
 * 两者随 App 同版发布,必须逐项一致——漂移会造成"下拉可选但图像通道
 * enum 不认"(或反之)的割裂。改任一边,另一边必须同步。
 */

import { describe, it, expect } from 'vitest';
import { XDPROXY_IMAGE_MODELS } from '../../cindy-proxy-media/types.js';
import { BUNDLED_CATALOG } from '@lizi/model-providers';

describe('图像模型清单同源守卫', () => {
  it('内置目录 xd.imageModels 与 lizi-mcps 打包常量逐项一致(id + 显示名)', () => {
    const xd = BUNDLED_CATALOG.providers.find((p) => p.id === 'xd');
    expect(xd?.imageModels, '内置目录 xd 供应商缺 imageModels 区').toBeTruthy();
    expect(xd?.imageModels).toEqual(XDPROXY_IMAGE_MODELS.map((m) => ({ id: m.id, name: m.label })));
  });
});

describe('图像默认选型入册守卫', () => {
  it('内置目录 xd.imageDefaults 存在且每个值都指向在册模型', () => {
    const xd = BUNDLED_CATALOG.providers.find((p) => p.id === 'xd');
    const ids = new Set((xd?.imageModels ?? []).map((m) => m.id));
    expect(xd?.imageDefaults?.standard, '缺 imageDefaults.standard(默认选型必须入册,代码零字面量)').toBeTruthy();
    for (const v of Object.values(xd?.imageDefaults ?? {})) {
      expect(ids.has(v as string), `imageDefaults 值 ${String(v)} 不在 imageModels`).toBe(true);
    }
  });
});
