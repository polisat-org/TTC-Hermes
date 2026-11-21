#pragma once

#include <Arduino.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "crc16.h"
#include "e32.h"
#include "protocol.h"

class Rdt3 {
 public:
  explicit Rdt3(E32Driver &radio) : radio_(radio) {}

  void begin(uint8_t session) {
    session_ = session;
    txSeq_ = 0;
    txMsgId_ = 0;
    haveSession_ = false;
    rxLen_ = 0;
    readyLen_ = 0;
    radio_.clearRx();
    resetAssembly();
  }

  bool sendMessage(const uint8_t *data, size_t len) {
    if (data == nullptr || len == 0 || len > RDT_MAX_MESSAGE) {
      return false;
    }
    uint8_t fragTotal =
        static_cast<uint8_t>((len + RDT_MAX_PAYLOAD - 1) / RDT_MAX_PAYLOAD);
    if (fragTotal == 0 || fragTotal > RDT_MAX_FRAGS) {
      return false;
    }
    uint8_t msgId = txMsgId_++;
    size_t offset = 0;
    for (uint8_t frag = 0; frag < fragTotal; ++frag) {
      size_t fragLen = len - offset;
      if (fragLen > RDT_MAX_PAYLOAD) {
        fragLen = RDT_MAX_PAYLOAD;
      }
      uint8_t packet[RDT_MAX_PACKET];
      RdtHeader header;
      header.magic0 = RDT_MAGIC0;
      header.magic1 = RDT_MAGIC1;
      header.type = RDT_TYPE_DATA;
      header.seq = txSeq_;
      header.session = session_;
      header.msg_id = msgId;
      header.frag_idx = frag;
      header.frag_total = fragTotal;
      header.total_len = static_cast<uint16_t>(len);
      header.frag_len = static_cast<uint16_t>(fragLen);
      memcpy(packet, &header, RDT_HEADER_SIZE);
      memcpy(packet + RDT_HEADER_SIZE, data + offset, fragLen);
      uint16_t crc = crc16_ccitt_false(packet, RDT_HEADER_SIZE + fragLen);
      packet[RDT_HEADER_SIZE + fragLen] = static_cast<uint8_t>(crc & 0xFF);
      packet[RDT_HEADER_SIZE + fragLen + 1] = static_cast<uint8_t>(crc >> 8);
      size_t packetLen = RDT_HEADER_SIZE + fragLen + RDT_CRC_SIZE;
      bool acked = false;
      for (uint8_t attempt = 0; attempt <= RDT_MAX_RETRIES; ++attempt) {
        if (radio_.send(packet, packetLen) && waitAck(msgId, frag, txSeq_)) {
          acked = true;
          break;
        }
        delay(50);
      }
      if (!acked) {
        session_ = static_cast<uint8_t>(session_ + 1);
        txSeq_ = 0;
        return false;
      }
      txSeq_ ^= 1;
      offset += fragLen;
    }
    return true;
  }

  int pollMessage(uint8_t *out, size_t maxLen) {
    if (out == nullptr || maxLen == 0) {
      return -1;
    }
    if (readyLen_ > 0) {             // completada enquanto este lado esperava um ACK
      return deliverReady(out, maxLen);
    }
    fillRx();
    PacketInfo info;
    uint8_t payload[RDT_MAX_PAYLOAD];
    while (popPacket(info, payload, sizeof(payload))) {
      if (info.type != RDT_TYPE_DATA) {
        continue;
      }
      if (handleData(info, payload)) {
        return deliverReady(out, maxLen);
      }
    }
    return -1;
  }

  // Mensagens recebidas inteiras e pacotes ruins (para diagnóstico).
  uint32_t messagesReceived() const { return messagesRx_; }
  uint32_t badPackets() const { return badPackets_; }

 private:
  struct PacketInfo {
    uint8_t type;
    uint8_t seq;
    uint8_t session;
    uint8_t msg_id;
    uint8_t frag_idx;
    uint8_t frag_total;
    uint16_t total_len;
    uint16_t frag_len;
  };

  // Trata um pacote DATA: ACK, remontagem. Devolve true quando completa uma mensagem (em ready_).
  bool handleData(const PacketInfo &info, const uint8_t *payload) {
    if (!haveSession_ || info.session != rxSession_) {
      haveSession_ = true;
      rxSession_ = info.session;
      expectedSeq_ = info.seq;
      lastAckSeq_ = static_cast<uint8_t>(info.seq ^ 1);
      resetAssembly();
    }
    if (info.seq == lastAckSeq_) {
      sendAck(info);               // duplicata: o ACK anterior se perdeu
      return false;
    }
    if (info.seq != expectedSeq_) {
      return false;
    }
    if (readyLen_ > 0) {
      return false;                // ainda não entregou a anterior: sem ACK, o outro lado retransmite
    }
    bool valid = info.frag_total > 0 && info.frag_total <= RDT_MAX_FRAGS &&
                 info.frag_idx < info.frag_total && info.total_len > 0 &&
                 info.total_len <= RDT_MAX_MESSAGE && info.frag_len > 0;
    if (valid) {
      size_t offset = static_cast<size_t>(info.frag_idx) * RDT_MAX_PAYLOAD;
      if (offset + info.frag_len > RDT_MAX_MESSAGE) {
        valid = false;
      }
    }
    if (!valid) {
      return false;
    }
    if (info.frag_idx == 0) {
      rxMsgId_ = info.msg_id;
      rxTotalFrags_ = info.frag_total;
      rxTotalLen_ = info.total_len;
      rxReceivedMask_ = 0;
    } else if (info.msg_id != rxMsgId_ ||
               info.frag_total != rxTotalFrags_ ||
               info.total_len != rxTotalLen_) {
      return false;
    }
    size_t offset = static_cast<size_t>(info.frag_idx) * RDT_MAX_PAYLOAD;
    memcpy(rxAssembly_ + offset, payload, info.frag_len);
    rxReceivedMask_ |= static_cast<uint8_t>(1u << info.frag_idx);
    expectedSeq_ ^= 1;
    lastAckSeq_ = info.seq;
    sendAck(info);
    uint8_t fullMask =
        rxTotalFrags_ >= 8 ? 0xFF : static_cast<uint8_t>((1u << rxTotalFrags_) - 1);
    if ((rxReceivedMask_ & fullMask) == fullMask) {
      rxReceivedMask_ = 0;
      readyLen_ = rxTotalLen_;
      ++messagesRx_;
      return true;
    }
    return false;
  }

  int deliverReady(uint8_t *out, size_t maxLen) {
    size_t n = readyLen_;
    readyLen_ = 0;
    if (n > maxLen) {
      return -1;
    }
    memcpy(out, rxAssembly_, n);
    return static_cast<int>(n);
  }

  void resetAssembly() {
    rxMsgId_ = 0;
    rxTotalFrags_ = 0;
    rxTotalLen_ = 0;
    rxReceivedMask_ = 0;
  }

  void fillRx() {
    while (rxLen_ < sizeof(rxBuffer_)) {
      int value = radio_.read();
      if (value < 0) {
        break;
      }
      rxBuffer_[rxLen_++] = static_cast<uint8_t>(value);
    }
  }

  void dropFront(size_t count) {
    if (count >= rxLen_) {
      rxLen_ = 0;
      return;
    }
    memmove(rxBuffer_, rxBuffer_ + count, rxLen_ - count);
    rxLen_ -= count;
  }

  bool popPacket(PacketInfo &info, uint8_t *payload, size_t payloadMax) {
    while (rxLen_ >= RDT_HEADER_SIZE + RDT_CRC_SIZE) {
      if (rxBuffer_[0] != RDT_MAGIC0 || rxBuffer_[1] != RDT_MAGIC1) {
        dropFront(1);
        continue;
      }
      uint16_t fragLen = static_cast<uint16_t>(rxBuffer_[10]) |
                         (static_cast<uint16_t>(rxBuffer_[11]) << 8);
      if (fragLen > RDT_MAX_PAYLOAD) {
        dropFront(1);
        continue;
      }
      size_t packetLen = RDT_HEADER_SIZE + fragLen + RDT_CRC_SIZE;
      if (rxLen_ < packetLen) {
        return false;
      }
      uint16_t receivedCrc = static_cast<uint16_t>(rxBuffer_[packetLen - 2]) |
                             (static_cast<uint16_t>(rxBuffer_[packetLen - 1]) << 8);
      if (crc16_ccitt_false(rxBuffer_, packetLen - RDT_CRC_SIZE) != receivedCrc) {
        ++badPackets_;
        dropFront(1);
        continue;
      }
      info.type = rxBuffer_[2];
      info.seq = rxBuffer_[3];
      info.session = rxBuffer_[4];
      info.msg_id = rxBuffer_[5];
      info.frag_idx = rxBuffer_[6];
      info.frag_total = rxBuffer_[7];
      info.total_len = static_cast<uint16_t>(rxBuffer_[8]) |
                       (static_cast<uint16_t>(rxBuffer_[9]) << 8);
      info.frag_len = fragLen;
      if (info.frag_len > payloadMax) {
        dropFront(packetLen);
        continue;
      }
      memcpy(payload, rxBuffer_ + RDT_HEADER_SIZE, info.frag_len);
      dropFront(packetLen);
      return true;
    }
    return false;
  }

  bool waitAck(uint8_t msgId, uint8_t fragIdx, uint8_t seq) {
    uint32_t start = millis();
    while (static_cast<uint32_t>(millis() - start) < RDT_TIMEOUT_MS) {
      fillRx();
      PacketInfo info;
      uint8_t payload[RDT_MAX_PAYLOAD];
      while (popPacket(info, payload, sizeof(payload))) {
        if (info.type == RDT_TYPE_ACK && info.session == session_ &&
            info.msg_id == msgId && info.frag_idx == fragIdx &&
            info.seq == seq) {
          return true;
        }
        // Os dois lados podem transmitir ao mesmo tempo (TC subindo, TM descendo). Descartar o DATA
        // do outro lado aqui travava o enlace: cada um retransmitia esperando o próprio ACK.
        if (info.type == RDT_TYPE_DATA) {
          handleData(info, payload);
        }
      }
      delay(1);
    }
    return false;
  }

  void sendAck(const PacketInfo &info) {
    RdtHeader header;
    header.magic0 = RDT_MAGIC0;
    header.magic1 = RDT_MAGIC1;
    header.type = RDT_TYPE_ACK;
    header.seq = info.seq;
    header.session = info.session;
    header.msg_id = info.msg_id;
    header.frag_idx = info.frag_idx;
    header.frag_total = info.frag_total;
    header.total_len = 0;
    header.frag_len = 0;
    uint8_t packet[RDT_HEADER_SIZE + RDT_CRC_SIZE];
    memcpy(packet, &header, RDT_HEADER_SIZE);
    uint16_t crc = crc16_ccitt_false(packet, RDT_HEADER_SIZE);
    packet[RDT_HEADER_SIZE] = static_cast<uint8_t>(crc & 0xFF);
    packet[RDT_HEADER_SIZE + 1] = static_cast<uint8_t>(crc >> 8);
    delay(RDT_ACK_DELAY_MS);
    radio_.send(packet, sizeof(packet));
  }

  E32Driver &radio_;
  uint8_t session_ = 0;
  uint8_t txSeq_ = 0;
  uint8_t txMsgId_ = 0;
  bool haveSession_ = false;
  uint8_t rxSession_ = 0;
  uint8_t expectedSeq_ = 0;
  uint8_t lastAckSeq_ = 0xFF;
  uint8_t rxMsgId_ = 0;
  uint8_t rxTotalFrags_ = 0;
  uint8_t rxReceivedMask_ = 0;
  uint16_t rxTotalLen_ = 0;
  uint8_t rxAssembly_[RDT_MAX_MESSAGE];
  uint8_t rxBuffer_[RDT_RX_BUF];
  size_t rxLen_ = 0;
  size_t readyLen_ = 0;          // mensagem completa em rxAssembly_ esperando o pollMessage
  uint32_t messagesRx_ = 0;
  uint32_t badPackets_ = 0;
};
