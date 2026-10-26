export type StepType = 'page' | 'goal' | 'payment';
export interface FunnelStepDef {
  type: StepType;
  value: string;
}
export interface FunnelSuggestion {
  name: string;
  steps: FunnelStepDef[];
}

type Row = { label: string | null; visitors: number };

const INTENT_PAGE = [/^\/pricing\/?$/i, /pricing/i, /^\/(plans|pro|upgrade|buy|checkout)\b/i];
const INTENT_GOAL = [/checkout/i, /sign_?up|register/i, /trial/i];

function pick<T extends Row>(rows: T[], patterns: RegExp[]) {
  for (const re of patterns) {
    const hit = rows.find((r) => re.test(r.label ?? ''));
    if (hit) return hit;
  }
  return null;
}

export function suggestFunnels(pages: Row[], goals: Row[]): FunnelSuggestion[] {
  const ps = pages.filter((r) => r.label && r.visitors > 0).sort((a, b) => b.visitors - a.visitors);
  const gs = goals.filter((r) => r.label && r.visitors > 0).sort((a, b) => b.visitors - a.visitors);
  if (!ps.length && !gs.length) return [];
  const home = ps.find((r) => r.label === '/') ?? null;
  const rest = ps.filter((r) => r !== home);
  const mid = pick(rest, INTENT_PAGE) ?? rest[0] ?? null;
  const goal = pick(gs, INTENT_GOAL) ?? gs[0] ?? null;
  const payment: FunnelStepDef = { type: 'payment', value: '' };
  const page = (r: Row | null): FunnelStepDef[] => (r ? [{ type: 'page', value: r.label! }] : []);
  const goalStep: FunnelStepDef[] = goal ? [{ type: 'goal', value: goal.label! }] : [];

  const out: FunnelSuggestion[] = [];
  const add = (name: string, steps: FunnelStepDef[]) => {
    const key = JSON.stringify(steps);
    if (steps.length >= 2 && !out.some((s) => JSON.stringify(s.steps) === key)) out.push({ name, steps });
  };
  const midName = mid?.label && /pric/i.test(mid.label) ? 'Pricing' : mid?.label ?? 'Homepage';
  add(`${midName} to payment`, [...page(mid ?? home), ...goalStep, payment]);
  if (home) add('Homepage to payment', [...page(home), ...page(mid), ...goalStep, payment]);
  return out.slice(0, 2);
}
