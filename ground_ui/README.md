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

## Variantes: TT&C ou payload pela rede (`--pi`, `--ui`)

Uma interface só, com duas origens de dados e duas variantes de tela (flags em `src/ui.ts`):

```bash
npm run pi -- http://10.93.42.30:8080          # quadros do Pi (hermes_simples.rede), UI "mission"
npm run bridge -- --port COM13                 # rádio TT&C, UI "full" (completa)
npm run bridge -- --port COM13 --ui mission    # rádio TT&C com a UI "mission"
```

- `--pi <url>`: o bridge busca `GET /quadros` no Pi a cada 300 ms e entrega os bytes ao mesmo parser da USB.
  Cada telecomando vira `POST /telecomando`, e a resposta volta como o quadro 'A'. Sem ESP nem COM.
- `--ui full` (padrão sem `--pi`): todos os modos, janela de 10 min, Start só marca o relógio.
- `--ui mission` (padrão com `--pi`): só o modo Mission. Start manda 0x01, a janela é de 16 min e, ao fim, manda 0x00.
- Tabela de aviões: ICAO, call sign, lat., lon., alt., velocidade, rumo. O call sign só chega no modo `--pi`:
  o `PlaneDown_t` de 28 B do OBC não tem esse campo, então pelo TT&C ele aparece como "—".

## Quadros que chegam (os do OBC real)

O `ground_ttc.ino` repassa à USB cada quadro do OBC exatamente como saiu dele (`common/telemetry.h`):

| Quadro | Tamanho | Quando | Conteúdo |
|---|---|---|---|
| `'T'` | 1 + 85 B | no boot do OBC e a cada 60 s | `Telemetry_t`: relógio, temperaturas, umidade/pressão, deploy, EPS (barramentos, carregadores, baterias), último azimute |
| `'P'` | 2 + 28n B | a cada 5 s com a missão ligada | até 20 aviões (`PlaneDown_t`: ICAO, lat, lon, altitude, velocidade, rumo, tempo da posição) |
| `'H'` | 1 + 32 B | junto com o `'P'` | controle térmico do payload (4 sondas, aquecedores, situação, CRC) |
| `'Z'` | 1 + 5 B | até 1 por segundo no apontamento | azimute do ADCS, `"ddd.d"` |
| `'A'` | 3 B | resposta a cada telecomando | `'A'` cmd status (OK / FALHA / OCUPADO) |

A telemetria do OBC **não informa o modo** (não há `*_state` no `Telemetry_t`): a tela mostra o último
telecomando confirmado e o que dá para ver nos dados (antena aberta, aviões chegando, azimutes chegando).
No simulador (`npm run sim`) a telemetria vem a cada 10 s para não esperar (`--sim-tm-s <s>` muda isso).

## O que tem na tela

- **Telecomando:** cinco modos (Standby, Mission, Detumbling, Pointing, Deploy), um por vez, com o byte
  `0x00–0x0F`. Deploy pede confirmação; com o bit Deploy o OBC **só** faz o deploy, então mande o próximo modo
  depois. O histórico mostra o status `'A'` e o RTT. "OK" significa que o rádio do CubeSat recebeu e repassou ao OBC.
- **Indicadores:** quadros recebidos por tipo e idade do último, bateria (MAX17048, a célula mais baixa) e carga,
  temperatura da bateria (sonda mais fria do TCS; sem `'H'` recente, a da telemetria), aquecedores, azimute e aviões.
- **Mapa:** trilha por aeronave (ICAO), origem observada e projeção tracejada pelo rumo e velocidade do ADS-B.
  Fundo OpenStreetMap (precisa de internet) ou **grade lat/lon offline**.
- **Aeronaves:** tabela com ICAO, altitude, velocidade e rumo (do ADS-B), nº de pontos, idade e export CSV.
- **Gráficos:** temperatura da bateria pelo TCS (5 s), temperatura e tensão da bateria e barramento de 13,8 V
  (housekeeping, 60 s), com a referência da regra (bateria > 0 °C).
- **Avançado:** relógio do OBC, EPS completo, registradores dos carregadores, dados do TCS, `Telemetry_t` cru e console.
- **Relógio de missão (10:00):** inicia sozinho no primeiro ACK OK com o bit Mission ou manualmente.

## Logs (HLR-SW-02)

Cada execução ao vivo cria `logs/<data-hora>/`:

| Arquivo | Conteúdo |
|---|---|
| `raw.jsonl` | todos os bytes RX/TX com horário do PC (fonte para `--replay`) |
| `events.jsonl` | eventos decodificados (telemetria, aviões, térmico, azimute, ack, comandos, console) |
| `telemetry.csv` | um `Telemetry_t` por linha |
| `planes.csv` | uma aeronave por linha, com índice do quadro `'P'` |
| `thermal.csv` | um quadro `'H'` (TCS) por linha |
| `azimuth.csv` | um azimute `'Z'` por linha |
| `commands.csv` | comandos enviados e respostas `'A'` |
| `session.json` | modo, porta e horário de início |

## Mudou o firmware?

Toda a decodificação de bytes está em **`bridge/protocol.mjs`** (`TELEMETRY_FIELDS`, `decodePlane`,
`decodeThermal`, `StreamParser`), espelhando `customTypes.h` do OBC e `common/telemetry.h`. Se um struct mudar,
ajuste ali, em `src/types.ts` e no simulador (`bridge/sim.mjs`). O teste de integração do repositório
Hermes-Integracao (`checks/run_all.sh`) passa os quadros reais do OBC por este parser.
