// Diagnóstico do E32 na placa do CubeSat (E32 na UART2 RX2/TX2). Também imprime o que faz na USB (115200).
// Use junto com o diag_e32 no ground, que imprime tudo o que recebe:
//   - a cada 5 s o satélite transmite "SAT<n>"       -> se o ground recebe, o TX do satélite funciona
//   - tudo que o satélite recebe ele devolve "ECO:<bytes>" -> se o ground recebe ECO, o RX do satélite funciona
// LED (GPIO2 da DevKit e GPIO13) pisca a cada byte recebido do rádio.

#define E32_RX_PIN 16  // RX2
#define E32_TX_PIN 17  // TX2
#define E32_M0_PIN 18
#define E32_M1_PIN 5
#define E32_AUX_PIN 15
#define E32_BAUD 9600

HardwareSerial E32(2);
uint32_t lastBeacon = 0;
uint32_t n = 0;

void espera() {
  uint32_t t = millis();
  while (digitalRead(E32_AUX_PIN) == LOW && millis() - t < 3000) delay(1);
}

void led(bool on) {
  digitalWrite(2, on);
  digitalWrite(13, on);
}

void setup() {
  Serial.begin(115200);
  pinMode(2, OUTPUT);
  pinMode(13, OUTPUT);
  pinMode(E32_M0_PIN, OUTPUT);
  pinMode(E32_M1_PIN, OUTPUT);
  pinMode(E32_AUX_PIN, INPUT);
  digitalWrite(E32_M0_PIN, LOW);
  digitalWrite(E32_M1_PIN, LOW);
  E32.begin(E32_BAUD, SERIAL_8N1, E32_RX_PIN, E32_TX_PIN);
  delay(500);
  espera();
  Serial.printf("\n##### diag_e32_sat: M0=%d M1=%d AUX=%d #####\n", digitalRead(E32_M0_PIN), digitalRead(E32_M1_PIN), digitalRead(E32_AUX_PIN));
  for (int i = 0; i < 3; i++) { led(true); delay(150); led(false); delay(150); }
}

void loop() {
  if (E32.available()) {
    uint8_t buf[64];
    int len = 0;
    uint32_t t = millis();
    led(true);
    while (millis() - t < 30) {
      while (E32.available() && len < (int)sizeof(buf)) { buf[len++] = E32.read(); t = millis(); }
    }
    led(false);
    delay(100);
    espera();
    Serial.printf("[rx] %d bytes -> eco\n", len);
    E32.write((const uint8_t *)"ECO:", 4);
    E32.write(buf, len);
    E32.flush();
    espera();
  }
  if (millis() - lastBeacon >= 5000) {
    lastBeacon = millis();
    char s[16];
    int k = snprintf(s, sizeof(s), "SAT%lu", (unsigned long)n++);
    espera();
    E32.write((const uint8_t *)s, k);
    E32.flush();
    espera();
    Serial.printf("[tx] %s  (AUX=%d)\n", s, digitalRead(E32_AUX_PIN));
  }
}
