import type { Category, CurvePoint, DecayConfig, DecayCurve, Task } from '../types';
import { hoursBetween, tryParseIsoLocal } from '../clock';

/** CONTRACT section 4, DECAY_CONFIG seed. */
export const DEFAULT_DECAY_CONFIG: readonly DecayConfig[] = [
  { category: 'class', curve: 'cliff', half_life_hours: 24, floor_weight: 0.2 },
  { category: 'assignment', curve: 'cliff', half_life_hours: 48, floor_weight: 0.1 },
  { category: 'work', curve: 'cliff', half_life_hours: 24, floor_weight: 0.2 },
  { category: 'errand', curve: 'linear', half_life_hours: 72, floor_weight: 0.1 },
  { category: 'meal', curve: 'daily_reset', half_life_hours: 24, floor_weight: 0.3 },
  { category: 'rest', curve: 'rising_floor', half_life_hours: 36, floor_weight: 0.2 },
  { category: 'money', curve: 'cliff', half_life_hours: 24, floor_weight: 0.2 },
  { category: 'social', curve: 'defer_multiplier', half_life_hours: 168, floor_weight: 0.05 },
  { category: 'club', curve: 'defer_multiplier', half_life_hours: 168, floor_weight: 0.05 },
];

/** Hours of postponement sampled for PlanItem.curve. */
export const CURVE_HOURS: readonly number[] = [0, 1, 2, 3, 4, 6, 8, 12, 18, 24, 36, 48];

const FALLBACK: Omit<DecayConfig, 'category'> = { curve: 'linear', half_life_hours: 72, floor_weight: 0.1 };

export function decayFor(category: Category, config: readonly DecayConfig[] = DEFAULT_DECAY_CONFIG): DecayConfig {
  const found = config.find((c) => c.category === category);
  return found ?? { category, ...FALLBACK };
}

type DecayTask = Pick<Task, 'category' | 'due_at' | 'money_at_risk' | 'defer_count' | 'created_at'>;

/** The curve actually used: money at risk with a deadline is always a cliff; a cliff without a deadline is linear. */
export function curveKindFor(task: DecayTask, config: readonly DecayConfig[] = DEFAULT_DECAY_CONFIG): DecayCurve {
  const due = task.due_at ? tryParseIsoLocal(task.due_at) : null;
  if (due && (task.money_at_risk ?? 0) > 0) return 'cliff';
  const kind = decayFor(task.category, config).curve;
  if (kind === 'cliff' && !due) return 'linear';
  return kind;
}

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** Relative cost (0…1) of postponing `task` by `t` hours from `now`. */
export function cost(task: DecayTask, t: number, now: Date, config: readonly DecayConfig[] = DEFAULT_DECAY_CONFIG): number {
  const cfg = decayFor(task.category, config);
  const floor = cfg.floor_weight;
  const halfLife = cfg.half_life_hours > 0 ? cfg.half_life_hours : 1;
  const kind = curveKindFor(task, config);
  const created = tryParseIsoLocal(task.created_at);
  const hoursOpen = created ? Math.max(0, hoursBetween(created, now)) : 0;
  const due = task.due_at ? tryParseIsoLocal(task.due_at) : null;

  switch (kind) {
    case 'cliff': {
      if (!due) return clamp01(floor + t / (2 * halfLife));
      const hoursToDue = hoursBetween(now, due);
      if (hoursToDue <= 0 || t >= hoursToDue) return 1;
      return clamp01(floor + (0.5 - floor) * (t / hoursToDue));
    }
    case 'linear':
      return clamp01(Math.min(1, floor + t / (2 * halfLife)));
    case 'daily_reset':
      return clamp01(floor + (1 - floor) * (((hoursOpen + t) % 24) / 24));
    case 'rising_floor':
      return clamp01(Math.min(1, floor + (hoursOpen + t) / (2 * halfLife)));
    case 'defer_multiplier':
      return clamp01(Math.min(1, (floor + t / (2 * halfLife)) * (1 + 0.5 * task.defer_count)));
  }
}

export function curvePoints(task: DecayTask, now: Date, config: readonly DecayConfig[] = DEFAULT_DECAY_CONFIG): CurvePoint[] {
  return CURVE_HOURS.map((hours) => ({ hours, cost: round4(cost(task, hours, now, config)) }));
}
