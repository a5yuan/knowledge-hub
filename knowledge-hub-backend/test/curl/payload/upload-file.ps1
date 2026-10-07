# Upload a local file (possibly with Chinese name) to /document/upload.
# Filename is encoded as UTF-8 in Content-Disposition (browser-equivalent).
# The file path is passed as a parameter (UTF-16 process args), never hardcoded
# here, so Windows PowerShell 5.1 cannot mojibake it.
param(
  [Parameter(Mandatory = $true)][string]$Path
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Path)) { throw "file not found: $Path" }

$fullName = (Resolve-Path -LiteralPath $Path).Path
$name = Split-Path -Leaf $fullName
$size = (Get-Item -LiteralPath $fullName).Length

$boundary = '----kh' + [Guid]::NewGuid().ToString('N')
$lf = "`r`n"
$ms = New-Object IO.MemoryStream
$w = New-Object IO.BinaryWriter($ms)
$u = [Text.Encoding]::UTF8
$a = [Text.Encoding]::ASCII

$w.Write($a.GetBytes("--$boundary$lf"))
$w.Write($u.GetBytes("Content-Disposition: form-data; name=`"file`"; filename=`"$name`"$lf"))
$w.Write($a.GetBytes("Content-Type: application/pdf$lf$lf"))
$fs = [IO.File]::OpenRead($fullName)
$fs.CopyTo($ms)
$fs.Close()
$w.Write($a.GetBytes("$lf--$boundary--$lf"))
$w.Flush()

$resp = Invoke-WebRequest -Uri 'http://localhost:3000/document/upload' -Method Post `
  -ContentType "multipart/form-data; boundary=$boundary" -Body $ms.ToArray() -UseBasicParsing

Write-Output "uploaded file=$name size=$size bytes"
Write-Output $resp.Content
