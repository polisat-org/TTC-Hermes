#!/usr/bin/env node
// Ponte Ground Station: USB do ESP32 ground <-> WebSocket (+ HTTP da UI).
//
//   node bridge/server.mjs --port COM5           # hardware (Windows)
//   node bridge/server.mjs --port /dev/ttyUSB0   # hardware (Linux)
//   node bridge/server.mjs --sim                 # simulador, sem hardware ('T' a cada --sim-tm-s, padrão 10 s;
//                                                # o OBC real manda a cada 60 s)
//   node bridge/server.mjs --replay logs/<sessao>/raw.jsonl [--speed 4]
//   node bridge/server.mjs --list                # lista portas seriais
//   node bridge/server.mjs --tcp-listen 8766     # WSL: a porta COM é lida no Windows por
//                                                # bridge/com_relay.ps1, que repassa via TCP
//   node bridge/server.mjs --pi http://<ip-do-pi>:8080   # payload pela rede (hermes_simples.rede no Pi):
//                                                # os quadros chegam no mesmo parser da USB do ground
//   npm run pi -- http://<ip-do-pi>:8080         # o mesmo, pelo npm
//
// Interface: --ui full (ground station completa) ou --ui mission (só o modo Mission, Start e janela
// de 16 min). Padrão: mission com --pi, full nos outros casos. A UI lê isso de link.ui.
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
import { StreamParser, encodeCommand, toHex, fromHex, CMD_STATUS, TELEMETRY_FIELDS } from './protocol.mjs';
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
const PI_URL = opt('pi', null)?.replace(/\/+$/, '') ?? null;
const UI = opt('ui', PI_URL ? 'mission' : 'full');
if (UI !== 'full' && UI !== 'mission') {
  console.error('--ui deve ser full ou mission');
  process.exit(1);
}
const LOG_ROOT = path.resolve(opt('logs', path.join(ROOT, 'logs')));

if (flag('list')) {
  const { SerialPort } = await import('serialport');
  for (const p of await SerialPort.list()) {
    console.log(`${p.path}\t${p.manufacturer ?? ''}\t${p.vendorId ?? ''}:${p.productId ?? ''}`);
  }
  process.exit(0);
}
if (!SERIAL_PATH && !SIM && !REPLAY && !TCP_LISTEN && !PI_URL) {
  console.error('Use --port <porta>, --pi <url>, --sim ou --replay <raw.jsonl>. Veja --list.');
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
    this.thermal = open('thermal.csv');
    this.azimuth = open('azimuth.csv');
    this.cmds = open('commands.csv');
    this.tm.write(['pc_time_iso', 'pc_time_ms', ...TELEMETRY_FIELDS.map(([n]) => n)].join(',') + '\n');
    this.planes.write('pc_time_iso,pc_time_ms,frame_idx,count,icao_hex,latitude,longitude,altitude_ft,velocity_kt,track_deg,last_pos_met_ms\n');
    this.thermal.write('pc_time_iso,pc_time_ms,valid,age_s,probe1_c,probe2_c,probe3_c,probe4_c,duty_a,duty_b,situation_a,situation_b,tcs_time_s,mission,planes\n');
    this.azimuth.write('pc_time_iso,pc_time_ms,azimuth_deg\n');
    this.cmds.write('pc_time_iso,pc_time_ms,event,cmd_hex,status\n');
    this.frameIdx = 0;
    fs.writeFileSync(
      path.join(dir, 'session.json'),
      JSON.stringify({ started: new Date().toISOString(), mode: MODE, port: SERIAL_PATH ?? PI_URL, baud: BAUD }, null, 2),
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
      this.tm.write([iso, ev.t, ...TELEMETRY_FIELDS.map(([n]) => d[n])].join(',') + '\n');
    } else if (ev.type === 'payload') {
      const idx = this.frameIdx++;
      for (const p of ev.planes) {
        this.planes.write(
          [iso, ev.t, idx, ev.planes.length, p.icao.toString(16).padStart(6, '0'), p.latitude, p.longitude, p.altitude_ft,
            p.velocity_kt, p.track_deg, p.last_pos_met_ms].join(',') + '\n',
        );
      }
    } else if (ev.type === 'thermal') {
      const d = ev.data;
      this.thermal.write(
        [iso, ev.t, d.valid ? 1 : 0, d.age_s ?? '', ...d.probes_c.map((x) => x ?? ''), ...d.duty_pct, ...d.situation,
          d.tcs_time_s, d.mission ? 1 : 0, d.planes].join(',') + '\n',
      );
    } else if (ev.type === 'azimuth') {
      this.azimuth.write([iso, ev.t, ev.value].join(',') + '\n');
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
const link = { mode: MODE, source: PI_URL ? 'pi' : 'ttc', ui: UI, port: SERIAL_PATH ?? PI_URL ?? (TCP_LISTEN ? `relay tcp:${TCP_LISTEN}` : null) ?? REPLAY ?? 'sim', connected: false, bytesRx: 0, bytesTx: 0, logDir: log?.dir ?? null };

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
    else if (e.kind === 'thermal') publish({ type: 'thermal', t, data: e.data });
    else if (e.kind === 'azimuth') publish({ type: 'azimuth', t, value: e.value });
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

// Payload pela rede: GET /quadros traz os bytes que o TT&C entregaria ao solo; cada telecomando vira
// POST /telecomando e a resposta volta como o quadro 'A' (cmd, status) que o ESP do ground manda pela USB.
function startPi() {
  let desde = 0;
  let evDesde = 0; // eventos (erros/avisos) do Pi já repassados
  let estadoAntes = '';
  let falhas = 0;
  const fila = [];
  let enviando = false;
  const poll = async () => {
    try {
      const r = await fetch(`${PI_URL}/quadros?desde=${desde}&ev=${evDesde}`, { signal: AbortSignal.timeout(2000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      if (d.ultimo < desde) desde = 0;   // o programa do Pi reiniciou: recomeça a numeração
      // Erros e avisos do Pi (só existem neste modo: não passam pelo OBC/TT&C).
      if (typeof d.ultimo_evento === 'number') {
        if (d.ultimo_evento < evDesde) evDesde = 0;
        for (const e of d.eventos ?? []) {
          publish({ type: 'device_log', t: Date.now(), source: 'payload', level: e.nivel, text: e.texto });
          evDesde = Math.max(evDesde, e.seq);
        }
      }
      if (d.estado) {
        const j = JSON.stringify(d.estado);
        if (j !== estadoAntes) {
          estadoAntes = j;
          link.payload = d.estado;
          broadcast({ type: 'link', link });
        }
      }
      for (const q of d.quadros) {
        const t = Date.now();
        onRx(fromHex(q.hex), t);
        // Só o Pi manda o indicativo (o downlink do OBC não tem esse campo): {"E48000": "TAM3054", ...}
        if (q.indicativos && Object.keys(q.indicativos).length) publish({ type: 'callsigns', t, map: q.indicativos });
        desde = Math.max(desde, q.seq);
      }
      if (!link.connected || falhas) setLink(true);
      falhas = 0;
    } catch (e) {
      if (++falhas === 3 || (falhas > 3 && link.connected)) setLink(false, `sem resposta de ${PI_URL} (${e.message})`);
    }
    setTimeout(poll, 300);
  };
  const enviaFila = async () => {
    if (enviando) return;
    enviando = true;
    while (fila.length) {
      const cmd = fila.shift();
      let status = 1;   // falha no enlace
      try {
        const r = await fetch(`${PI_URL}/telecomando`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mascara: cmd }),
          signal: AbortSignal.timeout(3000),
        });
        if (r.ok) status = (await r.json()).status ?? 1;
      } catch {
        status = 1;
      }
      onRx(Uint8Array.from([0x41, cmd, status]));   // 'A' cmd status
    }
    enviando = false;
  };
  writeToDevice = (b) => {
    if (!link.connected) return false;
    for (const cmd of b) fila.push(cmd);
    enviaFila();
    return true;
  };
  poll();
}

function startSim() {
  const sim = new GroundSimulator({ tmPeriodMs: Number(opt('sim-tm-s', 10)) * 1000 });
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
  console.log(`[bridge] ui=${UI} modo=${MODE}  UI: http://localhost:${HTTP_PORT}  WS: ws://localhost:${HTTP_PORT}/ws`);
  if (log) console.log(`[bridge] log da sessão: ${log.dir}`);
});

if (PI_URL) startPi();
else if (TCP_LISTEN) startTcpRelay();
else if (MODE === 'serial') startSerial();
else if (MODE === 'sim') startSim();
else startReplay();
