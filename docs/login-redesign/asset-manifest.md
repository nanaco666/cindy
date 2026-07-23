# 登录换肤静态资产清单(asset-manifest,PR0a 交付)

> 依据:implementation-plan.md Step 0 WHAT2「硬约束四条(wave4 更新)」。全部资产由
> Figma MCP `download_assets` 按 nodeId 直接导出(fileKey `xNK3qh7zVfrO3zrKj5tEf8`),
> **禁止**从 wave4 frame 自选导出层;立绘来源裁定见 `figma-component-spec.md` §10.2
> (默认路径:复用旧 source,wave4 帧内立绘为同组件 instance、无独立新资产)。
> UI 静态打包资源不是运行时媒体字节,**不走 cindy-media 总仓**(规则 25 边界:媒体总仓
> 管运行时生成/落盘的媒体,构建期打包资源走 bundler 资源管线)。
>
> DPI 策略(硬约束④):桌面 `image-set()` 1x/2x;移动 RN `@2x/@3x`(移动设计稿 750 宽
> 即 @2x 基准,故 @2x=figma 1x 导出、@3x=figma 1.5x 导出)。变更本清单须同步重导并
> 更新 SHA256。

## 桌面(apps/desktop/src/renderer/assets/login/)

| 文件 | nodeId | 尺寸(px) | DPI 档 | 透明底验收 | SHA256(前 16) |
|---|---|---|---|---|---|
| wordmark.png | `368:1381` | 423×145 | 1x | ✅ 真透明〔GAP-A 修复 2026-07-20;2026-07-21 用户实锤同病毛边修复:统一母版,与 mobile `login-wordmark@2x.png` 同 SHA;按 #F1F0F1 matte 反解 alpha 去污,字重按 inferred alpha 零漂移,非边缘 α=1 RGB 零改动〕 | 924788e60f82db2a |
| wordmark@2x.png | `368:1381` | 846×290 | 2x | ✅〔GAP-A + 2026-07-21 毛边修复同法;桌面 2x 独立档位〕 | 0555ef71254d3170 |
| slogan.png | `368:1394` | 455×131 | 1x | ✅(#2A2828 矢量 + 0.5px stroke;含 1-2px 矢量描边出血,几何按 453.2×129.1 消费)〔GAP-A 修复 2026-07-20;2026-07-21 毛边修复:统一母版,与 mobile `login-slogan@2x.png` 同 SHA;按 #F1F0F1 matte 反解 alpha 去污,字重按 inferred alpha 零漂移,非边缘 α=1 RGB 零改动〕 | 11f002d286074c6d |
| slogan@2x.png | `368:1394` | 909×261 | 2x | ✅〔GAP-A + 2026-07-21 毛边修复同法;桌面 2x 独立档位〕 | fb153e98d9ab0ae7 |
| hero.png | `347:971` | 934×934 | 1x | ✅(CINDY_Client 旧 source 复用,§10.2 裁定)〔GAP-A 修复 2026-07-20:原件为 figma 画布 #C5C5C5 实底(导出烘焙祖先渲染,重导出复现同缺陷);改用同 nodeId raw 透明源(2048² 方形,与节点纵横比精确一致)sips 缩放;相对旧节点渲染中心色 maxΔ=15,与 exec-c mobile 同法修复(b8a4b0a0,demo 已验收)同性质〕 | c5b979852a49cfd3 |
| hero@2x.png | `347:971` | 1868×1868 | 2x | ✅〔GAP-A 同法修复(raw 2048² 降采样)〕 | ff55748e17469607 |

## 回调 chibi 三表情(apps/desktop/src/renderer/assets/login/chibi/)

按 adaptation-spec §5 条 6 预裁切 280/560/840(figma 裁切百分比已在节点内烘焙,导出即
成品,无需实现端复刻 object-position)。**消费方 = PR3**:按 U-7 裁决转 280×280@2x webp
data URI(单张 ≤120KB)内嵌进 `loginCallbackAssets.ts`;本清单交付原始 png 三档。

| 文件 | nodeId(emoj 帧) | 所在卡 | 尺寸 | 透明底验收 | SHA256(前 16) |
|---|---|---|---|---|---|
| chibi-success.png/@2x/@3x | `347:355` | 成功卡 `343:355` | 280/560/840 | ✅ 真退底透明(全透明像素 ~38%,四角 α=0;2026-07-22 换用用户提供退底源:@1x 原样,@2x/@3x 等比 Lanczos 放大,不裁内容不加工画面。旧版为 #FBFBFB 满底不透明,Dark 卡显白色矩形,手测缺陷已修) | 8172dfc849d5f688 / ce0f2eb51ebec5ef / addeb4fa38aeb16f |
| chibi-failure.png/@2x/@3x | `347:1356` | 失败卡 `347:1353` | 280/560/840 | 同上(全透明 ~40%) | 24bcd4f772dd0bf7 / 953d95f35df07d8f / 723851799361794a |
| chibi-neutral.png/@2x/@3x | `347:1464` | Warning 卡 `347:1461` | 280/560/840 | 同上(全透明 ~38%) | 14c770d89f8ddbd0 / e1ce53880a4b8ccb / 6f81afa93f73e4f5 |

## 桌面图标(apps/desktop/src/renderer/assets/login/icons/,PR1 追加,lead 裁决方案 C)

第三方圆钮 icon 层(figma §4.5,icon 48×48 居中于 80×80 圆钮)。**SVG 矢量交付**
(lead 裁决第 4 条:按导出质量选;PNG 导出会把组件集画布/按钮底 #2A2828 一并烘焙,
矢量导出后剔除泄漏的父级图层——画布灰底 #C5C5C5、组件集虚线框、按钮圆底/描边三个
rect——仅保留字形组,glyph path 逐字节未动)。矢量天然 DPI 无关,无需 @2x 档。

| 文件 | nodeId | 视口 | 格式 | 底色验收 | SHA256(前 16) |
|---|---|---|---|---|---|
| icons/apple.svg | `247:1692` | 48×48 | SVG(白 fill 字形) | ✅ 无底 rect | 9ec5d9af29564f85 |
| icons/google.svg | `247:1714` | 48×48 | SVG(多色品牌字形) | ✅ 无底 rect | f7ef6da85beb8982 |
| icons/wechat.svg | `247:1724` | 48×48 | SVG(主绿 #00C70A,wave3 §9.3) | ✅ 无底 rect | c52f9d7a3de4f764 |
| icons/sso.svg | `329:248` | 48×48 | SVG(白 fill 字形) | ✅ 无底 rect | 93881dff538931ac |

- WeChat 资产照裁决备好:圆钮行由服务端 `providers.social` 驱动,无返回时不渲染
  (计划非目标「不上 WeChat 入口」= 不主动展示,design §5)。
- spinner 不导位图:代码实现(design §3,247:1546 仅作尺寸/弧色参数参考)。
- 方式行 enterprise/person/share 三枚矢量内联于 `components/login/LoginControls.tsx`
  (源 = 设计稿导出 SVG path,nodeId 随 329:956 组件;fill 收敛到 login token)。

## 移动(apps/mobile/assets/login/)

| 文件 | nodeId | 尺寸(px) | RN 档 | 透明底验收 | SHA256(前 16) |
|---|---|---|---|---|---|
| login-wordmark@2x.png | `368:1381` | 423×145 | @2x(=figma 1x) | ✅〔2026-07-21 用户实锤同病毛边修复:统一母版,与 desktop `wordmark.png` 同 SHA;按 #F1F0F1 matte 反解 alpha 去污,字重偏差 0.012% <0.5%,非边缘 α=1 RGB 零改动〕 | 924788e60f82db2a |
| login-wordmark@3x.png | `368:1381` | 635×218 | @3x(=figma 1.5x) | ✅〔2026-07-21 毛边修复同法;移动 3x 独立档位〕 | 68b7c64b1969c62 |
| login-slogan@2x.png | `368:1394` | 455×131 | @2x | ✅〔2026-07-21 毛边修复:统一母版,与 desktop `slogan.png` 同 SHA;按 #F1F0F1 matte 反解 alpha 去污,字重按 inferred alpha 零漂移〕 | 11f002d286074c6d |
| login-slogan@3x.png | `368:1394` | 682×196 | @3x | ✅〔2026-07-21 毛边修复同法;移动 3x 独立档位〕 | 54b9218ebd4345d6 |
| login-hero@2x.png | `347:2707` | 750×902 | @2x(CINDY_mobile 旧 source) | ✅ | 4e0ce24b482ac28e |
| login-hero@3x.png | `347:2707` | 1125×1353 | @3x | ✅ | d3cb03089d71e8f6 |

## 几何消费备注(硬约束②③)

- 字标内层几何按 wave4:容器 680×180 @570,1029、内层 423×145 @(128,17)(绝对≈698,1046);
  移动端在旧字标框(长屏 401×137 等)内 **contain 等比适配,禁止非等比拉伸**。
- slogan 几何沿旧(桌面 1191,863,460×134;矢量 453.2×129.1);移动沿 wave3.5 旧表。
- 立绘几何不变(桌面 934×934@443,275;移动 y=116 双区统一)。
- 背景渐变**不在资产内**——双 #F70121 渐变由代码绘制(design.md §8.1,token 组已注册)。
- 验收含 macOS Retina 与 Windows 125%/150%(image-set 由消费 PR 落码时验证)。
