#pragma once

// Parser dos quadros OBC -> TT&C ('T', 'P', 'H', 'Z'; ver telemetry.h), byte a byte.
// A UART do OBC não tem sincronismo nem CRC: o parser descarta bytes que não iniciam um quadro,
// rejeita contagem de aviões > 20 e azimute fora do formato "ddd.d", e abandona um quadro
// incompleto se a UART ficar parada mais que OBC_FRAME_GAP_MS (o OBC manda cada quadro de uma vez).

#include <Arduino.h>
#include <stddef.h>
#include <stdint.h>

#include "protocol.h"
#include "telemetry.h"

#ifndef OBC_FRAME_GAP_MS
#define OBC_FRAME_GAP_MS 100
#endif

// Tamanho total do quadro que começa com id; count = 2º byte (só para 'P'). 0 = id desconhecido.
inline size_t obcFrameSize(uint8_t id, uint8_t count) {
  switch (id) {
    case TELEMETRY_ID: return TELEMETRY_FRAME_SIZE;
    case PAYLOAD_ID: return count <= MAX_PLANES ? PAYLOAD_HEADER_SIZE + static_cast<size_t>(count) * sizeof(Plane_t) : 0;
    case THERMAL_ID: return THERMAL_FRAME_SIZE;
    case AZIMUTH_ID: return AZIMUTH_FRAME_SIZE;
    default: return 0;
  }
}

// Confere se um quadro completo é válido (tamanho e conteúdo mínimo).
inline bool obcFrameValid(const uint8_t *f, size_t len) {
  if (f == nullptr || len == 0) return false;
  size_t need = obcFrameSize(f[0], len > 1 ? f[1] : 0);
  if (need == 0 || need != len) return false;
  if (f[0] == AZIMUTH_ID) {
    auto dig = [](uint8_t c) { return c >= '0' && c <= '9'; };
    if (!(dig(f[1]) && dig(f[2]) && dig(f[3]) && f[4] == '.' && dig(f[5]))) return false;
    if ((f[1] - '0') * 100 + (f[2] - '0') * 10 + (f[3] - '0') > 359) return false;
  }
  if (f[0] == THERMAL_ID && !(f[1] == 'T' && f[2] == 'C' && f[3] == 'S')) return false;
  return true;
}

class ObcFrameParser {
 public:
  // Alimenta um byte. Devolve true quando frame()/length() têm um quadro completo e válido.
  bool feed(uint8_t b, uint32_t nowMs) {
    if (len_ > 0 && static_cast<uint32_t>(nowMs - lastByteMs_) > OBC_FRAME_GAP_MS) {
      len_ = 0;            // quadro anterior ficou pela metade
      ++incomplete_;
    }
    lastByteMs_ = nowMs;
    if (len_ == 0) {
      if (b != TELEMETRY_ID && b != PAYLOAD_ID && b != THERMAL_ID && b != AZIMUTH_ID) {
        ++noise_;
        return false;
      }
      buf_[0] = b;
      len_ = 1;
      need_ = (b == PAYLOAD_ID) ? 2 : obcFrameSize(b, 0);
      return false;
    }
    buf_[len_++] = b;
    if (buf_[0] == PAYLOAD_ID && len_ == 2) {
      need_ = obcFrameSize(PAYLOAD_ID, b);
      if (need_ == 0) {    // contagem impossível: não era quadro
        len_ = 0;
        ++noise_;
        return false;
      }
    }
    if (len_ < need_) return false;
    size_t n = len_;
    len_ = 0;
    if (!obcFrameValid(buf_, n)) {
      ++invalid_;
      return false;
    }
    frameLen_ = n;
    ++frames_;
    return true;
  }

  const uint8_t *frame() const { return buf_; }
  size_t length() const { return frameLen_; }
  uint8_t type() const { return buf_[0]; }
  uint32_t frames() const { return frames_; }
  uint32_t noiseBytes() const { return noise_; }
  uint32_t invalidFrames() const { return invalid_; }
  uint32_t incompleteFrames() const { return incomplete_; }

 private:
  uint8_t buf_[OBC_FRAME_MAX];
  size_t len_ = 0;
  size_t need_ = 0;
  size_t frameLen_ = 0;
  uint32_t lastByteMs_ = 0;
  uint32_t frames_ = 0, noise_ = 0, invalid_ = 0, incomplete_ = 0;
};
