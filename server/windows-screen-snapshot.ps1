$ErrorActionPreference = "Stop"
Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class JarvisScreenDpi {
  [DllImport("user32.dll")]
  public static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);

  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();
}
"@
try {
  [void][JarvisScreenDpi]::SetProcessDpiAwarenessContext([IntPtr](-4))
} catch {
  try { [void][JarvisScreenDpi]::SetProcessDPIAware() } catch {}
}
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$screens = [Windows.Forms.Screen]::AllScreens
if ($screens.Count -eq 0) { throw "No Windows display is available in this session" }
$screenIndex = 0
$parsedIndex = 0
if ([int]::TryParse($env:JARVIS_SCREEN_INDEX, [ref]$parsedIndex)) {
  $screenIndex = [Math]::Max(0, [Math]::Min($screens.Count - 1, $parsedIndex))
}
$screen = $screens[$screenIndex]

$bounds = $screen.Bounds
$source = New-Object Drawing.Bitmap($bounds.Width, $bounds.Height, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [Drawing.Graphics]::FromImage($source)
try {
  $graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bounds.Size, [Drawing.CopyPixelOperation]::SourceCopy)
} finally {
  $graphics.Dispose()
}

$displayWidth = $bounds.Width
$displayHeight = $bounds.Height
$captureId = $env:JARVIS_SCREEN_CAPTURE_ID
$parsedCaptureId = [Guid]::Empty
if (-not [Guid]::TryParse($captureId, [ref]$parsedCaptureId)) {
  throw "A valid Windows screen capture id is required"
}
$captureId = $parsedCaptureId.ToString()

$maxLongEdge = 1920
$parsedMaxWidth = 0
if ([int]::TryParse($env:JARVIS_SCREEN_MAX_WIDTH, [ref]$parsedMaxWidth)) {
  $maxLongEdge = [Math]::Max(1280, [Math]::Min(2560, $parsedMaxWidth))
}
$quality = 75
$parsedQuality = 0
if ([int]::TryParse($env:JARVIS_SCREEN_QUALITY, [ref]$parsedQuality)) {
  $quality = [Math]::Max(30, [Math]::Min(90, $parsedQuality))
}

$scale = [Math]::Min(1.0, [Math]::Min($maxLongEdge / $source.Width, $maxLongEdge / $source.Height))
try {
  $codec = [Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object MimeType -eq "image/jpeg" | Select-Object -First 1
  $width = [Math]::Max(1, [int][Math]::Round($source.Width * $scale))
  $height = [Math]::Max(1, [int][Math]::Round($source.Height * $scale))
  $target = New-Object Drawing.Bitmap($width, $height)
  $resize = [Drawing.Graphics]::FromImage($target)
  try {
    $resize.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $resize.DrawImage($source, 0, 0, $width, $height)
  } finally {
    $resize.Dispose()
  }

  try {
    $tempPath = Join-Path ([IO.Path]::GetTempPath()) "jarvis-screen-$captureId.jpg"
    Get-ChildItem -LiteralPath ([IO.Path]::GetTempPath()) -Filter "jarvis-screen-*.jpg" -File -ErrorAction SilentlyContinue |
      Where-Object LastWriteTimeUtc -lt ([DateTime]::UtcNow.AddMinutes(-5)) |
      Remove-Item -Force -ErrorAction SilentlyContinue

    $encoderParams = New-Object Drawing.Imaging.EncoderParameters(1)
    try {
      $encoderParams.Param[0] = New-Object Drawing.Imaging.EncoderParameter([Drawing.Imaging.Encoder]::Quality, [long]$quality)
      $target.Save($tempPath, $codec, $encoderParams)
    } finally {
      $encoderParams.Dispose()
    }

    $byteLength = (Get-Item -LiteralPath $tempPath).Length
    if ($byteLength -le 0 -or $byteLength -gt 8388608) {
      Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
      throw "Windows screen capture is outside the supported size limit"
    }

    @{
      ok = $true
      captureId = $captureId
      format = "jpeg"
      byteLength = $byteLength
      width = $target.Width
      height = $target.Height
      displayWidth = $displayWidth
      displayHeight = $displayHeight
      screenIndex = $screenIndex
      screenCount = $screens.Count
      capturedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    } | ConvertTo-Json -Compress
  } finally {
    $target.Dispose()
  }
} finally {
  $source.Dispose()
}
