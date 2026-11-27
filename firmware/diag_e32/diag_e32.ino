// Diagnóstico do E32-433T20D na placa do ground (E32 na UART2 16/17; USB livre para o relatório).
// Mostra: níveis de M0/M1/AUX, configuração gravada no módulo (C1), versão (C3) e, a cada 3 s,
// transmite um pacote de teste medindo quanto tempo o AUX fica baixo (≈ tempo no ar).
// Também imprime em hex qualquer byte recebido pelo rádio.
// Monitor serial a 115200. Comandos: 'c' relê a configuração, 's' para/retoma os envios.

#define E32_RX_PIN 16
#define E32_TX_PIN 17
#define E32_M0_PIN 18
#define E32_M1_PIN 5
#define E32_AUX_PIN 15
#define E32_BAUD 9600

HardwareSerial E32(2);
bool sending = true;
uint32_t lastSend = 0;
uint32_t count = 0;

void modo(bool m0, bool m1) {
  digitalWrite(E32_M0_PIN, m0);
  digitalWrite(E32_M1_PIN, m1);
}

bool esperaAux(uint32_t ms) {
  uint32_t t = millis();
  while (digitalRead(E32_AUX_PIN) == LOW) {
    if (millis() - t >= ms) return false;
    delay(1);
  }
  return true;
}

void pinos(const char *quando) {
  Serial.printf("[pinos] %s: M0=%d M1=%d AUX=%d\n", quando, digitalRead(E32_M0_PIN),
                digitalRead(E32_M1_PIN), digitalRead(E32_AUX_PIN));
}

int leResposta(uint8_t *buf, int n, uint32_t ms) {
  int got = 0;
  uint32_t t = millis();
  while (got < n && millis() - t < ms) {
    if (E32.available()) buf[got++] = E32.read();
  }
  return got;
}

void leConfig() {
  Serial.println("\n=== configuração do E32 ===");
  modo(HIGH, HIGH);
  delay(50);
  pinos("modo config (M0=M1=1)");
  if (!esperaAux(2000)) Serial.println("[ERRO] AUX não subiu em 2 s no modo config (AUX desligado? módulo sem alimentação?)");
  while (E32.available()) E32.read();

  const uint8_t c1[3] = {0xC1, 0xC1, 0xC1};
  E32.write(c1, 3);
  E32.flush();
  uint8_t r[6];
  int n = leResposta(r, 6, 1000);
  Serial.printf("C1 -> %d bytes:", n);
  for (int i = 0; i < n; i++) Serial.printf(" %02X", r[i]);
  Serial.println();
  if (n == 6 && (r[0] == 0xC0 || r[0] == 0xC2)) {
    static const char *air[] = {"0.3k", "1.2k", "2.4k", "4.8k", "9.6k", "19.2k", "19.2k", "19.2k"};
    static const uint32_t uart[] = {1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200};
    static const char *pot[] = {"20 dBm", "17 dBm", "14 dBm", "10 dBm"};
    uint8_t sped = r[3], chan = r[4], opt = r[5];
    Serial.printf("  endereço  ADDH:ADDL = %02X:%02X\n", r[1], r[2]);
    Serial.printf("  UART      %lu baud, paridade bits=%d\n", (unsigned long)uart[(sped >> 3) & 7], sped >> 6);
    Serial.printf("  taxa ar   %s\n", air[sped & 7]);
    Serial.printf("  canal     0x%02X -> %d MHz (se for E32-433)\n", chan, 410 + (chan & 0x1F));
    Serial.printf("  modo      %s\n", (opt & 0x80) ? "FIXO (os 3 primeiros bytes viram endereço+canal!)" : "transparente");
    Serial.printf("  FEC       %s\n", (opt & 0x04) ? "ligado" : "desligado");
    Serial.printf("  potência  %s\n", pot[opt & 3]);
    Serial.printf("  IO drive  %s\n", (opt & 0x40) ? "push-pull" : "open-drain");
  } else {
    Serial.println("[ERRO] resposta inválida: confira TXD/RXD do E32 (cruzados?), M0/M1 e alimentação");
  }

  while (E32.available()) E32.read();
  const uint8_t c3[3] = {0xC3, 0xC3, 0xC3};
  E32.write(c3, 3);
  E32.flush();
  uint8_t v[4];
  n = leResposta(v, 4, 1000);
  Serial.printf("C3 (versão) -> %d bytes:", n);
  for (int i = 0; i < n; i++) Serial.printf(" %02X", v[i]);
  Serial.println(n == 4 ? (v[1] == 0x32 ? "  (433 MHz)" : v[1] == 0x38 ? "  (470 MHz)" : v[1] == 0x45 ? "  (868 MHz)" : v[1] == 0x44 ? "  (915 MHz)" : "") : "");

  modo(LOW, LOW);
  delay(50);
  esperaAux(2000);
  pinos("modo normal (M0=M1=0)");
  Serial.println("===========================\n");
}

void transmite() {
  uint8_t pkt[15] = {0xA5, 0x5A, 'D', 'I', 'A', 'G'};
  pkt[6] = count & 0xFF;
  for (int i = 7; i < 15; i++) pkt[i] = 0x55;
  if (digitalRead(E32_AUX_PIN) == LOW) Serial.println("[aviso] AUX já estava baixo antes de enviar");
  uint32_t t0 = micros();
  E32.write(pkt, sizeof(pkt));
  E32.flush();
  uint32_t tUart = micros() - t0;
  // espera o AUX descer (até 20 ms) e depois subir
  uint32_t t1 = micros();
  bool desceu = false;
  while (micros() - t1 < 20000) {
    if (digitalRead(E32_AUX_PIN) == LOW) { desceu = true; break; }
  }
  bool subiu = esperaAux(3000);
  uint32_t total = micros() - t0;
  Serial.printf("[tx %lu] UART %lu us | AUX %s | total até AUX alto %lu ms%s\n", (unsigned long)count,
                (unsigned long)tUart, desceu ? "desceu" : "NÃO desceu", (unsigned long)(total / 1000),
                subiu ? "" : " (AUX preso em baixo!)");
  count++;
}

void setup() {
  Serial.begin(115200);
  pinMode(E32_M0_PIN, OUTPUT);
  pinMode(E32_M1_PIN, OUTPUT);
  pinMode(E32_AUX_PIN, INPUT);
  E32.begin(E32_BAUD, SERIAL_8N1, E32_RX_PIN, E32_TX_PIN);
  delay(1500);
  Serial.println("\n##### diag_e32 #####");
  pinos("logo após o boot (antes de configurar M0/M1)");
  modo(LOW, LOW);
  delay(100);
  leConfig();
}

void loop() {
  while (Serial.available()) {
    int c = Serial.read();
    if (c == 'c') leConfig();
    if (c == 's') { sending = !sending; Serial.printf("envios %s\n", sending ? "ligados" : "parados"); }
  }
  if (E32.available()) {
    Serial.print("[rx]");
    uint32_t t = millis();
    while (millis() - t < 30) {
      while (E32.available()) { Serial.printf(" %02X", E32.read()); t = millis(); }
    }
    Serial.println();
  }
  if (sending && millis() - lastSend >= 3000) {
    lastSend = millis();
    transmite();
  }
}
