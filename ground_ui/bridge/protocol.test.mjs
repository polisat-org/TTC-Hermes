import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamParser, encodeTelemetry, encodePayload, encodeAck, encodeCommand, TELEMETRY_SIZE } from './protocol.mjs';

const tm = {
  timestamp_ms: 123456, uptime_ms: 130000, mode: 2, flags: 3, error_count: 7,
  battery_voltage: 3.95, battery_current: -0.25, temperature: 23.5,
  gyro: [1, -2, 3], accel: [10, -20, 16384], mag: [100, -200, 300],
  latitude: -34.5776, longitude: -58.5196, altitude: 25,
  deploy_state: 1, detumbling_state: 0, pointing_state: 2, mission_state: 1,
  command_count: 4, telemetry_count: 99, packet_count: 12,
  reserved: [...Buffer.from('270.5'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
};
const planes = [
  { id: 0x4001, type: 1, flags: 1, latitude: -34.6, longitude: -58.4, confidence: 0.9 },
  { id: 0x4002, type: 2, flags: 0, latitude: -34.7, longitude: -58.3, confidence: 0.5 },
];
const cat = (...a) => Buffer.concat(a.map((x) => Buffer.from(x)));
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-4, `${a} != ${b}`);

test('tamanho de Telemetry_t confere com o firmware', () => {
  assert.equal(TELEMETRY_SIZE, 79);
  assert.equal(encodeTelemetry(tm).length, 80);
  assert.equal(encodePayload(planes).length, 2 + 2 * 16);
});

test('round-trip telemetria, payload e ACK', () => {
  const p = new StreamParser();
  const evs = p.push(cat(encodeTelemetry(tm), encodePayload(planes), encodeAck(5, 0)));
  assert.deepEqual(evs.map((e) => e.kind), ['telemetry', 'payload', 'ack']);
  const d = evs[0].data;
  assert.equal(d.timestamp_ms, 123456);
  close(d.battery_voltage, 3.95);
  close(d.latitude, -34.5776);
  assert.deepEqual(d.gyro, [1, -2, 3]);
  assert.equal(d.telemetry_count, 99);
  assert.equal(d.azimuth_str, '270.5');
  assert.equal(evs[1].planes.length, 2);
  assert.equal(evs[1].planes[1].id, 0x4002);
  close(evs[1].planes[0].confidence, 0.9);
  assert.deepEqual([evs[2].cmd, evs[2].status], [5, 0]);
});

test('payload com count = 0', () => {
  const evs = new StreamParser().push(encodePayload([]));
  assert.equal(evs.length, 1);
  assert.equal(evs[0].planes.length, 0);
});

test('ressincroniza após texto de boot do ESP32 (contendo T, A, P)', () => {
  const boot = Buffer.from('ets Jun  8 2016\r\nrst:0x1 (POWERON_RESET),boot:0x13 (SPI_FAST_FLASH_BOOT)\r\nTAP\r\n');
  const p = new StreamParser();
  // Um 'P' do texto pode parecer início de quadro grande: o parser espera e,
  // após o timeout, descarta só 1 byte — nenhum quadro real é perdido.
  const evs = [...p.push(cat(boot, encodeTelemetry(tm), encodeAck(1, 0)), 0)];
  for (let t = 2000; t < 60000 && !evs.some((e) => e.kind === 'ack'); t += 2000) evs.push(...p.push(new Uint8Array(0), t));
  const kinds = evs.map((e) => e.kind);
  assert.deepEqual(kinds.filter((k) => k !== 'console'), ['telemetry', 'ack']);
  assert.ok(evs.find((e) => e.kind === 'console').text.includes('POWERON_RESET'));
});

test('não aceita telemetria falsa formada por texto + início de quadro real', () => {
  // Caso real observado: "...BOOT)\r\n" + 'T'... decodificava como TM plausível.
  const p = new StreamParser();
  const evs = p.push(cat(Buffer.from('boot:0x13 (SPI_FAST_FLASH_BOOT)\r\n'), encodeTelemetry(tm), encodeTelemetry(tm)), 0);
  const tms = evs.filter((e) => e.kind === 'telemetry');
  assert.equal(tms.length, 2);
  for (const e of tms) assert.equal(e.data.timestamp_ms, 123456);
});

test('entrega byte a byte (chunks USB arbitrários)', () => {
  const p = new StreamParser();
  const all = cat(encodePayload(planes), encodeTelemetry(tm));
  const evs = [];
  for (const b of all) evs.push(...p.push(Uint8Array.of(b)));
  assert.deepEqual(evs.map((e) => e.kind), ['payload', 'telemetry']);
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
