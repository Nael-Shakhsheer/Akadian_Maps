// Distances in the units people expect: feet/miles in the US (and a few others), metres elsewhere.
const IMPERIAL_REGIONS = new Set(['US', 'LR', 'MM']);

function region() {
  try {
    return new Intl.Locale(navigator.language).maximize().region || '';
  } catch {
    return (navigator.language || '').split('-')[1]?.toUpperCase() || '';
  }
}

export const IMPERIAL = IMPERIAL_REGIONS.has(region());

/** "350 ft", "0.3 mi", "40 m", "1.2 km" — rounded to what's useful for walking. */
export function fmtDist(m) {
  if (IMPERIAL) {
    const ft = m * 3.28084;
    if (ft < 1000) return `${Math.max(10, Math.round(ft / (ft < 300 ? 10 : 50)) * (ft < 300 ? 10 : 50))} ft`;
    return `${(m / 1609.34).toFixed(m < 16093 ? 1 : 0)} mi`;
  }
  if (m < 1000) return `${Math.max(5, Math.round(m / (m < 50 ? 5 : 10)) * (m < 50 ? 5 : 10))} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

/** Heights: "~50 ft" / "~15 m". */
export function fmtHeight(m) {
  return IMPERIAL ? `~${Math.round((m * 3.28084) / 5) * 5} ft` : `~${Math.round(m)} m`;
}

/** Walking time at ~1.3 m/s, never "0 min". */
export function walkMins(m) {
  return Math.max(1, Math.round(m / 1.3 / 60));
}
