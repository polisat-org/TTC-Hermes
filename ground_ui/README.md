# Hermes Ground UI

Interface da estação de solo: um **bridge Node** (USB do ESP32 ground ↔ WebSocket) e um **dashboard React**
com telecomando, telemetria, mapa de trajetórias ADS-B e logs para pós-análise.

```text
ESP32 ground (ground_ttc.ino) ──USB 115200──> bridge/server.mjs ──ws://localhost:8765/ws──> React (navegador)
                                                  │
                                                  └── logs/<data-hora>/ raw.jsonl, events.jsonl, *.csv
```

O navegador não fala com a serial: quem fala é o bridge, que decodifica (`bridge/protocol.mjs`), grava tudo em
disco e repassa JSON. Assim, vários navegadores podem abrir a mesma sessão e um refresh não perde dados.

## Uso

```bash
cd ground_ui
npm install
npm run build                 # compila a UI (uma vez); o bridge a serve em http://localhost:8765

node bridge/server.mjs --list            # lista portas seriais
node bridge/server.mjs --port COM5       # Windows (ou /dev/ttyUSB0 no Linux)
npm run sim                              # sem hardware: simulador gera os mesmos bytes do ground
node bridge/server.mjs --replay logs/20261119-170629/raw.jsonl --speed 4   # reproduz uma sessão
```

Abra **http://localhost:8765**.

Desenvolvimento com hot-reload: rode o bridge (`npm run sim` ou `--port …`) e, em outro terminal, `npm run dev`
(Vite em http://localhost:5173, com proxy do `/ws` para o bridge).

Opções: `--http <porta>` (padrão 8765), `--baud` (115200), `--logs <dir>`, `--speed <x>` (replay).

Testes do parser: `npm test`.

## O que tem na tela

- **Telecomando:** os 4 bits (Mission, Deploy, Detumbling, Pointing) formam o byte `0x00–0x0F`. O comando é um
  *vetor de estado*: cada envio define os 4 bits. Deploy pede confirmação. O histórico mostra o status `'A'`
  (OK/FALHA/OCUPADO) e o RTT. "OK" significa ACK do ESP32 do CubeSat. A execução é confirmada pelos estados e pelo
  `command_count` na telemetria.
- **Estado do CubeSat:** `*_state`, bateria, temperatura, rotação em rpm, azimute, contadores, idade da última TM.
- **Enlace:** perda de TM (lacunas em `telemetry_count`), latência relativa, estatísticas do parser e pasta do log.
- **Mapa:** trilha por aeronave, origem observada, projeção tracejada pelo rumo e posição do CubeSat. Fundo
  OpenStreetMap (precisa de internet) ou **grade lat/lon offline**.
- **Aeronaves:** tabela com velocidade/rumo derivados no solo, nº de pontos, confiança, idade e export CSV.
- **Gráficos:** tensão, corrente, temperatura e rpm, com linhas de referência das regras (< 5 rpm, bateria > 0 °C).
- **Relógio de missão (10:00):** inicia sozinho no primeiro ACK OK com o bit Mission ou manualmente.

## Logs (HLR-SW-02)

Cada execução ao vivo cria `logs/<data-hora>/`:

| Arquivo | Conteúdo |
|---|---|
| `raw.jsonl` | todos os bytes RX/TX com horário do PC (fonte para `--replay`) |
| `events.jsonl` | eventos decodificados (telemetria, payload, ack, comandos, console) |
| `telemetry.csv` | um `Telemetry_t` por linha |
| `planes.csv` | uma aeronave por linha, com índice do quadro `'P'` |
| `commands.csv` | comandos enviados e respostas `'A'` |
| `session.json` | modo, porta e horário de início |

## Mudou o firmware?

Toda a decodificação de bytes está em **`bridge/protocol.mjs`** (`decodeTelemetry`, `decodePlane`, `StreamParser`),
espelhando `common/telemetry.h`. Se `Telemetry_t`/`Plane_t` mudarem, ajuste ali, em `src/types.ts` e no
simulador (`bridge/sim.mjs`). A escala do giroscópio usada para rpm é `GYRO_LSB_PER_DPS` em `src/store.ts`
(assumida 16.4, a confirmar com o ADCS). Ver `../docs/analise_ttc.md` para as mudanças propostas.
