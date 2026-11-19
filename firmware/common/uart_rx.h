#pragma once

#include <Arduino.h>
#include <stddef.h>
#include <stdint.h>

template <size_t N>
class UartRxBuffer {
 public:
  void drain(Stream &stream) {
    while (stream.available() > 0) {
      int value = stream.read();
      if (value < 0) {
        break;
      }
      size_t next = (head_ + 1) % N;
      if (next != tail_) {
        buffer_[head_] = static_cast<uint8_t>(value);
        head_ = next;
      }
    }
  }

  int available() const {
    size_t head = head_;
    size_t tail = tail_;
    return static_cast<int>((head + N - tail) % N);
  }

  int read() {
    if (head_ == tail_) {
      return -1;
    }
    uint8_t value = buffer_[tail_];
    tail_ = (tail_ + 1) % N;
    return static_cast<int>(value);
  }

  void clear() {
    tail_ = head_;
  }

 private:
  uint8_t buffer_[N];
  volatile size_t head_ = 0;
  volatile size_t tail_ = 0;
};
