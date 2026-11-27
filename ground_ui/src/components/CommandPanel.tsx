import { store, useNow, type State } from '../store';
import { currentMode, hex, modeByCmd, MODES, type ModeId } from '../subsystems';
import { CMD_STATUS_LABEL } from '../types';
import { uiFeatures } from '../ui';
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

/** Linha de detalhe de cada modo, a partir do que chega do satélite. */
function modeDetail(mode: ModeId, s: State, now: number, deployed: boolean): string {
  switch (mode) {
    case 'standby':
      return deployed ? 'Antenna deployed · waiting for a command' : 'Waiting for a command';
    case 'mission': {
      const active = [...s.tracks.values()].filter((t) => now - t.lastT < 30_000).length;
      const age = s.lastPayloadT === null ? null : (now - s.lastPayloadT) / 1000;
      return age === null
        ? 'Waiting for the first aircraft frame (the receiver takes up to 15 s)'
        : `${active} aircraft in view · last frame ${age.toFixed(0)} s ago`;
    }
    case 'detumbling':
      return 'Reaction wheel on · spin rate is not in the telemetry';
    case 'pointing': {
      const az = s.azimuths[s.azimuths.length - 1];
      return az && now - az.t < 10_000 ? `Light source at ${az.value.toFixed(1)}°` : 'Searching for the light source…';
    }
    case 'deploy':
      return deployed ? 'Antenna deployed' : 'Releasing the antenna… (send the next mode after it opens)';
  }
}

export function CommandPanel({ s }: { s: State }) {
  const now = useNow(500);
  const tm = s.tm[s.tm.length - 1];
  const deployed = tm?.deploy_antena === 1;
  const ui = uiFeatures(s.link);
  // Variante mission: a tela mostra Mission desde o início (é o único modo desta interface).
  const mode = currentMode(s.commandedMask, deployed) ?? (ui.modeSelect ? null : 'mission');
  const modeInfo = MODES.find((m) => m.id === mode);
  const since = s.commandedT;
  const replay = s.link?.mode === 'replay';
  const canSend = !replay && s.ws === 'open' && !!s.link?.connected;
  const pending = [...s.commands].reverse().find((c) => c.status === undefined);
  const last = s.commands[s.commands.length - 1];
  const stale = s.lastFrameT === null || now - s.lastFrameT > 70_000; // 'T' vem a cada 60 s
  const ModeIcon = mode ? ICONS[mode] : IconPower;

  const running = s.missionStart !== null && !s.missionDone;
  const select = (cmd: number, confirmText?: string) => {
    if (!ui.modeSelect) return store.startMission(); // mission: o botão faz o mesmo que o Start
    if (confirmText && !confirm(confirmText)) return;
    store.sendCommand(cmd);
  };

  return (
    <section className="panel mission-control">
      <div className="panel-head">
        <h2>Mission control</h2>
        <span className="help">
          {ui.modeSelect
            ? 'One mode at a time. Click a mode to switch the satellite to it.'
            : `ADS-B Mission mode. Press Start to begin the ${ui.missionMs / 60000}-minute mission.`}
        </span>
      </div>

      {/* ---- tela de modo atual ---- */}
      <div className={`mode-screen ${mode ?? 'none'} ${stale ? 'stale' : ''}`}>
        <div className="screen-top">
          <span>COMMANDED MODE</span>
          <span className={`screen-dot ${stale ? 'off' : 'on'}`}>{s.lastFrameT !== null ? (stale ? 'NO SIGNAL' : 'LIVE') : 'NO DATA'}</span>
        </div>
        <div className="screen-main">
          <ModeIcon size={34} />
          <div>
            <div className="screen-mode">{modeInfo ? modeInfo.name.toUpperCase() : '— — —'}</div>
            <div className="screen-detail">{s.commandedMask === null
                ? ui.modeSelect
                  ? 'No command confirmed yet: pick a mode below'
                  : 'Ready: press Start to begin the mission'
                : mode && modeDetail(mode, s, now, deployed)}</div>
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
          const active = mode === m.id && s.commandedMask !== null;
          const locked = !ui.modeSelect && (m.id !== 'mission' || running);
          const isPending = pending?.cmd === m.cmd;
          const isDeployed = m.id === 'deploy' && deployed;
          return (
            <button
              key={m.id}
              className={`mode-btn ${m.id} ${active ? 'active' : ''} ${isPending ? 'pending' : ''} ${m.confirm ? 'danger' : ''}`}
              onClick={() => select(m.cmd, m.confirm)}
              disabled={locked || !canSend || active || isPending || isDeployed}
              title={`${m.blurb} · sends ${hex(m.cmd)}`}
            >
              <Icon size={22} />
              <span className="mode-name">{m.name}</span>
              <small>{isDeployed ? 'Already deployed' : active ? 'Active now' : isPending ? 'Sending…' : m.blurb}</small>
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
          "Confirmed" means the satellite's radio received the command and passed it to the OBC. The OBC telemetry
          does not report the mode, so the screen shows the last confirmed command. With Deploy, the OBC only
          deploys: send the next mode afterwards.
        </p>
      </details>
    </section>
  );
}
