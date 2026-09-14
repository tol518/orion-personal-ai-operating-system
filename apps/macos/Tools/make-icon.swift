import AppKit
import CoreImage

// Builds a macOS .iconset from the Orion logo.
//
// Uses the emblem only. The "ORION" wordmark below it is illegible at 16 and 32pt, where the
// icon spends most of its life — in the Dock, the menu bar's app switcher, and Finder lists —
// so including it would trade recognisability for a smudge.
//
// Geometry follows the Big Sur app icon spec: a 1024pt canvas with an 824pt rounded rect inset
// 100pt on each side, corner radius 185.4. That is what makes an icon sit correctly alongside
// every other app rather than looking oversized or square-cornered.

let sourcePath = CommandLine.arguments[1]
let outputDir = CommandLine.arguments[2]

// Emblem bounds measured from the source, with a small margin so the outer ring is not clipped.
let cropRect = NSRect(x: 300, y: 202, width: 676, height: 665)

guard let source = NSImage(contentsOfFile: sourcePath),
      let sourceTIFF = source.tiffRepresentation,
      let sourceBitmap = NSBitmapImageRep(data: sourceTIFF) else {
    print("could not read source")
    exit(1)
}

// The plate colour comes from the artwork itself, so the icon's background matches the logo
// rather than a guessed black.
let plate = sourceBitmap.colorAt(x: 20, y: 20) ?? NSColor.black
print(String(
    format: "plate colour: #%02X%02X%02X",
    Int(plate.redComponent * 255), Int(plate.greenComponent * 255), Int(plate.blueComponent * 255)
))

/// Crops the emblem out of the source at full resolution.
func emblem() -> CGImage? {
    guard let full = sourceBitmap.cgImage else { return nil }
    return full.cropping(to: cropRect)
}

guard let mark = emblem() else { print("crop failed"); exit(1) }

let ciContext = CIContext()

/// Lifts contrast and brightness so thin strokes survive a heavy downscale.
func strengthened(_ image: CGImage) -> CGImage? {
    let input = CIImage(cgImage: image)
    guard let filter = CIFilter(name: "CIColorControls") else { return nil }
    filter.setValue(input, forKey: kCIInputImageKey)
    filter.setValue(1.35, forKey: kCIInputContrastKey)
    filter.setValue(0.10, forKey: kCIInputBrightnessKey)
    filter.setValue(1.20, forKey: kCIInputSaturationKey)
    guard let output = filter.outputImage else { return nil }
    return ciContext.createCGImage(output, from: input.extent)
}

let sizes = [16, 32, 64, 128, 256, 512, 1024]
var rendered: [Int: Data] = [:]

for size in sizes {
    let scale = CGFloat(size) / 1024.0
    let inset = 100.0 * scale
    let plateSide = 824.0 * scale
    let radius = 185.4 * scale
    // The mark fills most of the plate but keeps a margin, so it reads as artwork on a tile
    // rather than a photo cropped to the edges. Small sizes get more of the plate and a
    // contrast lift: the logo is fine line art on near-black, and below about 128pt the strokes
    // fall under a pixel and grey out into a smudge.
    let small = size <= 128
    let markSide = plateSide * (small ? 0.94 : 0.80)

    guard let context = CGContext(
        data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { continue }

    context.interpolationQuality = .high
    context.clear(CGRect(x: 0, y: 0, width: size, height: size))

    // Rounded plate, transparent outside it.
    let plateRect = CGRect(x: inset, y: inset, width: plateSide, height: plateSide)
    let path = CGPath(roundedRect: plateRect, cornerWidth: radius, cornerHeight: radius, transform: nil)
    context.addPath(path)
    context.setFillColor(plate.cgColor)
    context.fillPath()

    // Emblem centred on the plate.
    context.saveGState()
    context.addPath(path)
    context.clip()
    let markRect = CGRect(
        x: (CGFloat(size) - markSide) / 2,
        y: (CGFloat(size) - markSide) / 2,
        width: markSide,
        height: markSide
    )
    context.draw(small ? strengthened(mark) ?? mark : mark, in: markRect)
    context.restoreGState()

    guard let output = context.makeImage() else { continue }
    let rep = NSBitmapImageRep(cgImage: output)
    rep.size = NSSize(width: size, height: size)
    guard let png = rep.representation(using: .png, properties: [:]) else { continue }
    rendered[size] = png
}

// .iconset filenames macOS expects.
let names: [(String, Int)] = [
    ("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024),
]

try? FileManager.default.createDirectory(atPath: outputDir, withIntermediateDirectories: true)
for (name, size) in names {
    guard let data = rendered[size] else { print("missing \(size)"); continue }
    try? data.write(to: URL(fileURLWithPath: outputDir).appendingPathComponent(name))
}
print("wrote \(names.count) images to \(outputDir)")
