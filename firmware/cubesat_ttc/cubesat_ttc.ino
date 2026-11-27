#include <Arduino.h>
#include <esp_system.h>

#include "../common/crc16.h"
#include "../common/protocol.h"
#include "../common/telemetry.h"
#include "../common/e32.h"
#include "../common/rdt3.h"
#include "../common/uart_rx.h"
#include "../common/obc_frames.h"

// E32 na UART2 (RX2/TX2). RX0/TX0 são do OBC (abaixo). Ver firmware/README.md.
#define E32_RX_PIN 16  // RX2 <- TXD do E32
#define E32_TX_PIN 17  // TX2 -> RXD do E32
#define E32_M0_PIN 18
#define E32_M1_PIN 5
#define E32_AUX_PIN 15
#define E32_BAUD 9600
#define E32_TX_POWER E32_POWER_20DBM

// OBC na UART0 (RX0/TX0), canal exclusivo TT&C/OBC. É a mesma UART da USB da DevKit: não use Serial.print
// neste sketch (iria para o OBC). Ver firmware/README.md.
#define OBC_RX_PIN 3   // RX0 <- TX do OBC
#define OBC_TX_PIN 1   // TX0 -> RX do OBC
#define OBC_BAUD 9600

// TTC_BUSY no GPIO13: é o que a PCB do TT&C liga ao J2-10 do barramento (PC0 do OBC).
#define TTC_BUSY_PIN 13
#define TTC_BUSY_RELEASE_MS 2
#define STATUS_LED_PIN 2   // LED azul da DevKit (o GPIO13 é o TTC_BUSY)
#define LED_HOLD_MS 50

HardwareSerial LoraSerial(2);
HardwareSerial &ObcSerial = Serial;  // UART0
E32Driver lora(LoraSerial, E32_RX_PIN, E32_TX_PIN, E32_M0_PIN, E32_M1_PIN,
               E32_AUX_PIN, E32_BAUD);
Rdt3 rdt(lora);
UartRxBuffer<1024> obcRx;

// Quadros do OBC: 'T' telemetria, 'P' aviões, 'H' térmico, 'Z' azimute (common/telemetry.h).
// Cada quadro completo vira UMA mensagem RDT para o solo, sem alteração.
ObcFrameParser obcParser;
uint8_t downlinkBuffer[OBC_FRAME_MAX];
size_t downlinkLen = 0;
bool downlinkReady = false;
uint32_t busyHoldUntil = 0;
uint32_t ledUntil = 0;

void onObcReceive() {
  obcRx.drain(ObcSerial);
}

uint8_t makeSession() {
  uint32_t value = esp_random();
  return static_cast<uint8_t>(value == 0 ? 1 : value);
}

void setup() {
  pinMode(STATUS_LED_PIN, OUTPUT);
  digitalWrite(STATUS_LED_PIN, LOW);
  pinMode(TTC_BUSY_PIN, OUTPUT);
  digitalWrite(TTC_BUSY_PIN, LOW);

  ObcSerial.begin(OBC_BAUD, SERIAL_8N1, OBC_RX_PIN, OBC_TX_PIN);
  ObcSerial.onReceive(onObcReceive);

  if (lora.begin()) {
    lora.configure(E32_TX_POWER);
  }

  rdt.begin(makeSession());
  busyHoldUntil = millis();
}

void serviceBusy(uint32_t now) {
  if (digitalRead(E32_AUX_PIN) == LOW) {
    busyHoldUntil = now + TTC_BUSY_RELEASE_MS;
  }
  bool busy = downlinkReady || static_cast<int32_t>(busyHoldUntil - now) > 0;
  digitalWrite(TTC_BUSY_PIN, busy ? HIGH : LOW);
}

void serviceObc() {
  // Enquanto há um quadro esperando o rádio, os bytes seguintes ficam no buffer da UART (1 KB).
  while (!downlinkReady && obcRx.available() > 0) {
    int value = obcRx.read();
    if (value < 0) {
      break;
    }
    if (obcParser.feed(static_cast<uint8_t>(value), millis())) {
      downlinkLen = obcParser.length();
      memcpy(downlinkBuffer, obcParser.frame(), downlinkLen);
      downlinkReady = true;
    }
  }
}

void serviceDownlink() {
  if (!downlinkReady) {
    return;
  }
  busyHoldUntil = millis() + TTC_BUSY_RELEASE_MS;
  digitalWrite(TTC_BUSY_PIN, HIGH);
  rdt.sendMessage(downlinkBuffer, downlinkLen);
  downlinkReady = false;
  downlinkLen = 0;
  busyHoldUntil = millis() + TTC_BUSY_RELEASE_MS;
}

void serviceCommands() {
  uint8_t commandBuffer[4];
  int length = rdt.pollMessage(commandBuffer, sizeof(commandBuffer));
  if (length != 1 || commandBuffer[0] > CMD_MAX) {
    return;
  }
  busyHoldUntil = millis() + TTC_BUSY_RELEASE_MS;
  digitalWrite(TTC_BUSY_PIN, HIGH);
  ObcSerial.write(commandBuffer[0]);
  ObcSerial.flush();
  busyHoldUntil = millis() + TTC_BUSY_RELEASE_MS;
  ledUntil = millis() + LED_HOLD_MS;
  digitalWrite(STATUS_LED_PIN, HIGH);
}

void serviceLed(uint32_t now) {
  if (static_cast<int32_t>(ledUntil - now) <= 0) {
    digitalWrite(STATUS_LED_PIN, LOW);
  }
}

void loop() {
  uint32_t now = millis();
  serviceBusy(now);
  serviceObc();
  serviceDownlink();
  serviceCommands();
  serviceLed(millis());
}
