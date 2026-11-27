# Detalhamento TTC — Hermes

## 1. Visão geral

O TT&C usa dois ESP32 WROOM de 30 pinos e dois módulos E32-433T20D. O E32 é usado no modo transparente: o ESP32 escreve bytes na UART e o módulo transmite; bytes recebidos do ar aparecem na UART.

Como o E32 transparente não oferece sequência, ACK, detecção de duplicata ou fragmentação, essas funções são implementadas em software pelo RDT3.0.

O OBC continua responsável pelas prioridades de missão. O ESP32 do CubeSat apenas entrega o byte de telecomando e devolve telemetria/payload.

## 2. Pinagem e conexões

> **Atenção:** nos dois ESP32 o E32 fica na UART2 (RX2/TX2 = 16/17). RX0/TX0 não são usados pelo LoRa: no ground são a USB do PC, no CubeSat são o canal exclusivo TT&C/OBC (UART do OBC: RX0 = GPIO3, TX0 = GPIO1). Ver [`firmware/README.md`](../firmware/README.md#pinagem-do-e32-cubesat-e-ground).

### 2.1 CubeSat

| Sinal ESP32 | GPIO | Direção | Conecta em |
|---|---:|---|---|
| `E32_RX_PIN` | 16 (RX2) | entrada | TX do E32 |
| `E32_TX_PIN` | 17 (TX2) | saída | RX do E32 |
| `E32_M0_PIN` | 18 | saída | M0 do E32 |
| `E32_M1_PIN` | 5 | saída | M1 do E32 |
| `E32_AUX_PIN` | 15 | entrada | AUX do E32 |
| `OBC_RX_PIN` | 3 (RX0) | entrada | TX do OBC |
| `OBC_TX_PIN` | 1 (TX0) | saída | RX do OBC |
| `TTC_BUSY_PIN` | 13 | saída | J2-10 do barramento → PC0 do OBC |
| `STATUS_LED_PIN` | 2 | saída | LED azul da DevKit |

### 2.2 Ground

| Sinal ESP32 | GPIO | Direção | Conecta em |
|---|---:|---|---|
| `E32_RX_PIN` | 16 | entrada | TX do E32 |
| `E32_TX_PIN` | 17 | saída | RX do E32 |
| `E32_M0_PIN` | 18 | saída | M0 do E32 |
| `E32_M1_PIN` | 5 | saída | M1 do E32 |
| `E32_AUX_PIN` | 15 | entrada | AUX do E32 |
| `STATUS_LED_PIN` | 13 | saída | LED |
| USB | — | bidirecional | PC |

### 2.3 Alimentação do E32

O E32-433T20D pode transmitir com 20 dBm. Para operação em voo:

1. Cortar a trilha que liga `VCC` do E32 ao regulador de 3,3 V.
2. Ligar `VCC` do E32 ao rail de 5 V.
3. Soldar `100 µF` eletrolítico e `0,1 µF` cerâmico entre `VCC` e `GND`, o mais próximo possível do módulo.
4. Manter a UART do E32 em 3,3 V. O E32 não é tolerante a 5 V nos pinos de lógica.

O módulo está soldado diretamente na PCB; a modificação deve ser feita com o módulo já montado, conforme a praça disponível.

## 3. Configuração do E32

### 3.1 Modos

| M0 | M1 | Modo |
|---:|---:|---|
| 0 | 0 | normal |
| 1 | 1 | configuração |

### 3.2 Parâmetros

- UART: `9600 8N1`.
- Configuração de fábrica: `C0 00 00 1A 17 44`.
  - `ADDH = 0x00`
  - `ADDL = 0x00`
  - `SPED = 0x1A`
  - `CHAN = 0x17`
  - `OPTION = 0x44`

### 3.3 Leitura

Com `M0=1` e `M1=1`, enviar:

```text
C1 C1 C1
```

O módulo responde com 6 bytes:

```text
C1 ADDH ADDL SPED CHAN OPTION
```

### 3.4 Escrita

Com `M0=1` e `M1=1`, enviar:

```text
C2 ADDH ADDL SPED CHAN OPTION
```

O módulo responde com:

```text
C2 ADDH ADDL SPED CHAN OPTION
```

A implementação lê a configuração atual, altera apenas os bits de potência e escreve de volta, preservando endereço, canal e taxa.

### 3.5 Potência

Os bits 1–0 de `OPTION` definem a potência:

| Bits 1–0 | Potência |
|---|---|
| `00` | 20 dBm |
| `01` | 17 dBm |
| `10` | 14 dBm |
| `11` | 10 dBm |

O valor padrão `0x44` tem bits 1–0 iguais a `00`, portanto 20 dBm.

### 3.6 AUX

`AUX` fica baixo enquanto o E32 está ocupado:

- inicializando;
- recebendo;
- transmitindo;
- em modo configuração.

Antes de transmitir, o firmware espera `AUX` alto. Depois de escrever no E32, espera `AUX` voltar a alto para confirmar que o pacote saiu do buffer.

## 4. Interface PC ↔ Ground

### 4.1 PC → Ground

O PC envia um único byte:

```text
0x00 a 0x0F
```

O ground ignora bytes fora dessa faixa.

### 4.2 Ground → PC, status de comando

Para cada comando aceito, o ground responde:

```text
'A' cmd status
```

| Campo | Tamanho | Descrição |
|---|---:|---|
| `'A'` | 1 | identificador de resposta de comando |
| `cmd` | 1 | byte original do comando |
| `status` | 1 | `0x00` sucesso, `0x01` falha, `0x02` ocupado |

O status `0x02` é enviado imediatamente quando a fila de comandos está cheia.

### 4.3 Ground → PC, telemetria

```text
'T' + Telemetry_t
```

Total: `1 + 79 = 80` bytes.

### 4.4 Ground → PC, payload

```text
'P' + count + count * Plane_t
```

Total: `2 + count * 16` bytes, com `count <= 20`.

## 5. Interface OBC ↔ CubeSat

### 5.1 CubeSat → OBC

Um byte:

```text
0x00 a 0x0F
```

O OBC deve ler a UART por interrupção e tratar os bits:

- bit 0: Mission
- bit 1: Deploy
- bit 2: Detumbling
- bit 3: Pointing

### 5.2 OBC → CubeSat, telemetria

```text
'T' + Telemetry_t
```

Total: `1 + 79 = 80` bytes.

### 5.3 OBC → CubeSat, payload

```text
'P' + count + count * Plane_t
```

Total: `2 + count * 16` bytes.

O firmware do CubeSat valida `count <= 20`; se `count` for inválido, descarta o quadro e volta ao estado de espera de tipo.

## 6. Estruturas de dados

### 6.1 Telemetry_t

`Telemetry_t` é `packed` e tem 79 bytes.

| Offset | Campo | Tipo | Tamanho |
|---:|---|---|---:|
| 0 | `timestamp_ms` | `uint32_t` | 4 |
| 4 | `uptime_ms` | `uint32_t` | 4 |
| 8 | `mode` | `uint8_t` | 1 |
| 9 | `flags` | `uint8_t` | 1 |
| 10 | `error_count` | `uint16_t` | 2 |
| 12 | `battery_voltage` | `float` | 4 |
| 16 | `battery_current` | `float` | 4 |
| 20 | `temperature` | `float` | 4 |
| 24 | `gyro_x` | `int16_t` | 2 |
| 26 | `gyro_y` | `int16_t` | 2 |
| 28 | `gyro_z` | `int16_t` | 2 |
| 30 | `accel_x` | `int16_t` | 2 |
| 32 | `accel_y` | `int16_t` | 2 |
| 34 | `accel_z` | `int16_t` | 2 |
| 36 | `mag_x` | `int16_t` | 2 |
| 38 | `mag_y` | `int16_t` | 2 |
| 40 | `mag_z` | `int16_t` | 2 |
| 42 | `latitude` | `float` | 4 |
| 46 | `longitude` | `float` | 4 |
| 50 | `altitude` | `float` | 4 |
| 54 | `deploy_state` | `uint8_t` | 1 |
| 55 | `detumbling_state` | `uint8_t` | 1 |
| 56 | `pointing_state` | `uint8_t` | 1 |
| 57 | `mission_state` | `uint8_t` | 1 |
| 58 | `command_count` | `uint16_t` | 2 |
| 60 | `telemetry_count` | `uint16_t` | 2 |
| 62 | `packet_count` | `uint16_t` | 2 |
| 64 | `reserved` | `uint8_t[15]` | 15 |

### 6.2 Plane_t

`Plane_t` é `packed` e tem 16 bytes.

| Offset | Campo | Tipo | Tamanho |
|---:|---|---|---:|
| 0 | `id` | `uint16_t` | 2 |
| 2 | `type` | `uint8_t` | 1 |
| 3 | `flags` | `uint8_t` | 1 |
| 4 | `latitude` | `float` | 4 |
| 8 | `longitude` | `float` | 4 |
| 12 | `confidence` | `float` | 4 |

## 7. Pacote RDT

### 7.1 Cabeçalho

O cabeçalho tem 12 bytes e é `packed`.

| Offset | Campo | Tamanho | Descrição |
|---:|---|---:|---|
| 0 | `magic0` | 1 | `0xA5` |
| 1 | `magic1` | 1 | `0x5A` |
| 2 | `type` | 1 | `1 = DATA`, `2 = ACK` |
| 3 | `seq` | 1 | sequência `0` ou `1` |
| 4 | `session` | 1 | sessão de boot do transmissor |
| 5 | `msg_id` | 1 | identificador da mensagem |
| 6 | `frag_idx` | 1 | índice do fragmento |
| 7 | `frag_total` | 1 | total de fragmentos |
| 8 | `total_len` | 2 | tamanho total, little-endian |
| 10 | `frag_len` | 2 | tamanho do fragmento, little-endian |

### 7.2 Formato completo

```text
cabeçalho (12) + payload + crc16 (2)
```

O CRC é calculado sobre o cabeçalho mais o payload, sem os dois bytes do CRC. Usa polinômio `0x1021`, valor inicial `0xFFFF`, sem reflexão e sem XOR final.

Tamanho máximo: `12 + 128 + 2 = 142` bytes.

### 7.3 ACK

O ACK usa o mesmo cabeçalho, com:

- `type = 2`
- `seq` igual ao do DATA confirmado
- `session`, `msg_id`, `frag_idx` e `frag_total` copiados do DATA
- `total_len = 0`
- `frag_len = 0`

O ACK não tem payload; o CRC cobre apenas os 12 bytes do cabeçalho.

## 8. RDT3.0

### 8.1 Constantes

| Constante | Valor |
|---|---:|
| `RDT_TIMEOUT_MS` | 2500 |
| `RDT_MAX_RETRIES` | 5 |
| `RDT_ACK_DELAY_MS` | 50 |
| `RDT_MAX_PAYLOAD` | 128 |
| `RDT_MAX_MESSAGE` | 384 |
| `RDT_MAX_FRAGS` | 8 |
| `RDT_RX_BUF` | 512 |

### 8.2 Transmissor

Para cada mensagem:

1. Calcular `frag_total = ceil(len / 128)`.
2. Incrementar `msg_id`.
3. Para cada fragmento:
   1. Montar DATA com `seq`, `session`, `msg_id`, `frag_idx`, `frag_total`, `total_len` e `frag_len`.
   2. Calcular CRC.
   3. Enviar pelo E32.
   4. Esperar ACK com a mesma sessão, `msg_id`, `frag_idx` e `seq`.
   5. Se não chegar em `2500 ms`, reenviar.
   6. Após sucesso, alternar `seq`.
   7. Se estourar `RDT_MAX_RETRIES`, retornar falha.
4. Retornar sucesso após o último ACK.

`session` é gerado no boot com `esp_random()`. O transmissor mantém `seq` e `msg_id` entre mensagens.

### 8.3 Receptor

Para cada DATA válido:

1. Se a sessão mudou, aceitar a nova sessão, zerar a remontagem e ajustar `expected_seq` ao `seq` recebido.
2. Se `seq == last_ack_seq`, é duplicata: reenviar ACK e não entregar.
3. Se `seq != expected_seq`, ignorar.
4. Validar `frag_total`, `frag_idx`, `total_len` e limites do buffer.
5. Se `frag_idx == 0`, iniciar nova remontagem.
6. Copiar o payload em `frag_idx * 128`.
7. Marcar o bit do fragmento.
8. Alternar `expected_seq` e atualizar `last_ack_seq`.
9. Enviar ACK.
10. Se todos os fragmentos chegaram, entregar `total_len` bytes.

O receptor descarta o quadro e não envia ACK se o cabeçalho for inválido.

### 8.4 Sessão

`sessão` tem 8 bits. Ela diferencia um reboot do transmissor de uma retransmissão normal. Quando o receptor vê uma sessão diferente, reinicia o estado de sequência e remontagem.

### 8.5 Fragmentação

- Telemetria de 80 bytes: 1 fragmento.
- Payload de 322 bytes: 3 fragmentos.
- Comando de 1 byte: 1 fragmento.

## 9. Ground

### 9.1 Boot

1. Iniciar USB em `115200 8N1`.
2. Configurar LED.
3. Iniciar E32 em `9600 8N1`.
4. Aplicar potência configurada.
5. Iniciar RDT com sessão aleatória.
6. Marcar `last_radio_activity = millis()`.

### 9.2 Loop

1. Ler bytes da USB e enfileirar comandos `0x00–0x0F`.
2. Se a fila estiver cheia, responder `'A' cmd 0x02`.
3. Se houver bytes no E32, atualizar `last_radio_activity`.
4. Chamar `pollMessage` para receber telemetria/payload.
5. Se receber telemetria válida, escrever `'T' + 79` na USB.
6. Se receber payload válido, escrever `'P' + count + count*16` na USB.
7. Se houver comando na fila e o enlace estiver ocioso por `TX_GUARD_MS = 1000 ms`:
   1. Esperar `AUX` alto.
   2. Enviar o comando via RDT.
   3. Escrever `'A' cmd status` na USB.
   4. Atualizar `last_radio_activity`.

### 9.3 Fila de comandos

- Profundidade: 4.
- FIFO circular.
- Um comando é removido antes do envio; se o envio falhar, o status é `0x01`.
- Comandos recebidos com fila cheia não entram na fila.

### 9.4 Validação antes de enviar ao PC

Telemetria:

- `len == 1 + sizeof(Telemetry_t)`
- primeiro byte `'T'`

Payload:

- `len >= 2`
- primeiro byte `'P'`
- `count <= 20`
- `len == 2 + count * sizeof(Plane_t)`

## 10. CubeSat

### 10.1 Boot

1. Configurar LED e `TTC_BUSY` como saídas baixas.
2. Iniciar UART do OBC em `9600 8N1`.
3. Registrar interrupção de RX da UART do OBC.
4. Iniciar E32 em `9600 8N1`.
5. Aplicar potência configurada.
6. Iniciar RDT com sessão aleatória.

### 10.2 Loop

1. Atualizar `TTC_BUSY`.
2. Ler e montar quadros do OBC.
3. Se houver telemetria/payload pronto, enviar via RDT.
4. Processar comandos recebidos via RDT.
5. Se o comando for válido, acionar `TTC_BUSY`, escrever no OBC e liberar após 2 ms.
6. Atualizar LED.

### 10.3 Parser do OBC

Estados:

```text
WAIT_TYPE
TELEMETRY
PAYLOAD_COUNT
PAYLOAD
```

Regras:

- Em `WAIT_TYPE`, aceitar apenas `'T'` ou `'P'`.
- Em `TELEMETRY`, acumular até `1 + 79` bytes.
- Em `PAYLOAD_COUNT`, aceitar `count <= 20`.
- Em `PAYLOAD`, acumular `count * 16` bytes.
- `count = 0` conclui o payload imediatamente após o byte de count.
- Ao concluir, marcar `downlink_ready`.

### 10.4 Download

- Se `downlink_ready`, acionar `TTC_BUSY`.
- Enviar o buffer via `sendMessage`.
- Limpar `downlink_ready`.
- Manter `TTC_BUSY` por mais `2 ms`.
- Em caso de falha, descartar o quadro e continuar; a telemetria é periódica.

## 11. TTC_BUSY

### 11.1 Regra

`TTC_BUSY` é alto quando:

- `AUX` do E32 está baixo; ou
- há downlink pronto; ou
- o firmware está escrevendo um comando no OBC; ou
- ainda não passaram `2 ms` desde a última atividade.

### 11.2 Temporização

```text
AUX baixo                  AUX alto
    |-------------------------|
    |                         |
TTC_BUSY alto ---------------+
                              | 2 ms |
                              +------+
```

- O OBC deve verificar `TTC_BUSY` antes de começar um quadro de telemetria.
- O OBC deve verificar `Serial.available()` antes de concluir que não há comando.
- Pulsos curtos de `TTC_BUSY` durante ACK são aceitáveis.

## 12. Buffers

| Buffer | Tamanho | Uso |
|---|---:|---|
| RX OBC | 1024 | bytes recebidos do OBC por interrupção |
| RX E32 | 512 | bytes recebidos do E32 por interrupção |
| Remontagem RDT | 384 | mensagem RDT em montagem |
| Downlink CubeSat | 384 | telemetria ou payload pronto |
| Fila de comandos ground | 4 | comandos PC aguardando envio |

## 13. Taxas e tempos

- UART E32: 9600 8N1.
- UART OBC: 9600 8N1.
- USB ground: 115200 8N1.
- Timeout RDT: 2500 ms.
- Atraso de ACK: 50 ms.
- Guarda de TX do ground: 1000 ms.
- Liberação de `TTC_BUSY`: 2 ms.
- LED de atividade: 50 ms.

## 14. Tratamento de erros

- CRC inválido: descartar pacote e procurar próximo `0xA5 0x5A`.
- Magic inválido: descartar byte e continuar.
- `frag_len > 128`: descartar pacote.
- `frag_total > 8`: descartar.
- `total_len > 384`: descartar.
- Sessão nova: reiniciar estado de recepção.
- ACK perdido: retransmitir DATA.
- Data duplicado: reenviar ACK sem entregar novamente.
- Fila de comandos cheia: status `0x02`.
- Falha de transmissão: status `0x01` no ground; descarte no CubeSat.
- `count > 20`: descartar payload e voltar a `WAIT_TYPE`.

## 15. Compilação

```bash
arduino-cli compile --fqbn esp32:esp32:esp32 firmware/cubesat_ttc
arduino-cli compile --fqbn esp32:esp32:esp32 firmware/ground_ttc
```

## 16. Testes

### 16.1 Bancada

1. Alimentar os dois E32 e conectar os ESP32.
2. Confirmar `AUX` alto em repouso.
3. Confirmar leitura `C1` e escrita `C2` com potência desejada.
4. Abrir o PC na USB do ground.
5. Enviar `0x01` e verificar status `'A' 0x01 0x00`.
6. Confirmar que o OBC recebeu `0x01`.
7. Injetar telemetria no OBC e verificar `'T' + 79` no PC.
8. Injetar payload com `count = 1` e verificar `'P' + 1 + 16`.
9. Repetir com `count = 20`.
10. Desligar o ACK do receptor e confirmar retransmissão.
11. Reiniciar o CubeSat e confirmar nova sessão.
12. Medir `TTC_BUSY` com analisador lógico.

### 16.2 Voo

1. Confirmar alimentação de 5 V no E32.
2. Confirmar capacitores próximos ao módulo.
3. Confirmar que a UART do E32 está em 3,3 V.
4. Confirmar potência configurada.
5. Confirmar que o OBC respeita `TTC_BUSY`.

## 17. Observações

- Não usar `Serial.print` para dados binários no ground.
- Usar `Serial.write`.
- O OBC tem prioridade sobre Deploy e Detumbling; o ESP32 não decide prioridade.
- O E32 é half-duplex; colisões são tratadas por retransmissão RDT.
- O ground evita enviar comando enquanto há atividade recente no enlace.
