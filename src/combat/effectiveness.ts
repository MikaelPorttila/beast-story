import type { ElementType } from '../core/types';

// 10-type chart: STRONG = 2x, WEAK = 0.5x, otherwise 1x.
const STRONG: Record<ElementType, readonly ElementType[]> = {
  fire: ['grass', 'ice'],
  water: ['fire', 'rock'],
  grass: ['water', 'rock'],
  electric: ['water', 'wind'],
  ice: ['grass', 'dragon'],
  rock: ['fire', 'electric'],
  wind: ['grass', 'shadow'],
  shadow: ['light', 'dragon'],
  light: ['shadow', 'dragon'],
  dragon: ['fire', 'water'],
};

const WEAK: Record<ElementType, readonly ElementType[]> = {
  fire: ['water', 'rock'],
  water: ['grass', 'electric'],
  grass: ['fire', 'wind'],
  electric: ['rock', 'grass'],
  ice: ['fire', 'rock'],
  rock: ['water', 'grass'],
  wind: ['electric', 'ice'],
  shadow: ['shadow', 'wind'],
  light: ['light', 'rock'],
  dragon: ['ice', 'light'],
};

export function elementMultiplier(attacker?: ElementType, defender?: ElementType): number {
  if (!attacker || !defender) return 1;
  if (STRONG[attacker].includes(defender)) return 2;
  if (WEAK[attacker].includes(defender)) return 0.5;
  return 1;
}
