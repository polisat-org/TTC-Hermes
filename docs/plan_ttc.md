# Plano TTC — Hermes

## 1. Objetivo

Implementar o subsistema de TT&C do CubeSat com dois firmwares ESP32:

- `cubesat_ttc`: ponte entre o rádio LoRa E32 e o OBC.
- `ground_ttc`: ponte entre o PC e o rádio LoRa E32.

O enlace usa LoRa transparente com RDT3.0 stop-and-wait sobre os bytes do E32.

## 2. Arquitetura

### CubeSat

```text
OBC UART <-> ESP32 CubeSat <-> E32 <-> enlace LoRa
```

- Telecomando recebido por LoRa é entregue ao OBC pela UART.
- Telemetria e payload recebidos do OBC são enviados ao ground por LoRa.
- `TTC_BUSY` informa ao OBC que o TT&C está ocupado.

### Ground

```text
PC USB <-> ESP32 Ground <-> E32 <-> enlace LoRa
```

- Comando do PC é enviado ao CubeSat por LoRa.
- Telemetria/payload recebidos do CubeSat são entregues ao PC pela USB.
- O ground devolve um pacote de status para cada comando.

## 3. Estrutura de arquivos

```text
TTC-Hermes/
├── docs/
│   ├── plan_ttc.md
│   ├── detalhamento_ttc.md
│   └── analise_ttc.md
├── firmware/
│   ├── common/          crc16.h, protocol.h, telemetry.h, e32.h, rdt3.h, uart_rx.h
│   ├── cubesat_ttc/     cubesat_ttc.ino
│   ├── ground_ttc/      ground_ttc.ino
│   ├── wired_ground/    wired_ground.ino  (solo cabeado, sem rádio)
│   └── mock_obc/        mock_obc.ino      (NUCLEO-L476RG, dados simulados)
└── ground_ui/           bridge Node + interface React
```

## 4. Interfaces

### PC -> Ground

Um byte cru:

```text
0x00 a 0x0F
```

Bits:

- bit 0: Mission
- bit 1: Deploy
- bit 2: Detumbling
- bit 3: Pointing

### Ground -> PC

```text
'A' + cmd + status
```

Status:

- `0x00`: sucesso
- `0x01`: falha
- `0x02`: ocupado

### Ground -> PC, telemetria

```text
'T' + Telemetry_t
```

`Telemetry_t` tem 79 bytes.

### Ground -> PC, payload

```text
'P' + count + count * Plane_t
```

`count <= 20`, `Plane_t = 16 bytes`, tamanho máximo `2 + 20 * 16 = 322`.

### CubeSat -> OBC

Um byte de comando `0x00` a `0x0F`.

### OBC -> CubeSat

```text
'T' + Telemetry_t
'P' + count + count * Plane_t
```

## 5. Protocolo RDT3.0

- Stop-and-wait com sequência alternada `0/1`.
- ACK por fragmento.
- Timeout de `2500 ms`.
- Até `5` retransmissões.
- Atraso de ACK de `50 ms`.
- Sessão de boot de 8 bits.
- Detecção de duplicata por `seq`.
- Fragmentação e remontagem por `msg_id`, `frag_idx` e `frag_total`.
- Payload máximo por fragmento: `128` bytes.
- Mensagem máxima: `384` bytes.
- CRC-16/CCITT-FALSE.

## 6. Configuração do E32

- UART: `9600 8N1`.
- Modo normal: `M0=0`, `M1=0`.
- Modo configuração: `M0=1`, `M1=1`.
- Leitura de configuração: `C1 C1 C1`.
- Escrita de configuração: `C2 ADDH ADDL SPED CHAN OPTION`.
- Potência configurável nos bits 1–0 de `OPTION`:
  - `00`: 20 dBm
  - `01`: 17 dBm
  - `10`: 14 dBm
  - `11`: 10 dBm
- Valor padrão de fábrica: `C0 00 00 1A 17 44`.
- Em voo, alimentar o E32 com 5 V, cortar a trilha de 3,3 V e adicionar `100 µF` + `0,1 µF` junto ao módulo.

## 7. Pinagem padrão

| Sinal | GPIO |
|---|---:|
| E32 RX | 16 (RX2) |
| E32 TX | 17 (TX2) |
| E32 M0 | 18 |
| E32 M1 | 5 |
| E32 AUX | 15 |
| OBC RX | 3 (RX0) |
| OBC TX | 1 (TX0) |
| TTC_BUSY | 13 |
| LED | 2 |

## 8. TTC_BUSY

- Ativo alto.
- Acionado quando `AUX` do E32 está baixo.
- Acionado durante recepção de comando, envio de ACK, escrita no OBC e download.
- Liberado após `TTC_BUSY_RELEASE_MS = 2 ms` sem atividade.
- O OBC deve consultar `TTC_BUSY` antes de iniciar telemetria e checar `Serial.available()`.

## 9. Validação

1. Compilar os dois sketches para `esp32:esp32:esp32`.
2. Testar configuração do E32 e leitura de `OPTION`.
3. Testar comando PC -> ground -> CubeSat -> OBC.
4. Testar status `'A'` no PC.
5. Testar telemetria OBC -> CubeSat -> ground -> PC.
6. Testar payload com `count = 0`, `1` e `20`.
7. Testar perda de ACK e retransmissão.
8. Testar reboot do CubeSat e mudança de sessão.
9. Testar `TTC_BUSY` durante uplink e downlink.

## 10. Detalhamento

A especificação completa de pacotes, offsets, máquinas de estado, buffers, tempos e sequência de boot está em `detalhamento_ttc.md`.
