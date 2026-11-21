#pragma once

#include <stddef.h>
#include <stdint.h>

#define RDT_MAGIC0 0xA5
#define RDT_MAGIC1 0x5A

#define RDT_HEADER_SIZE 12
#define RDT_CRC_SIZE 2
#define RDT_MAX_PAYLOAD 128
#define RDT_MAX_MESSAGE 640   // cabe o maior quadro do OBC ('P' com 20 aviões = 562 B)
#define RDT_MAX_FRAGS 8
#define RDT_MAX_PACKET (RDT_HEADER_SIZE + RDT_MAX_PAYLOAD + RDT_CRC_SIZE)
#define RDT_RX_BUF 512

#define RDT_TIMEOUT_MS 2500
#define RDT_MAX_RETRIES 5
#define RDT_ACK_DELAY_MS 50

#define CMD_MAX 0x0F
#define CMD_RESPONSE_ID 'A'
#define TELEMETRY_ID 'T'
#define PAYLOAD_ID 'P'
#define THERMAL_ID 'H'
#define AZIMUTH_ID 'Z'
#define CMD_STATUS_OK 0x00
#define CMD_STATUS_FAIL 0x01
#define CMD_STATUS_BUSY 0x02

enum RdtPacketType : uint8_t {
  RDT_TYPE_DATA = 1,
  RDT_TYPE_ACK = 2
};

struct __attribute__((packed)) RdtHeader {
  uint8_t magic0;
  uint8_t magic1;
  uint8_t type;
  uint8_t seq;
  uint8_t session;
  uint8_t msg_id;
  uint8_t frag_idx;
  uint8_t frag_total;
  uint16_t total_len;
  uint16_t frag_len;
};

static_assert(sizeof(RdtHeader) == RDT_HEADER_SIZE, "RdtHeader size");
