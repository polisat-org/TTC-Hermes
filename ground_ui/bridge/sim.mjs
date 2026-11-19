// Simulador do Ground ESP32: gera exatamente os bytes que ground_ttc.ino
// escreveria na USB ('A', 'T', 'P') e reage aos bytes de comando.
// Serve para desenvolver/testar a interface sem hardware. Inclui ruído de boot
// para exercitar a ressincronização do parser.
import { EventEmitter } from 'node:events';
import { encodeAck, encodePayload, encodeTelemetry, CMD_MAX } from './protocol.mjs';

// UNSAM, San Martín (Buenos Aires) — local da etapa presencial.
const SITE = { lat: -34.5776, lon: -58.5196 };
const R_EARTH = 6371e3;

function destPoint(lat, lon, bearingDeg, distM) {
  const d = distM / R_EARTH;
  const b = (bearingDeg * Math.PI) / 180;
  const p1 = (lat * Math.PI) / 180;
  const l1 = (lon * Math.PI) / 180;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: (p2 * 180) / Math.PI, lon: (l2 * 180) / Math.PI };
}

export class GroundSimulator extends EventEmitter {
  constructor({ nPlanes = 12, tmPeriodMs = 1000, payloadPeriodMs = 3000 } = {}) {
    super();
    this.t0 = Date.now();
    this.tmPeriodMs = tmPeriodMs;
    this.payloadPeriodMs = payloadPeriodMs;
    this.mask = 0;
    this.state = { deploy: 0, detumbling: 0, pointing: 0, mission: 0 };
    this.counts = { command: 0, telemetry: 0, packet: 0 };
    this.rate = [0.2, -0.3, 6.28]; // rad/s (~60 rpm em z), cenário de detumbling
    this.azimuth = null;
    this.planes = Array.from({ length: nPlanes }, (_, i) => {
      const start = destPoint(SITE.lat, SITE.lon, Math.random() * 360, 20e3 + Math.random() * 60e3);
      return {
        id: 0x4000 + i * 37,
        type: 1 + (i % 4),
        heading: Math.random() * 360,
        speed: 180 + Math.random() * 90, // m/s
        turn: (Math.random() - 0.5) * 0.6, // °/s
        ...start,
      };
    });
  }

  start() {
    // Mensagens de boot do ROM do ESP32 (texto a 115200 ao abrir a porta).
    this.emitBytes(Buffer.from('ets Jun  8 2016 00:22:57\r\n\r\nrst:0x1 (POWERON_RESET),boot:0x13 (SPI_FAST_FLASH_BOOT)\r\n'));
    this.tmTimer = setInterval(() => this.sendTelemetry(), this.tmPeriodMs);
    this.plTimer = setInterval(() => this.sendPayload(), this.payloadPeriodMs);
    this.stepTimer = setInterval(() => this.step(0.2), 200);
  }

  stop() {
    clearInterval(this.tmTimer);
    clearInterval(this.plTimer);
    clearInterval(this.stepTimer);
  }

  emitBytes(b) {
    // Entrega em pedaços aleatórios para simular a fragmentação da USB-CDC.
    let i = 0;
    while (i < b.length) {
      const n = 1 + Math.floor(Math.random() * 64);
      this.emit('data', Buffer.from(b.subarray(i, i + n)));
      i += n;
    }
  }

  /** Byte(s) vindos do PC. */
  write(bytes) {
    for (const cmd of bytes) {
      if (cmd > CMD_MAX) continue;
      // Ground espera TX_GUARD + RDT (ACK ou até 6 tentativas de 2.5 s).
      const fail = Math.random() < 0.08;
      const delay = fail ? 15000 : 400 + Math.random() * 1800;
      setTimeout(() => {
        this.emitBytes(encodeAck(cmd, fail ? 1 : 0));
        if (!fail) this.applyCommand(cmd);
      }, delay);
    }
  }

  applyCommand(mask) {
    this.counts.command++;
    this.mask = mask;
    this.state.mission = mask & 1 ? 1 : 0;
    if (mask & 2 && this.state.deploy === 0) {
      this.state.deploy = 1; // 3 s "deploying", depois travado em 2
      setTimeout(() => (this.state.deploy = 2), 3000);
    }
    this.state.detumbling = mask & 4 ? 1 : 0;
    this.state.pointing = mask & 8 ? 1 : 0;
    if (this.state.pointing) this.azimuth = null;
  }

  step(dt) {
    for (const p of this.planes) {
      p.heading = (p.heading + p.turn * dt + 360) % 360;
      Object.assign(p, destPoint(p.lat, p.lon, p.heading, p.speed * dt));
    }
    if (this.state.detumbling) this.rate = this.rate.map((w) => w * Math.exp(-0.12 * dt));
    if (this.state.pointing && this.azimuth === null && Math.random() < 0.02) {
      this.azimuth = 180 + Math.random() * 180;
      this.state.pointing = 2; // encontrado
    }
  }

  sendTelemetry() {
    const now = Date.now() - this.t0;
    this.counts.telemetry++;
    if (Math.random() < 0.05) return; // perda simulada (contador avança)
    const charging = Math.sin(now / 60000) > 0;
    const azStr = this.azimuth === null ? null : this.azimuth.toFixed(1).padStart(5, '0').slice(0, 5);
    const reserved = new Array(15).fill(0);
    if (azStr) for (let i = 0; i < 5; i++) reserved[i] = azStr.charCodeAt(i);
    const gyroLsb = 16.4 * (180 / Math.PI); // LSB por rad/s (MPU ±2000 °/s, mesmo valor default da UI)
    const tm = {
      timestamp_ms: now,
      uptime_ms: now + 4200,
      mode: this.state.mission ? 2 : 1,
      flags: (this.state.deploy ? 1 : 0) | (charging ? 2 : 0),
      error_count: Math.floor(now / 97000),
      battery_voltage: 3.9 + 0.15 * Math.sin(now / 45000) + (Math.random() - 0.5) * 0.01,
      battery_current: (charging ? 0.35 : -0.22) + (Math.random() - 0.5) * 0.03,
      temperature: 24 + 3 * Math.sin(now / 120000) + (Math.random() - 0.5) * 0.2,
      gyro: this.rate.map((w) => Math.max(-32768, Math.min(32767, Math.round(w * gyroLsb)))),
      accel: [12, -40, 16384].map((a) => a + Math.round((Math.random() - 0.5) * 80)),
      mag: [220, -130, 410].map((m) => m + Math.round((Math.random() - 0.5) * 6)),
      latitude: SITE.lat,
      longitude: SITE.lon,
      altitude: 25,
      deploy_state: this.state.deploy,
      detumbling_state: this.state.detumbling,
      pointing_state: this.state.pointing,
      mission_state: this.state.mission,
      command_count: this.counts.command,
      telemetry_count: this.counts.telemetry,
      packet_count: this.counts.packet,
      reserved,
    };
    this.emitBytes(encodeTelemetry(tm));
  }

  sendPayload() {
    if (!this.state.mission) return;
    this.counts.packet++;
    // Nem toda aeronave é vista em todo ciclo.
    const seen = this.planes.filter(() => Math.random() > 0.15);
    const planes = seen.map((p) => ({
      id: p.id,
      type: p.type,
      flags: 0x01,
      latitude: p.lat,
      longitude: p.lon,
      confidence: 0.7 + Math.random() * 0.3,
    }));
    this.emitBytes(encodePayload(planes));
  }
}
