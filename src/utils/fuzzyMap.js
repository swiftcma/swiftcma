const synonyms = {
  address: ['property address','street address','address','addr'],
  list_price: ['list price','listprice','asking price'],
  sold_price: ['sold price','sale price','closed price','price sold'],
  beds: ['bedrooms','beds','br'],
  baths: ['bathrooms','baths','ba','bath'],
  sqft: ['sqft','living area','square feet','square footage'],
  dom: ['dom','cdom','days on market'],
  status: ['status','sale status'],
  photo_url: ['photo url','primary photo'],
  year_built: ['year built','yr built'],
  lot_sqft: ['lot sqft','lot size'],
  distance_mi: ['distance','mi']
};

function norm(s='') { return s.toLowerCase().replace(/[^a-z0-9]+/g,''); }

export function suggestMapping(headers=[]) {
  const map = {};
  headers.forEach(h => {
    const nh = norm(h);
    let best = null;
    for (const [key, syns] of Object.entries(synonyms)) {
      if (syns.some(s => nh.includes(norm(s)))) { best = key; break; }
    }
    map[h] = best || null;
  });
  return map;
}

function toNumber(v) {
  if (v == null) return null;
  const s = v.toString().replace(/[\$,]/g,'');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

export function normalizeRow(row, map) {
  const out = {};
  for (const [hdr, key] of Object.entries(map)) {
    if (!key) continue;
    let val = row[hdr];
    if (['list_price','sold_price','sqft','beds','baths','dom','year_built','lot_sqft','distance_mi'].includes(key)) {
      val = toNumber(val);
    }
    out[key] = val ?? null;
  }
  return out;
}
