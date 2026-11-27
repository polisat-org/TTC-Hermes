#pragma once

// Quadros OBC -> TT&C, iguais aos do firmware do OBC (polisat-org/OBC):
//   'T' + Telemetry_t   (1 + 85 B)  telemetria (Core/Inc/customTypes.h)
//   'P' + n + n*Plane_t (2 + 36n B, n <= 20)  aviões ADS-B (Core/Inc/payload_downlink.h)
//   'H' + TcsStatus_t   (1 + 32 B)  controle térmico do payload, repassado inteiro
//   'Z' + 5 caracteres  (1 + 5 B)   azimute do ADCS, "ddd.d"
// Tudo little-endian e packed. Se o OBC mudar um struct, mude AQUI (e os static_assert).

#include <stddef.h>
#include <stdint.h>

struct __attribute__((packed)) Telemetry_t {
  // OBC (RTC)
  uint8_t hora;
  uint8_t minuto;
  uint8_t segundo;
  uint8_t dia;
  uint8_t mes;
  uint8_t ano;
  // Mecânica
  float temperatura_bateria;
  float temperatura_estrutura;
  float umidade;
  float pressao;
  uint8_t deploy_antena;
  // EPS: barramentos 13,8 V e 5 V
  float tensao_13v8;
  float tensao_5v;
  float corrente_13v8;
  float corrente_5v;
  // Painéis solares
  float tensao_painel_solar_1;
  float tensao_painel_solar_2;
  float tensao_painel_solar_3;
  float tensao_painel_solar_4;
  // Carregadores
  uint8_t status_carregador_1;
  uint8_t status_carregador_2;
  uint8_t falha_carregador_1;
  uint8_t falha_carregador_2;
  // ADC
  uint8_t adc_tensao_sistema_1;
  uint8_t adc_tensao_sistema_2;
  uint8_t adc_tensao_ntc_1;
  uint8_t adc_tensao_ntc_2;
  uint8_t adc_corrente_carga_1;
  uint8_t adc_corrente_carga_2;
  uint8_t adc_corrente_sistema_1;
  uint8_t adc_corrente_sistema_2;
  // ADCS: último azimute "ddd.d" + '\0'
  char angulo_apontamento[6];
  // Baterias
  uint16_t tensao_bateria_1;
  uint16_t tensao_bateria_2;
  uint16_t carga_bateria_1;
  uint16_t carga_bateria_2;
  int16_t taxa_carga_descarga_bateria_1;
  int16_t taxa_carga_descarga_bateria_2;
};
static_assert(sizeof(Telemetry_t) == 85, "Telemetry_t precisa ter 85 B (igual ao OBC)");

// Avião no downlink (PlaneDown_t do OBC). NaN = campo ausente.
struct __attribute__((packed)) Plane_t {
  uint32_t icao;              // 24 bits, nunca 0
  float latitude;             // graus
  float longitude;            // graus
  float altitude_ft;          // pés (alt_baro)
  float velocity_kt;          // nós (gs)
  float track_deg;            // graus
  uint32_t last_pos_met_ms;   // tempo de missão da posição; 0 = inválido
  char callsign[8];           // indicativo de voo (ASCII), completado com 0
};
static_assert(sizeof(Plane_t) == 36, "Plane_t precisa ter 36 B (PlaneDown_t do OBC)");

// Trailer do controle térmico (TCS) do Raspberry Pi, repassado inteiro pelo OBC.
struct __attribute__((packed)) TcsStatus_t {
  char magic[4];              // "TCS1"
  uint8_t versao;             // 1
  uint8_t flags;              // bit0: dado válido
  uint16_t idade_ds;          // idade da leitura (0,1 s); 0xFFFF sem dado
  int16_t temp_x100[4];       // sondas 1..4 (0,01 °C); -32768 = inválida
  uint8_t duty[2];            // aquecedores A/B (%)
  uint8_t situacao[2];        // situação A/B
  uint32_t t_ds;              // relógio do TCS (0,1 s)
  uint8_t missao;             // missão ADS-B ativa
  uint8_t avioes;             // aviões no bloco
  uint8_t reservado[4];
  uint16_t crc;               // CRC16-CCITT (0x1021, init 0xFFFF) dos bytes 0..29
};
static_assert(sizeof(TcsStatus_t) == 32, "TcsStatus_t precisa ter 32 B");

static constexpr uint8_t MAX_PLANES = 20;
static constexpr size_t AZIMUTH_LEN = 5;
static constexpr size_t TELEMETRY_FRAME_SIZE = 1 + sizeof(Telemetry_t);
static constexpr size_t PAYLOAD_HEADER_SIZE = 2;
static constexpr size_t PAYLOAD_MAX_SIZE = PAYLOAD_HEADER_SIZE + static_cast<size_t>(MAX_PLANES) * sizeof(Plane_t);
static constexpr size_t THERMAL_FRAME_SIZE = 1 + sizeof(TcsStatus_t);
static constexpr size_t AZIMUTH_FRAME_SIZE = 1 + AZIMUTH_LEN;
static constexpr size_t OBC_FRAME_MAX = PAYLOAD_MAX_SIZE;
