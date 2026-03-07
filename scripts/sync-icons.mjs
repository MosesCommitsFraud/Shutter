import { mkdtempSync, mkdirSync, readFileSync, rmSync, copyFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const macIconDir = resolve(repoRoot, "public/macIcon");
const windowsLogoSvg = resolve(repoRoot, "public/logo.svg");
const tauriIconsDir = resolve(repoRoot, "src-tauri/icons");

const macIconMap = {
  "icon_16x16.png": "Icon-iOS-Dark-16x16@1x.png",
  "icon_16x16@2x.png": "Icon-iOS-Dark-16x16@2x.png",
  "icon_32x32.png": "Icon-iOS-Dark-32x32@1x.png",
  "icon_32x32@2x.png": "Icon-iOS-Dark-32x32@2x.png",
  "icon_128x128.png": "Icon-iOS-Dark-128x128@1x.png",
  "icon_128x128@2x.png": "Icon-iOS-Dark-128x128@2x.png",
  "icon_256x256.png": "Icon-iOS-Dark-256x256@1x.png",
  "icon_256x256@2x.png": "Icon-iOS-Dark-256x256@2x.png",
  "icon_512x512.png": "Icon-iOS-Dark-512x512@1x.png",
  "icon_512x512@2x.png": "Icon-iOS-Dark-1024x1024@1x.png",
};

const macCopies = [
  ["Icon-iOS-Dark-32x32@1x.png", "32x32.png"],
  ["Icon-iOS-Dark-64x64@2x.png", "128x128.png"],
  ["Icon-iOS-Dark-128x128@2x.png", "128x128@2x.png"],
  ["Icon-iOS-Dark-32x32@2x.png", "64x64.png"],
  ["Icon-iOS-Dark-512x512@1x.png", "icon.png"],
];
const macInsetScale = 0.82;

const windowsPngTargets = [
  ["Square30x30Logo.png", 30],
  ["Square44x44Logo.png", 44],
  ["Square71x71Logo.png", 71],
  ["Square89x89Logo.png", 89],
  ["Square107x107Logo.png", 107],
  ["Square142x142Logo.png", 142],
  ["Square150x150Logo.png", 150],
  ["Square284x284Logo.png", 284],
  ["Square310x310Logo.png", 310],
  ["StoreLogo.png", 50],
  ["icon.png", 512],
];

const windowsIcoSizes = [16, 32, 48, 64, 128, 256];

mkdirSync(tauriIconsDir, { recursive: true });

syncMacIcons();
syncWindowsIcons();

function syncMacIcons() {
  for (const sourceName of Object.values(macIconMap)) {
    const sourcePath = resolve(macIconDir, sourceName);
    if (!existsSync(sourcePath)) {
      throw new Error(`Missing macOS icon source: ${sourcePath}`);
    }
  }

  const tempDir = mkdtempSync(join(tmpdir(), "flashbang-mac-icons-"));

  try {
    const icnsImages = [
      ["icp4", prepareMacIcon(resolve(macIconDir, "Icon-iOS-Dark-16x16@1x.png"), join(tempDir, "icp4.png"), 16)],
      ["icp5", prepareMacIcon(resolve(macIconDir, "Icon-iOS-Dark-32x32@1x.png"), join(tempDir, "icp5.png"), 32)],
      ["icp6", prepareMacIcon(resolve(macIconDir, "Icon-iOS-Dark-32x32@2x.png"), join(tempDir, "icp6.png"), 64)],
      ["ic07", prepareMacIcon(resolve(macIconDir, "Icon-iOS-Dark-128x128@1x.png"), join(tempDir, "ic07.png"), 128)],
      ["ic08", prepareMacIcon(resolve(macIconDir, "Icon-iOS-Dark-128x128@2x.png"), join(tempDir, "ic08.png"), 256)],
      ["ic09", prepareMacIcon(resolve(macIconDir, "Icon-iOS-Dark-256x256@2x.png"), join(tempDir, "ic09.png"), 512)],
      ["ic10", prepareMacIcon(resolve(macIconDir, "Icon-iOS-Dark-1024x1024@1x.png"), join(tempDir, "ic10.png"), 1024)],
    ];

    writeFileSync(resolve(tauriIconsDir, "icon.icns"), buildIcns(icnsImages));

    for (const [sourceName, targetName] of macCopies) {
      const sourcePath = resolve(macIconDir, sourceName);
      prepareMacIcon(sourcePath, resolve(tauriIconsDir, targetName), imageSizeFromName(sourceName));
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function syncWindowsIcons() {
  if (!existsSync(windowsLogoSvg)) {
    throw new Error(`Missing Windows icon source: ${windowsLogoSvg}`);
  }

  const icoBuffers = [];

  for (const [fileName, size] of windowsPngTargets) {
    const outputPath = resolve(tauriIconsDir, fileName);
    renderSvgToPng(windowsLogoSvg, outputPath, size);
  }

  for (const size of windowsIcoSizes) {
    const outputPath = resolve(tauriIconsDir, `.icon-${size}.png`);
    renderSvgToPng(windowsLogoSvg, outputPath, size);
    icoBuffers.push(readFileSync(outputPath));
    rmSync(outputPath, { force: true });
  }

  writeFileSync(resolve(tauriIconsDir, "icon.ico"), buildIco(icoBuffers, windowsIcoSizes));
}

function renderSvgToPng(inputPath, outputPath, size) {
  renderImageToPng(inputPath, outputPath, size, 1);
}

function prepareMacIcon(inputPath, outputPath, size) {
  renderImageToPng(inputPath, outputPath, size, macInsetScale);
  return outputPath;
}

function renderImageToPng(inputPath, outputPath, size, scale) {
  const swiftSource = `
import AppKit
import Foundation

let inputPath = CommandLine.arguments[1]
let outputPath = CommandLine.arguments[2]
let size = CGFloat(Double(CommandLine.arguments[3])!)
let scale = CGFloat(Double(CommandLine.arguments[4])!)

guard let image = NSImage(contentsOf: URL(fileURLWithPath: inputPath)) else {
  fputs("Failed to load image at \\(inputPath)\\n", stderr)
  exit(1)
}

let targetSize = NSSize(width: size, height: size)
let outputImage = NSImage(size: targetSize)
outputImage.lockFocus()
NSGraphicsContext.current?.imageInterpolation = .high
let inset = (1.0 - scale) * size / 2.0
let drawRect = NSRect(x: inset, y: inset, width: size * scale, height: size * scale)
image.draw(
  in: drawRect,
  from: NSRect(origin: .zero, size: image.size),
  operation: .copy,
  fraction: 1.0
)
outputImage.unlockFocus()

guard
  let tiffRepresentation = outputImage.tiffRepresentation,
  let bitmap = NSBitmapImageRep(data: tiffRepresentation),
  let pngData = bitmap.representation(using: .png, properties: [:])
else {
  fputs("Failed to rasterize image at \\(inputPath)\\n", stderr)
  exit(1)
}

try pngData.write(to: URL(fileURLWithPath: outputPath))
`;

  execFileSync("swift", ["-e", swiftSource, inputPath, outputPath, String(size), String(scale)], {
    env: {
      ...process.env,
      CLANG_MODULE_CACHE_PATH: join(tmpdir(), "swift-module-cache"),
    },
    stdio: "inherit",
  });
}

function buildIco(pngBuffers, sizes) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngBuffers.length, 4);

  const entries = Buffer.alloc(16 * pngBuffers.length);
  let offset = header.length + entries.length;

  pngBuffers.forEach((buffer, index) => {
    const size = sizes[index];
    const entryOffset = index * 16;

    entries.writeUInt8(size >= 256 ? 0 : size, entryOffset);
    entries.writeUInt8(size >= 256 ? 0 : size, entryOffset + 1);
    entries.writeUInt8(0, entryOffset + 2);
    entries.writeUInt8(0, entryOffset + 3);
    entries.writeUInt16LE(1, entryOffset + 4);
    entries.writeUInt16LE(32, entryOffset + 6);
    entries.writeUInt32LE(buffer.length, entryOffset + 8);
    entries.writeUInt32LE(offset, entryOffset + 12);

    offset += buffer.length;
  });

  return Buffer.concat([header, entries, ...pngBuffers]);
}

function buildIcns(images) {
  const chunks = images.map(([type, filePath]) => {
    const data = readFileSync(filePath);
    const chunkHeader = Buffer.alloc(8);
    chunkHeader.write(type, 0, "ascii");
    chunkHeader.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([chunkHeader, data]);
  });

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 8);
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(totalLength, 4);

  return Buffer.concat([header, ...chunks]);
}

function imageSizeFromName(fileName) {
  const match = fileName.match(/-(\d+(?:\.\d+)?)x\1@(\d+)x\.png$/);
  if (!match) {
    throw new Error(`Cannot infer image size from filename: ${fileName}`);
  }

  return Math.round(Number(match[1]) * Number(match[2]));
}
