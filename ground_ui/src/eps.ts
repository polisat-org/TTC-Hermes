import type { Telemetry } from './types';

/**
 * Carga das baterias a partir do MP2733 e do MAX17048 (os INA3221 estão ligados errados na placa).
 * Escalas do datasheet do MP2733 (Rev. 1.1), registradores de 1 byte:
 *   REG0Ch bits 4-3 CHG_STAT · REG0Fh VSYS 20 mV · REG11h VIN 60 mV · REG12h ICHG 17,5 mA · REG13h IIN 13,3 mA
 * CRATE do MAX17048: 0,208 %/h por LSB (positivo = carregando).
 */
export type ChargeState = 'not charging' | 'trickle' | 'constant current' | 'done';
const CHG: ChargeState[] = ['not charging', 'trickle', 'constant current', 'done'];

export interface Charger {
  state: ChargeState;
  charging: boolean;
  vinV: number; // entrada do carregador (painel ou fonte)
  ichgMa: number; // corrente de carga
  iinMa: number; // corrente de entrada
  vsysV: number;
  crate: number; // %/h
  fault: number; // REG0Dh cru
}

export function charger(tm: Telemetry, n: 1 | 2): Charger {
  const st = n === 1 ? tm.status_carregador_1 : tm.status_carregador_2;
  const state = CHG[(st >> 3) & 3];
  return {
    state,
    charging: state === 'trickle' || state === 'constant current',
    vinV: n === 1 ? tm.tensao_painel_solar_1 : tm.tensao_painel_solar_2,
    ichgMa: (n === 1 ? tm.adc_corrente_carga_1 : tm.adc_corrente_carga_2) * 17.5,
    iinMa: (n === 1 ? tm.adc_corrente_sistema_1 : tm.adc_corrente_sistema_2) * 13.3,
    vsysV: (n === 1 ? tm.adc_tensao_sistema_1 : tm.adc_tensao_sistema_2) * 0.02,
    crate: (n === 1 ? tm.taxa_carga_descarga_bateria_1 : tm.taxa_carga_descarga_bateria_2) * 0.208,
    fault: n === 1 ? tm.falha_carregador_1 : tm.falha_carregador_2,
  };
}

export const OBC_MODES = ['IDLE', 'MISSION', 'DETUMBLING', 'POINTING'];
export const TC_RESULT = ['executed', 'rejected (invalid)', 'ignored (deploy in progress)'];
