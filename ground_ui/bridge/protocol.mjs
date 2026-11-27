// Protocolo Ground ESP32 <-> PC (USB 115200 8N1). O ground_ttc.ino repassa à USB, sem alteração, cada
// quadro do OBC recebido pelo rádio, e responde 'A' a cada telecomando. Os formatos são os do firmware
// do OBC (polisat-org/OBC, Core/Inc/customTypes.h e payload_downlink.h) e de firmware/common/telemetry.h.
// Toda decodificação de bytes fica neste arquivo: se um struct mudar no OBC, altere SOMENTE aqui.
//
//   PC -> Ground : 1 byte de comando 0x00..0x0F (bitmask Mission/Deploy/Detumbling/Pointing)
//   Ground -> PC : 'A' cmd status                 (3 B)      resposta do ground ao telecomando
//                  'T' Telemetry_t                (1 + 90 B) housekeeping do OBC, a cada 60 s e logo após cada TC
//                  'P' n seq tx_met_ms mensagens n*Plane_t  (12 + 36n B, n <= 20) aviões ADS-B, a cada 5 s na missão
//                  'H' TcsStatus_t                (1 + 32 B) controle térmico do payload, junto com o 'P'
//                  'Z' "ddd.d"                    (1 + 5 B)  azimute do ADCS, até 1 por segundo
//
// O enlace USB NÃO tem sincronismo nem CRC próprio. O parser ressincroniza por plausibilidade: um byte que
// não inicia um quadro válido é descartado (e guardado como "console", p.ex. mensagens de boot do ESP32).

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
export const ID_THERMAL = 0x48; // 'H'
export const ID_AZIMUTH = 0x5a; // 'Z'

export const TELEMETRY_SIZE = 90;
export const PAYLOAD_HEADER = 12; // 'P' n seq(u16) tx_met_ms(u32) mensagens(u32)
export const PLANE_SIZE = 36; // PlaneDown_t do OBC: 28 B de dados + indicativo de 8 B
export const MAX_PLANES = 20;
export const THERMAL_SIZE = 32;
export const AZIMUTH_LEN = 5;
export const TCS_TEMP_INVALID = -32768;

// Tempo máximo esperando o resto de um quadro antes de considerar o byte inicial como ruído.
const PARTIAL_TIMEOUT_MS = 1500;

// ------------------------------------------------------------------ Telemetry_t (90 B, packed, LE)
// Ordem e tipos de customTypes.h do OBC. Unidades: temperaturas °C, umidade %, pressão hPa (BME280),
// tensões V e correntes A (INA3221), status/falha = registradores 0x0C/0x0D do MP2733, tensão da bateria mV e
// carga % (MAX17048), angulo_apontamento = último azimute do ADCS ("ddd.d", vazio se nunca chegou).
export const TELEMETRY_FIELDS = [
  ['hora', 'u8'], ['minuto', 'u8'], ['segundo', 'u8'], ['dia', 'u8'], ['mes', 'u8'], ['ano', 'u8'],
  ['temperatura_bateria', 'f32'], ['temperatura_estrutura', 'f32'], ['umidade', 'f32'], ['pressao', 'f32'],
  ['deploy_antena', 'u8'],
  ['tensao_13v8', 'f32'], ['tensao_5v', 'f32'], ['corrente_13v8', 'f32'], ['corrente_5v', 'f32'],
  ['tensao_painel_solar_1', 'f32'], ['tensao_painel_solar_2', 'f32'], ['tensao_painel_solar_3', 'f32'], ['tensao_painel_solar_4', 'f32'],
  ['status_carregador_1', 'u8'], ['status_carregador_2', 'u8'], ['falha_carregador_1', 'u8'], ['falha_carregador_2', 'u8'],
  ['adc_tensao_sistema_1', 'u8'], ['adc_tensao_sistema_2', 'u8'], ['adc_tensao_ntc_1', 'u8'], ['adc_tensao_ntc_2', 'u8'],
  ['adc_corrente_carga_1', 'u8'], ['adc_corrente_carga_2', 'u8'], ['adc_corrente_sistema_1', 'u8'], ['adc_corrente_sistema_2', 'u8'],
  ['angulo_apontamento', 'str6'],
  ['tensao_bateria_1', 'u16'], ['tensao_bateria_2', 'u16'], ['carga_bateria_1', 'u16'], ['carga_bateria_2', 'u16'],
  ['taxa_carga_descarga_bateria_1', 'i16'], ['taxa_carga_descarga_bateria_2', 'i16'],
  // estado do OBC: modo (0 IDLE, 1 MISSION, 2 DETUMBLING, 3 POINTING), estado (bit0 missão, bit1 deploy em
  // curso, bit2 antenas abertas), último TC no OBC (0xFF nenhum), resultado (0 executado, 1 recusado,
  // 2 ignorado), seq_t (contador de 'T')
  ['modo', 'u8'], ['estado', 'u8'], ['ultimo_tc', 'u8'], ['resultado_tc', 'u8'], ['seq_t', 'u8'],
];
const SIZES = { u8: 1, u16: 2, i16: 2, f32: 4, str6: 6 };
if (TELEMETRY_FIELDS.reduce((s, [, t]) => s + SIZES[t], 0) !== TELEMETRY_SIZE) throw new Error('Telemetry_t != 90 B');

/** Decodifica Telemetry_t (90 B a partir de off). */
export function decodeTelemetry(buf, off = 0) {
  const v = new DataView(buf.buffer, buf.byteOffset + off, TELEMETRY_SIZE);
  const out = {};
  let o = 0;
  for (const [name, type] of TELEMETRY_FIELDS) {
    switch (type) {
      case 'u8': out[name] = v.getUint8(o); break;
      case 'u16': out[name] = v.getUint16(o, true); break;
      case 'i16': out[name] = v.getInt16(o, true); break;
      case 'f32': out[name] = v.getFloat32(o, true); break;
      case 'str6': {
        const b = buf.subarray(off + o, off + o + 6);
        const end = b.indexOf(0);
        out[name] = String.fromCharCode(...b.subarray(0, end < 0 ? 6 : end));
        break;
      }
    }
    o += SIZES[type];
  }
  out.azimuth = parseAzimuth(out.angulo_apontamento);
  return out;
}

/** Codifica 'T' + Telemetry_t — usado pelo simulador e pelos testes. Campos ausentes vão com 0. */
export function encodeTelemetry(t) {
  const b = new Uint8Array(1 + TELEMETRY_SIZE);
  b[0] = ID_TELEMETRY;
  const v = new DataView(b.buffer, 1, TELEMETRY_SIZE);
  let o = 0;
  for (const [name, type] of TELEMETRY_FIELDS) {
    const x = t[name] ?? 0;
    switch (type) {
      case 'u8': v.setUint8(o, x & 0xff); break;
      case 'u16': v.setUint16(o, x & 0xffff, true); break;
      case 'i16': v.setInt16(o, x, true); break;
      case 'f32': v.setFloat32(o, x, true); break;
      case 'str6': for (let i = 0; i < 5 && i < String(x || '').length; i++) b[1 + o + i] = String(x).charCodeAt(i); break;
    }
    o += SIZES[type];
  }
  return b;
}

// ------------------------------------------------------------------ Plane_t (PlaneDown_t do OBC, 36 B)
/** Decodifica um avião. NaN = campo ausente no ADS-B. */
export function decodePlane(buf, off = 0) {
  const v = new DataView(buf.buffer, buf.byteOffset + off, PLANE_SIZE);
  return {
    icao: v.getUint32(0, true),
    latitude: v.getFloat32(4, true),
    longitude: v.getFloat32(8, true),
    altitude_ft: v.getFloat32(12, true),
    velocity_kt: v.getFloat32(16, true),
    track_deg: v.getFloat32(20, true),
    last_pos_met_ms: v.getUint32(24, true), // tempo de missão da posição; 0 = inválido
    callsign: decodeCallsign(buf, off + 28), // '' = sem indicativo
  };
}

/** char[8]: ASCII 0x20..0x7E até o primeiro byte fora da faixa (o OBC completa com 0); sem espaços nas pontas. */
function decodeCallsign(buf, off) {
  let s = '';
  for (let i = 0; i < 8; i++) {
    const c = buf[off + i];
    if (c < 0x20 || c > 0x7e) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

/** Codifica 'P' + n + Plane_t[] — usado pelo simulador e pelos testes. */
export function encodePayload(planes, hdr = {}) {
  const n = Math.min(planes.length, MAX_PLANES);
  const b = new Uint8Array(PAYLOAD_HEADER + n * PLANE_SIZE);
  b[0] = ID_PAYLOAD;
  b[1] = n;
  const v = new DataView(b.buffer);
  v.setUint16(2, (hdr.seq ?? 0) & 0xffff, true);
  v.setUint32(4, (hdr.tx_met_ms ?? 0) >>> 0, true);
  v.setUint32(8, (hdr.mensagens ?? 0) >>> 0, true);
  for (let i = 0; i < n; i++) {
    const o = PAYLOAD_HEADER + i * PLANE_SIZE;
    const p = planes[i];
    v.setUint32(o, p.icao >>> 0, true);
    v.setFloat32(o + 4, p.latitude ?? NaN, true);
    v.setFloat32(o + 8, p.longitude ?? NaN, true);
    v.setFloat32(o + 12, p.altitude_ft ?? NaN, true);
    v.setFloat32(o + 16, p.velocity_kt ?? NaN, true);
    v.setFloat32(o + 20, p.track_deg ?? NaN, true);
    v.setUint32(o + 24, p.last_pos_met_ms >>> 0, true);
    const cs = String(p.callsign ?? '').slice(0, 8);
    for (let k = 0; k < cs.length; k++) b[o + 28 + k] = cs.charCodeAt(k) & 0x7f;
  }
  return b;
}

// ------------------------------------------------------------------ TcsStatus_t (trailer do payload, 32 B)
// Códigos de situação de cada bloco de aquecimento (bits, iguais ao TCS do Raspberry).
export const TCS_SITUATION = [
  [1, 'no probe'], [2, 'cut-off'], [4, 'single probe'], [8, 'uncalibrated'],
  [16, 'slow reading'], [32, 'disagrees with other block'], [64, 'heater not responding'],
];

export function crc16ccitt(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** Decodifica o trailer TCS (32 B a partir de off). */
export function decodeThermal(buf, off = 0) {
  const v = new DataView(buf.buffer, buf.byteOffset + off, THERMAL_SIZE);
  const temp = (x) => (x === TCS_TEMP_INVALID ? null : x / 100);
  const age = v.getUint16(6, true);
  return {
    magic: String.fromCharCode(...buf.subarray(off, off + 4)),
    version: v.getUint8(4),
    valid: (v.getUint8(5) & 1) === 1,
    age_s: age === 0xffff ? null : age / 10,
    probes_c: [0, 1, 2, 3].map((i) => temp(v.getInt16(8 + 2 * i, true))),
    duty_pct: [v.getUint8(16), v.getUint8(17)],
    situation: [v.getUint8(18), v.getUint8(19)],
    tcs_time_s: v.getUint32(20, true) / 10,
    mission: v.getUint8(24) === 1,
    planes: v.getUint8(25),
    crc_ok: crc16ccitt(buf.subarray(off, off + 30)) === v.getUint16(30, true),
  };
}

/** Codifica 'H' + TcsStatus_t — usado pelo simulador e pelos testes. */
export function encodeThermal(t) {
  const b = new Uint8Array(1 + THERMAL_SIZE);
  b[0] = ID_THERMAL;
  const v = new DataView(b.buffer, 1, THERMAL_SIZE);
  b.set([...'TCS1'].map((c) => c.charCodeAt(0)), 1);
  v.setUint8(4, 1);
  v.setUint8(5, t.valid === false ? 0 : 1);
  v.setUint16(6, t.age_s == null ? 0xffff : Math.round(t.age_s * 10), true);
  for (let i = 0; i < 4; i++) v.setInt16(8 + 2 * i, t.probes_c?.[i] == null ? TCS_TEMP_INVALID : Math.round(t.probes_c[i] * 100), true);
  v.setUint8(16, t.duty_pct?.[0] ?? 0);
  v.setUint8(17, t.duty_pct?.[1] ?? 0);
  v.setUint8(18, t.situation?.[0] ?? 0);
  v.setUint8(19, t.situation?.[1] ?? 0);
  v.setUint32(20, Math.round((t.tcs_time_s ?? 0) * 10) >>> 0, true);
  v.setUint8(24, t.mission ? 1 : 0);
  v.setUint8(25, t.planes ?? 0);
  v.setUint16(30, crc16ccitt(b.subarray(1, 31)), true);
  return b;
}

// ------------------------------------------------------------------ azimute 'Z'
/** "ddd.d" (000.0..359.9) -> graus; null se não estiver no formato. */
export function parseAzimuth(s) {
  if (!/^\d{3}\.\d$/.test(s)) return null;
  const v = Number(s);
  return v < 360 ? v : null;
}

export function encodeAzimuth(deg) {
  const s = (Math.round(deg * 10) / 10).toFixed(1).padStart(5, '0');
  return Uint8Array.of(ID_AZIMUTH, ...[...s].map((c) => c.charCodeAt(0)));
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

// --- plausibilidade (rejeita quadros falsos criados por ruído/texto) -------
const finiteOrNaN = (x, lim) => Number.isNaN(x) || (Number.isFinite(x) && Math.abs(x) <= lim);
const latOk = (x) => Number.isNaN(x) || (x >= -90 && x <= 90);
const lonOk = (x) => Number.isNaN(x) || (x >= -180 && x <= 180);

function telemetryPlausible(t) {
  const floats = TELEMETRY_FIELDS.filter(([, ty]) => ty === 'f32').every(([n]) => finiteOrNaN(t[n], 1e6));
  const azOk = t.angulo_apontamento === '' || t.azimuth !== null;
  return (
    t.hora <= 23 && t.minuto <= 59 && t.segundo <= 59 && t.dia <= 31 && t.mes <= 12 && t.ano <= 99 &&
    t.deploy_antena <= 1 && t.modo <= 3 && t.estado <= 7 && (t.resultado_tc <= 2 || t.resultado_tc === 0xff) && floats && azOk
  );
}

function planePlausible(p) {
  return (
    p.icao > 0 && p.icao <= 0xffffff && latOk(p.latitude) && lonOk(p.longitude) &&
    finiteOrNaN(p.altitude_ft, 1e5) && finiteOrNaN(p.velocity_kt, 1e4) && finiteOrNaN(p.track_deg, 360)
  );
}

const isFrameStart = (b) => b === ID_ACK || b === ID_TELEMETRY || b === ID_PAYLOAD || b === ID_THERMAL || b === ID_AZIMUTH;

/**
 * Parser incremental de fluxo. Chame push(bytes, now) a cada chunk recebido; retorna lista de eventos:
 *   {kind:'ack', cmd, status}
 *   {kind:'telemetry', data, raw}
 *   {kind:'payload', planes, raw}
 *   {kind:'thermal', data, raw}
 *   {kind:'azimuth', value, text}
 *   {kind:'console', text}         bytes de ruído imprimíveis (boot, debug)
 */
export class StreamParser {
  constructor() {
    this.buf = new Uint8Array(0);
    this.partialSince = null;
    this.noise = [];
    this.stats = { frames: 0, telemetry: 0, payload: 0, thermal: 0, azimuth: 0, ack: 0, droppedBytes: 0, rejected: 0 };
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
      else if (id === ID_THERMAL) need = 1 + THERMAL_SIZE;
      else if (id === ID_AZIMUTH) need = 1 + AZIMUTH_LEN;
      else if (id === ID_PAYLOAD) {
        if (avail >= 2) {
          const count = this.buf[pos + 1];
          if (count > MAX_PLANES) {
            drop();
            continue;
          }
          need = PAYLOAD_HEADER + count * PLANE_SIZE;
        } else need = 2;
      } else {
        drop();
        continue;
      }

      if (avail < need) {
        // rejeita cedo o que já dá para ver que não é quadro (evita esperar o timeout com o fluxo travado)
        let bad = false;
        if (id === ID_PAYLOAD && avail >= PAYLOAD_HEADER) {
          const full = Math.floor((avail - PAYLOAD_HEADER) / PLANE_SIZE);
          for (let i = 0; i < full && !bad; i++) bad = !planePlausible(decodePlane(this.buf, pos + PAYLOAD_HEADER + i * PLANE_SIZE));
        } else if (id === ID_THERMAL) {
          const m = 'TCS1';
          for (let i = 1; i < Math.min(avail, 5) && !bad; i++) bad = this.buf[pos + i] !== m.charCodeAt(i - 1);
        } else if (id === ID_AZIMUTH) {
          const fmt = 'ddd.d';
          for (let i = 1; i < avail && !bad; i++) {
            const c = this.buf[pos + i];
            bad = fmt[i - 1] === '.' ? c !== 0x2e : c < 0x30 || c > 0x39;
          }
        }
        if (bad) {
          this.stats.rejected++;
          this.partialSince = null;
          drop();
          continue;
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
      } else if (id === ID_THERMAL) {
        const data = decodeThermal(raw, 1);
        if (data.magic === 'TCS1' && data.crc_ok) ev = { kind: 'thermal', data, raw };
      } else if (id === ID_AZIMUTH) {
        const text = String.fromCharCode(...raw.subarray(1));
        const value = parseAzimuth(text);
        if (value !== null) ev = { kind: 'azimuth', value, text };
      } else {
        const count = raw[1];
        const planes = [];
        let ok = true;
        for (let i = 0; i < count; i++) {
          const p = decodePlane(raw, PAYLOAD_HEADER + i * PLANE_SIZE);
          if (!planePlausible(p)) ok = false;
          planes.push(p);
        }
        const hv = new DataView(raw.buffer, raw.byteOffset, PAYLOAD_HEADER);
        const header = { seq: hv.getUint16(2, true), tx_met_ms: hv.getUint32(4, true), mensagens: hv.getUint32(8, true) };
        if (ok) ev = { kind: 'payload', planes, header, raw };
      }

      // Confirmação por look-ahead: num fluxo alinhado, o byte logo após um quadro é o início do próximo ou o
      // fim do buffer. Um quadro "falso" formado a partir de ruído quase sempre termina no meio de um real.
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
