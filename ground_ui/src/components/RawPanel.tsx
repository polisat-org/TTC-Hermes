import { useNow, type State } from '../store';

const clock = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour12: false });
const hx = (n: number) => '0x' + n.toString(16).toUpperCase().padStart(2, '0');
const fmt = (x: number | undefined | null, d = 2) => (x === undefined || x === null || Number.isNaN(x) ? '—' : x.toFixed(d));

function Row({ k, v, cls }: { k: string; v: React.ReactNode; cls?: string }) {
  return (
    <div className="kv">
      <span className="k">{k}</span>
      <span className={`v ${cls ?? ''}`}>{v}</span>
    </div>
  );
}

/** Detalhes técnicos: enlace, contadores, Telemetry_t completo e console USB. */
export function RawPanel({ s }: { s: State }) {
  const now = useNow();
  const tm = s.tm[s.tm.length - 1];
  const th = s.thermal[s.thermal.length - 1];
  const two = (n: number) => String(n).padStart(2, '0');
  const entries = tm
    ? Object.entries(tm).map(([k, v]) => [k, Array.isArray(v) ? `[${v.join(', ')}]` : typeof v === 'number' ? String(+v.toFixed(5)) : String(v)])
    : [];
  const log = [...s.console.map((c) => ({ ...c, cls: 'muted' })), ...s.errors.map((e) => ({ ...e, cls: 'bad' }))].sort((a, b) => b.t - a.t);

  return (
    <section className="panel advanced">
      <details>
        <summary>
          <h2>Advanced</h2>
          <span className="help">link details, raw telemetry and console</span>
        </summary>

        <h3>Link</h3>
        <Row k="Dashboard ↔ bridge" v={s.ws} cls={s.ws === 'open' ? 'ok' : 'bad'} />
        <Row k={`Ground station (${s.link?.mode ?? '?'})`} v={s.link ? `${s.link.connected ? 'connected' : 'disconnected'} · ${s.link.port}` : '—'} cls={s.link?.connected ? 'ok' : 'bad'} />
        {s.link?.error && <Row k="Error" v={s.link.error} cls="bad" />}
        <Row k="Frames T / P / H / Z" v={<code>{s.frames.telemetry} / {s.frames.payload} / {s.frames.thermal} / {s.frames.azimuth}</code>} />
        {s.parser && <Row k="USB parser" v={<code>{s.parser.frames} ok · {s.parser.rejected} rejected · {s.parser.droppedBytes} B noise</code>} />}
        <Row k="Bytes in / out" v={s.link ? `${s.link.bytesRx} / ${s.link.bytesTx}` : '—'} />
        {s.link?.logDir && <Row k="Session log" v={<code className="path">{s.link.logDir}</code>} />}

        <h3>Satellite</h3>
        {tm ? (
          <>
            <Row k="Last telemetry" v={`${((now - tm.t) / 1000).toFixed(1)} s ago`} />
            <Row k="OBC clock (RTC)" v={<code>{two(tm.dia)}/{two(tm.mes)}/{two(tm.ano)} {two(tm.hora)}:{two(tm.minuto)}:{two(tm.segundo)}</code>} />
            <Row k="Antenna" v={tm.deploy_antena ? 'deployed' : 'stowed'} />
            <Row k="Structure" v={`${fmt(tm.temperatura_estrutura, 1)} °C · ${fmt(tm.umidade, 0)} % · ${fmt(tm.pressao, 1)} hPa`} />
            <Row k="Bus 13.8 V / 5 V" v={`${fmt(tm.tensao_13v8)} V · ${fmt(tm.corrente_13v8, 3)} A / ${fmt(tm.tensao_5v)} V · ${fmt(tm.corrente_5v, 3)} A`} />
            <Row k="Batteries" v={`${(tm.tensao_bateria_1 / 1000).toFixed(3)} V ${tm.carga_bateria_1} % / ${(tm.tensao_bateria_2 / 1000).toFixed(3)} V ${tm.carga_bateria_2} %`} />
            <Row
              k="Chargers status / fault"
              v={<code>{hx(tm.status_carregador_1)} {hx(tm.falha_carregador_1)} / {hx(tm.status_carregador_2)} {hx(tm.falha_carregador_2)}</code>}
              cls={tm.falha_carregador_1 || tm.falha_carregador_2 ? 'warn' : ''}
            />
          </>
        ) : (
          <p className="hint">No telemetry yet.</p>
        )}

        <h3>Thermal control (last H)</h3>
        {th ? (
          <>
            <Row k="Probes" v={th.probes_c.map((x) => (x === null ? '—' : `${x.toFixed(2)} °C`)).join(' · ')} />
            <Row k="Heaters A / B" v={`${th.duty_pct[0]} % / ${th.duty_pct[1]} %`} />
            <Row k="Situation A / B" v={<code>{hx(th.situation[0])} / {hx(th.situation[1])}</code>} cls={th.situation[0] || th.situation[1] ? 'warn' : ''} />
            <Row k="Data" v={`${th.valid ? 'valid' : 'NOT valid'} · ${th.age_s === null ? 'no reading' : `${th.age_s.toFixed(1)} s old`}`} cls={th.valid ? '' : 'warn'} />
          </>
        ) : (
          <p className="hint">Arrives every 5 s while the ADS-B mission is on.</p>
        )}

        <h3>Telemetry_t (last frame)</h3>
        <div className="scroll small raw">
          {entries.map(([k, v]) => (
            <div key={k} className="kv">
              <span className="k">{k}</span>
              <code className="v">{v}</code>
            </div>
          ))}
        </div>

        <h3>USB console / errors</h3>
        <div className="scroll small console">
          {log.length === 0 && <span className="muted">Nothing yet.</span>}
          {log.slice(0, 200).map((l, i) => (
            <div key={i} className={l.cls}>
              <span className="muted">{clock(l.t)}</span> {l.text}
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}
