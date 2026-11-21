// wired_ground — ESP32 WROOM-32 como estação de solo CABEADA (sem rádio).
//
// Faz a ponte OBC UART <-> PC USB falando, do lado do PC, EXATAMENTE o mesmo
// protocolo do ground_ttc (detalhamento_ttc.md §4), para que a ground_ui funcione
// sem mudanças. Do lado do OBC fala o protocolo OBC<->TT&C (§5).
// Serve para: testar a interface com o OBC mock (firmware/mock_obc) e para o
// teste de comunicação CABEADO das regras (4.1: TC/TM "wired").
//
//   PC  -> ESP32 : byte de comando 0x00..0x0F  -> repassado ao OBC
//   ESP32 -> PC  : 'A' cmd 0x00   (comando entregue na UART do OBC)
//                  'T' + Telemetry_t, 'P' + count + Plane_t[], 'H' + TcsStatus_t, 'Z' + azimute (vindos do OBC)
//
// Ligação (3,3 V nos dois lados, GND comum obrigatório):
//   ESP32 GPIO16 (RX2) <- TX do OBC   (Nucleo D8 / PA9)
//   ESP32 GPIO17 (TX2) -> RX do OBC   (Nucleo D2 / PA10)
// NÃO use TX0/RX0 (GPIO1/3): são a UART da USB (CH9102) — conflito elétrico.
//
// LED de enlace (GPIO27):
//   piscada curta      = quadro 'T' (telemetria) recebido do OBC
//   piscada dupla      = quadro 'P' (aviões) recebido do OBC
//   pulso longo        = comando recebido do PC e repassado ao OBC
//   "respiração" lenta = ESP32 vivo, mas nada do OBC há > 3 s
#include <Arduino.h>

#include "../common/protocol.h"
#include "../common/telemetry.h"
#include "../common/obc_frames.h"

#ifndef OBC_RX_PIN
#define OBC_RX_PIN 16  // RX2
#endif
#ifndef OBC_TX_PIN
#define OBC_TX_PIN 17  // TX2
#endif
#define OBC_BAUD 9600  // Notion/OBC: todas as UARTs a 9600
#define PC_BAUD 115200
#define STATUS_LED_PIN 2  // LED azul da DevKit (GPIO2)
#define LED_HOLD_MS 30
#define LINK_LED_PIN 27
#define LINK_LED_CH_FREQ 5000
#define LINK_TIMEOUT_MS 3000

HardwareSerial ObcSerial(2);

ObcFrameParser obcParser;
uint32_t ledUntil = 0;
uint32_t lastObcFrame = 0;

void blink() {
  digitalWrite(STATUS_LED_PIN, HIGH);
  ledUntil = millis() + LED_HOLD_MS;
}

// ---- LED de enlace (GPIO27): padrões não bloqueantes -------------------
// Cada padrão é uma sequência de durações ON/OFF em ms.
const uint16_t PATTERN_TM[] = {40};
const uint16_t PATTERN_PAYLOAD[] = {40, 80, 40};
const uint16_t PATTERN_CMD[] = {400};
const uint16_t *pattern = nullptr;
uint8_t patternLen = 0, patternIdx = 0;
uint32_t patternStepAt = 0;

void linkLed(uint8_t duty) { ledcWrite(LINK_LED_PIN, duty); }

void playPattern(const uint16_t *p, uint8_t len) {
  if (pattern == PATTERN_CMD && p != PATTERN_CMD) return;  // não corta o pulso de comando
  pattern = p;
  patternLen = len;
  patternIdx = 0;
  patternStepAt = millis();
  linkLed(255);
}

void serviceLinkLed(uint32_t now) {
  if (pattern) {
    if (now - patternStepAt >= pattern[patternIdx]) {
      patternStepAt = now;
      if (++patternIdx >= patternLen) {
        pattern = nullptr;
        linkLed(0);
      } else {
        linkLed(patternIdx % 2 == 0 ? 255 : 0);  // índices pares = ON
      }
    }
    return;
  }
  if (now - lastObcFrame > LINK_TIMEOUT_MS) {
    // sem enlace: "respiração" lenta (período 2 s, brilho baixo)
    float phase = (now % 2000) / 2000.0f;
    float tri = phase < 0.5f ? phase * 2 : (1 - phase) * 2;
    linkLed(static_cast<uint8_t>(tri * tri * 60));
  } else {
    linkLed(0);
  }
}

void obcFrameDone(bool isPayload) {
  lastObcFrame = millis();
  blink();
  if (isPayload) playPattern(PATTERN_PAYLOAD, 3);
  else playPattern(PATTERN_TM, 1);
}

// Mesmo parser de quadros do cubesat_ttc (common/obc_frames.h).
void feedObcByte(uint8_t b) {
  if (obcParser.feed(b, millis())) {
    Serial.write(obcParser.frame(), obcParser.length());
    obcFrameDone(obcParser.type() == PAYLOAD_ID);
  }
}

void setup() {
  pinMode(STATUS_LED_PIN, OUTPUT);
  digitalWrite(STATUS_LED_PIN, LOW);
  ledcAttach(LINK_LED_PIN, LINK_LED_CH_FREQ, 8);  // PWM para a "respiração"
  // Teste de lâmpada no boot: 3 piscadas.
  for (int i = 0; i < 3; ++i) {
    linkLed(255);
    delay(120);
    linkLed(0);
    delay(120);
  }
  Serial.setRxBufferSize(256);
  Serial.begin(PC_BAUD);
  ObcSerial.setRxBufferSize(1024);
  ObcSerial.begin(OBC_BAUD, SERIAL_8N1, OBC_RX_PIN, OBC_TX_PIN);
  // Nada de Serial.print: a USB é um canal binário (detalhamento §17).
}

void loop() {
  while (ObcSerial.available() > 0) {
    feedObcByte(static_cast<uint8_t>(ObcSerial.read()));
  }
  while (Serial.available() > 0) {
    int v = Serial.read();
    if (v < 0 || v > CMD_MAX) continue;
    uint8_t cmd = static_cast<uint8_t>(v);
    ObcSerial.write(cmd);
    ObcSerial.flush();
    const uint8_t ack[3] = {CMD_RESPONSE_ID, cmd, CMD_STATUS_OK};
    Serial.write(ack, sizeof(ack));
    blink();
    pattern = nullptr;
    playPattern(PATTERN_CMD, 1);
  }
  uint32_t now = millis();
  serviceLinkLed(now);
  if (static_cast<int32_t>(ledUntil - now) <= 0) digitalWrite(STATUS_LED_PIN, LOW);
}
