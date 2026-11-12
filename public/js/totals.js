// Calcul des totaux, identique à celui du serveur (src/business.js) :
// l'écran, le document imprimé, la liste et la comptabilité affichent exactement le même montant.
// Arrondi au centime « demi-centime vers le haut » (2,125 → 2,13), TVA arrondie par taux.
export const round2 = (n) => {
  const x = Number(n) || 0;
  return (Math.sign(x) * Math.round(Math.abs(x) * 100 * (1 + 1e-12))) / 100 || 0;
};
export const lineTotal = (l) => (l.kind === 'text' ? 0 : round2((Number(l.quantity) || 0) * (Number(l.unit_price) || 0) * (1 - (Number(l.discount) || 0) / 100)));
export function computeTotals(lines) {
  const byRate = {};
  let sub = 0;
  for (const l of lines || []) {
    if (l.kind === 'text') continue;
    const t = lineTotal(l);
    sub += t;
    const rate = Number(l.tax_rate) || 0;
    byRate[rate] = (byRate[rate] || 0) + t;
  }
  const taxes = Object.entries(byRate).map(([rate, base]) => ({ rate: Number(rate), base: round2(base), amount: round2((round2(base) * Number(rate)) / 100) }));
  const tax = round2(taxes.reduce((a, t) => a + t.amount, 0));
  sub = round2(sub);
  return { sub, taxes, tax, total: round2(sub + tax) };
}
