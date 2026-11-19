#pragma once

#include <stddef.h>
#include <stdint.h>

struct __attribute__((packed)) Telemetry_t {
  uint32_t timestamp_ms;
  uint32_t uptime_ms;
  uint8_t mode;
  uint8_t flags;
  uint16_t error_count;
  float battery_voltage;
  float battery_current;
  float temperature;
  int16_t gyro_x;
  int16_t gyro_y;
  int16_t gyro_z;
  int16_t accel_x;
  int16_t accel_y;
  int16_t accel_z;
  int16_t mag_x;
  int16_t mag_y;
  int16_t mag_z;
  float latitude;
  float longitude;
  float altitude;
  uint8_t deploy_state;
  uint8_t detumbling_state;
  uint8_t pointing_state;
  uint8_t mission_state;
  uint16_t command_count;
  uint16_t telemetry_count;
  uint16_t packet_count;
  uint8_t reserved[15];
};

static_assert(sizeof(Telemetry_t) == 79, "Telemetry_t size");

struct __attribute__((packed)) Plane_t {
  uint16_t id;
  uint8_t type;
  uint8_t flags;
  float latitude;
  float longitude;
  float confidence;
};

static_assert(sizeof(Plane_t) == 16, "Plane_t size");

static constexpr size_t TELEMETRY_FRAME_SIZE = 1 + sizeof(Telemetry_t);
static constexpr size_t PAYLOAD_HEADER_SIZE = 2;
static constexpr uint8_t MAX_PLANES = 20;
static constexpr size_t PAYLOAD_MAX_SIZE =
    PAYLOAD_HEADER_SIZE + static_cast<size_t>(MAX_PLANES) * sizeof(Plane_t);
