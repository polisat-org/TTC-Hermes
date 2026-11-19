import { useNow, type State } from '../store';
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

const ok = (x: number | undefined) => x !== undefined && Number.isFinite(x);

export function KpiStrip({ s }: { s: State }) {
  const now = useNow();
  const tm = s.tm[s.tm.length - 1];
  const total = s.tmReceived + s.tmLost;
  const loss = total ? (100 * s.tmLost) / total : 0;
  const active = [...s.tracks.values()].filter((t) => now - t.lastT < 30_000).length;
  const v = tm?.battery_voltage;
  const i = tm?.battery_current;
  const temp = tm?.temperature;
  const rpm = tm?.rpm;

  return (
    <section className="kpis">
      <Kpi
        icon={<IconSignal />}
        label="Link quality"
        value={total ? `${(100 - loss).toFixed(0)}` : '—'}
        unit="%"
        hint={total ? `${s.tmReceived} packets in, ${s.tmLost} lost` : 'No packets yet'}
        tone={!total ? 'idle' : loss < 5 ? 'ok' : loss < 20 ? 'warn' : 'bad'}
      />
      <Kpi
        icon={<IconBattery />}
        label="Battery"
        value={ok(v) ? v!.toFixed(2) : '—'}
        unit="V"
        hint={ok(i) ? (i! > 0.02 ? `Charging · ${(i! * 1000).toFixed(0)} mA` : i! < -0.02 ? `Discharging · ${(-i! * 1000).toFixed(0)} mA` : 'Idle') : 'Waiting for telemetry'}
        tone={!ok(v) ? 'idle' : v! >= 3.6 ? 'ok' : v! >= 3.4 ? 'warn' : 'bad'}
      />
      <Kpi
        icon={<IconThermo />}
        label="Temperature"
        value={ok(temp) ? temp!.toFixed(1) : '—'}
        unit="°C"
        hint="Battery must stay above 0 °C"
        tone={!ok(temp) ? 'idle' : temp! > 0 && temp! < 50 ? 'ok' : 'bad'}
      />
      <Kpi
        icon={<IconSpin />}
        label="Spin rate"
        value={ok(rpm) ? rpm!.toFixed(1) : '—'}
        unit="rpm"
        hint={ok(rpm) ? (rpm! < 5 ? 'Stable · below 5 rpm target' : 'Tumbling · target < 5 rpm') : 'Target: below 5 rpm'}
        tone={!ok(rpm) ? 'idle' : rpm! < 5 ? 'ok' : 'warn'}
      />
      <Kpi
        icon={<IconCompass />}
        label="Light azimuth"
        value={tm?.azimuth_str ?? '—'}
        unit={tm?.azimuth_str ? '°' : undefined}
        hint={tm?.azimuth_str ? 'Reported by the ADCS' : 'Turn on Light Pointing'}
        tone={tm?.azimuth_str ? 'ok' : 'idle'}
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
