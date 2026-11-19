# Relay COM (Windows) <-> TCP, para rodar o bridge dentro do WSL, que não enxerga portas COM.
#   WSL:     node bridge/server.mjs --tcp-listen 8766
#   Windows: powershell -ExecutionPolicy Bypass -File bridge\com_relay.ps1 -Port COM13
param([string]$Port = "COM13", [int]$Baud = 115200, [string]$TcpHost = "localhost", [int]$TcpPort = 8766)

$sp = New-Object System.IO.Ports.SerialPort $Port, $Baud, "None", 8, "One"
$sp.DtrEnable = $false; $sp.RtsEnable = $false; $sp.ReadTimeout = 50
$sp.Open()
Write-Host "[relay] $Port aberto a $Baud"
$buf = New-Object byte[] 4096
while ($true) {
  try {
    $tcp = New-Object System.Net.Sockets.TcpClient
    $tcp.NoDelay = $true
    $tcp.Connect($TcpHost, $TcpPort)
    $ns = $tcp.GetStream()
    Write-Host "[relay] conectado ao bridge ${TcpHost}:${TcpPort}"
    while ($tcp.Connected) {
      $idle = $true
      if ($sp.BytesToRead -gt 0) { $n = $sp.Read($buf, 0, $buf.Length); $ns.Write($buf, 0, $n); $idle = $false }
      if ($ns.DataAvailable) { $n = $ns.Read($buf, 0, $buf.Length); if ($n -le 0) { break }; $sp.Write($buf, 0, $n); $idle = $false }
      if ($tcp.Client.Poll(0, [System.Net.Sockets.SelectMode]::SelectRead) -and $tcp.Client.Available -eq 0) { break }
      if ($idle) { Start-Sleep -Milliseconds 5 }
    }
  } catch { Write-Host "[relay] $($_.Exception.Message)" }
  try { $tcp.Close() } catch {}
  Write-Host "[relay] bridge desconectado; tentando de novo em 2 s"
  Start-Sleep -Seconds 2
}
