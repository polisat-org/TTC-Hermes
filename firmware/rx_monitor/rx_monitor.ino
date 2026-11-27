// Monitor de recepção do E32 na placa do ground (E32 na UART2 16/17). Não transmite nada.
// Imprime no monitor serial (115200) cada pacote recebido pelo rádio, em texto e em hex.
// Use com o diag_e32_sat no CubeSat: deve aparecer "SAT0", "SAT1", ... a cada 5 s.

#define E32_RX_PIN 16
#define E32_TX_PIN 17
#define E32_M0_PIN 18
#define E32_M1_PIN 5
#define E32_AUX_PIN 15
#define E32_BAUD 9600

HardwareSerial E32(2);
uint32_t pacotes = 0;
uint32_t ultimoAviso = 0;

void setup() {
  Serial.begin(115200);
  pinMode(E32_M0_PIN, OUTPUT);
  pinMode(E32_M1_PIN, OUTPUT);
  pinMode(E32_AUX_PIN, INPUT);
  digitalWrite(E32_M0_PIN, LOW);  // modo normal
  digitalWrite(E32_M1_PIN, LOW);
  E32.begin(E32_BAUD, SERIAL_8N1, E32_RX_PIN, E32_TX_PIN);
  delay(500);
  Serial.println("\n##### rx_monitor: escutando o E32 (433 MHz, canal 0x17, 2.4k) #####");
}

void loop() {
  if (E32.available()) {
    uint8_t buf[256];
    int len = 0;
    uint32_t t = millis();
    while (millis() - t < 30 && len < (int)sizeof(buf)) {  // junta bytes até 30 ms de silêncio
      while (E32.available() && len < (int)sizeof(buf)) { buf[len++] = E32.read(); t = millis(); }
    }
    pacotes++;
    Serial.printf("[%8.1f s] #%lu  %d bytes  texto: \"", millis() / 1000.0, (unsigned long)pacotes, len);
    for (int i = 0; i < len; i++) Serial.write(buf[i] >= 32 && buf[i] < 127 ? buf[i] : '.');
    Serial.print("\"  hex:");
    for (int i = 0; i < len; i++) Serial.printf(" %02X", buf[i]);
    Serial.println();
    ultimoAviso = millis();
  }
  if (millis() - ultimoAviso >= 10000) {  // sinal de vida quando nada chega
    ultimoAviso = millis();
    Serial.printf("[%8.1f s] ... nada recebido nos últimos 10 s (AUX=%d)\n", millis() / 1000.0,
                  digitalRead(E32_AUX_PIN));
  }
}
