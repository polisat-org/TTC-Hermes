import { useSyncExternalStore } from 'react';
import { uiFeatures } from './ui';
import type { BridgeEvent, BridgeMessage, LinkInfo, ParserStats, PayloadHeader, Plane, Telemetry, Thermal } from './types';

export interface TmPoint extends Telemetry {
  t: number; // horário de chegada no PC (ms epoch)
}

export interface ThermalPoint extends Thermal {
  t: number;
}

export interface TrackPoint {
  t: number; // chegada no PC
  lat: number;
  lon: number;
  alt: number; // ft (NaN = sem altitude)
}

export interface Track {
  id: number; // ICAO 24 bits
  points: TrackPoint[];
  firstT: number;
  lastT: number;
  altitude: number | null; // ft
  speed: number | null; // kt (ADS-B)
  heading: number | null; // graus (ADS-B)
  lastPosMet: number; // last_pos_met_ms da última posição guardada
}

export interface CommandRecord {
  cmd: number;
  sentT: number;
  ackT?: number;
  status?: number;
}

/** Métricas de sucesso da missão (HLR-ADS-08), contadas desde o Start (ou o último Clear). */
export interface AdsbMetrics {
  pRecv: number; // quadros 'P' recebidos
  pLost: number; // quadros 'P' perdidos (buracos no seq)
  pSeq: number | null;
  decoded: number; // mensagens ADS-B decodificadas a bordo
  msgsLast: number | null;
  latMs: number[]; // latência recepção -> transmissão de cada posição nova
  tRecv: number; // quadros 'T'
  tLost: number;
  tSeq: number | null;
}
export const emptyMetrics = (): AdsbMetrics => ({ pRecv: 0, pLost: 0, pSeq: null, decoded: 0, msgsLast: null, latMs: [], tRecv: 0, tLost: 0, tSeq: null });

/** Metas do ADS-08: a equipe define (editáveis na tela, guardadas no navegador). */
export interface AdsbTargets {
  minDecoded: number; // mensagens decodificadas na janela, no mínimo
  maxLossPct: number; // perda de quadros 'P', no máximo (%)
  maxLatencyS: number; // latência recepção -> transmissão, no máximo (s)
}

export interface State {
  ws: 'connecting' | 'open' | 'closed';
  link: LinkInfo | null;
  parser: ParserStats | null;
  tm: TmPoint[];
  thermal: ThermalPoint[];
  azimuths: { t: number; value: number }[];
  tracks: Map<number, Track>;
  payloadFrames: number;
  lastPayloadT: number | null;
  commands: CommandRecord[];
  // A telemetria do OBC não diz o modo: vale o último telecomando confirmado pelo ground.
  commandedMask: number | null;
  commandedT: number | null;
  console: { t: number; text: string }[];
  errors: { t: number; text: string }[];
  deviceLog: { t: number; level: 'info' | 'aviso' | 'erro'; text: string }[]; // erros/avisos do Pi
  frames: { telemetry: number; payload: number; thermal: number; azimuth: number };
  lastFrameT: number | null; // último quadro do satélite (qualquer tipo)
  missionStart: number | null;
  missionDone: boolean; // janela da missão encerrada (variante mission: já mandou 0x00)
  missionEnd: number | null; // quando terminou (fim da janela ou Stop): o relógio para aí
  callsigns: Map<number, string>; // ICAO -> indicativo
  metrics: AdsbMetrics;
  lastEventT: number | null; // tempo do último evento (relógio do replay)
}

const MAX_TM = 6_000; // 100 h a 1/min
const MAX_THERMAL = 20_000; // ~28 h a 1/5 s
const MAX_AZ = 20_000;
const MAX_POINTS_PER_TRACK = 5_000;

function emptyState(): State {
  return {
    ws: 'connecting',
    link: null,
    parser: null,
    tm: [],
    thermal: [],
    azimuths: [],
    tracks: new Map(),
    payloadFrames: 0,
    lastPayloadT: null,
    commands: [],
    commandedMask: null,
    commandedT: null,
    console: [],
    errors: [],
    deviceLog: [],
    frames: { telemetry: 0, payload: 0, thermal: 0, azimuth: 0 },
    lastFrameT: null,
    missionStart: null,
    missionDone: false,
    missionEnd: null,
    callsigns: new Map(),
    metrics: emptyMetrics(),
    lastEventT: null,
  };
}

// Guardados no navegador: sobrevivem a recarregar a página (o bridge reenvia o histórico no snapshot).
const LS_EXPORT = 'hermes.lastExportT';
const LS_CLEARED = 'hermes.resultsClearedAt';
const LS_TARGETS = 'hermes.adsbTargets';
const DEFAULT_TARGETS: AdsbTargets = { minDecoded: 500, maxLossPct: 10, maxLatencyS: 10 };
function loadTargets(): AdsbTargets {
  try {
    return { ...DEFAULT_TARGETS, ...JSON.parse(localStorage.getItem(LS_TARGETS) ?? '{}') };
  } catch {
    return { ...DEFAULT_TARGETS };
  }
}
const lsNum = (k: string) => {
  try {
    return Number(localStorage.getItem(k)) || 0;
  } catch {
    return 0;
  }
};
const lsSet = (k: string, v: number) => {
  try {
    localStorage.setItem(k, String(v));
  } catch {
    /* sem localStorage: vale só nesta aba */
  }
};

class Store {
  state: State = emptyState();
  /** Último Export CSV (ms epoch). Posições mais novas que isto ainda não foram salvas. */
  lastExportT = lsNum(LS_EXPORT);
  /** Último Reset dos resultados: quadros de aviões anteriores são ignorados (também no snapshot). */
  resultsClearedAt = lsNum(LS_CLEARED);
  targets: AdsbTargets = loadTargets();

  setTargets(t: Partial<AdsbTargets>) {
    this.targets = { ...this.targets, ...t };
    try {
      localStorage.setItem(LS_TARGETS, JSON.stringify(this.targets));
    } catch {
      /* só nesta aba */
    }
    this.notify();
  }
  version = 0;
  private listeners = new Set<() => void>();
  private pending = false;
  private sock: WebSocket | null = null;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = () => this.version;

  // Notificação agrupada: no máx. ~8 renders/s mesmo com rajadas de quadros.
  private notify() {
    if (this.pending) return;
    this.pending = true;
    setTimeout(() => {
      this.pending = false;
      this.version++;
      this.listeners.forEach((l) => l());
    }, 120);
  }

  connect() {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    this.state.ws = 'connecting';
    const s = new WebSocket(url);
    this.sock = s;
    s.onopen = () => {
      this.state.ws = 'open';
      this.notify();
    };
    s.onclose = () => {
      this.state.ws = 'closed';
      this.notify();
      setTimeout(() => this.connect(), 2000);
    };
    s.onmessage = (m) => this.onMessage(JSON.parse(m.data) as BridgeMessage);
  }

  sendCommand(mask: number) {
    if (this.sock?.readyState !== WebSocket.OPEN) {
      this.state.errors.push({ t: Date.now(), text: 'Bridge desconectado.' });
      this.notify();
      return;
    }
    this.sock.send(JSON.stringify({ type: 'command', mask }));
  }

  /** Start. Na variante mission também liga o modo Mission (0x01). */
  startMission(t = Date.now()) {
    if (this.state.missionStart !== null && !this.state.missionDone) return;
    this.state.missionStart = t;
    this.state.missionDone = false;
    this.state.missionEnd = null;
    this.state.metrics = emptyMetrics(); // as métricas do ADS-08 valem para a janela da missão
    if (uiFeatures(this.state.link).startCommands) this.sendCommand(0x01);
    this.notify();
  }
  /** Fim da janela ou Stop (variante mission): desliga o payload (0x00) e para o relógio. */
  finishMission(t = Date.now()) {
    if (this.state.missionStart === null || this.state.missionDone) return;
    this.state.missionDone = true;
    this.state.missionEnd = Math.min(t, this.state.missionStart + uiFeatures(this.state.link).missionMs);
    if (uiFeatures(this.state.link).startCommands) this.sendCommand(0x00);
    this.notify();
  }
  resetMission() {
    this.state.missionStart = null;
    this.state.missionDone = false;
    this.state.missionEnd = null;
    this.notify();
  }
  markExported(t = Date.now()) {
    this.lastExportT = t;
    lsSet(LS_EXPORT, t);
    this.notify();
  }
  /** Há posição de avião que chegou depois do último Export CSV? */
  hasUnexported(): boolean {
    for (const tr of this.state.tracks.values()) if (tr.points.some((p) => p.t > this.lastExportT)) return true;
    return false;
  }
  /** Reset dos resultados: aviões, trajetórias, indicativos e contagem de quadros 'P'. O log em disco fica. */
  resetResults(t = Date.now()) {
    this.resultsClearedAt = t;
    lsSet(LS_CLEARED, t);
    this.state.tracks = new Map();
    this.state.callsigns = new Map();
    this.state.metrics = emptyMetrics();
    this.state.payloadFrames = 0;
    this.state.lastPayloadT = null;
    this.state.frames.payload = 0;
    this.notify();
  }
  clearTracks() {
    this.state.tracks = new Map();
    this.notify();
  }

  private onMessage(msg: BridgeMessage) {
    switch (msg.type) {
      case 'snapshot': {
        const keep = { ws: this.state.ws, missionStart: this.state.missionStart, missionDone: this.state.missionDone, missionEnd: this.state.missionEnd };
        this.state = { ...emptyState(), ...keep, link: msg.link };
        for (const ev of msg.events) this.apply(ev);
        break;
      }
      case 'link':
        this.state.link = msg.link;
        break;
      case 'stats':
        this.state.link = msg.link;
        this.state.parser = msg.parser;
        break;
      case 'error':
        this.state.errors.push({ t: msg.t, text: msg.text });
        break;
      default:
        this.apply(msg);
    }
    this.notify();
  }

  private apply(ev: BridgeEvent) {
    const s = this.state;
    s.lastEventT = ev.t;
    switch (ev.type) {
      case 'telemetry':
        s.frames.telemetry++;
        s.lastFrameT = ev.t;
        s.tm.push({ ...ev.data, t: ev.t });
        if (s.tm.length > MAX_TM) s.tm.splice(0, s.tm.length - MAX_TM);
        if (!this.beforeReset(ev.t)) {
          const m = s.metrics;
          m.tRecv++;
          if (m.tSeq !== null) {
            const d = (ev.data.seq_t - m.tSeq) & 0xff;
            if (d > 1 && d < 64) m.tLost += d - 1; // salto grande = OBC reiniciou
          }
          m.tSeq = ev.data.seq_t;
        }
        break;
      case 'payload':
        s.lastFrameT = ev.t;
        if (this.beforeReset(ev.t)) break;
        s.frames.payload++;
        s.payloadFrames++;
        s.lastPayloadT = ev.t;
        if (ev.header) this.countPayload(ev.header);
        for (const p of ev.planes) this.addPlane(p, ev.t, ev.header);
        break;
      case 'thermal':
        s.frames.thermal++;
        s.lastFrameT = ev.t;
        s.thermal.push({ ...ev.data, t: ev.t });
        if (s.thermal.length > MAX_THERMAL) s.thermal.splice(0, s.thermal.length - MAX_THERMAL);
        break;
      case 'azimuth':
        s.frames.azimuth++;
        s.lastFrameT = ev.t;
        s.azimuths.push({ t: ev.t, value: ev.value });
        if (s.azimuths.length > MAX_AZ) s.azimuths.splice(0, s.azimuths.length - MAX_AZ);
        break;
      case 'cmd_sent':
        s.commands.push({ cmd: ev.cmd, sentT: ev.t });
        break;
      case 'ack': {
        // casa com o comando pendente mais antigo de mesmo valor (fila FIFO do ground)
        const rec = s.commands.find((c) => c.status === undefined && c.cmd === ev.cmd);
        if (rec) {
          rec.ackT = ev.t;
          rec.status = ev.status;
        } else s.commands.push({ cmd: ev.cmd, sentT: ev.t, ackT: ev.t, status: ev.status });
        if (ev.status === 0) {
          s.commandedMask = ev.cmd;
          s.commandedT = ev.t;
          if (ev.cmd & 1 && s.missionStart === null) s.missionStart = ev.t;
        }
        break;
      }
      case 'callsigns':
        if (this.beforeReset(ev.t)) break;
        for (const [hex, cs] of Object.entries(ev.map)) {
          const name = cs.trim();
          if (name) s.callsigns.set(parseInt(hex, 16), name);
        }
        break;
      case 'device_log':
        s.deviceLog.push({ t: ev.t, level: ev.level, text: ev.text });
        if (s.deviceLog.length > 300) s.deviceLog.shift();
        s.console.push({ t: ev.t, text: `[payload ${ev.level}] ${ev.text}` });
        if (s.console.length > 500) s.console.shift();
        break;
      case 'console':
        s.console.push({ t: ev.t, text: ev.text });
        if (s.console.length > 500) s.console.shift();
        break;
    }
  }

  /** Evento anterior ao último Reset (no replay o tempo é o do arquivo: não filtra). */
  private beforeReset(t: number): boolean {
    return this.state.link?.mode !== 'replay' && t < this.resultsClearedAt;
  }

  /** Perda (buracos no seq do 'P') e mensagens decodificadas (contador da missão no OBC). */
  private countPayload(h: PayloadHeader) {
    const m = this.state.metrics;
    if (m.pSeq !== null) {
      const d = (h.seq - m.pSeq) & 0xffff;
      if (d === 0) return; // repetido
      if (d < 1000) m.pLost += d - 1; // salto enorme = OBC reiniciou: não conta como perda
    }
    m.pSeq = h.seq;
    m.pRecv++;
    // o contador do OBC zera no início da missão: soma os aumentos; se voltou, recomeçou
    m.decoded += m.msgsLast === null ? h.mensagens : h.mensagens >= m.msgsLast ? h.mensagens - m.msgsLast : h.mensagens;
    m.msgsLast = h.mensagens;
  }

  private addPlane(p: Plane, t: number, h?: PayloadHeader) {
    let tr = this.state.tracks.get(p.icao);
    if (!tr) {
      tr = { id: p.icao, points: [], firstT: t, lastT: t, altitude: null, speed: null, heading: null, lastPosMet: 0 };
      this.state.tracks.set(p.icao, tr);
    }
    tr.lastT = t;
    if (p.callsign) this.state.callsigns.set(p.icao, p.callsign);
    if (Number.isFinite(p.altitude_ft)) tr.altitude = p.altitude_ft;
    if (Number.isFinite(p.velocity_kt)) tr.speed = p.velocity_kt;
    if (Number.isFinite(p.track_deg)) tr.heading = p.track_deg;
    // só guarda posição nova (o payload repete a última posição enquanto não chega outra)
    if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude) || p.last_pos_met_ms === 0) return;
    if (p.last_pos_met_ms === tr.lastPosMet && tr.points.length) return;
    tr.lastPosMet = p.last_pos_met_ms;
    // latência da posição nova: recepção a bordo -> transmissão do 'P' (relógio de missão do payload)
    if (h && h.tx_met_ms >= p.last_pos_met_ms) {
      const lat = this.state.metrics.latMs;
      lat.push(h.tx_met_ms - p.last_pos_met_ms);
      if (lat.length > 50_000) lat.shift();
    }
    tr.points.push({ t, lat: p.latitude, lon: p.longitude, alt: p.altitude_ft });
    if (tr.points.length > MAX_POINTS_PER_TRACK) tr.points.shift();
  }
}

export const store = new Store();

export function useStore(): State {
  useSyncExternalStore(store.subscribe, store.getVersion);
  return store.state;
}

/**
 * "Agora" para idades e relógio de missão, com re-render periódico.
 * No replay usa o tempo do último evento (os timestamps vêm do arquivo).
 */
export function useNow(periodMs = 1000): number {
  const wall = useSyncExternalStore(
    (cb) => {
      const id = setInterval(cb, periodMs);
      return () => clearInterval(id);
    },
    () => Math.floor(Date.now() / periodMs) * periodMs,
  );
  const s = store.state;
  return s.link?.mode === 'replay' && s.lastEventT !== null ? s.lastEventT : wall;
}
