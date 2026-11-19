// mock_obc — NUCLEO-L476RG fazendo papel de OBC + carga útil ADS-B (dados simulados).
//
// Envia ao TT&C, pela UART1 a 9600 8N1 (protocolo OBC->CubeSat, detalhamento §5):
//   'T' + Telemetry_t (79 B)              a cada TM_PERIOD_MS
//   'P' + count + count*Plane_t (16 B)    a cada PAYLOAD_PERIOD_MS, se Mission ativa
// e recebe 1 byte de comando 0x00..0x0F (bit0 Mission, bit1 Deploy,
// bit2 Detumbling, bit3 Pointing), atualizando os *_state da telemetria.
//
// Ligação (GND comum obrigatório) — ver também o espelhamento em D1/D0 abaixo:
//   D8 / PA9  (USART1 TX) -> ESP32 GPIO16 (RX2)
//   D2 / PA10 (USART1 RX) <- ESP32 GPIO17 (TX2)
#include <Arduino.h>
#include <math.h>
#include <string.h>

#include "../common/protocol.h"
#include "../common/telemetry.h"

#define LINK_BAUD 9600
#define TM_PERIOD_MS 1000
#define PAYLOAD_PERIOD_MS 2000
#define STEP_MS 100
#define N_PLANES 12
#define MISSION_ON_AT_BOOT 1  // 1 = aviões aparecem sem precisar de comando

// Enlace: USART1 = D8 (PA9, TX) / D2 (PA10, RX).
// Os quadros também são espelhados na USART2 (PA2/PA3), mas na Nucleo-64 essa UART só
// chega ao ST-Link (Virtual COM, útil para depurar a 9600). D0/D1 do header Arduino
// ficam DESLIGADOS de fábrica (SB62/SB63 abertas, UM1724): não use para o enlace.
Uart Link1(PA_10, PA_9);  // (rx, tx) = USART1  (STM32duino 3.x: classe Uart, PinName)
#define Link2 Serial      // USART2 (D0/D1)

void linkWrite(const uint8_t *d, size_t n) {
  Link1.write(d, n);
  Link2.write(d, n);
}
void linkWrite(uint8_t b) { linkWrite(&b, 1); }

// UNSAM, San Martín (Buenos Aires)
static const float SITE_LAT = -34.5776f;
static const float SITE_LON = -58.5196f;
static const float M_PER_DEG = 111320.0f;
// Escala do giro (LSB por °/s) — mesma premissa da ground_ui (GYRO_LSB_PER_DPS).
static const float GYRO_LSB_PER_DPS = 16.4f;

struct MockPlane {
  uint16_t id;
  uint8_t type;
  float lat, lon;
  float heading;  // graus
  float speed;    // m/s
  float turn;     // graus/s
};

MockPlane planes[N_PLANES];
Telemetry_t tm;
float rate[3] = {0.2f, -0.3f, 6.28f};  // rad/s (~60 rpm em z)
uint8_t commandMask = MISSION_ON_AT_BOOT ? 0x01 : 0x00;
bool deployed = false;
bool deploying = false;
uint32_t deployStart = 0;
#define DEPLOY_TIME_MS 3000
bool azimuthFound = false;
float azimuth = 0;
uint32_t pointingSince = 0;
uint16_t commandCount = 0, telemetryCount = 0, packetCount = 0;
uint32_t lastTm = 0, lastPayload = 0, lastStep = 0;

float frand(float a, float b) { return a + (b - a) * (random(0, 10001) / 10000.0f); }

void initPlanes() {
  for (int i = 0; i < N_PLANES; ++i) {
    float brg = frand(0, 2 * PI);
    float dist = frand(20e3f, 80e3f);
    MockPlane &p = planes[i];
    p.id = 0x4000 + i * 37;
    p.type = 1 + (i % 4);
    p.lat = SITE_LAT + dist * cosf(brg) / M_PER_DEG;
    p.lon = SITE_LON + dist * sinf(brg) / (M_PER_DEG * cosf(SITE_LAT * DEG_TO_RAD));
    p.heading = frand(0, 360);
    p.speed = frand(180, 270);
    p.turn = frand(-0.3f, 0.3f);
  }
}

void stepWorld(float dt) {
  for (int i = 0; i < N_PLANES; ++i) {
    MockPlane &p = planes[i];
    p.heading = fmodf(p.heading + p.turn * dt + 360.0f, 360.0f);
    float d = p.speed * dt;
    p.lat += d * cosf(p.heading * DEG_TO_RAD) / M_PER_DEG;
    p.lon += d * sinf(p.heading * DEG_TO_RAD) / (M_PER_DEG * cosf(p.lat * DEG_TO_RAD));
    // mantém o tráfego na região: dá meia-volta se afastar > 120 km
    float dy = (p.lat - SITE_LAT) * M_PER_DEG, dx = (p.lon - SITE_LON) * M_PER_DEG * cosf(SITE_LAT * DEG_TO_RAD);
    if (dx * dx + dy * dy > 120e3f * 120e3f) p.heading = fmodf(p.heading + 180.0f, 360.0f);
  }
  if (commandMask & 0x04) {
    for (float &w : rate) w *= expf(-0.12f * dt);  // detumbling
  }
  if ((commandMask & 0x08) && !azimuthFound && millis() - pointingSince > 8000) {
    azimuthFound = true;
    azimuth = frand(0, 359.9f);
  }
}

void applyCommand(uint8_t mask) {
  ++commandCount;
  if ((mask & 0x08) && !(commandMask & 0x08)) {
    azimuthFound = false;
    pointingSince = millis();
  }
  if ((mask & 0x02) && !deployed && !deploying) {  // 3 s "deploying", depois travado
    deploying = true;
    deployStart = millis();
  }
  commandMask = mask;
}

void sendTelemetry() {
  uint32_t now = millis();
  memset(&tm, 0, sizeof(tm));
  bool charging = sinf(now / 60000.0f) > 0;
  tm.timestamp_ms = now;
  tm.uptime_ms = now;
  tm.mode = (commandMask & 0x01) ? 2 : 1;
  tm.flags = (deployed ? 0x01 : 0) | (charging ? 0x02 : 0);
  tm.error_count = 0;
  tm.battery_voltage = 3.9f + 0.15f * sinf(now / 45000.0f) + frand(-0.005f, 0.005f);
  tm.battery_current = (charging ? 0.35f : -0.22f) + frand(-0.015f, 0.015f);
  tm.temperature = 24.0f + 3.0f * sinf(now / 120000.0f) + frand(-0.1f, 0.1f);
  const float lsbPerRad = GYRO_LSB_PER_DPS * RAD_TO_DEG;
  tm.gyro_x = constrain(lroundf(rate[0] * lsbPerRad), -32768, 32767);
  tm.gyro_y = constrain(lroundf(rate[1] * lsbPerRad), -32768, 32767);
  tm.gyro_z = constrain(lroundf(rate[2] * lsbPerRad), -32768, 32767);
  tm.accel_x = 12 + random(-40, 41);
  tm.accel_y = -40 + random(-40, 41);
  tm.accel_z = 16384 + random(-40, 41);
  tm.mag_x = 220 + random(-3, 4);
  tm.mag_y = -130 + random(-3, 4);
  tm.mag_z = 410 + random(-3, 4);
  tm.latitude = SITE_LAT;
  tm.longitude = SITE_LON;
  tm.altitude = 25.0f;
  if (deploying && now - deployStart >= DEPLOY_TIME_MS) {
    deploying = false;
    deployed = true;
  }
  tm.deploy_state = deployed ? 2 : (deploying ? 1 : 0);
  tm.detumbling_state = (commandMask & 0x04) ? 1 : 0;
  tm.pointing_state = (commandMask & 0x08) ? (azimuthFound ? 2 : 1) : 0;
  tm.mission_state = (commandMask & 0x01) ? 1 : 0;
  tm.command_count = commandCount;
  tm.telemetry_count = ++telemetryCount;
  tm.packet_count = packetCount;
  if (azimuthFound) {  // proposta: azimute ASCII de 5 chars em reserved[0..4] (Notion/ADCS)
    char buf[8];
    snprintf(buf, sizeof(buf), "%05.1f", azimuth);
    memcpy(tm.reserved, buf, 5);
  }
  linkWrite(static_cast<uint8_t>(TELEMETRY_ID));
  linkWrite(reinterpret_cast<const uint8_t *>(&tm), sizeof(tm));
}

void sendPayload() {
  Plane_t out[MAX_PLANES];
  uint8_t n = 0;
  for (int i = 0; i < N_PLANES && n < MAX_PLANES; ++i) {
    if (random(100) < 15) continue;  // nem todo avião é ouvido em todo ciclo
    out[n].id = planes[i].id;
    out[n].type = planes[i].type;
    out[n].flags = 0x01;
    out[n].latitude = planes[i].lat;
    out[n].longitude = planes[i].lon;
    out[n].confidence = frand(0.7f, 1.0f);
    ++n;
  }
  ++packetCount;
  linkWrite(static_cast<uint8_t>(PAYLOAD_ID));
  linkWrite(n);
  linkWrite(reinterpret_cast<const uint8_t *>(out), n * sizeof(Plane_t));
}

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  Link1.begin(LINK_BAUD);
  Link2.begin(LINK_BAUD);
  randomSeed(analogRead(A0) ^ micros());
  initPlanes();
}

void loop() {
  uint32_t now = millis();
  while (Link1.available() > 0) {
    int v = Link1.read();
    if (v >= 0 && v <= CMD_MAX) applyCommand(static_cast<uint8_t>(v));
  }
  while (Link2.available() > 0) {
    int v = Link2.read();
    if (v >= 0 && v <= CMD_MAX) applyCommand(static_cast<uint8_t>(v));
  }
  if (now - lastStep >= STEP_MS) {
    stepWorld((now - lastStep) / 1000.0f);
    lastStep = now;
  }
  if (now - lastTm >= TM_PERIOD_MS) {
    lastTm = now;
    sendTelemetry();
    digitalWrite(LED_BUILTIN, !digitalRead(LED_BUILTIN));
  }
  if ((commandMask & 0x01) && now - lastPayload >= PAYLOAD_PERIOD_MS) {
    lastPayload = now;
    sendPayload();
  }
}
