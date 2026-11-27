#pragma once

#include <Arduino.h>
#include <stddef.h>
#include <stdint.h>

enum E32Power : uint8_t {
  E32_POWER_20DBM = 0,
  E32_POWER_17DBM = 1,
  E32_POWER_14DBM = 2,
  E32_POWER_10DBM = 3
};

// Taxa no ar (SPED bits 2..0). Os dois lados (sat e ground) PRECISAM usar a mesma.
// 4,8 kbps desde o 'P' de 36 B por avião (com indicativo): a 2,4 kbps, 20 aviões + H + Z não cabem
// no ciclo de 5 s (checks/radio_link.cpp). Custa ~3 dB de sensibilidade em relação a 2,4 kbps.
#define E32_AIR_2K4 0x02
#define E32_AIR_4K8 0x03
#define E32_AIR_9K6 0x04
#ifndef E32_AIR_RATE
#define E32_AIR_RATE E32_AIR_4K8
#endif

class E32Driver {
 public:
  E32Driver(HardwareSerial &serial, uint8_t rxPin, uint8_t txPin, uint8_t m0Pin,
            uint8_t m1Pin, uint8_t auxPin, uint32_t baud = 9600)
      : serial_(serial),
        rxPin_(rxPin),
        txPin_(txPin),
        m0Pin_(m0Pin),
        m1Pin_(m1Pin),
        auxPin_(auxPin),
        baud_(baud) {}

  bool begin() {
    pinMode(m0Pin_, OUTPUT);
    pinMode(m1Pin_, OUTPUT);
    pinMode(auxPin_, INPUT);
    digitalWrite(m0Pin_, LOW);
    digitalWrite(m1Pin_, LOW);
    serial_.begin(baud_, SERIAL_8N1, rxPin_, txPin_);
    serial_.onReceive([this]() { handleRx(); });
    delay(100);
    return waitReady(3000);
  }

  // Grava potência e taxa no ar (SPED bits 2..0), mantendo endereço, canal, UART e o resto do OPTION.
  // Se o módulo já está assim, não regrava (poupa a memória do E32).
  bool configure(uint8_t powerBits, uint8_t airRate = E32_AIR_RATE) {
    setConfigMode();
    delay(50);
    if (!waitReady(2000)) {
      setNormalMode();
      return false;
    }
    clearRx();
    const uint8_t readCommand[3] = {0xC1, 0xC1, 0xC1};
    serial_.write(readCommand, sizeof(readCommand));
    serial_.flush();
    uint8_t config[6];
    // O E32-433T20D responde ao C1 C1 C1 com cabeçalho 0xC0 (parâmetros salvos); 0xC1 aceito por compatibilidade.
    if (!readBytes(config, sizeof(config), 1000) || (config[0] != 0xC0 && config[0] != 0xC1)) {
      setNormalMode();
      return false;
    }
    uint8_t option = static_cast<uint8_t>((config[5] & 0xFC) | (powerBits & 0x03));
    uint8_t sped = static_cast<uint8_t>((config[3] & 0xF8) | (airRate & 0x07));
    if (option == config[5] && sped == config[3]) {
      setNormalMode();
      delay(50);
      waitReady(2000);
      return true;
    }
    uint8_t writeCommand[6] = {0xC2, config[1], config[2], sped, config[4], option};
    clearRx();
    serial_.write(writeCommand, sizeof(writeCommand));
    serial_.flush();
    uint8_t response[6];
    bool ok = readBytes(response, sizeof(response), 1000) && response[0] == 0xC2;
    setNormalMode();
    delay(50);
    waitReady(2000);
    return ok;
  }

  bool waitReady(uint32_t timeoutMs) {
    uint32_t start = millis();
    while (digitalRead(auxPin_) == LOW) {
      if (static_cast<uint32_t>(millis() - start) >= timeoutMs) {
        return false;
      }
      delay(1);
    }
    return true;
  }

  bool send(const uint8_t *data, size_t len) {
    if (data == nullptr || len == 0 || len > RX_CAPACITY) {
      return false;
    }
    if (!waitReady(2000)) {
      return false;
    }
    size_t written = serial_.write(data, len);
    serial_.flush();
    if (written != len) {
      return false;
    }
    delay(1);
    return waitReady(3000);
  }

  int available() {
    size_t head = rxHead_;
    size_t tail = rxTail_;
    return static_cast<int>((head + RX_CAPACITY - tail) % RX_CAPACITY);
  }

  int read() {
    if (rxHead_ == rxTail_) {
      return -1;
    }
    uint8_t value = rxBuffer_[rxTail_];
    rxTail_ = (rxTail_ + 1) % RX_CAPACITY;
    return static_cast<int>(value);
  }

  void clearRx() {
    while (read() >= 0) {
    }
  }

 private:
  enum : size_t { RX_CAPACITY = 512 };

  void handleRx() {
    while (serial_.available() > 0) {
      int value = serial_.read();
      if (value < 0) {
        break;
      }
      size_t next = (rxHead_ + 1) % RX_CAPACITY;
      if (next != rxTail_) {
        rxBuffer_[rxHead_] = static_cast<uint8_t>(value);
        rxHead_ = next;
      }
    }
  }

  bool readBytes(uint8_t *out, size_t len, uint32_t timeoutMs) {
    uint32_t start = millis();
    size_t received = 0;
    while (received < len) {
      int value = read();
      if (value >= 0) {
        out[received++] = static_cast<uint8_t>(value);
        continue;
      }
      if (static_cast<uint32_t>(millis() - start) >= timeoutMs) {
        return false;
      }
      delay(1);
    }
    return true;
  }

  void setNormalMode() {
    digitalWrite(m0Pin_, LOW);
    digitalWrite(m1Pin_, LOW);
    delay(20);
  }

  void setConfigMode() {
    digitalWrite(m0Pin_, HIGH);
    digitalWrite(m1Pin_, HIGH);
    delay(20);
  }

  HardwareSerial &serial_;
  uint8_t rxPin_;
  uint8_t txPin_;
  uint8_t m0Pin_;
  uint8_t m1Pin_;
  uint8_t auxPin_;
  uint32_t baud_;
  uint8_t rxBuffer_[RX_CAPACITY];
  volatile size_t rxHead_ = 0;
  volatile size_t rxTail_ = 0;
};
