// Protocolo Ground ESP32 <-> PC (USB 115200 8N1), conforme detalhamento_ttc.md §4
// e common/telemetry.h. Toda decodificação de bytes fica neste arquivo: se
// Telemetry_t ou Plane_t mudarem no firmware, altere SOMENTE aqui.
//
//   PC -> Ground : 1 byte de comando 0x00..0x0F (bitmask)
//   Ground -> PC : 'A' cmd status            (3 bytes)
//                  'T' Telemetry_t           (1 + 79 bytes)
//                  'P' count count*Plane_t   (2 + 16*count bytes, count <= 20)
//
// O enlace USB atual NÃO tem cabeçalho de sincronismo nem CRC. O parser abaixo
// ressincroniza por plausibilidade: um byte que não inicia um quadro válido é
// descartado (e guardado como "console", p.ex. mensagens de boot do ESP32).

export const CMD_MAX = 0x0f;
export const CMD_BITS = [
  { bit: 0, key: 'mission', label: 'Mission' },
  { bit: 1, key: 'deploy', label: 'Deploy' },
  { bit: 2, key: 'detumbling', label: 'Detumbling' },
  { bit: 3, key: 'pointing', label: 'Pointing' },
];
export const CMD_STATUS = { 0: 'ok', 1: 'fail', 2: 'busy' };

export const ID_ACK = 0x41; // 'A'
export const ID_TELEMETRY = 0x54; // 'T'
export const ID_PAYLOAD = 0x50; // 'P'

export const TELEMETRY_SIZE = 79;
export const PLANE_SIZE = 16;
export const MAX_PLANES = 20;

// Tempo máximo esperando o resto de um quadro antes de considerar o byte
// inicial como ruído.
const PARTIAL_TIMEOUT_MS = 1500;

/** Decodifica Telemetry_t (packed, little-endian). */
export function decodeTelemetry(buf, off = 0) {
  const v = new DataView(buf.buffer, buf.byteOffset + off, TELEMETRY_SIZE);
  const i16 = (o) => v.getInt16(o, true);
  const f32 = (o) => v.getFloat32(o, true);
  const reserved = Array.from(buf.subarray(off + 64, off + 79));
  return {
    timestamp_ms: v.getUint32(0, true),
    uptime_ms: v.getUint32(4, true),
    mode: v.getUint8(8),
    flags: v.getUint8(9),
    error_count: v.getUint16(10, true),
    battery_voltage: f32(12),
    battery_current: f32(16),
    temperature: f32(20),
    gyro: [i16(24), i16(26), i16(28)],
    accel: [i16(30), i16(32), i16(34)],
    mag: [i16(36), i16(38), i16(40)],
    latitude: f32(42),
    longitude: f32(46),
    altitude: f32(50),
    deploy_state: v.getUint8(54),
    detumbling_state: v.getUint8(55),
    pointing_state: v.getUint8(56),
    mission_state: v.getUint8(57),
    command_count: v.getUint16(58, true),
    telemetry_count: v.getUint16(60, true),
    packet_count: v.getUint16(62, true),
    reserved,
    // Notion/OBC: ADCS devolve o azimute como string de 5 chars ("270.5"),
    // que vai para o struct de telemetria. Ainda não há campo dedicado;
    // proposta: reserved[0..4]. Só é exposto se for ASCII imprimível.
    azimuth_str: asciiOrNull(reserved.slice(0, 5)),
  };
}

/** Decodifica Plane_t (packed, little-endian). */
export function decodePlane(buf, off = 0) {
  const v = new DataView(buf.buffer, buf.byteOffset + off, PLANE_SIZE);
  return {
    id: v.getUint16(0, true),
    type: v.getUint8(2),
    flags: v.getUint8(3),
    latitude: v.getFloat32(4, true),
    longitude: v.getFloat32(8, true),
    confidence: v.getFloat32(12, true),
  };
}

/** Codifica Telemetry_t — usado pelo simulador e pelos testes. */
export function encodeTelemetry(t) {
  const b = new Uint8Array(1 + TELEMETRY_SIZE);
  b[0] = ID_TELEMETRY;
  const v = new DataView(b.buffer, 1, TELEMETRY_SIZE);
  v.setUint32(0, t.timestamp_ms >>> 0, true);
  v.setUint32(4, t.uptime_ms >>> 0, true);
  v.setUint8(8, t.mode & 0xff);
  v.setUint8(9, t.flags & 0xff);
  v.setUint16(10, t.error_count & 0xffff, true);
  v.setFloat32(12, t.battery_voltage, true);
  v.setFloat32(16, t.battery_current, true);
  v.setFloat32(20, t.temperature, true);
  [...t.gyro, ...t.accel, ...t.mag].forEach((x, i) => v.setInt16(24 + 2 * i, x, true));
  v.setFloat32(42, t.latitude, true);
  v.setFloat32(46, t.longitude, true);
  v.setFloat32(50, t.altitude, true);
  v.setUint8(54, t.deploy_state);
  v.setUint8(55, t.detumbling_state);
  v.setUint8(56, t.pointing_state);
  v.setUint8(57, t.mission_state);
  v.setUint16(58, t.command_count & 0xffff, true);
  v.setUint16(60, t.telemetry_count & 0xffff, true);
  v.setUint16(62, t.packet_count & 0xffff, true);
  (t.reserved || []).slice(0, 15).forEach((x, i) => v.setUint8(64 + i, x));
  return b;
}

/** Codifica 'P' + count + Plane_t[] — usado pelo simulador e pelos testes. */
export function encodePayload(planes) {
  const n = Math.min(planes.length, MAX_PLANES);
  const b = new Uint8Array(2 + n * PLANE_SIZE);
  b[0] = ID_PAYLOAD;
  b[1] = n;
  const v = new DataView(b.buffer);
  for (let i = 0; i < n; i++) {
    const o = 2 + i * PLANE_SIZE;
    const p = planes[i];
    v.setUint16(o, p.id & 0xffff, true);
    v.setUint8(o + 2, p.type & 0xff);
    v.setUint8(o + 3, p.flags & 0xff);
    v.setFloat32(o + 4, p.latitude, true);
    v.setFloat32(o + 8, p.longitude, true);
    v.setFloat32(o + 12, p.confidence, true);
  }
  return b;
}

export function encodeAck(cmd, status) {
  return Uint8Array.of(ID_ACK, cmd & 0xff, status & 0xff);
}

/** Valida e codifica um comando (bitmask 0..15) para o ground. */
export function encodeCommand(mask) {
  if (!Number.isInteger(mask) || mask < 0 || mask > CMD_MAX) {
    throw new RangeError(`comando fora da faixa 0x00..0x0F: ${mask}`);
  }
  return Uint8Array.of(mask);
}

function asciiOrNull(bytes) {
  if (bytes.every((c) => c === 0)) return null;
  if (!bytes.every((c) => c >= 0x20 && c < 0x7f)) return null;
  return String.fromCharCode(...bytes);
}

// --- plausibilidade (rejeita quadros falsos criados por ruído/texto) -------
const finiteOrNaN = (x, lim) => Number.isNaN(x) || (Number.isFinite(x) && Math.abs(x) <= lim);
const latOk = (x) => Number.isNaN(x) || (x >= -90 && x <= 90);
const lonOk = (x) => Number.isNaN(x) || (x >= -180 && x <= 180);

function telemetryPlausible(t) {
  return (
    finiteOrNaN(t.battery_voltage, 1e4) &&
    finiteOrNaN(t.battery_current, 1e4) &&
    finiteOrNaN(t.temperature, 1e4) &&
    latOk(t.latitude) &&
    lonOk(t.longitude) &&
    finiteOrNaN(t.altitude, 1e7)
  );
}

const isFrameStart = (b) => b === ID_ACK || b === ID_TELEMETRY || b === ID_PAYLOAD;

function planePlausible(p) {
  return latOk(p.latitude) && lonOk(p.longitude) && finiteOrNaN(p.confidence, 1e6);
}

/**
 * Parser incremental de fluxo. Chame push(bytes, now) a cada chunk recebido;
 * retorna lista de eventos:
 *   {kind:'ack', cmd, status}
 *   {kind:'telemetry', data, raw}
 *   {kind:'payload', planes, raw}
 *   {kind:'console', text}         bytes de ruído imprimíveis (boot, debug)
 */
export class StreamParser {
  constructor() {
    this.buf = new Uint8Array(0);
    this.partialSince = null;
    this.noise = [];
    this.stats = { frames: 0, telemetry: 0, payload: 0, ack: 0, droppedBytes: 0, rejected: 0 };
  }

  push(chunk, now = Date.now()) {
    if (chunk && chunk.length) {
      const nb = new Uint8Array(this.buf.length + chunk.length);
      nb.set(this.buf);
      nb.set(chunk, this.buf.length);
      this.buf = nb;
    }
    const out = [];
    let pos = 0;
    const drop = () => {
      this.noise.push(this.buf[pos]);
      this.stats.droppedBytes++;
      pos++;
    };
    while (pos < this.buf.length) {
      const id = this.buf[pos];
      const avail = this.buf.length - pos;
      let need = 0;
      if (id === ID_ACK) need = 3;
      else if (id === ID_TELEMETRY) need = 1 + TELEMETRY_SIZE;
      else if (id === ID_PAYLOAD) {
        if (avail >= 2) {
          const count = this.buf[pos + 1];
          if (count > MAX_PLANES) {
            drop();
            continue;
          }
          need = 2 + count * PLANE_SIZE;
        } else need = 2;
      } else {
        drop();
        continue;
      }

      if (avail < need) {
        // 'P' incompleto: rejeita cedo se algum Plane_t já completo for implausível
        if (id === ID_PAYLOAD && avail >= 2) {
          const full = Math.floor((avail - 2) / PLANE_SIZE);
          let bad = false;
          for (let i = 0; i < full && !bad; i++) bad = !planePlausible(decodePlane(this.buf, pos + 2 + i * PLANE_SIZE));
          if (bad) {
            this.stats.rejected++;
            this.partialSince = null;
            drop();
            continue;
          }
        }
        // quadro incompleto: espera mais bytes, mas não para sempre
        if (this.partialSince === null) this.partialSince = now;
        if (now - this.partialSince > PARTIAL_TIMEOUT_MS) {
          this.partialSince = null;
          drop();
          continue;
        }
        break;
      }
      this.partialSince = null;

      const raw = this.buf.slice(pos, pos + need);
      let ev = null;
      if (id === ID_ACK) {
        const cmd = raw[1];
        const status = raw[2];
        if (cmd <= CMD_MAX && status in CMD_STATUS) ev = { kind: 'ack', cmd, status };
      } else if (id === ID_TELEMETRY) {
        const data = decodeTelemetry(raw, 1);
        if (telemetryPlausible(data)) ev = { kind: 'telemetry', data, raw };
      } else {
        const count = raw[1];
        const planes = [];
        let ok = true;
        for (let i = 0; i < count; i++) {
          const p = decodePlane(raw, 2 + i * PLANE_SIZE);
          if (!planePlausible(p)) ok = false;
          planes.push(p);
        }
        if (ok) ev = { kind: 'payload', planes, raw };
      }

      // Confirmação por look-ahead: num fluxo alinhado, o byte logo após um
      // quadro é o início do próximo ('A'/'T'/'P') ou o fim do buffer. Um
      // quadro "falso" formado a partir de ruído quase sempre termina no meio
      // de um quadro real, e é rejeitado aqui.
      if (ev && avail > need && !isFrameStart(this.buf[pos + need])) ev = null;

      if (ev) {
        this.flushNoise(out);
        out.push(ev);
        this.stats.frames++;
        this.stats[ev.kind]++;
        pos += need;
      } else {
        this.stats.rejected++;
        drop();
      }
    }
    this.buf = this.buf.slice(pos);
    if (this.buf.length === 0) this.flushNoise(out);
    return out;
  }

  flushNoise(out) {
    if (!this.noise.length) return;
    const printable = this.noise.filter((c) => c === 10 || c === 13 || c === 9 || (c >= 0x20 && c < 0x7f));
    const text = String.fromCharCode(...printable).trim();
    if (text) out.push({ kind: 'console', text });
    this.noise = [];
  }
}

export const toHex = (u8) => Buffer.from(u8).toString('hex');
export const fromHex = (s) => new Uint8Array(Buffer.from(s, 'hex'));
