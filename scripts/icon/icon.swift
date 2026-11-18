// Draws images/icon.png (256x256) with CoreGraphics. Usage: swift scripts/icon/icon.swift images/icon.png
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let size = 256
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "images/icon.png"
let space = CGColorSpaceCreateDeviceRGB()
guard let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { exit(1) }

func rgb(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
  CGColor(red: CGFloat((hex >> 16) & 255) / 255, green: CGFloat((hex >> 8) & 255) / 255, blue: CGFloat(hex & 255) / 255, alpha: a)
}

// Rounded square with a vertical gradient (top #0b1530 to bottom #16264f).
let full = CGRect(x: 0, y: 0, width: size, height: size)
ctx.saveGState()
ctx.addPath(CGPath(roundedRect: full, cornerWidth: 56, cornerHeight: 56, transform: nil))
ctx.clip()
let gradient = CGGradient(colorsSpace: space, colors: [rgb(0x16264f), rgb(0x0b1530)] as CFArray, locations: [0, 1])!
ctx.drawLinearGradient(gradient, start: CGPoint(x: 0, y: 0), end: CGPoint(x: 0, y: size), options: [])
ctx.restoreGState()

// Text cursor bar (y axis points up): 10 x 120, light blue, left of centre so the whole motif is centred.
let cursorW: CGFloat = 10, cursorH: CGFloat = 120
let ghostGap: CGFloat = 16, ghostH: CGFloat = 12
let longW: CGFloat = 76, shortW: CGFloat = 48
let motifW = cursorW + ghostGap + longW
let x0 = (CGFloat(size) - motifW) / 2
let top = (CGFloat(size) + cursorH) / 2
let cursor = CGRect(x: x0, y: top - cursorH, width: cursorW, height: cursorH)
ctx.setFillColor(rgb(0x7cc4ff))
ctx.addPath(CGPath(roundedRect: cursor, cornerWidth: 3, cornerHeight: 3, transform: nil))
ctx.fillPath()

// Ghost text: a bar on the cursor's middle line and a shorter one below, 35% white, round caps.
ctx.setFillColor(rgb(0xffffff, 0.35))
let gx = x0 + cursorW + ghostGap
let mid = CGFloat(size) / 2
for (w, cy) in [(longW, mid), (shortW, mid - 30)] {
  let r = CGRect(x: gx, y: cy - ghostH / 2, width: w, height: ghostH)
  ctx.addPath(CGPath(roundedRect: r, cornerWidth: ghostH / 2, cornerHeight: ghostH / 2, transform: nil))
  ctx.fillPath()
}

guard let image = ctx.makeImage(),
      let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: out) as CFURL, UTType.png.identifier as CFString, 1, nil) else { exit(1) }
CGImageDestinationAddImage(dest, image, nil)
exit(CGImageDestinationFinalize(dest) ? 0 : 1)
