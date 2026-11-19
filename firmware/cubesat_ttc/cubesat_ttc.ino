#include <Arduino.h>
#include <esp_system.h>

#include "../common/crc16.h"
#include "../common/protocol.h"
#include "../common/telemetry.h"
#include "../common/e32.h"
#include "../common/rdt3.h"
#include "../common/uart_rx.h"

#define E32_RX_PIN 16
#define E32_TX_PIN 17
#define E32_M0_PIN 21
#define E32_M1_PIN 22
#define E32_AUX_PIN 18
#define E32_BAUD 9600
#define E32_TX_POWER E32_POWER_20DBM

#define OBC_RX_PIN 25
#define OBC_TX_PIN 26
#define OBC_BAUD 9600

#define TTC_BUSY_PIN 27
#define TTC_BUSY_RELEASE_MS 2
#define STATUS_LED_PIN 13
#define LED_HOLD_MS 50

HardwareSerial LoraSerial(2);
HardwareSerial ObcSerial(1);
E32Driver lora(LoraSerial, E32_RX_PIN, E32_TX_PIN, E32_M0_PIN, E32_M1_PIN,
               E32_AUX_PIN, E32_BAUD);
Rdt3 rdt(lora);
UartRxBuffer<1024> obcRx;

enum ObcParseState : uint8_t {
  OBC_WAIT_TYPE,
  OBC_TELEMETRY,
  OBC_PAYLOAD_COUNT,
  OBC_PAYLOAD
};

uint8_t downlinkBuffer[RDT_MAX_MESSAGE];
size_t downlinkLen = 0;
bool downlinkReady = false;
ObcParseState obcState = OBC_WAIT_TYPE;
size_t payloadRemaining = 0;
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
  if (downlinkReady) {
    return;
  }
  while (!downlinkReady && obcRx.available() > 0) {
    int value = obcRx.read();
    if (value < 0) {
      break;
    }
    uint8_t byte = static_cast<uint8_t>(value);
    switch (obcState) {
      case OBC_WAIT_TYPE:
        if (byte == TELEMETRY_ID) {
          downlinkBuffer[0] = TELEMETRY_ID;
          downlinkLen = 1;
          obcState = OBC_TELEMETRY;
        } else if (byte == PAYLOAD_ID) {
          downlinkBuffer[0] = PAYLOAD_ID;
          downlinkLen = 1;
          obcState = OBC_PAYLOAD_COUNT;
        }
        break;
      case OBC_TELEMETRY:
        if (downlinkLen >= sizeof(downlinkBuffer)) {
          downlinkLen = 0;
          obcState = OBC_WAIT_TYPE;
          break;
        }
        downlinkBuffer[downlinkLen++] = byte;
        if (downlinkLen == TELEMETRY_FRAME_SIZE) {
          downlinkReady = true;
          obcState = OBC_WAIT_TYPE;
        }
        break;
      case OBC_PAYLOAD_COUNT:
        if (byte <= MAX_PLANES) {
          downlinkBuffer[1] = byte;
          downlinkLen = PAYLOAD_HEADER_SIZE;
          payloadRemaining = static_cast<size_t>(byte) * sizeof(Plane_t);
          if (payloadRemaining == 0) {
            downlinkReady = true;
            obcState = OBC_WAIT_TYPE;
          } else {
            obcState = OBC_PAYLOAD;
          }
        } else {
          obcState = OBC_WAIT_TYPE;
        }
        break;
      case OBC_PAYLOAD:
        if (downlinkLen >= sizeof(downlinkBuffer)) {
          downlinkLen = 0;
          payloadRemaining = 0;
          obcState = OBC_WAIT_TYPE;
          break;
        }
        downlinkBuffer[downlinkLen++] = byte;
        --payloadRemaining;
        if (payloadRemaining == 0) {
          downlinkReady = true;
          obcState = OBC_WAIT_TYPE;
        }
        break;
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
  obcState = OBC_WAIT_TYPE;
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
