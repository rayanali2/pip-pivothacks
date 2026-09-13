import type { Plan, PlanDiff, PlanItem, PlanMove, PlanSection } from '../types';
import { dollars, firstClause, plural } from './text';
import { GROCERY_SHARE } from './rules';

interface Located {
  item: PlanItem;
  section: PlanSection;
  index: number;
}

const SECTION_ORDER: Record<PlanSection, number> = { do_now: 0, next: 1, today: 2, can_wait: 3 };

function locate(plan: Plan): Map<string, Located> {
  const out = new Map<string, Located>();
  if (plan.do_now) out.set(plan.do_now.item_id, { item: plan.do_now, section: 'do_now', index: 0 });
  if (plan.next) out.set(plan.next.item_id, { item: plan.next, section: 'next', index: 0 });
  plan.today.forEach((item, index) => {
    if (!out.has(item.item_id)) out.set(item.item_id, { item, section: 'today', index });
  });
  plan.can_wait.forEach((item, index) => {
    if (!out.has(item.item_id)) out.set(item.item_id, { item, section: 'can_wait', index });
  });
  return out;
}

function firstStepOf(plan: Plan, taskId: string | null): number | null {
  if (!taskId) return null;
  return plan.reasoning.pre_rank.find((p) => p.task_id === taskId)?.first_step_minutes ?? null;
}

function moveReason(prev: Plan, next: Plan, from: Located | undefined, to: Located | undefined): string {
  const eff = next.reasoning.effective_minutes;
  if (!to) {
    if (from && from.item.item_id.endsWith('#cont')) return 'No longer split into a later session';
    return 'Done, dropped or expired';
  }
  const item = to.item;
  if (!from) {
    if (item.item_id.endsWith('#cont')) return 'The rest of the work continues after do now';
    return 'New in this plan';
  }
  switch (to.section) {
    case 'do_now':
      return `Best use of the ${eff} min you have now`;
    case 'next':
      return item.kind === 'fixed_block' ? 'Your next fixed block' : `Also fits in the ${eff} min`;
    case 'today': {
      if (item.flag === 'at_risk') {
        const fs = firstStepOf(next, item.task_id);
        return fs !== null ? `Needs ${fs} min but only ${eff} are free` : `Doesn't fit in ${eff} min`;
      }
      if (item.flag === 'balance_guard') return 'Basic need held for today';
      return from.section === 'do_now' ? 'Moved to a later slot today' : 'Scheduled for later today';
    }
    case 'can_wait':
      return prev.reasoning.effective_minutes !== eff ? `Doesn't need the ${eff} min right now` : 'Safe to leave for later';
  }
}

function headline(prev: Plan, next: Plan, moves: PlanMove[]): string {
  const prevDo = prev.do_now;
  const nextDo = next.do_now;
  const effP = prev.reasoning.effective_minutes;
  const effN = next.reasoning.effective_minutes;
  const cashP = prev.reasoning.cash_available;
  const cashN = next.reasoning.cash_available;
  const nextBlockTitle = next.reasoning.free_window?.next_block_title ?? null;

  if (!prevDo && nextDo) return `Do now: "${nextDo.title}".`;
  if (prevDo && !nextDo) return `Nothing fits right now, so "${prevDo.title}" is off do now.`;
  if (!prevDo || !nextDo) {
    const answer = next.reasoning.answer;
    return answer ? `No change: ${firstClause(answer)}.` : 'No change.';
  }

  const changed = prevDo.item_id !== nextDo.item_id;
  if (changed) {
    const prevNow = locate(next).get(prevDo.item_id);
    if (prevNow && prevNow.item.flag === 'at_risk') {
      const fs = firstStepOf(next, prevNow.item.task_id);
      const risk = (prevNow.item.money_at_risk ?? 0) > 0 ? `${dollars(prevNow.item.money_at_risk ?? 0)} at risk` : 'deadline at risk';
      const before = nextBlockTitle ? ` before ${nextBlockTitle}` : '';
      const size = fs !== null ? ` (${fs} min)` : '';
      const lead = effN < effP ? `Only ${effN} min` : `${effN} min`;
      return `${lead}: "${prevDo.title}"${size} won't fit${before} (${risk}), so do now is "${nextDo.title}".`;
    }
    if (effN < effP) return `Only ${effN} min: do now is "${nextDo.title}" instead of "${prevDo.title}".`;
    if (effN > effP) return `${effN} min free: do now is "${nextDo.title}" instead of "${prevDo.title}".`;
    if (cashN !== cashP) {
      return `With ${dollars(cashN)} instead of ${dollars(cashP)}, do now is "${nextDo.title}" instead of "${prevDo.title}".`;
    }
    return `Do now changed: "${prevDo.title}" → "${nextDo.title}".`;
  }

  if (cashN !== cashP) {
    return `With ${dollars(cashN)} instead of ${dollars(cashP)}, groceries are capped at ${dollars(Math.floor(cashN * GROCERY_SHARE))} and do now stays "${nextDo.title}".`;
  }
  if (moves.length === 0) {
    const answer = next.reasoning.answer;
    if (answer) return `No change: ${firstClause(answer)}.`;
    if (effN !== effP) return `${effN} min: do now stays "${nextDo.title}".`;
    return `No change: do now is still "${nextDo.title}".`;
  }
  return `Do now stays "${nextDo.title}"; ${plural(moves.length, 'item')} moved.`;
}

/** What changed between two plans (section moves, not index-only shuffles). */
export function diffPlans(prev: Plan, next: Plan): PlanDiff {
  const a = locate(prev);
  const b = locate(next);
  const ids = new Set<string>([...a.keys(), ...b.keys()]);
  const moves: PlanMove[] = [];
  for (const id of ids) {
    const from = a.get(id);
    const to = b.get(id);
    if (from && to && from.section === to.section) continue;
    moves.push({
      item_id: id,
      title: (to ?? from)?.item.title ?? id,
      from: from ? from.section : null,
      to: to ? to.section : null,
      from_index: from ? from.index : null,
      to_index: to ? to.index : null,
      reason: moveReason(prev, next, from, to),
    });
  }
  moves.sort((x, y) => {
    const sx = x.to ? SECTION_ORDER[x.to] : 9;
    const sy = y.to ? SECTION_ORDER[y.to] : 9;
    if (sx !== sy) return sx - sy;
    return (x.to_index ?? 0) - (y.to_index ?? 0);
  });

  const doNowChanged = (prev.do_now?.item_id ?? null) !== (next.do_now?.item_id ?? null);
  return {
    headline: headline(prev, next, moves),
    do_now_changed: doNowChanged,
    previous_do_now_title: prev.do_now ? prev.do_now.title : null,
    moves,
  };
}
