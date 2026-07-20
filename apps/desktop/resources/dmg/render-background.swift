// DMG 安装窗口背景图生成器(background.png 的唯一来源,改视觉先改这里再重新生成)。
//
// 再生成步骤(两步都必须,顺序不能少):
//   swift render-background.swift
//   sips -m "/System/Library/ColorSync/Profiles/sRGB Profile.icc" \
//        -s dpiWidth 72 -s dpiHeight 72 -s format png \
//        background-raw.png --out background.png && rm background-raw.png
//
// ⚠️ macOS 26 (Tahoe) Finder 对 DMG 背景图的硬约束(2026-07 实测,违反任一项背景静默不渲染):
//   - 只认 PNG;多分辨率 HiDPI TIFF(tiffutil -cathidpicheck)不渲染 → Retina 高清背景当前无解,
//     只能接受 1x 上采样的轻微发虚;
//   - 必须 72dpi(144dpi 不渲染);
//   - 必须带 sRGB IEC61966-2.1 profile(NSBitmapImageRep 直出的 calibratedRGB 不渲染,
//     所以上面的 sips 归一化是必须步骤);
//   - 尺寸必须是 1x 逻辑尺寸(660×420 可用;1320×840 不渲染,疑有 ~1024px 上限);
//   - 目录里不要出现 background@2x.png 同名配对,dmgbuild 会自动合成 TIFF 导致背景消失。
//
// 布局坐标与 scripts/ci/lib.mjs 的 createMacDMG settings 联动:窗口 660×420,
// 图标行中心 y=250(app x=175 / Applications x=485),箭头画在两图标之间。改动要两边同步。
import AppKit

let W: CGFloat = 660, H: CGFloat = 420

let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: Int(W), pixelsHigh: Int(H),
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .calibratedRGB, bytesPerRow: 0, bitsPerPixel: 0
)!
rep.size = NSSize(width: W, height: H)

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)!

// 背景:浅灰纵向渐变(顶亮底稍暗,遵守 DESIGN.md 不出现纯白)
NSGradient(
    starting: NSColor(calibratedRed: 0.980, green: 0.980, blue: 0.984, alpha: 1),
    ending: NSColor(calibratedRed: 0.925, green: 0.925, blue: 0.933, alpha: 1)
)!.draw(in: NSRect(x: 0, y: 0, width: W, height: H), angle: -90)

// 文字按"从顶部往下"的 y 定位(AppKit 坐标原点在左下,内部换算)
func drawCentered(_ text: String, font: NSFont, color: NSColor, topY: CGFloat) {
    let s = NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: color])
    let size = s.size()
    s.draw(at: NSPoint(x: (W - size.width) / 2, y: H - topY - size.height))
}

drawCentered("Install Cindy",
             font: .systemFont(ofSize: 27, weight: .bold),
             color: NSColor(calibratedWhite: 0.11, alpha: 1), topY: 62)
drawCentered("Drag Cindy to the Applications folder to complete the installation",
             font: .systemFont(ofSize: 13, weight: .regular),
             color: NSColor(calibratedWhite: 0.56, alpha: 1), topY: 104)

// 拖拽引导箭头:图标行中心高度(topY 250 → 底部坐标 H-250),横线 + 右向箭头头
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
