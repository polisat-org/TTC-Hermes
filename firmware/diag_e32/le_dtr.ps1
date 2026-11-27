param([string]$Port="COM20",[int]$Seg=14,[string]$Envia="")
$ate=(Get-Date).AddSeconds(15)
while(-not ([System.IO.Ports.SerialPort]::GetPortNames() -contains $Port)){ if((Get-Date) -gt $ate){ Write-Host "[le] $Port nao apareceu"; exit 1 }; Start-Sleep -Milliseconds 500 }
$sp = New-Object System.IO.Ports.SerialPort $Port,115200,"None",8,"One"
$sp.DtrEnable=$true; $sp.RtsEnable=$true
try { $sp.Open() } catch { Write-Host "[le] falha ao abrir: $($_.Exception.Message)"; exit 2 }
Write-Host "[le] $Port aberta"
Start-Sleep -Milliseconds 300
if ($Envia) { $sp.Write($Envia) }
$fim=(Get-Date).AddSeconds($Seg)
while((Get-Date) -lt $fim){ $s=$sp.ReadExisting(); if($s){ [Console]::Write($s) }; Start-Sleep -Milliseconds 50 }
$sp.Close()
