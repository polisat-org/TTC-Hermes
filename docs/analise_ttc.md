# Análise TT&C — Hermes (branch `comms`)

Referências: `plan_ttc.md`, `detalhamento_ttc.md`, firmware em `firmware/common/`, `firmware/cubesat_ttc/`, `firmware/ground_ttc/`,
regras *CubeDesign 2026 — CubeSat* (`contexto/Rules 2026 - CubeSat (1).pdf`) e página Notion
"Comunicação com outros subsistemas" (OBC).

> Os sketches compilam com `esp32:esp32` 3.3.12 (verificado depois). A análise é de leitura do código. A interface de solo nova (`ground_ui/`) foi testada com o simulador.

## Veredito

| Área | Situação |
|---|---|
| Camada de enlace (E32 + RDT3.0 + CRC) | **Boa base.** Stop-and-wait, sessão, duplicatas, fragmentação e CRC estão implementados e coerentes com o detalhamento. |
| Ground station (firmware) | **Funciona para TC/TM básico, mas não basta para a missão.** Risco de *starvation* do uplink, enlace USB sem framing e só faz ponte: não havia software de solo (requisito 4.4.2 / HLR-COMM). |
| Conteúdo dos dados (Telemetry_t / Plane_t) | **Insuficiente para as regras.** `Plane_t` não carrega ICAO de 24 bits, altitude, velocidade, rumo nem timestamp (HLR-ADS-02, HLR-ADS-07, 4.4.1). Falta campo de azimute (Notion). |
| Software de solo / análise | **Não existia → criado em `ground_ui/`** (bridge serial↔WebSocket + React, logs para pós-análise, replay, simulador). |

Para o **nível básico** (receber TC e enviar TM via RF) o código atual provavelmente passa. Para a **missão ADS-B**
(trajetórias, ICAO, altitude, velocidade, timestamp) e para pontuar em HLR-SW-02 e HLR-ADS-08, os itens P0/P1 abaixo são necessários.

---

## P0 — Corrigir antes da competição

### 1. Uplink pode nunca sair (starvation pelo `TX_GUARD_MS`)

`ground_ttc.ino:102` só transmite se não houve atividade de rádio por `TX_GUARD_MS = 1000 ms`, e
`ground_ttc.ino:142-148` renova `lastRadioActivity` a cada byte recebido. Com o E32 em 2,4 kbps (SPED `0x1A`):

| Mensagem | Bytes no ar (DATA + ACK) | Tempo aprox. |
|---|---:|---:|
| TM (`'T'`+79) | 94 + 14 | ~0,4 s |
| Payload 20 aviões (`'P'`+322, 3 fragmentos) | 364 + 42 | ~1,4 s + 3×50 ms + latência E32 |

Se o OBC mandar TM a ~1 Hz (mais payload), o canal nunca fica 1 s em silêncio: **os comandos ficam presos na fila
e o PC não recebe nem `'A'`**. Isso atinge diretamente o teste de comunicação, o deploy por comando e o detumbling.

**Correção sugerida:** abrir uma janela de uplink logo após o ground **terminar de ACKar** uma mensagem do CubeSat.
Nesse momento o CubeSat acabou o `sendMessage` e está em `pollMessage`. Ex.: enviar a fila quando
`pollMessage` acabou de entregar uma mensagem, ou quando `now - lastRadioActivity >= 150 ms`, e não 1000 ms.
Alternativa: o OBC limita o período de TM (≥ 3 s) e o ground usa guarda menor.

### 2. Os dois lados descartam DATA do outro enquanto esperam ACK

`rdt3.h:227-243` (`waitAck`) consome e **joga fora** qualquer DATA recebido. Se ground e CubeSat transmitem ao
mesmo tempo (half-duplex), nenhum ACKa o outro. Os dois esgotam as 6 tentativas (~15 s), o ground reporta `0x01`
e o CubeSat descarta o quadro. O CubeSat transmite sem guarda nenhuma (`cubesat_ttc.ino:151`), então isso acontece sempre
que um comando cruza com telemetria.

**Correção sugerida:** em `waitAck`, quando chegar DATA válido, ACKá-lo e guardar a mensagem (mesma lógica do
`pollMessage`) em vez de descartar. Mais simples: o lado CubeSat sempre cede (pausa aleatória de 200–800 ms antes
de retransmitir) e o ground tem prioridade.

### 3. `Plane_t` não atende os requisitos da missão

As regras exigem ICAO, posição, altitude, velocidade (HLR-ADS-02), rumo e trajetória (4.4.1) e **timestamp por
mensagem** com resolução suficiente para reconstruir trajetórias (HLR-ADS-07). Hoje `Plane_t` tem
`id (u16)`, `type`, `flags`, `lat`, `lon`, `confidence`:

- ICAO tem **24 bits**: não cabe em `uint16_t`.
- Faltam altitude, velocidade, rumo e timestamp.

Proposta (28 bytes, packed, a validar com a equipe de carga útil):

```c
struct __attribute__((packed)) Plane_t {   // v2
  uint32_t icao;          // 24 bits usados
  uint32_t timestamp_ms;  // relógio do OBC da última posição decodificada
  float    latitude;
  float    longitude;
  int32_t  altitude_ft;
  uint16_t ground_speed_kt;
  uint16_t heading_cdeg;  // 0..35999 (0,01°)
  int16_t  vertical_rate_fpm;
  uint8_t  flags;         // bit0 pos válida, bit1 vel válida, bit2 on-ground...
  uint8_t  msg_count;     // mensagens desta aeronave no ciclo
};
static_assert(sizeof(Plane_t) == 28, "Plane_t size");
```

Com 20 aviões, `'P'` vira `2 + 20×36 = 722 B` (36 B por avião desde a inclusão do indicativo). `RDT_MAX_MESSAGE` = 768 (6 fragmentos ≤ `RDT_MAX_FRAGS = 8`)
e os buffers `downlinkBuffer` e `rxAssembly_`, ou paginar em dois quadros `'P'` de até 10 aviões. A UI concentra toda a
decodificação em `ground_ui/bridge/protocol.mjs` (`decodePlane`): mudar o struct é trocar só essa função.

---

## P1 — Importante para pontuação / robustez

### 4. Enlace USB ground→PC sem sincronismo nem CRC

`'A'/'T'/'P'` são escritos crus (`ground_ttc.ino:60-80`). Ao abrir a porta, o ESP32 costuma resetar e o ROM
imprime texto a 115200 (`ets Jun 8 2016 … POWERON_RESET …`). No teste com o simulador, o parser **aceitou uma
telemetria falsa** montada com o texto de boot mais o começo de um quadro real. O parser da UI agora tem heurísticas
(plausibilidade + *look-ahead*: 12.000/12.000 quadros recuperados, 1 falso em 300 boots simulados), mas o certo é
enquadrar no firmware:

```c
// ground_ttc.ino — substitui Serial.write direto
void writeFrame(uint8_t type, const uint8_t *data, uint16_t len) {
  uint8_t hdr[5] = {0xAA, 0x55, type, (uint8_t)(len & 0xFF), (uint8_t)(len >> 8)};
  uint16_t crc = crc16_ccitt_false(hdr + 2, 3);           // type + len
  for (uint16_t i = 0; i < len; ++i) crc = crc16_update(crc, data[i]);
  Serial.write(hdr, 5); Serial.write(data, len);
  Serial.write((uint8_t)(crc & 0xFF)); Serial.write((uint8_t)(crc >> 8));
}
```

(`crc16_update` = laço interno de `crc16_ccitt_false` com o estado como parâmetro.) Se adotarem, aviso e a mudança
no `StreamParser` é pequena.

### 5. Campos faltando / não documentados em `Telemetry_t`

- **Azimute:** pelo Notion, o ADCS devolve string de 5 chars (`"270.5"`) que "vai para o struct de telemetria",
  mas não há campo para ela. A UI já lê `reserved[0..4]` como ASCII. Sugestão: oficializar
  `char azimuth[5]` no lugar de `reserved[0..4]` (ficam 10 bytes reservados, tamanho 79 mantido).
- **Escala do giroscópio** não está definida em lugar nenhum. O teste de detumbling é em rpm (60 → < 5).
  A UI assume `16.4 LSB/(°/s)` (±2000 °/s, necessário para 360 °/s), em `ground_ui/src/store.ts` (`GYRO_LSB_PER_DPS`).
  Confirmar com o ADCS.
- **Temperatura da bateria** separada (HLR-EPS-04 e teste térmico: "bateria > 0 °C"). Hoje há uma só `temperature`.
- **Convenção de sinal de `battery_current`** (carga > 0?) para o teste de carga por luz.
- **Significado de `mode`, `flags`, `*_state`**: HLR-SW-02 exige dados *documentados*. Uma tabela no `detalhamento_ttc.md` basta.

### 6. "Falha" do ground ≠ comando não executado

Se o último ACK se perde, o CubeSat já entregou o comando ao OBC, mas o ground reporta `0x01`. Como o comando é
um **vetor de estado** (bitmask), reenviar é idempotente, o que está certo. Mas a confirmação real tem que vir da
telemetria (`command_count`, `*_state`). A UI mostra as duas coisas e deixa isso explícito.

### 7. Canal/endereço default do E32

`E32Driver::configure` preserva ADDH/ADDL/CHAN do módulo (default `00 00` / `0x17`). O E32-433 é muito comum, e
outras equipes no evento provavelmente estarão no mesmo canal default. Magic + CRC filtram o lixo, mas o canal ocupado
gera colisões e reforça o problema 1. Fixar um `CHAN` e um endereço próprios, iguais nos dois lados, no `configure`.

### 8. Taxa no ar

Com 2,4 kbps o enlace fica perto da saturação (TM + payload ≈ 2 s de ar por ciclo). Em distância de bancada/arena,
4,8 ou 9,6 kbps (`SPED` bits 2–0 = `011`/`100`) dão folga e reduzem a latência (HLR-ADS-08). Avaliar alcance.

**Decidido (27/11/2026): 4,8 kbps.** Com o indicativo no `PlaneDown_t` (36 B por avião, `'P'` de 722 B com 20 aviões),
a 2,4 kbps o ciclo de 5 s não fecha (o solo termina 5,8 s depois do último quadro; `checks/radio_link.cpp`). A 4,8 kbps
termina em 0,2 s, com o canal ~47% ocupado. O `configure()` do `e32.h` grava `E32_AIR_RATE` nos dois módulos a cada boot
(só regrava se mudou). Custo: ~3 dB de sensibilidade em relação a 2,4 kbps.

---

## P2 — Menores

- `HLR-COMM-01` pede **tempo de resposta limitado definido pela equipe**. Pior caso hoje: guarda + 6 × (TX + 2,5 s)
  ≈ 17 s (sem o problema 1). Declarar o valor no DP.
- `sendMessage` bloqueia o `loop` do CubeSat por até ~15 s por fragmento em caso de falha. O buffer OBC de 1024 B
  absorve, mas quadros antigos são enviados depois (latência). Considerar descartar TM velha se houver uma mais nova.
- Ao abrir a USB, o ESP32 ground pode resetar (DTR/RTS) e trocar de sessão. É inofensivo pelo RDT, mas o bridge já
  força `dtr/rts = false`.
- O `E32Driver::send` checa `len > RX_CAPACITY` (512), o que não tem relação com o limite do módulo. É inofensivo.
- Não há telemetria de enlace (retransmissões, CRC ruim, sessões) saindo do ground. Um quadro `'S'` periódico
  ajudaria a justificar HLR-COMM-03 e HLR-ADS-08 (perda/latência) com dados.

---

## O que a interface (`ground_ui/`) cobre das regras

| Regra | Como |
|---|---|
| 4.1 / 7 / HLR-COMM-01 — TC | Painel de telecomando (bitmask Mission/Deploy/Detumbling/Pointing), confirmação para Deploy, status `'A'` com RTT, confirmação pela TM |
| HLR-COMM-02 — TM estruturada | Estados dos subsistemas, potência, atitude (rpm), azimute, contadores, gráficos com limites (< 5 rpm, bateria > 0 °C) |
| 4.4.1 — trajetórias, origem/destino | Mapa com trilha por aeronave, origem observada, projeção pelo rumo (1–30 min), vel./rumo derivados no solo |
| HLR-ADS-05 — 10 min contínuos, ≤ 20 aeronaves | Relógio de missão (auto-inicia no ACK de Mission), contagem de aeronaves ativas |
| HLR-ADS-08 — perda e latência | Perda de TM por lacuna em `telemetry_count`, latência relativa (chegada no PC − `timestamp_ms`) |
| HLR-SW-02 / 5 — dados estruturados, reprodutíveis, pós-análise | Cada sessão grava `raw.jsonl` (bytes crus), `events.jsonl`, `telemetry.csv`, `planes.csv`, `commands.csv`; `--replay` reproduz uma sessão pelo mesmo parser |
| 9 — "bring your own ground station" | Roda offline (grade lat/lon se não houver internet para o mapa) num notebook com o ESP32 ground na USB |

Limitação conhecida: enquanto `Plane_t` não tiver timestamp, a trajetória usa o **horário de chegada no solo**
(tem jitter de alguns segundos por causa do RDT). Isso está indicado na própria UI.
