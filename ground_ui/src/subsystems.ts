import type { Telemetry } from './types';

// Bit do telecomando ↔ campo *_state da telemetria ↔ textos da UI.
// Os nomes dos estados seguem o mock_obc; confirme com o OBC real e ajuste AQUI.
export interface Subsystem {
  bit: number;
  key: 'mission_state' | 'deploy_state' | 'detumbling_state' | 'pointing_state';
  name: string;
  action: string; // o que ligar o bit faz, em linguagem simples
  states: Record<number, { label: string; tone: 'idle' | 'busy' | 'good' }>;
  oneWay?: boolean;
}

export const SUBSYSTEMS: Subsystem[] = [
  {
    bit: 0,
    key: 'mission_state',
    name: 'ADS-B Mission',
    action: 'Listen to aircraft and downlink their positions',
    states: { 0: { label: 'Idle', tone: 'idle' }, 1: { label: 'Running', tone: 'good' } },
  },
  {
    bit: 1,
    key: 'deploy_state',
    name: 'Antenna Deploy',
    action: 'Release the deployable antenna. One-way action!',
    states: {
      0: { label: 'Stowed', tone: 'idle' },
      1: { label: 'Deploying', tone: 'busy' },
      2: { label: 'Deployed', tone: 'good' },
    },
    oneWay: true,
  },
  {
    bit: 2,
    key: 'detumbling_state',
    name: 'Detumbling',
    action: 'Slow the spin down below 5 rpm',
    states: { 0: { label: 'Off', tone: 'idle' }, 1: { label: 'Active', tone: 'busy' } },
  },
  {
    bit: 3,
    key: 'pointing_state',
    name: 'Light Pointing',
    action: 'Search for the light source and report its azimuth',
    states: {
      0: { label: 'Off', tone: 'idle' },
      1: { label: 'Searching', tone: 'busy' },
      2: { label: 'Found', tone: 'good' },
    },
  },
];

export function stateOf(s: Subsystem, tm: Telemetry | undefined) {
  if (!tm) return { label: 'No data', tone: 'idle' as const, raw: null as number | null };
  const raw = tm[s.key];
  return { ...(s.states[raw] ?? { label: `State ${raw}`, tone: 'busy' as const }), raw };
}

export function describeMask(mask: number): string {
  const on = SUBSYSTEMS.filter((s) => mask & (1 << s.bit)).map((s) => s.name);
  return on.length ? on.join(' + ') : 'Everything off';
}

export const hex = (n: number) => '0x' + n.toString(16).toUpperCase().padStart(2, '0');

// ---- Modos mutuamente exclusivos -------------------------------------------
// A UI só envia comandos com UM bit ligado (ou 0x00 = Standby). O protocolo continua
// sendo o bitmask do detalhamento §4.1; a exclusividade é uma regra de operação.
export type ModeId = 'standby' | 'mission' | 'deploy' | 'detumbling' | 'pointing';

export interface Mode {
  id: ModeId;
  name: string;
  cmd: number;
  blurb: string;
  confirm?: string;
}

export const MODES: Mode[] = [
  { id: 'standby', name: 'Standby', cmd: 0x00, blurb: 'Everything off, telemetry only' },
  { id: 'mission', name: 'ADS-B Mission', cmd: 0x01, blurb: 'Track aircraft and downlink positions' },
  { id: 'detumbling', name: 'Detumbling', cmd: 0x04, blurb: 'Slow the spin below 5 rpm' },
  { id: 'pointing', name: 'Light Pointing', cmd: 0x08, blurb: 'Find the light source azimuth' },
  {
    id: 'deploy',
    name: 'Antenna Deploy',
    cmd: 0x02,
    blurb: 'Release the antenna (one-way)',
    confirm: 'Deploy the antenna?\n\nThis is a one-way mechanism: it cannot be undone.',
  },
];

export const modeByCmd = (cmd: number): Mode | undefined => MODES.find((m) => m.cmd === cmd);

/** Modo atual segundo a TELEMETRIA (o que o satélite diz que está fazendo). */
export function currentMode(tm: Telemetry | undefined): ModeId | null {
  if (!tm) return null;
  if (tm.deploy_state === 1) return 'deploy';
  if (tm.mission_state) return 'mission';
  if (tm.detumbling_state) return 'detumbling';
  if (tm.pointing_state) return 'pointing';
  return 'standby';
}
