export function computeStats(comps=[]) {
  const sold = comps.filter(c => c.sold_price && c.sqft);
  const soldPrices = sold.map(c => c.sold_price).sort((a,b)=>a-b);
  const avgSold = soldPrices.length ? Math.round(soldPrices.reduce((a,b)=>a+b,0)/soldPrices.length) : null;
  const ppsf = sold.map(c => c.sold_price/(c.sqft||1)).filter(Boolean);
  const avgPpsf = ppsf.length ? Math.round(ppsf.reduce((a,b)=>a+b,0)/ppsf.length) : null;
  const doms = comps.map(c => c.dom).filter(Boolean);
  const avgDom = doms.length ? Math.round(doms.reduce((a,b)=>a+b,0)/doms.length) : null;
  const median = soldPrices.length ? soldPrices[Math.floor(soldPrices.length/2)] : null;
  return {
    avgSoldPrice: avgSold,
    avgPricePerSqft: avgPpsf,
    avgDOM: avgDom,
    suggestedListLow: median ? Math.round(median*0.95):null,
    suggestedListHigh: median ? Math.round(median*1.08):null
  };
}
