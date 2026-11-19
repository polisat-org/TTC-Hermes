# Firmware

| Sketch | Placa | Papel |
|---|---|---|
| `cubesat_ttc/` | ESP32 (CubeSat) | E32 LoRa ↔ OBC. RDT3.0 sobre LoRa |
| `ground_ttc/` | ESP32 (solo) | PC USB ↔ E32 LoRa |
| `wired_ground/` | ESP32 WROOM-32 (solo, cabeado) | PC USB ↔ UART do OBC, sem rádio. Mesmo protocolo USB do `ground_ttc` |
| `mock_obc/` | NUCLEO-L476RG | OBC + carga útil **simulados**: telemetria 1 Hz e aviões ADS-B a cada 2 s |
| `common/` | — | structs, protocolo, CRC, driver E32, RDT3.0 (incluídos por caminho relativo) |

Protocolos e structs: `../docs/detalhamento_ttc.md`. Análise e pendências: `../docs/analise_ttc.md`.

## Bancada de teste com dados simulados

```text
NUCLEO-L476RG (mock_obc) ──UART 9600──> ESP32 (wired_ground) ──USB 115200──> ground_ui
```

| NUCLEO-L476RG | | ESP32 WROOM-32 |
|---|---|---|
| **D8 / PA9** (USART1 TX) | → | **GPIO16 / RX2** |
| **D2 / PA10** (USART1 RX) | ← | **GPIO17 / TX2** |
| **GND** | — | **GND** |

**Não use D0/D1 da Nucleo-64.** De fábrica, D0/D1 do header Arduino **não estão ligados ao microcontrolador**: as
pontes de solda SB62/SB63 vêm abertas, e a USART2 (PA2/PA3) vai só para o ST-Link (manual UM1724). O `mock_obc`
espelha os quadros também na USART2, e isso só serve para depuração: dá para ver os bytes na COM do ST-Link a 9600.

Não use **ESP32 TX0/RX0 (GPIO1/3)**: são a UART do conversor USB (CH9102). Ligar outro dispositivo ali gera conflito
elétrico com a USB e atrapalha a gravação.

Se nada chegar (LED do GPIO27 só "respirando"):
1. Confira o **GND comum**.
2. Confira se o fio sai do **D8** (TX) e do **D2** (RX), e **não** do D1/D0 (desligados de fábrica).
3. Confira se chega no pino **RX2 = GPIO16**.

A USART1 da Nucleo é a "UART1 do TT&C" do OBC (Notion).

LED no **GPIO27** do ESP32 (com resistor) indica o enlace:
- 3 piscadas no boot (teste da lâmpada).
- Piscada curta: telemetria `'T'` recebida.
- Piscada dupla: aviões `'P'` recebidos.
- Pulso longo: comando vindo da interface.
- "Respiração" lenta: nada chegou do OBC há mais de 3 s.

O `mock_obc` começa com Mission ativa (`MISSION_ON_AT_BOOT`) e reage aos comandos da interface:
- Detumbling reduz a rotação.
- Pointing encontra um azimute depois de ~8 s.
- Deploy fica travado.
- Mission desligada para de enviar aviões.

## Compilar e gravar (Windows, arduino-cli que vem com a Arduino IDE)

```powershell
$cli = "$env:LOCALAPPDATA\Programs\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe"

# ESP32 (core esp32:esp32 3.3.x)
& $cli compile --fqbn esp32:esp32:esp32 --upload -p COM13 firmware\wired_ground

# NUCLEO-L476RG (core STMicroelectronics:stm32 3.1.x; URL do índice abaixo)
& $cli core install STMicroelectronics:stm32 --additional-urls https://github.com/stm32duino/BoardManagerFiles/raw/main/package_stmicroelectronics_index.json
& $cli compile --fqbn STMicroelectronics:stm32:Nucleo_64:pnum=NUCLEO_L476RG --output-dir build\mock_obc firmware\mock_obc
Copy-Item build\mock_obc\mock_obc.ino.bin D:\    # drive "NOD_L476RG" do ST-Link (mass storage)
```

As portas COM e a letra do drive mudam de PC para PC. Veja no Gerenciador de Dispositivos.
