import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  StreamParser, encodeTelemetry, encodePayload, encodeThermal, encodeAzimuth, encodeAck, encodeCommand,
  TELEMETRY_SIZE, PLANE_SIZE, THERMAL_SIZE,
} from './protocol.mjs';

const tm = {
  hora: 13, minuto: 45, segundo: 7, dia: 24, mes: 11, ano: 26,
  temperatura_bateria: 5.25, temperatura_estrutura: 23.5, umidade: 41, pressao: 1012.5, deploy_antena: 1,
  tensao_13v8: 12.6, tensao_5v: 5.01, corrente_13v8: 1.32, corrente_5v: 0.874,
  status_carregador_1: 0x5b, falha_carregador_2: 0x80,
  angulo_apontamento: '270.5',
  tensao_bateria_1: 3900, tensao_bateria_2: 3600, carga_bateria_1: 91, carga_bateria_2: 40,
  taxa_carga_descarga_bateria_2: -320,
};
const planes = [
  { icao: 0xe48c01, latitude: -34.6, longitude: -58.4, altitude_ft: 3500, velocity_kt: 180, track_deg: 90, last_pos_met_ms: 12000 },
  { icao: 0xe48c02, latitude: NaN, longitude: NaN, altitude_ft: 9000, velocity_kt: NaN, track_deg: NaN, last_pos_met_ms: 0 },
];
const tcs = { probes_c: [-1.25, 3.5, null, 4], duty_pct: [80, 0], situation: [0, 1], age_s: 0.8, tcs_time_s: 1234.5, mission: true, planes: 2 };
const cat = (...a) => Buffer.concat(a.map((x) => Buffer.from(x)));
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-4, `${a} != ${b}`);

test('tamanhos iguais aos do OBC (Telemetry_t 85, PlaneDown_t 28, TcsStatus_t 32)', () => {
  assert.equal(TELEMETRY_SIZE, 85);
  assert.equal(PLANE_SIZE, 28);
  assert.equal(THERMAL_SIZE, 32);
  assert.equal(encodeTelemetry(tm).length, 86);
  assert.equal(encodePayload(planes).length, 2 + 2 * 28);
  assert.equal(encodeThermal(tcs).length, 33);
  assert.equal(encodeAzimuth(270.5).length, 6);
});

test('round-trip T, P, H, Z e A', () => {
  const evs = new StreamParser().push(cat(encodeTelemetry(tm), encodePayload(planes), encodeThermal(tcs), encodeAzimuth(5.3), encodeAck(5, 0)));
  assert.deepEqual(evs.map((e) => e.kind), ['telemetry', 'payload', 'thermal', 'azimuth', 'ack']);
  const d = evs[0].data;
  assert.deepEqual([d.hora, d.minuto, d.segundo, d.dia, d.mes, d.ano], [13, 45, 7, 24, 11, 26]);
  close(d.temperatura_bateria, 5.25);
  close(d.tensao_13v8, 12.6);
  close(d.corrente_5v, 0.874);
  assert.equal(d.deploy_antena, 1);
  assert.equal(d.angulo_apontamento, '270.5');
  assert.equal(d.azimuth, 270.5);
  assert.equal(d.tensao_bateria_1, 3900);
  assert.equal(d.carga_bateria_2, 40);
  assert.equal(d.status_carregador_1, 0x5b);
  assert.equal(d.falha_carregador_2, 0x80);
  assert.equal(d.taxa_carga_descarga_bateria_2, -320);
  const p = evs[1].planes;
  assert.equal(p.length, 2);
  assert.equal(p[0].icao, 0xe48c01);
  close(p[0].latitude, -34.6);
  close(p[0].altitude_ft, 3500);
  assert.equal(p[0].last_pos_met_ms, 12000);
  assert.ok(Number.isNaN(p[1].latitude));
  const h = evs[2].data;
  assert.ok(h.crc_ok && h.valid && h.mission);
  assert.deepEqual(h.probes_c, [-1.25, 3.5, null, 4]);
  assert.deepEqual(h.duty_pct, [80, 0]);
  assert.equal(h.planes, 2);
  assert.deepEqual([evs[3].text, evs[3].value], ['005.3', 5.3]);
  assert.deepEqual([evs[4].cmd, evs[4].status], [5, 0]);
});

test('telemetria do boot do OBC (RTC zerado, sem azimute) é aceita', () => {
  const evs = new StreamParser().push(encodeTelemetry({ dia: 1, mes: 1 }));
  assert.equal(evs.length, 1);
  assert.equal(evs[0].data.angulo_apontamento, '');
  assert.equal(evs[0].data.azimuth, null);
});

test('payload com count = 0', () => {
  const evs = new StreamParser().push(encodePayload([]));
  assert.equal(evs.length, 1);
  assert.equal(evs[0].planes.length, 0);
});

test('H com CRC errado e Z fora do formato são descartados', () => {
  const h = encodeThermal(tcs);
  h[10] ^= 0xff;
  const p = new StreamParser();
  // um byte do quadro corrompido pode parecer início de quadro: o parser espera o timeout e segue
  const evs = [...p.push(cat(h, Buffer.from('Z360.0'), Buffer.from('Z27a.5'), encodeAzimuth(359.9)), 0), ...p.push(new Uint8Array(0), 5000)];
  assert.deepEqual(evs.filter((e) => e.kind !== 'console').map((e) => e.kind), ['azimuth']);
  assert.equal(evs.find((e) => e.kind === 'azimuth').text, '359.9');
});

test('ressincroniza após texto de boot do ESP32 (contendo T, A, P, H, Z)', () => {
  const boot = Buffer.from('ets Jun  8 2016\r\nrst:0x1 (POWERON_RESET),boot:0x13 (SPI_FAST_FLASH_BOOT)\r\nTAPHZ\r\n');
  const p = new StreamParser();
  const evs = [...p.push(cat(boot, encodeTelemetry(tm), encodeAck(1, 0)), 0)];
  for (let t = 2000; t < 60000 && !evs.some((e) => e.kind === 'ack'); t += 2000) evs.push(...p.push(new Uint8Array(0), t));
  assert.deepEqual(evs.map((e) => e.kind).filter((k) => k !== 'console'), ['telemetry', 'ack']);
  assert.ok(evs.find((e) => e.kind === 'console').text.includes('POWERON_RESET'));
});

test('não aceita telemetria falsa formada por texto + início de quadro real', () => {
  const p = new StreamParser();
  const evs = p.push(cat(Buffer.from('boot:0x13 (SPI_FAST_FLASH_BOOT)\r\n'), encodeTelemetry(tm), encodeTelemetry(tm)), 0);
  const tms = evs.filter((e) => e.kind === 'telemetry');
  assert.equal(tms.length, 2);
  for (const e of tms) assert.equal(e.data.tensao_bateria_1, 3900);
});

test('entrega byte a byte (chunks USB arbitrários)', () => {
  const p = new StreamParser();
  const all = cat(encodePayload(planes), encodeThermal(tcs), encodeTelemetry(tm), encodeAzimuth(90));
  const evs = [];
  for (const b of all) evs.push(...p.push(Uint8Array.of(b)));
  assert.deepEqual(evs.map((e) => e.kind), ['payload', 'thermal', 'telemetry', 'azimuth']);
});

test('rejeita ACK com status inválido e P com count > 20', () => {
  const p = new StreamParser();
  const evs = p.push(cat(Uint8Array.of(0x41, 0x01, 0x09), Uint8Array.of(0x50, 21), encodeAck(2, 1)));
  assert.deepEqual(evs.filter((e) => e.kind !== 'console').map((e) => [e.kind, e.cmd, e.status]), [['ack', 2, 1]]);
});

test('quadro parcial é descartado após timeout', () => {
  const p = new StreamParser();
  assert.deepEqual(p.push(Uint8Array.of(0x54, 1, 2), 0), []);
  const evs = p.push(encodeAck(3, 0), 5000);
  assert.ok(evs.some((e) => e.kind === 'ack' && e.cmd === 3));
});

test('encodeCommand valida faixa', () => {
  assert.deepEqual([...encodeCommand(0x0f)], [0x0f]);
  assert.throws(() => encodeCommand(16));
  assert.throws(() => encodeCommand(-1));
});
