#include <Arduino.h>
#include <esp_system.h>

#include "../common/crc16.h"
#include "../common/protocol.h"
#include "../common/telemetry.h"
#include "../common/e32.h"
#include "../common/rdt3.h"
#include "../common/obc_frames.h"

#define E32_RX_PIN 16
#define E32_TX_PIN 17
#define E32_M0_PIN 21
#define E32_M1_PIN 22
#define E32_AUX_PIN 18
#define E32_BAUD 9600
#define E32_TX_POWER E32_POWER_20DBM

#define STATUS_LED_PIN 13
#define LED_HOLD_MS 50
// Espera um pouco de silêncio no rádio antes de mandar um TC (dá tempo do ACK do outro lado), mas
// não para sempre: com o pointing ligado o satélite manda azimute a cada 1 s e um silêncio de 1 s
// nunca acontecia, então o solo não conseguia mandar TC nenhum. Depois de TX_GUARD_MAX_WAIT_MS o TC
// sai mesmo assim (o RDT3 trata DATA dos dois lados ao mesmo tempo).
#define TX_GUARD_MS 150
#define TX_GUARD_MAX_WAIT_MS 2000
#define COMMAND_QUEUE_SIZE 4

HardwareSerial LoraSerial(2);
E32Driver lora(LoraSerial, E32_RX_PIN, E32_TX_PIN, E32_M0_PIN, E32_M1_PIN,
               E32_AUX_PIN, E32_BAUD);
Rdt3 rdt(lora);

uint8_t commandQueue[COMMAND_QUEUE_SIZE];
uint8_t queueHead = 0;
uint8_t queueTail = 0;
uint8_t queueCount = 0;
uint32_t lastRadioActivity = 0;
uint32_t queueWaitSince = 0;   // desde quando há TC esperando o rádio
uint32_t ledUntil = 0;

uint8_t makeSession() {
  uint32_t value = esp_random();
  return static_cast<uint8_t>(value == 0 ? 1 : value);
}

bool enqueueCommand(uint8_t command) {
  if (queueCount >= COMMAND_QUEUE_SIZE) {
    return false;
  }
  commandQueue[queueHead] = command;
  queueHead = static_cast<uint8_t>((queueHead + 1) % COMMAND_QUEUE_SIZE);
  ++queueCount;
  return true;
}

bool dequeueCommand(uint8_t &command) {
  if (queueCount == 0) {
    return false;
  }
  command = commandQueue[queueTail];
  queueTail = static_cast<uint8_t>((queueTail + 1) % COMMAND_QUEUE_SIZE);
  --queueCount;
  return true;
}

void sendStatus(uint8_t command, uint8_t status) {
  uint8_t response[3] = {CMD_RESPONSE_ID, command, status};
  Serial.write(response, sizeof(response));
}

// Repassa ao PC só quadros do OBC íntegros ('T', 'P', 'H', 'Z'; ver common/telemetry.h).
void sendToPc(const uint8_t *data, size_t length) {
  if (obcFrameValid(data, length)) {
    Serial.write(data, length);
  }
}

void servicePc() {
  while (Serial.available() > 0) {
    int value = Serial.read();
    if (value < 0) {
      break;
    }
    uint8_t command = static_cast<uint8_t>(value);
    if (command > CMD_MAX) {
      continue;
    }
    if (!enqueueCommand(command)) {
      sendStatus(command, CMD_STATUS_BUSY);
    }
  }
}

void serviceCommandQueue(uint32_t now) {
  if (queueCount == 0) {
    return;
  }
  if (queueWaitSince == 0) {
    queueWaitSince = now ? now : 1;
  }
  bool esperouDemais = static_cast<uint32_t>(now - queueWaitSince) >= TX_GUARD_MAX_WAIT_MS;
  if (!esperouDemais && static_cast<uint32_t>(now - lastRadioActivity) < TX_GUARD_MS) {
    return;
  }
  if (!lora.waitReady(5)) {
    return;
  }
  uint8_t command;
  if (!dequeueCommand(command)) {
    return;
  }
  queueWaitSince = 0;
  bool ok = rdt.sendMessage(&command, 1);
  sendStatus(command, ok ? CMD_STATUS_OK : CMD_STATUS_FAIL);
  lastRadioActivity = millis();
  ledUntil = millis() + LED_HOLD_MS;
  digitalWrite(STATUS_LED_PIN, HIGH);
}

void serviceLed(uint32_t now) {
  if (static_cast<int32_t>(ledUntil - now) <= 0) {
    digitalWrite(STATUS_LED_PIN, LOW);
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(STATUS_LED_PIN, OUTPUT);
  digitalWrite(STATUS_LED_PIN, LOW);

  if (lora.begin()) {
    lora.configure(E32_TX_POWER);
  }

  rdt.begin(makeSession());
  lastRadioActivity = millis();
}

void loop() {
  servicePc();

  uint32_t now = millis();
  if (lora.available() > 0) {
    lastRadioActivity = now;
  }
  uint8_t message[RDT_MAX_MESSAGE];
  int length = rdt.pollMessage(message, sizeof(message));
  if (length >= 0) {
    lastRadioActivity = millis();
    sendToPc(message, static_cast<size_t>(length));
  }

  serviceCommandQueue(millis());
  serviceLed(millis());
}
