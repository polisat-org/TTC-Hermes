import { useSyncExternalStore } from 'react';
import type { BridgeEvent, BridgeMessage, LinkInfo, ParserStats, Plane, Telemetry, Thermal } from './types';

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
  frames: { telemetry: number; payload: number; thermal: number; azimuth: number };
  lastFrameT: number | null; // último quadro do satélite (qualquer tipo)
  missionStart: number | null;
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
    frames: { telemetry: 0, payload: 0, thermal: 0, azimuth: 0 },
    lastFrameT: null,
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
      case 'telemetry':
        s.frames.telemetry++;
        s.lastFrameT = ev.t;
        s.tm.push({ ...ev.data, t: ev.t });
        if (s.tm.length > MAX_TM) s.tm.splice(0, s.tm.length - MAX_TM);
        break;
      case 'payload':
        s.frames.payload++;
        s.lastFrameT = ev.t;
        s.payloadFrames++;
        s.lastPayloadT = ev.t;
        for (const p of ev.planes) this.addPlane(p, ev.t);
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
      case 'console':
        s.console.push({ t: ev.t, text: ev.text });
        if (s.console.length > 500) s.console.shift();
        break;
    }
  }

  private addPlane(p: Plane, t: number) {
    let tr = this.state.tracks.get(p.icao);
    if (!tr) {
      tr = { id: p.icao, points: [], firstT: t, lastT: t, altitude: null, speed: null, heading: null, lastPosMet: 0 };
      this.state.tracks.set(p.icao, tr);
    }
    tr.lastT = t;
    if (Number.isFinite(p.altitude_ft)) tr.altitude = p.altitude_ft;
    if (Number.isFinite(p.velocity_kt)) tr.speed = p.velocity_kt;
    if (Number.isFinite(p.track_deg)) tr.heading = p.track_deg;
    // só guarda posição nova (o payload repete a última posição enquanto não chega outra)
    if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude) || p.last_pos_met_ms === 0) return;
    if (p.last_pos_met_ms === tr.lastPosMet && tr.points.length) return;
    tr.lastPosMet = p.last_pos_met_ms;
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
