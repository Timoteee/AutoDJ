$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$toolDirectory = Join-Path $projectRoot '.tools'
New-Item -ItemType Directory -Path $toolDirectory -Force | Out-Null
$release = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'
$binary = Join-Path $toolDirectory 'yt-dlp.exe'
Invoke-WebRequest -Uri "$release/yt-dlp.exe" -OutFile $binary
$checksumResponse = (Invoke-WebRequest -Uri "$release/SHA2-256SUMS").Content
$checksums = if ($checksumResponse -is [byte[]]) { [System.Text.Encoding]::UTF8.GetString($checksumResponse) } else { [string]$checksumResponse }
$expected = (($checksums -split "`n" | Where-Object { $_ -match '\s+yt-dlp\.exe\s*$' }) -split '\s+')[0]
if (!$expected -or (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected.ToLowerInvariant()) {
  throw 'yt-dlp checksum verification failed'
}
& $binary --version
