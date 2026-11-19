# TTC-Hermes
Repositório que contém os arquivos desenvolvidos para a missão Hermes.

```text
docs/        plan_ttc.md (visão geral), detalhamento_ttc.md (protocolos e structs), analise_ttc.md (análise e pendências)
firmware/    cubesat_ttc, ground_ttc (enlace LoRa), wired_ground + mock_obc (bancada com dados simulados), common/
ground_ui/   estação de solo: bridge USB↔WebSocket + interface React (telecomando, telemetria, trajetórias, logs)
```

- Firmware, fiação e gravação: [`firmware/README.md`](firmware/README.md)
- Interface de solo: [`ground_ui/README.md`](ground_ui/README.md)

Início rápido com a bancada (Nucleo `mock_obc` → ESP32 `wired_ground` → PC):

```bash
cd ground_ui && npm install && npm run build
node bridge/server.mjs --port COM13        # Windows com Node
# no WSL (sem acesso às COM): node bridge/server.mjs --tcp-listen 8766
#   e no Windows: powershell -ExecutionPolicy Bypass -File ground_ui\bridge\com_relay.ps1 -Port COM13
# abrir http://localhost:8765
```
