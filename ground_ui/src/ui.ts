import type { LinkInfo } from './types';

/**
 * Variante da interface, escolhida no bridge (--ui, ou --pi que implica mission) e lida de link.ui.
 * Os componentes consultam estas flags em vez de existir uma cópia da interface para cada uso.
 *
 *   full    ground station completa: todos os modos clicáveis, janela de 10 min (HLR-ADS-05),
 *           Start só marca o início no relógio.
 *   mission só o modo Mission: Start manda 0x01, a janela é de 16 min e, ao fim, manda 0x00.
 */
export type UiVariant = 'full' | 'mission';

export interface UiFeatures {
  variant: UiVariant;
  missionMs: number; // duração da janela da missão
  modeSelect: boolean; // os outros modos (Deploy, Detumbling, Pointing, Off) podem ser enviados
  startCommands: boolean; // Start manda Mission (0x01) e o fim da janela manda 0x00
}

const FEATURES: Record<UiVariant, UiFeatures> = {
  full: { variant: 'full', missionMs: 10 * 60 * 1000, modeSelect: true, startCommands: false },
  mission: { variant: 'mission', missionMs: 16 * 60 * 1000, modeSelect: false, startCommands: true },
};

export function uiFeatures(link: LinkInfo | null): UiFeatures {
  return FEATURES[link?.ui === 'mission' ? 'mission' : 'full'];
}
