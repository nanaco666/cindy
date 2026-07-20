// DMG 安装窗口背景图生成器(background.png 的唯一来源,改视觉先改这里再重新生成)。
//
// 再生成步骤(两步都必须,顺序不能少):
//   swift render-background.swift
//   sips -m "/System/Library/ColorSync/Profiles/sRGB Profile.icc" \
//        -s dpiWidth 72 -s dpiHeight 72 -s format png \
//        background-raw.png --out background.png && rm background-raw.png
//
// ⚠️ macOS 26 (Tahoe) Finder 对 DMG 背景图的硬约束(2026-07 实测,违反任一项背景静默不渲染):
//   - 只认 PNG;多分辨率 HiDPI TIFF(tiffutil -cathidpicheck)不渲染;
//   - 必须 72dpi(144dpi 不渲染);
//   - 必须带 sRGB IEC61966-2.1 profile(NSBitmapImageRep 直出的 calibratedRGB 不渲染,
//     所以上面的 sips 归一化是必须步骤);
//   - 宽度有渲染上限:914 可渲染、990 不渲染(上限落在两者之间,本画布 900 压线可用);
//   - 目录里不要出现 background@2x.png 同名配对,dmgbuild 会自动合成 TIFF 导致背景消失;
//   - Finder 按 1:1 像素、左上角锚定、超窗裁切绘制,完全不缩放 → Retina 高清背景无解
//     (位图文字必有 1x 上采样发虚,OS 级硬上限);大字号粗体耐模糊,小字灰字最吃亏。
//
// 画布策略(2026-07-20 v2,解决"拉大窗口出现双背景色"):
//   画布 900×570 > 默认窗口 660×420;设计内容全部锚在左上 660×420 设计区
//   (默认打开视觉与 660×420 版逐像素一致),右侧 / 底部的画布延伸区渐隐到纯白,
//   与 Finder 窗口自身的白底(设背景图后固定浅色渲染)无缝衔接——用户拉大窗口
//   看到的是设计好的过渡而非生硬接缝。纯白仅用于画布边缘与 OS chrome 融合,
//   属 DESIGN.md 精神下的系统衔接豁免,不用于内容区。
//
// 布局坐标与 scripts/ci/lib.mjs 的 createMacDMG settings 联动:窗口 660×420,
// 图标行中心 y=250(app x=175 / Applications x=485),箭头画在两图标之间。改动要两边同步。
import AppKit

let W: CGFloat = 900, H: CGFloat = 570   // 画布(宽必须 <990,见上方渲染上限)
let DW: CGFloat = 660, DH: CGFloat = 420 // 设计区 = 默认窗口尺寸

let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: Int(W), pixelsHigh: Int(H),
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .calibratedRGB, bytesPerRow: 0, bitsPerPixel: 0
)!
rep.size = NSSize(width: W, height: H)

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)!

// 主渐变带:全宽、画布顶部往下 420px——默认窗口可视区,顶亮底稍暗,不出现纯白
let topBand = NSRect(x: 0, y: H - DH, width: W, height: DH)
NSGradient(
    starting: NSColor(calibratedRed: 0.980, green: 0.980, blue: 0.984, alpha: 1),
    ending: NSColor(calibratedRed: 0.925, green: 0.925, blue: 0.933, alpha: 1)
)!.draw(in: topBand, angle: -90)

// 底部延伸带(y>420 才可见):从主渐变末色继续渐隐到白,接 Finder 窗口白底
let bottomBand = NSRect(x: 0, y: 0, width: W, height: H - DH)
NSGradient(
    starting: NSColor(calibratedRed: 0.925, green: 0.925, blue: 0.933, alpha: 1),
    ending: NSColor.white
)!.draw(in: bottomBand, angle: -90)

// 右侧白色渐隐罩(x>660 才可见):x=680 → 900 从透明到不透明白
NSGradient(
    starting: NSColor(calibratedWhite: 1, alpha: 0),
    ending: NSColor(calibratedWhite: 1, alpha: 1)
)!.draw(in: NSRect(x: 680, y: 0, width: W - 680, height: H), angle: 0)

// 文字在设计区(660 宽)内水平居中;topY 从画布顶部量(画布顶 = 窗口顶)
func drawCentered(_ text: String, font: NSFont, color: NSColor, topY: CGFloat) {
    let s = NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: color])
    let size = s.size()
    s.draw(at: NSPoint(x: (DW - size.width) / 2, y: H - topY - size.height))
}

drawCentered("Install Cindy",
             font: .systemFont(ofSize: 27, weight: .bold),
             color: NSColor(calibratedWhite: 0.11, alpha: 1), topY: 62)
drawCentered("Drag Cindy to the Applications folder to complete the installation",
             font: .systemFont(ofSize: 13, weight: .regular),
             color: NSColor(calibratedWhite: 0.56, alpha: 1), topY: 104)

// 拖拽引导箭头:图标行中心高度(窗口内 y=250 → 画布底原点坐标 H-250)
let ay = H - 250
let arrow = NSBezierPath()
arrow.lineWidth = 5.5
arrow.lineCapStyle = .round
arrow.lineJoinStyle = .round
arrow.move(to: NSPoint(x: 300, y: ay))
arrow.line(to: NSPoint(x: 360, y: ay))
arrow.move(to: NSPoint(x: 342, y: ay + 16))
arrow.line(to: NSPoint(x: 360, y: ay))
arrow.line(to: NSPoint(x: 342, y: ay - 16))
NSColor(calibratedWhite: 0.62, alpha: 1).setStroke()
arrow.stroke()

NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!
    .write(to: URL(fileURLWithPath: "background-raw.png"))
print("wrote background-raw.png — 记得跑头部注释里的 sips 归一化,否则 Finder 不渲染")
