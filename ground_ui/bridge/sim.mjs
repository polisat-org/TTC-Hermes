// Simulador do Ground ESP32: gera os bytes que ground_ttc.ino escreveria na USB, ou seja, os quadros do OBC
// real ('T', 'P', 'H', 'Z') e as respostas 'A', e reage aos bytes de comando como o handleTelecommand do OBC.
// Serve para desenvolver/testar a interface sem hardware. Inclui ruído de boot para exercitar a
// ressincronização do parser.
//
// Cadência (igual ao OBC): 'T' no boot e a cada 60 s (tmPeriodMs), 'P' + 'H' a cada 5 s com a missão ligada,
// 'Z' a cada 1 s com o apontamento ligado (depois de achar a luz).
import { EventEmitter } from 'node:events';
import { encodeAck, encodeAzimuth, encodePayload, encodeTelemetry, encodeThermal, CMD_MAX } from './protocol.mjs';

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
  constructor({ nPlanes = 12, tmPeriodMs = 60_000, payloadPeriodMs = 5000 } = {}) {
    super();
    this.t0 = Date.now();
    this.tmPeriodMs = tmPeriodMs;
    this.payloadPeriodMs = payloadPeriodMs;
    this.state = { mission: false, deploy: 0, detumbling: false, pointing: false };
    this.azimuth = null; // último azimute achado ("ddd.d" na telemetria)
    this.missionStart = null;
    this.planes = Array.from({ length: nPlanes }, (_, i) => {
      const start = destPoint(SITE.lat, SITE.lon, Math.random() * 360, 20e3 + Math.random() * 60e3);
      return {
        icao: 0xe48000 + i * 37,
        callsign: i % 4 === 3 ? '' : `${['TAM', 'GLO', 'AZU'][i % 3]}${3000 + i * 17}`, // alguns sem indicativo
        heading: Math.random() * 360,
        speed: 180 + Math.random() * 90, // m/s
        alt: 3000 + Math.random() * 30000, // ft
        turn: (Math.random() - 0.5) * 0.6, // °/s
        ...start,
      };
    });
  }

  start() {
    // Mensagens de boot do ROM do ESP32 (texto a 115200 ao abrir a porta).
    this.emitBytes(Buffer.from('ets Jun  8 2016 00:22:57\r\n\r\nrst:0x1 (POWERON_RESET),boot:0x13 (SPI_FAST_FLASH_BOOT)\r\n'));
    setTimeout(() => this.sendTelemetry(), 500); // o OBC manda a 1ª telemetria no boot
    this.tmTimer = setInterval(() => this.sendTelemetry(), this.tmPeriodMs);
    this.plTimer = setInterval(() => this.sendPayload(), this.payloadPeriodMs);
    this.azTimer = setInterval(() => this.sendAzimuth(), 1000);
    this.stepTimer = setInterval(() => this.step(0.2), 200);
  }

  stop() {
    for (const t of [this.tmTimer, this.plTimer, this.azTimer, this.stepTimer]) clearInterval(t);
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
      // Ground espera TX_GUARD + RDT (ACK ou até 6 tentativas de 2,5 s).
      const fail = Math.random() < 0.05;
      const delay = fail ? 15000 : 400 + Math.random() * 1800;
      setTimeout(() => {
        this.emitBytes(encodeAck(cmd, fail ? 1 : 0));
        if (!fail) this.applyCommand(cmd);
      }, delay);
    }
  }

  // Igual ao handleTelecommand do OBC: com o bit Deploy (e antena ainda não aberta) só faz o deploy.
  applyCommand(mask) {
    if (mask & 2 && this.state.deploy === 0) {
      this.state.deploy = 1;
      setTimeout(() => (this.state.deploy = 2), 3000);
      return;
    }
    const mission = !!(mask & 1);
    if (mission && !this.state.mission) this.missionStart = Date.now();
    this.state.mission = mission;
    this.state.detumbling = !!(mask & 4);
    // detumbling tem prioridade sobre o apontamento
    const pointing = !!(mask & 8) && !this.state.detumbling;
    if (pointing && !this.state.pointing) this.pointingSince = Date.now();
    this.state.pointing = pointing;
  }

  step(dt) {
    for (const p of this.planes) {
      p.heading = (p.heading + p.turn * dt + 360) % 360;
      Object.assign(p, destPoint(p.lat, p.lon, p.heading, p.speed * dt));
    }
  }

  sendTelemetry() {
    const now = Date.now() - this.t0;
    const s = Math.floor(now / 1000);
    const charging = Math.sin(now / 600000) > 0;
    const noise = (a) => (Math.random() - 0.5) * a;
    const tm = {
      // RTC zerado no boot do OBC: hora = tempo desde que ligou
      hora: Math.floor(s / 3600) % 24, minuto: Math.floor(s / 60) % 60, segundo: s % 60, dia: 1, mes: 1, ano: 0,
      temperatura_bateria: 6 + 2 * Math.sin(now / 900000) + noise(0.2),
      temperatura_estrutura: 22 + 3 * Math.sin(now / 1200000) + noise(0.2),
      umidade: 45 + noise(2),
      pressao: 1012 + noise(1),
      deploy_antena: this.state.deploy === 2 ? 1 : 0,
      tensao_13v8: 12.4 + noise(0.1),
      tensao_5v: 5.0 + noise(0.04),
      corrente_13v8: (this.state.detumbling ? 0.9 : 0.25) + noise(0.05),
      corrente_5v: (this.state.mission ? 0.85 : 0.35) + noise(0.05),
      status_carregador_1: charging ? 0x48 : 0x40,
      status_carregador_2: charging ? 0x48 : 0x40,
      angulo_apontamento: this.azimuth === null ? '' : this.azimuth.toFixed(1).padStart(5, '0'),
      tensao_bateria_1: Math.round(3900 + 150 * Math.sin(now / 450000) + noise(10)),
      tensao_bateria_2: Math.round(3880 + 150 * Math.sin(now / 450000) + noise(10)),
      carga_bateria_1: Math.round(80 + 10 * Math.sin(now / 450000)),
      carga_bateria_2: Math.round(78 + 10 * Math.sin(now / 450000)),
    };
    this.emitBytes(encodeTelemetry(tm));
  }

  sendPayload() {
    if (!this.state.mission) return;
    const met = Date.now() - (this.missionStart ?? Date.now());
    // Nem toda aeronave é vista em todo ciclo.
    const seen = this.planes.filter(() => Math.random() > 0.15).slice(0, 20);
    const planes = seen.map((p) => ({
      icao: p.icao,
      latitude: p.lat,
      longitude: p.lon,
      altitude_ft: Math.round(p.alt / 25) * 25,
      velocity_kt: p.speed * 1.94384,
      track_deg: p.heading,
      last_pos_met_ms: Math.max(1, met - Math.floor(Math.random() * 2000)),
      callsign: p.callsign,
    }));
    this.emitBytes(encodePayload(planes));
    const heat = this.state.mission ? 60 : 0;
    this.emitBytes(
      encodeThermal({
        probes_c: [5.5, 6.1, 5.8, 6.4].map((x) => x + (Math.random() - 0.5) * 0.3),
        duty_pct: [heat, heat],
        situation: [0, 0],
        age_s: 0.6,
        tcs_time_s: (Date.now() - this.t0) / 1000,
        mission: true,
        planes: planes.length,
      }),
    );
  }

  sendAzimuth() {
    if (!this.state.pointing) return;
    // a busca leva uns 8 s; depois o ADCS manda um valor por segundo
    if (Date.now() - this.pointingSince < 8000) return;
    if (this.azimuth === null) this.azimuth = 180 + Math.random() * 180;
    this.azimuth = (this.azimuth + (Math.random() - 0.5) * 0.4 + 360) % 360;
    this.emitBytes(encodeAzimuth(this.azimuth));
  }
}
