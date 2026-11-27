param([string]$Port="COM13",[int]$Seg=14,[string]$Envia="c")
$sp = New-Object System.IO.Ports.SerialPort $Port,115200,"None",8,"One"
$sp.DtrEnable=$false; $sp.RtsEnable=$false; $sp.Open()
Start-Sleep -Milliseconds 300
if ($Envia) { $sp.Write($Envia) }
$fim=(Get-Date).AddSeconds($Seg)
while((Get-Date) -lt $fim){ $s=$sp.ReadExisting(); if($s){ [Console]::Write($s) }; Start-Sleep -Milliseconds 50 }
$sp.Close()
