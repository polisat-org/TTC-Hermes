import { useEffect } from 'react';
import { store, useNow, type State } from '../store';
import { uiFeatures } from '../ui';


const mmss = (ms: number) => {
  const t = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

export function linkSummary(s: State, now: number) {
  const age = s.lastFrameT === null ? null : (now - s.lastFrameT) / 1000;
  if (s.ws !== 'open') return { tone: 'bad', title: 'Dashboard offline', detail: 'Start the bridge (npm run bridge)' };
  if (!s.link?.connected) return { tone: 'bad', title: 'Ground station disconnected', detail: s.link?.error ?? 'Plug in the ESP32' };
  if (age === null) return { tone: 'warn', title: 'Waiting for the satellite', detail: 'Connected, no frames yet (telemetry every 60 s)' };
  // telemetria a cada 60 s: só é perda depois de faltar mais de um quadro
  if (age > 70) return { tone: 'warn', title: 'Signal lost', detail: `Last data ${age.toFixed(0)} s ago` };
  return { tone: 'ok', title: 'Receiving data', detail: `Last packet ${age.toFixed(1)} s ago` };
}

export function TopBar({ s }: { s: State }) {
  const now = useNow(500);
  const ui = uiFeatures(s.link);
  const MISSION_MS = ui.missionMs; // full: 10 min (HLR-ADS-05) · mission: 16 min
  const raw = s.missionStart !== null ? (s.missionEnd ?? now) - s.missionStart : 0;
  const elapsed = ui.startCommands ? Math.min(raw, MISSION_MS) : raw;
  const pct = Math.min(100, (100 * elapsed) / MISSION_MS);
  const running = ui.startCommands && s.missionStart !== null && !s.missionDone;
  const canSend = s.ws === 'open' && !!s.link?.connected;
  useEffect(() => {
    if (running && raw >= MISSION_MS) store.finishMission(); // fim da janela: manda 0x00
  }, [running, raw, MISSION_MS]);
  const link = linkSummary(s, now);
  const mode = s.link?.mode;

  return (
    <header className="topbar">
      <div className="brand">
        <img src="/brand/hermes-patch.webp" alt="Hermes mission patch" className="patch" />
        <div>
          <div className="brand-title">
            HERMES <span>Ground Station</span>
          </div>
          <div className="brand-sub">
            CubeDesign 2026 · ADS-B air surveillance
            {mode === 'sim' && <span className="tag warn">SIMULATOR</span>}
            {mode === 'replay' && <span className="tag info">REPLAY</span>}
          </div>
        </div>
      </div>

      <div className="mission-clock">
        <div className="clock-row">
          <span className="clock-label">Mission time</span>
          <span className="clock">{s.missionStart === null ? '--:--' : mmss(elapsed)}</span>
          <span className="clock-total">/ {mmss(MISSION_MS)}</span>
          {s.missionStart === null ? (
            <button className="ghost" onClick={() => store.startMission()} disabled={ui.startCommands && !canSend}>
              Start
            </button>
          ) : running ? (
            <button
              className="ghost danger"
              onClick={() => confirm('Stop the mission now? The payload will be turned off (0x00).') && store.finishMission()}
              disabled={!canSend}
              title="Stop the mission before the end of the window"
            >
              Stop
            </button>
          ) : (
            <button className="ghost" onClick={() => store.resetMission()}>
              Reset
            </button>
          )}
        </div>
        <div className="progress" title={ui.startCommands ? `Mission window: ${MISSION_MS / 60000} continuous minutes` : 'The rules require 10 continuous minutes of mission'}>
          <div className={`bar ${pct >= 100 ? 'done' : ''}`} style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className={`link-pill ${link.tone}`}>
        <span className="pulse" />
        <div>
          <b>{link.title}</b>
          <small>{link.detail}</small>
        </div>
      </div>

      <img src="/brand/polisat-logo.svg" alt="PoliSat" className="polisat" />
    </header>
  );
}
