import { store, useNow, type State, type TmPoint } from '../store';
import { currentMode, hex, modeByCmd, MODES, type ModeId } from '../subsystems';
import { CMD_STATUS_LABEL } from '../types';
import { IconAntenna, IconCompass, IconPlane, IconPower, IconSpin } from './Icons';

const ICONS: Record<ModeId, (p: { size?: number }) => JSX.Element> = {
  standby: IconPower,
  mission: IconPlane,
  detumbling: IconSpin,
  pointing: IconCompass,
  deploy: IconAntenna,
};

const clock = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour12: false });
const mmss = (ms: number) => {
  const t = Math.max(0, Math.floor(ms / 1000));
  return t >= 3600 ? `${Math.floor(t / 3600)}h ${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}m` : `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};
const cmdName = (cmd: number) => modeByCmd(cmd)?.name ?? `Custom ${hex(cmd)}`;

/** Desde quando a telemetria está no modo atual (varre o histórico de trás para frente). */
function modeSince(tm: TmPoint[], mode: ModeId): number | null {
  let since: number | null = null;
  for (let i = tm.length - 1; i >= 0; i--) {
    if (currentMode(tm[i]) !== mode) break;
    since = tm[i].t;
  }
  return since;
}

/** Linha de detalhe específica de cada modo, a partir da telemetria. */
function modeDetail(mode: ModeId, s: State, now: number): string {
  const tm = s.tm[s.tm.length - 1];
  if (!tm) return '';
  switch (mode) {
    case 'standby':
      return tm.deploy_state === 2 ? 'Antenna deployed · waiting for a command' : 'Waiting for a command';
    case 'mission': {
      const active = [...s.tracks.values()].filter((t) => now - t.lastT < 30_000).length;
      return `${active} aircraft in view · ${s.payloadFrames} position packets received`;
    }
    case 'detumbling':
      return tm.rpm < 5 ? `Stable: ${tm.rpm.toFixed(1)} rpm (target reached)` : `Spinning at ${tm.rpm.toFixed(1)} rpm → target below 5 rpm`;
    case 'pointing':
      return tm.pointing_state === 2 && tm.azimuth_str ? `Light source found at ${tm.azimuth_str}°` : 'Searching for the light source…';
    case 'deploy':
      return 'Releasing the antenna…';
  }
}

export function CommandPanel({ s }: { s: State }) {
  const now = useNow(500);
  const tm = s.tm[s.tm.length - 1];
  const mode = currentMode(tm);
  const modeInfo = MODES.find((m) => m.id === mode);
  const since = mode ? modeSince(s.tm, mode) : null;
  const replay = s.link?.mode === 'replay';
  const canSend = !replay && s.ws === 'open' && !!s.link?.connected;
  const pending = [...s.commands].reverse().find((c) => c.status === undefined);
  const last = s.commands[s.commands.length - 1];
  const stale = tm ? now - tm.t > 5000 : true;
  const ModeIcon = mode ? ICONS[mode] : IconPower;

  const select = (cmd: number, confirmText?: string) => {
    if (confirmText && !confirm(confirmText)) return;
    store.sendCommand(cmd);
  };

  return (
    <section className="panel mission-control">
      <div className="panel-head">
        <h2>Mission control</h2>
        <span className="help">One mode at a time. Click a mode to switch the satellite to it.</span>
      </div>

      {/* ---- tela de modo atual ---- */}
      <div className={`mode-screen ${mode ?? 'none'} ${stale ? 'stale' : ''}`}>
        <div className="screen-top">
          <span>CURRENT MODE</span>
          <span className={`screen-dot ${stale ? 'off' : 'on'}`}>{tm ? (stale ? 'NO SIGNAL' : 'LIVE') : 'NO DATA'}</span>
        </div>
        <div className="screen-main">
          <ModeIcon size={34} />
          <div>
            <div className="screen-mode">{modeInfo ? modeInfo.name.toUpperCase() : '— — —'}</div>
            <div className="screen-detail">{tm ? modeDetail(mode!, s, now) : 'Waiting for the first telemetry packet'}</div>
          </div>
        </div>
        <div className="screen-bottom">
          <span>{since !== null ? `in this mode for ${mmss(now - since)}` : ''}</span>
          <span>
            {pending
              ? `→ switching to ${cmdName(pending.cmd)}… ${((now - pending.sentT) / 1000).toFixed(0)} s`
              : last && last.status !== undefined && last.status !== 0
                ? `last command ${CMD_STATUS_LABEL[last.status].toLowerCase()}`
                : ''}
          </span>
        </div>
      </div>

      {/* ---- botões de modo ---- */}
      <div className="mode-grid">
        {MODES.map((m) => {
          const Icon = ICONS[m.id];
          const active = mode === m.id;
          const isPending = pending?.cmd === m.cmd;
          const deployed = m.id === 'deploy' && tm?.deploy_state === 2;
          return (
            <button
              key={m.id}
              className={`mode-btn ${m.id} ${active ? 'active' : ''} ${isPending ? 'pending' : ''} ${m.confirm ? 'danger' : ''}`}
              onClick={() => select(m.cmd, m.confirm)}
              disabled={!canSend || active || isPending || deployed}
              title={`${m.blurb} · sends ${hex(m.cmd)}`}
            >
              <Icon size={22} />
              <span className="mode-name">{m.name}</span>
              <small>{deployed ? 'Already deployed' : active ? 'Active now' : isPending ? 'Sending…' : m.blurb}</small>
            </button>
          );
        })}
      </div>
      {!canSend && !replay && <p className="hint warn-text">Ground station not connected: mode changes are disabled.</p>}
      {replay && <p className="hint">Replay mode: mode changes are disabled.</p>}

      <details className="history">
        <summary>
          Command history <span className="count">{s.commands.length}</span>
        </summary>
        {s.commands.length === 0 ? (
          <p className="hint">No commands sent yet.</p>
        ) : (
          <ul>
            {[...s.commands]
              .reverse()
              .slice(0, 30)
              .map((c, i) => (
                <li key={i}>
                  <span className="muted">{clock(c.sentT)}</span>
                  <span className="hist-what">{cmdName(c.cmd)}</span>
                  <span className={`state-chip ${c.status === undefined ? 'busy' : c.status === 0 ? 'good' : 'bad'}`}>
                    {c.status === undefined ? `sending… ${((now - c.sentT) / 1000).toFixed(0)} s` : CMD_STATUS_LABEL[c.status]}
                    {c.ackT && c.status !== undefined ? ` · ${((c.ackT - c.sentT) / 1000).toFixed(1)} s` : ''}
                  </span>
                </li>
              ))}
          </ul>
        )}
        <p className="hint">
          "Confirmed" means the satellite received the command. The Current mode screen shows what the satellite
          actually reports in its telemetry.
        </p>
      </details>
    </section>
  );
}
