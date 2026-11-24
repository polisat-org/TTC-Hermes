// Bit do telecomando ↔ textos da UI. A telemetria do OBC (Telemetry_t) não traz o estado de cada modo:
// a UI mostra o último telecomando CONFIRMADO pelo ground + o que dá para ver nos dados
// (deploy_antena, quadros 'P' chegando, azimutes 'Z' chegando).
export interface Subsystem {
  bit: number;
  name: string;
  action: string; // o que ligar o bit faz, em linguagem simples
  oneWay?: boolean;
}

export const SUBSYSTEMS: Subsystem[] = [
  { bit: 0, name: 'ADS-B Mission', action: 'Listen to aircraft and downlink their positions' },
  { bit: 1, name: 'Antenna Deploy', action: 'Release the deployable antenna. One-way action!', oneWay: true },
  { bit: 2, name: 'Detumbling', action: 'Slow the spin down below 5 rpm' },
  { bit: 3, name: 'Light Pointing', action: 'Search for the light source and report its azimuth' },
];

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

/**
 * Modo atual = último telecomando confirmado. Segue o handleTelecommand do OBC: com o bit Deploy (antena ainda
 * fechada) o OBC SÓ faz o deploy; detumbling tem prioridade sobre o apontamento.
 */
export function currentMode(mask: number | null, deployed: boolean): ModeId | null {
  if (mask === null) return null;
  if (mask & 2 && !deployed) return 'deploy';
  if (mask & 1) return 'mission';
  if (mask & 4) return 'detumbling';
  if (mask & 8) return 'pointing';
  return 'standby';
}
