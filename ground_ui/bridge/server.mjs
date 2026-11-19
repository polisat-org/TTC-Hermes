#!/usr/bin/env node
// Ponte Ground Station: USB do ESP32 ground <-> WebSocket (+ HTTP da UI).
//
//   node bridge/server.mjs --port COM5           # hardware (Windows)
//   node bridge/server.mjs --port /dev/ttyUSB0   # hardware (Linux)
//   node bridge/server.mjs --sim                 # simulador, sem hardware
//   node bridge/server.mjs --replay logs/<sessao>/raw.jsonl [--speed 4]
//   node bridge/server.mjs --list                # lista portas seriais
//   node bridge/server.mjs --tcp-listen 8766     # WSL: a porta COM é lida no Windows por
//                                                # bridge/com_relay.ps1, que repassa via TCP
//
// Toda sessão ao vivo é gravada em logs/<data-hora>/ (bytes crus + eventos
// decodificados + CSV), atendendo HLR-SW-02 (dados estruturados, documentados,
// reprodutíveis e disponíveis para pós-análise). O raw.jsonl pode ser
// reproduzido com --replay e passa pelo mesmo parser.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { StreamParser, encodeCommand, toHex, fromHex, CMD_STATUS } from './protocol.mjs';
import { GroundSimulator } from './sim.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- argumentos
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);

const HTTP_PORT = Number(opt('http', 8765));
const BAUD = Number(opt('baud', 115200));
const SERIAL_PATH = opt('port', null);
const REPLAY = opt('replay', null);
const SPEED = Number(opt('speed', 1));
const SIM = flag('sim');
const TCP_LISTEN = opt('tcp-listen', null);
const LOG_ROOT = path.resolve(opt('logs', path.join(ROOT, 'logs')));

if (flag('list')) {
  const { SerialPort } = await import('serialport');
  for (const p of await SerialPort.list()) {
    console.log(`${p.path}\t${p.manufacturer ?? ''}\t${p.vendorId ?? ''}:${p.productId ?? ''}`);
  }
  process.exit(0);
}
if (!SERIAL_PATH && !SIM && !REPLAY && !TCP_LISTEN) {
  console.error('Use --port <porta>, --sim ou --replay <raw.jsonl>. Veja --list.');
  process.exit(1);
}
const MODE = REPLAY ? 'replay' : SIM ? 'sim' : 'serial';

// ------------------------------------------------------------------ logging
class SessionLog {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    const open = (f) => fs.createWriteStream(path.join(dir, f), { flags: 'a' });
    this.raw = open('raw.jsonl');
    this.events = open('events.jsonl');
    this.tm = open('telemetry.csv');
    this.planes = open('planes.csv');
    this.cmds = open('commands.csv');
    this.tm.write(
      'pc_time_iso,pc_time_ms,timestamp_ms,uptime_ms,mode,flags,error_count,battery_voltage,battery_current,temperature,' +
        'gyro_x,gyro_y,gyro_z,accel_x,accel_y,accel_z,mag_x,mag_y,mag_z,latitude,longitude,altitude,' +
        'deploy_state,detumbling_state,pointing_state,mission_state,command_count,telemetry_count,packet_count,azimuth_str,reserved_hex\n',
    );
    this.planes.write('pc_time_iso,pc_time_ms,frame_idx,count,id,type,flags,latitude,longitude,confidence\n');
    this.cmds.write('pc_time_iso,pc_time_ms,event,cmd_hex,status\n');
    this.frameIdx = 0;
    fs.writeFileSync(
      path.join(dir, 'session.json'),
      JSON.stringify({ started: new Date().toISOString(), mode: MODE, port: SERIAL_PATH, baud: BAUD }, null, 2),
    );
  }
  rawBytes(t, dir, bytes) {
    this.raw.write(JSON.stringify({ t, d: dir, hex: toHex(bytes) }) + '\n');
  }
  event(ev) {
    this.events.write(JSON.stringify(ev) + '\n');
    const iso = new Date(ev.t).toISOString();
    if (ev.type === 'telemetry') {
      const d = ev.data;
      const row = [
        iso, ev.t, d.timestamp_ms, d.uptime_ms, d.mode, d.flags, d.error_count,
        d.battery_voltage, d.battery_current, d.temperature, ...d.gyro, ...d.accel, ...d.mag,
        d.latitude, d.longitude, d.altitude, d.deploy_state, d.detumbling_state, d.pointing_state,
        d.mission_state, d.command_count, d.telemetry_count, d.packet_count,
        d.azimuth_str ?? '', Buffer.from(d.reserved).toString('hex'),
      ];
      this.tm.write(row.join(',') + '\n');
    } else if (ev.type === 'payload') {
      const idx = this.frameIdx++;
      for (const p of ev.planes) {
        this.planes.write([iso, ev.t, idx, ev.planes.length, p.id, p.type, p.flags, p.latitude, p.longitude, p.confidence].join(',') + '\n');
      }
    } else if (ev.type === 'cmd_sent') {
      this.cmds.write([iso, ev.t, 'sent', hex2(ev.cmd), ''].join(',') + '\n');
    } else if (ev.type === 'ack') {
      this.cmds.write([iso, ev.t, 'ack', hex2(ev.cmd), CMD_STATUS[ev.status]].join(',') + '\n');
    }
  }
}
const hex2 = (n) => '0x' + n.toString(16).padStart(2, '0');
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

const log = MODE === 'replay' ? null : new SessionLog(path.join(LOG_ROOT, stamp()));

// ------------------------------------------------------------ estado/eventos
const MAX_HISTORY = 200_000;
const history = [];
const parser = new StreamParser();
const link = { mode: MODE, port: SERIAL_PATH ?? (TCP_LISTEN ? `relay tcp:${TCP_LISTEN}` : null) ?? REPLAY ?? 'sim', connected: false, bytesRx: 0, bytesTx: 0, logDir: log?.dir ?? null };

function publish(ev) {
  history.push(ev);
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  log?.event(ev);
  broadcast(ev);
}

function onRx(bytes, t = Date.now()) {
  link.bytesRx += bytes.length;
  log?.rawBytes(t, 'rx', bytes);
  handleParsed(parser.push(bytes, t), t);
}

function handleParsed(evs, t) {
  for (const e of evs) {
    if (e.kind === 'telemetry') publish({ type: 'telemetry', t, data: e.data });
    else if (e.kind === 'payload') publish({ type: 'payload', t, planes: e.planes });
    else if (e.kind === 'ack') publish({ type: 'ack', t, cmd: e.cmd, status: e.status });
    else if (e.kind === 'console') publish({ type: 'console', t, text: e.text });
  }
}

// Mantém o timeout de quadro parcial funcionando mesmo sem bytes novos
// (fora do replay, onde o tempo vem do arquivo).
setInterval(() => {
  if (MODE !== 'replay' && parser.buf.length) handleParsed(parser.push(new Uint8Array(0), Date.now()), Date.now());
}, 500);

// ------------------------------------------------------------------- fontes
let writeToDevice = () => false;

async function startSerial() {
  const { SerialPort } = await import('serialport');
  const connect = () => {
    const port = new SerialPort({ path: SERIAL_PATH, baudRate: BAUD, autoOpen: false });
    port.open((err) => {
      if (err) {
        setLink(false, err.message);
        setTimeout(connect, 2000);
        return;
      }
      // Evita reset do ESP32 pelo circuito auto-reset (DTR/RTS).
      port.set({ dtr: false, rts: false }, () => {});
      setLink(true);
      writeToDevice = (b) => {
        port.write(Buffer.from(b));
        return true;
      };
    });
    port.on('data', (d) => onRx(new Uint8Array(d)));
    port.on('close', () => {
      writeToDevice = () => false;
      setLink(false, 'porta fechada');
      setTimeout(connect, 2000);
    });
    port.on('error', (e) => setLink(false, e.message));
  };
  connect();
}

// Relay TCP: bridge/com_relay.ps1 (Windows) abre a COM e conecta aqui.
async function startTcpRelay() {
  const net = await import('node:net');
  let current = null;
  net
    .createServer((sock) => {
      current?.destroy();
      current = sock;
      sock.setNoDelay(true);
      setLink(true);
      writeToDevice = (b) => {
        sock.write(Buffer.from(b));
        return true;
      };
      sock.on('data', (d) => onRx(new Uint8Array(d)));
      sock.on('close', () => {
        if (current !== sock) return;
        current = null;
        writeToDevice = () => false;
        setLink(false, 'relay desconectado');
      });
      sock.on('error', () => {});
    })
    .listen(Number(TCP_LISTEN), '127.0.0.1', () => console.log(`[relay] aguardando com_relay.ps1 em 127.0.0.1:${TCP_LISTEN}`));
}

function startSim() {
  const sim = new GroundSimulator();
  sim.on('data', (d) => onRx(new Uint8Array(d)));
  writeToDevice = (b) => {
    sim.write(b);
    return true;
  };
  sim.start();
  setLink(true);
}

async function startReplay() {
  setLink(true);
  const rl = readline.createInterface({ input: fs.createReadStream(REPLAY) });
  let first = null;
  const wall0 = Date.now();
  for await (const line of rl) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line);
    if (first === null) first = rec.t;
    const due = wall0 + (rec.t - first) / SPEED;
    const wait = due - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const bytes = fromHex(rec.hex);
    if (rec.d === 'rx') onRx(bytes, rec.t);
    else if (rec.d === 'tx') for (const cmd of bytes) publish({ type: 'cmd_sent', t: rec.t, cmd });
  }
  console.log('[replay] fim do arquivo');
  broadcast({ type: 'console', t: Date.now(), text: '[replay] fim do arquivo' });
}

function setLink(connected, error = null) {
  link.connected = connected;
  link.error = error;
  console.log(`[link] ${connected ? 'conectado' : 'desconectado'} ${link.port}${error ? ' — ' + error : ''}`);
  broadcast({ type: 'link', link });
}

// ------------------------------------------------------- HTTP (UI) + WS
const DIST = path.join(ROOT, 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  let file = path.normalize(path.join(DIST, url === '/' ? 'index.html' : url));
  if (!file.startsWith(DIST)) {
    res.writeHead(403).end();
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  if (!fs.existsSync(file)) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('UI não compilada. Rode "npm run build" ou use "npm run dev" (Vite) apontando para este bridge.');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ server, path: '/ws' });
function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(s);
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'snapshot', link, events: history }));
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'command') {
      const t = Date.now();
      if (MODE === 'replay') {
        ws.send(JSON.stringify({ type: 'error', t, text: 'Comandos desabilitados no modo replay.' }));
        return;
      }
      let bytes;
      try {
        bytes = encodeCommand(msg.mask);
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', t, text: e.message }));
        return;
      }
      if (!writeToDevice(bytes)) {
        ws.send(JSON.stringify({ type: 'error', t, text: 'Ground station desconectada; comando não enviado.' }));
        return;
      }
      link.bytesTx += bytes.length;
      log?.rawBytes(t, 'tx', bytes);
      publish({ type: 'cmd_sent', t, cmd: msg.mask });
    }
  });
});

setInterval(() => broadcast({ type: 'stats', link, parser: parser.stats }), 1000);

server.listen(HTTP_PORT, () => {
  console.log(`[bridge] modo=${MODE}  UI: http://localhost:${HTTP_PORT}  WS: ws://localhost:${HTTP_PORT}/ws`);
  if (log) console.log(`[bridge] log da sessão: ${log.dir}`);
});

if (TCP_LISTEN) startTcpRelay();
else if (MODE === 'serial') startSerial();
else if (MODE === 'sim') startSim();
else startReplay();
