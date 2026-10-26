import { describe, expect, it } from 'vitest';
import { suggestFunnels } from '../src/dashboard/lib/funnelSuggest';

const rows = (...r: [string, number][]) => r.map(([label, visitors]) => ({ label, visitors }));

describe('starter funnels', () => {
  it('picks pricing, the checkout goal and payment for a hextaui-like site', () => {
    const pages = rows(['/', 900], ['/docs/components/button', 400], ['/blocks', 300], ['/pricing', 120]);
    const goals = rows(['pro_link_clicked', 200], ['sign_in_started', 80], ['checkout_started', 30], ['purchase_completed', 8]);
    expect(suggestFunnels(pages, goals)).toEqual([
      { name: 'Pricing to payment', steps: [{ type: 'page', value: '/pricing' }, { type: 'goal', value: 'checkout_started' }, { type: 'payment', value: '' }] },
      {
        name: 'Homepage to payment',
        steps: [{ type: 'page', value: '/' }, { type: 'page', value: '/pricing' }, { type: 'goal', value: 'checkout_started' }, { type: 'payment', value: '' }],
      },
    ]);
  });

  it('falls back to the top page and most common goal', () => {
    const s = suggestFunnels(rows(['/', 10], ['/about', 5]), rows(['newsletter', 3], ['contact', 1]));
    expect(s[0].steps).toEqual([{ type: 'page', value: '/about' }, { type: 'goal', value: 'newsletter' }, { type: 'payment', value: '' }]);
    expect(s).toHaveLength(2);
  });

  it('returns nothing without data and never a one-step funnel', () => {
    expect(suggestFunnels([], [])).toEqual([]);
    expect(suggestFunnels(rows(['/', 3]), []).map((s) => s.steps.length)).toEqual([2]);
  });
});
