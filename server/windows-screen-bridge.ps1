param(
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$ListenAddress = "127.0.0.1",
  [int]$Port = 43129
)

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
Add-Type -AssemblyName System.Web

function Write-JsonResponse {
  param($Stream, [int]$StatusCode, [hashtable]$Body)
  $statusText = if ($StatusCode -eq 200) { "OK" } elseif ($StatusCode -eq 401) { "Unauthorized" } elseif ($StatusCode -eq 404) { "Not Found" } else { "Internal Server Error" }
  $payload = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Compress -Depth 4))
  $headers = [Text.Encoding]::ASCII.GetBytes("HTTP/1.1 $StatusCode $statusText`r`nContent-Type: application/json`r`nContent-Length: $($payload.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n")
  $Stream.Write($headers, 0, $headers.Length)
  $Stream.Write($payload, 0, $payload.Length)
  $Stream.Flush()
}

function Read-Request {
  param($Stream)
  $buffer = New-Object byte[] 4096
  $memory = New-Object IO.MemoryStream
  while ($memory.Length -lt 16384) {
    $count = $Stream.Read($buffer, 0, $buffer.Length)
    if ($count -le 0) { break }
    $memory.Write($buffer, 0, $count)
    $text = [Text.Encoding]::ASCII.GetString($memory.ToArray())
    if ($text.Contains("`r`n`r`n")) { return $text }
  }
  return [Text.Encoding]::ASCII.GetString($memory.ToArray())
}

function Get-QueryInteger {
  param($Query, [string]$Name, [int]$Default, [int]$Minimum, [int]$Maximum)
  $raw = $Query[$Name]
  $parsed = $Default
  if (-not [string]::IsNullOrWhiteSpace($raw)) {
    $candidate = 0
    if ([int]::TryParse($raw, [ref]$candidate)) { $parsed = $candidate }
  }
  return [Math]::Max($Minimum, [Math]::Min($Maximum, $parsed))
}

function Capture-Screen {
  param([int]$ScreenIndex, [int]$MaxWidth, [long]$Quality)
  $screens = [Windows.Forms.Screen]::AllScreens
  if ($ScreenIndex -lt 0 -or $ScreenIndex -ge $screens.Count) { throw "Screen index $ScreenIndex is unavailable" }
  $bounds = $screens[$ScreenIndex].Bounds
  $source = New-Object Drawing.Bitmap($bounds.Width, $bounds.Height, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [Drawing.Graphics]::FromImage($source)
  try {
    $graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bounds.Size, [Drawing.CopyPixelOperation]::SourceCopy)
  } finally {
    $graphics.Dispose()
  }

  $target = $source
  if ($MaxWidth -gt 0 -and $source.Width -gt $MaxWidth) {
    $height = [Math]::Max(1, [Math]::Round($source.Height * ($MaxWidth / $source.Width)))
    $target = New-Object Drawing.Bitmap($MaxWidth, $height)
    $resize = [Drawing.Graphics]::FromImage($target)
    try {
      $resize.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $resize.DrawImage($source, 0, 0, $MaxWidth, $height)
    } finally {
      $resize.Dispose()
      $source.Dispose()
    }
  }

  $stream = New-Object IO.MemoryStream
  try {
    $codec = [Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object MimeType -eq "image/jpeg" | Select-Object -First 1
    $encoderParams = New-Object Drawing.Imaging.EncoderParameters(1)
    $encoderParams.Param[0] = New-Object Drawing.Imaging.EncoderParameter([Drawing.Imaging.Encoder]::Quality, $Quality)
    $target.Save($stream, $codec, $encoderParams)
    return @{
      ok = $true
      format = "jpeg"
      base64 = [Convert]::ToBase64String($stream.ToArray())
      width = $target.Width
      height = $target.Height
      screenIndex = $ScreenIndex
      screenCount = $screens.Count
      capturedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
  } finally {
    $stream.Dispose()
    $target.Dispose()
  }
}

$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Parse($ListenAddress), $Port)
$listener.Start()
try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
      $client.ReceiveTimeout = 5000
      $client.SendTimeout = 10000
      $network = $client.GetStream()
      $request = Read-Request $network
      $lines = $request -split "`r`n"
      $requestParts = $lines[0] -split " "
      $authorization = $lines | Where-Object { $_ -like "Authorization:*" } | Select-Object -First 1
      if ($authorization -ne "Authorization: Bearer $Token") {
        Write-JsonResponse $network 401 @{ ok = $false; error = "unauthorized" }
        continue
      }
      if ($requestParts.Count -lt 2 -or $requestParts[0] -ne "GET") {
        Write-JsonResponse $network 404 @{ ok = $false; error = "not found" }
        continue
      }
      $uri = [Uri]("http://localhost" + $requestParts[1])
      if ($uri.AbsolutePath -eq "/health") {
        Write-JsonResponse $network 200 @{ ok = $true; screenCount = [Windows.Forms.Screen]::AllScreens.Count }
        continue
      }
      if ($uri.AbsolutePath -ne "/snapshot") {
        Write-JsonResponse $network 404 @{ ok = $false; error = "not found" }
        continue
      }
      $query = [Web.HttpUtility]::ParseQueryString($uri.Query)
      $screenIndex = Get-QueryInteger $query "screenIndex" 0 0 15
      $maxWidth = Get-QueryInteger $query "maxWidth" 1280 320 2560
      $quality = Get-QueryInteger $query "quality" 58 10 100
      Write-JsonResponse $network 200 (Capture-Screen $screenIndex $maxWidth $quality)
    } catch {
      try { Write-JsonResponse $network 500 @{ ok = $false; error = $_.Exception.Message } } catch {}
    } finally {
      $client.Dispose()
    }
  }
} finally {
  $listener.Stop()
}
