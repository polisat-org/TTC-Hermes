import { useNow, type State } from '../store';
import { charger } from '../eps';
import { IconBattery, IconCompass, IconPlane, IconSignal, IconSpin, IconThermo } from './Icons';

type Tone = 'ok' | 'warn' | 'bad' | 'idle';

function Kpi({
  icon,
  label,
  value,
  unit,
  hint,
  tone = 'idle',
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  unit?: string;
  hint: string;
  tone?: Tone;
}) {
  return (
    <div className={`kpi ${tone}`}>
      <div className="kpi-icon">{icon}</div>
      <div className="kpi-body">
        <span className="kpi-label">{label}</span>
        <span className="kpi-value">
          {value}
          {unit && <small>{unit}</small>}
        </span>
        <span className="kpi-hint">{hint}</span>
      </div>
    </div>
  );
}

const ok = (x: number | undefined | null): x is number => x !== undefined && x !== null && Number.isFinite(x);
const ago = (ms: number) => (ms < 90_000 ? `${Math.round(ms / 1000)} s ago` : `${Math.round(ms / 60_000)} min ago`);

export function KpiStrip({ s }: { s: State }) {
  const now = useNow();
  const tm = s.tm[s.tm.length - 1];
  const th = s.thermal[s.thermal.length - 1];
  const az = s.azimuths[s.azimuths.length - 1];
  const active = [...s.tracks.values()].filter((t) => now - t.lastT < 30_000).length;
  const f = s.frames;
  const total = f.telemetry + f.payload + f.thermal + f.azimuth;
  const age = s.lastFrameT === null ? null : now - s.lastFrameT;
  // A TT&C manda 'T' a cada 60 s; na missão chegam 'P'/'H' a cada 5 s.
  const linkTone: Tone = age === null ? 'idle' : age < 70_000 ? 'ok' : age < 180_000 ? 'warn' : 'bad';
  // baterias com leitura do MAX17048 (tensão 0 = sem leitura)
  const bats = tm
    ? [{ mv: tm.tensao_bateria_1, soc: tm.carga_bateria_1 }, { mv: tm.tensao_bateria_2, soc: tm.carga_bateria_2 }].filter((b) => b.mv > 0)
    : [];
  const vbat = bats.length ? Math.min(...bats.map((b) => b.mv)) / 1000 : undefined;
  const soc = bats.map((b) => b.soc);
  const probes = th?.probes_c.filter((x): x is number => x !== null) ?? [];
  // bateria: a sonda mais fria do TCS (o OBC usa a mesma regra) ou a temperatura da telemetria
  const tbat = probes.length && th && s.lastEventT !== null && (s.lastEventT - th.t) < 15_000 ? Math.min(...probes) : tm?.temperatura_bateria;
  const azNow = az && now - az.t < 10_000 ? az.value : tm?.azimuth ?? null;
  // carga pelos carregadores MP2733 (status + corrente de carga) e CRATE do MAX17048
  const chg = tm ? [charger(tm, 1), charger(tm, 2)] : [];
  const charging = chg.filter((c) => c.charging);
  const ichg = charging.reduce((a, c) => a + c.ichgMa, 0);

  return (
    <section className="kpis">
      <Kpi
        icon={<IconSignal />}
        label="Downlink"
        value={total ? String(total) : '—'}
        unit={total ? 'frames' : undefined}
        hint={age === null ? 'No frames yet' : `Last frame ${ago(age)} · T ${f.telemetry} · P ${f.payload} · H ${f.thermal} · Z ${f.azimuth}`}
        tone={linkTone}
      />
      <Kpi
        icon={<IconBattery />}
        label="Battery"
        value={ok(vbat) ? vbat.toFixed(2) : '—'}
        unit="V"
        hint={ok(vbat) ? `Charge ${soc.join(' / ')} % · lowest cell` : tm ? 'No fuel gauge reading (EPS)' : 'Waiting for telemetry'}
        tone={!ok(vbat) ? 'idle' : vbat >= 3.6 ? 'ok' : vbat >= 3.4 ? 'warn' : 'bad'}
      />
      <Kpi
        icon={<IconBattery />}
        label="Charging"
        value={!tm ? '—' : charging.length ? ichg.toFixed(0) : chg.some((c) => c.state === 'done') ? 'full' : 'no'}
        unit={charging.length ? 'mA' : undefined}
        hint={
          !tm
            ? 'Waiting for telemetry'
            : chg.map((c, i) => `C${i + 1}: ${c.state}${c.vinV > 0 ? ` · in ${c.vinV.toFixed(1)} V` : ''}${c.crate ? ` · ${c.crate >= 0 ? '+' : ''}${c.crate.toFixed(1)} %/h` : ''}`).join(' | ')
        }
        tone={!tm ? 'idle' : charging.length ? 'ok' : chg.some((c) => c.fault) ? 'bad' : 'idle'}
      />
      <Kpi
        icon={<IconThermo />}
        label="Battery temp."
        value={ok(tbat) ? tbat.toFixed(1) : '—'}
        unit="°C"
        hint="Must stay above 0 °C"
        tone={!ok(tbat) ? 'idle' : tbat > 0 && tbat < 50 ? 'ok' : 'bad'}
      />
      <Kpi
        icon={<IconSpin />}
        label="Heaters"
        value={th ? `${th.duty_pct[0]} / ${th.duty_pct[1]}` : '—'}
        unit={th ? '%' : undefined}
        hint={th ? (th.valid ? `Thermal control · ${probes.length}/4 probes` : 'Thermal control: no valid data') : 'Arrives with the mission (H)'}
        tone={!th ? 'idle' : th.valid && !th.situation[0] && !th.situation[1] ? 'ok' : 'warn'}
      />
      <Kpi
        icon={<IconCompass />}
        label="Light azimuth"
        value={azNow !== null ? azNow.toFixed(1) : '—'}
        unit={azNow !== null ? '°' : undefined}
        hint={az && now - az.t < 10_000 ? 'Live from the ADCS (Z)' : azNow !== null ? 'Last value in telemetry' : 'Turn on Light Pointing'}
        tone={azNow !== null ? 'ok' : 'idle'}
      />
      <Kpi
        icon={<IconPlane />}
        label="Aircraft"
        value={String(active)}
        unit={`/ ${s.tracks.size}`}
        hint="Active now / seen in total (max 20)"
        tone={active ? 'ok' : 'idle'}
      />
    </section>
  );
}
