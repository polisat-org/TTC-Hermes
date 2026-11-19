import { useSyncExternalStore } from 'react';
import { bearing, haversine } from './geo';
import type { BridgeEvent, BridgeMessage, LinkInfo, ParserStats, Plane, Telemetry } from './types';

// Escala do giroscópio (LSB por °/s). NÃO está definida no firmware/OBC:
// confirme com o OBC/ADCS. 16.4 = MPU-6050/9250 em ±2000 °/s (necessário para 60 rpm = 360 °/s).
export const GYRO_LSB_PER_DPS = 16.4;

export interface TmPoint extends Telemetry {
  t: number; // horário de chegada no PC (ms epoch)
  rpm: number; // |ω| em rpm, usando GYRO_LSB_PER_DPS
}

export interface TrackPoint {
  t: number; // chegada no PC — Plane_t ainda não tem timestamp próprio
  lat: number;
  lon: number;
  confidence: number;
}

export interface Track {
  id: number;
  type: number;
  flags: number;
  points: TrackPoint[];
  firstT: number;
  lastT: number;
  speed: number | null; // m/s, derivado no solo
  heading: number | null; // graus, derivado no solo
}

export interface CommandRecord {
  cmd: number;
  sentT: number;
  ackT?: number;
  status?: number;
}

export interface State {
  ws: 'connecting' | 'open' | 'closed';
  link: LinkInfo | null;
  parser: ParserStats | null;
  tm: TmPoint[];
  tracks: Map<number, Track>;
  payloadFrames: number;
  lastPayloadT: number | null;
  commands: CommandRecord[];
  console: { t: number; text: string }[];
  errors: { t: number; text: string }[];
  // Métricas de enlace (HLR-ADS-08: perda e latência)
  tmLost: number; // lacunas em telemetry_count
  tmReceived: number;
  minDelayOffset: number | null; // min(t_pc - timestamp_ms): base para latência relativa
  missionStart: number | null;
  lastEventT: number | null; // tempo do último evento (relógio do replay)
}

const MAX_TM = 36_000; // 10 h a 1 Hz
const MAX_POINTS_PER_TRACK = 5_000;

function emptyState(): State {
  return {
    ws: 'connecting',
    link: null,
    parser: null,
    tm: [],
    tracks: new Map(),
    payloadFrames: 0,
    lastPayloadT: null,
    commands: [],
    console: [],
    errors: [],
    tmLost: 0,
    tmReceived: 0,
    minDelayOffset: null,
    missionStart: null,
    lastEventT: null,
  };
}

class Store {
  state: State = emptyState();
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

  startMission(t = Date.now()) {
    this.state.missionStart = t;
    this.notify();
  }
  resetMission() {
    this.state.missionStart = null;
    this.notify();
  }
  clearTracks() {
    this.state.tracks = new Map();
    this.notify();
  }

  private onMessage(msg: BridgeMessage) {
    switch (msg.type) {
      case 'snapshot': {
        const keep = { ws: this.state.ws, missionStart: this.state.missionStart };
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
      case 'telemetry': {
        const d = ev.data;
        const prev = s.tm[s.tm.length - 1];
        if (prev) {
          const delta = (d.telemetry_count - prev.telemetry_count + 0x10000) & 0xffff;
          // delta grande/zero = reboot do OBC ou contador parado; não conta como perda
          if (delta > 1 && delta < 1000) s.tmLost += delta - 1;
        }
        s.tmReceived++;
        const off = ev.t - d.timestamp_ms;
        if (s.minDelayOffset === null || off < s.minDelayOffset || (prev && d.timestamp_ms < prev.timestamp_ms)) {
          s.minDelayOffset = off; // também reinicia a base se o OBC rebootar
        }
        const w = Math.hypot(...d.gyro) / GYRO_LSB_PER_DPS; // °/s
        s.tm.push({ ...d, t: ev.t, rpm: w / 6 });
        if (s.tm.length > MAX_TM) s.tm.splice(0, s.tm.length - MAX_TM);
        break;
      }
      case 'payload':
        s.payloadFrames++;
        s.lastPayloadT = ev.t;
        for (const p of ev.planes) this.addPlane(p, ev.t);
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
        if (ev.status === 0 && ev.cmd & 1 && s.missionStart === null) s.missionStart = ev.t;
        break;
      }
      case 'console':
        s.console.push({ t: ev.t, text: ev.text });
        if (s.console.length > 500) s.console.shift();
        break;
    }
  }

  private addPlane(p: Plane, t: number) {
    if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) return;
    let tr = this.state.tracks.get(p.id);
    if (!tr) {
      tr = { id: p.id, type: p.type, flags: p.flags, points: [], firstT: t, lastT: t, speed: null, heading: null };
      this.state.tracks.set(p.id, tr);
    }
    tr.type = p.type;
    tr.flags = p.flags;
    tr.lastT = t;
    tr.points.push({ t, lat: p.latitude, lon: p.longitude, confidence: p.confidence });
    if (tr.points.length > MAX_POINTS_PER_TRACK) tr.points.shift();
    // velocidade/rumo derivados no solo a partir de pontos com >= 2 s de separação
    const last = tr.points[tr.points.length - 1];
    for (let i = tr.points.length - 2; i >= 0; i--) {
      const q = tr.points[i];
      const dt = (last.t - q.t) / 1000;
      if (dt >= 2) {
        const dist = haversine(q.lat, q.lon, last.lat, last.lon);
        tr.speed = dist / dt;
        tr.heading = dist > 1 ? bearing(q.lat, q.lon, last.lat, last.lon) : tr.heading;
        break;
      }
    }
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
