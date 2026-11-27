# Relay COM (Windows) <-> TCP, para rodar o bridge dentro do WSL, que não enxerga portas COM.
#   WSL:     node bridge/server.mjs --tcp-listen 8766
#   Windows: powershell -ExecutionPolicy Bypass -File bridge\com_relay.ps1 -Port COM13
# Se o cabo USB sair (ou a COM sumir), o relay fecha a porta, desconecta do bridge (a UI mostra
# "desconectado") e tenta reabrir a COM a cada 2 s; quando ela volta, reconecta sozinho.
param([string]$Port = "COM13", [int]$Baud = 115200, [string]$TcpHost = "localhost", [int]$TcpPort = 8766)

$sp = New-Object System.IO.Ports.SerialPort $Port, $Baud, "None", 8, "One"
$sp.DtrEnable = $false; $sp.RtsEnable = $false; $sp.ReadTimeout = 50
$buf = New-Object byte[] 4096
$avisouSemPorta = $false

function Fecha-Serial { try { if ($sp.IsOpen) { $sp.Close() } } catch {} }

while ($true) {
  # 1. Porta COM aberta (reabre depois de o cabo sair e voltar)
  if (-not $sp.IsOpen) {
    try {
      $sp.Open()
      Write-Host "[relay] $Port aberto a $Baud"
      $avisouSemPorta = $false
    } catch {
      if (-not $avisouSemPorta) { Write-Host "[relay] $Port indisponível ($($_.Exception.Message)); tentando a cada 2 s" }
      $avisouSemPorta = $true
      Start-Sleep -Seconds 2
      continue
    }
  }
  # 2. Repasse COM <-> bridge
  $tcp = $null
  $motivo = "bridge desconectado"
  try {
    $tcp = New-Object System.Net.Sockets.TcpClient
    $tcp.NoDelay = $true
    $tcp.Connect($TcpHost, $TcpPort)
    $ns = $tcp.GetStream()
    Write-Host "[relay] conectado ao bridge ${TcpHost}:${TcpPort}"
    while ($tcp.Connected) {
      $idle = $true
      try {
        if ($sp.BytesToRead -gt 0) { $n = $sp.Read($buf, 0, $buf.Length); $ns.Write($buf, 0, $n); $idle = $false }
      } catch [System.IO.IOException], [System.InvalidOperationException], [System.UnauthorizedAccessException] {
        $motivo = "$Port caiu ($($_.Exception.Message))"; Fecha-Serial; break
      }
      if ($ns.DataAvailable) {
        $n = $ns.Read($buf, 0, $buf.Length); if ($n -le 0) { break }
        try { $sp.Write($buf, 0, $n) } catch { $motivo = "$Port caiu ($($_.Exception.Message))"; Fecha-Serial; break }
        $idle = $false
      }
      if ($tcp.Client.Poll(0, [System.Net.Sockets.SelectMode]::SelectRead) -and $tcp.Client.Available -eq 0) { break }
      if (-not $sp.IsOpen) { $motivo = "$Port fechou"; break }
      if ($idle) { Start-Sleep -Milliseconds 5 }
    }
  } catch { $motivo = $_.Exception.Message }
  try { if ($tcp) { $tcp.Close() } } catch {}
  Write-Host "[relay] $motivo; tentando de novo em 2 s"
  Start-Sleep -Seconds 2
}
