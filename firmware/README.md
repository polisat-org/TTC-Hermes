# Firmware

| Sketch | Placa | Papel |
|---|---|---|
| `cubesat_ttc/` | ESP32 (CubeSat) | E32 LoRa ↔ OBC. RDT3.0 sobre LoRa |
| `ground_ttc/` | ESP32 (solo) | PC USB ↔ E32 LoRa |
| `wired_ground/` | ESP32 WROOM-32 (solo, cabeado) | PC USB ↔ UART do OBC, sem rádio. Mesmo protocolo USB do `ground_ttc` |
| `mock_obc/` | NUCLEO-L476RG | OBC + carga útil **simulados**: telemetria 1 Hz e aviões ADS-B a cada 2 s |
| `common/` | — | structs, protocolo, CRC, driver E32, RDT3.0 (incluídos por caminho relativo) |

Protocolos e structs: `../docs/detalhamento_ttc.md`. Análise e pendências: `../docs/analise_ttc.md`.

## Pinagem do E32 (CubeSat e ground)

| Sinal do E32 | ESP32 do CubeSat (`cubesat_ttc`) | ESP32 do ground (`ground_ttc`) |
|---|---|---|
| TXD → RX do ESP32 | **RX2 (GPIO16)** | **RX2 (GPIO16)** |
| RXD ← TX do ESP32 | **TX2 (GPIO17)** | **TX2 (GPIO17)** |
| M0 | D18 (GPIO18) | D18 (GPIO18) |
| M1 | D5 (GPIO5) | D5 (GPIO5) |
| AUX | D15 (GPIO15) | D15 (GPIO15) |

**RX0/TX0 (GPIO3/GPIO1) não são do LoRa.** A UART0 é a mesma ligada ao chip USB-serial da DevKit:

- **Ground:** é a USB que fala com o PC (bridge da `ground_ui`). Não ligue nada em RX0/TX0.
- **CubeSat:** RX0/TX0 são o **canal exclusivo TT&C/OBC**: RX0 (GPIO3) ← TX do OBC, TX0 (GPIO1) → RX do OBC,
  9600 8N1 (`ObcSerial` é uma referência a `Serial`). Consequências:
  - Não use `Serial.print` no `cubesat_ttc`: tudo o que sai em `Serial` vai para o OBC.
  - A cada reset, a ROM do ESP32 imprime o log de boot (115200 baud) em TX0. O OBC, a 9600, recebe isso como
    bytes aleatórios, e alguns podem cair na faixa de telecomando `0x00`–`0x0F`. **O OBC deve ignorar a UART do
    TT&C por ~500 ms depois que o TT&C liga/reseta.**
  - O TX do chip USB da DevKit também está ligado no RX0. Para gravar, tire o ESP32 da PCB (ou desconecte o TX do
    OBC). Se o TT&C não receber nada do OBC na PCB, verifique se o chip USB está segurando a linha.

GPIO5 e GPIO15 são pinos de strapping do ESP32. Funcionam aqui porque o AUX do E32 fica em nível alto ocioso,
que é o nível esperado no boot. Se o ESP32 não der boot com o E32 ligado, comece verificando esses dois.

Diagnóstico de bancada: `diag_e32/` (ground: lê a configuração do E32 e transmite um pacote a cada 3 s),
`rx_monitor/` (ground: só escuta e imprime o que chega) e `diag_e32_sat/` (CubeSat: beacon `SAT<n>` a cada 5 s
e eco do que recebe).

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
