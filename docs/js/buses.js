// Bus timetables: the next departures at a stop and where each bus goes from there.
// From the published schedule (campus.transit.schedule, built by engine/pipeline/schedule.py), so it works offline,
// but it's the timetable, not live positions. Times are wall-clock minutes in the feed's time zone.
const DAY = 1440;
const DAY_NAMES = { '1111100': 'Weekdays', '0000010': 'Saturday', '0000001': 'Sunday', '1111111': 'Every day', '0000011': 'Weekends' };

/** Today in the given time zone: { ymd: 'YYYYMMDD', dow: 0 (Mon) .. 6 (Sun), mins }. */
export function nowIn(tz, at = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(at).map((x) => [x.type, x.value]));
  return { ymd: `${p.year}${p.month}${p.day}`, dow: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday), mins: +p.hour * 60 + +p.minute };
}

function shift({ ymd, dow }, days) {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6) + days));
  return { ymd: d.toISOString().slice(0, 10).replaceAll('-', ''), dow: (dow + days % 7 + 7) % 7 };
}

/** "7:42 PM" (or "19:42", following the device's locale). */
export function fmtClock(mins) {
  const m = ((mins % DAY) + DAY) % DAY;
  return new Intl.DateTimeFormat(navigator.language, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })
    .format(Date.UTC(2000, 0, 1, Math.floor(m / 60), m % 60));
}

// "Vienna Metro North Bay C" -> "Vienna Metro", "Country Creek at Village Spring Lane (EB)" -> "Country Creek at Village Spring Lane"
export const place = (name) => name.replace(/\s*\((NB|SB|EB|WB)\)$/i, '').replace(/\s+(North|South|East|West)?\s*Bay\s+\w+$/i, '').trim();

export class Timetable {
  constructor(schedule, stops) {
    this.s = schedule;
    this.campusStops = stops;
    this.tz = schedule.feeds[0]?.tz || 'America/New_York';
  }

  runs(svc, day) {
    const s = this.s.services[svc];
    if (s.remove.includes(day.ymd)) return false;
    if (s.add.includes(day.ymd)) return true;
    return s.days[day.dow] === '1' && (!s.start || s.start <= day.ymd) && (!s.end || day.ymd <= s.end);
  }

  // every place a route's patterns call at this campus stop (a loop can pass the same stop twice); not the last stop
  calls(stopIndex) {
    const out = [];
    for (const [ref, route] of Object.entries(this.s.routes)) {
      route.patterns.forEach((pat, pi) => pat.stops.forEach((si, pos) => {
        if (this.s.stops[si][3] === stopIndex && pos < pat.stops.length - 1) out.push({ ref, route, pat, pi, pos });
      }));
    }
    return out;
  }

  /** Where a bus at this point of its pattern is heading: the next Metro station, else the end of the line. */
  toward(pat, pos) {
    const names = pat.stops.slice(pos + 1).map((si) => this.s.stops[si][0]);
    const metro = names.find((n) => /\bmetro\b/i.test(n));
    const via = (pat.heads[pat.via[pos]] || '').match(/\bvia (.+)$/i)?.[1];
    return { to: place(metro || names[names.length - 1] || ''), via: via ? `via ${via}` : '' };
  }

  /** Departures from a campus stop in the next `hours`, grouped by line and direction, soonest group first.
   *  Each departure: { at (minutes from today's midnight), call, trip }. */
  departures(stopIndex, now = nowIn(this.tz), hours = 30) {
    const groups = new Map();
    for (const call of this.calls(stopIndex)) {
      const { to, via } = this.toward(call.pat, call.pos);
      const key = `${call.ref}|${to}|${via}`;
      if (!groups.has(key)) groups.set(key, { key, ref: call.ref, route: call.route, to, via, deps: [] });
      for (const off of [-1, 0, 1, 2]) { // yesterday's trips that run past midnight, through the day after tomorrow
        const day = shift(now, off);
        call.pat.trips.forEach(([svc, mins], ti) => {
          if (!this.runs(svc, day)) return;
          const at = mins[call.pos] + off * DAY;
          if (at >= now.mins && at <= now.mins + hours * 60) groups.get(key).deps.push({ at, call, trip: ti });
        });
      }
    }
    const out = [...groups.values()].filter((g) => g.deps.length);
    for (const g of out) g.deps.sort((a, b) => a.at - b.at);
    return out.sort((a, b) => a.deps[0].at - b.deps[0].at);
  }

  /** The rest of one trip from this stop: [{ name, at, campus }] (at: minutes from that day's midnight). */
  ride({ call, trip, at }) {
    const mins = call.pat.trips[trip][1];
    const shiftBy = at - mins[call.pos];
    return call.pat.stops.slice(call.pos).map((si, i) => {
      const [name, , , ci] = this.s.stops[si];
      return { name, at: mins[call.pos + i] + shiftBy, campus: ci >= 0 };
    });
  }

  /** Service at this point of a line, per day type: [{ days: 'Weekdays', first, last, every }]. */
  hours(call) {
    const by = new Map();
    for (const [svc, mins] of call.pat.trips) {
      const t = mins[call.pos];
      (by.get(svc) || by.set(svc, []).get(svc)).push(t);
    }
    return [...by.entries()].map(([svc, ts]) => {
      ts.sort((a, b) => a - b);
      const gaps = ts.slice(1).map((t, i) => t - ts[i]).sort((a, b) => a - b);
      const s = this.s.services[svc];
      return { order: s.days.indexOf('1'), days: DAY_NAMES[s.days] || s.days, first: ts[0], last: ts[ts.length - 1],
        every: gaps.length ? gaps[Math.floor((gaps.length - 1) / 2)] : null };
    }).sort((a, b) => a.order - b.order);
  }
}

/** "now", "4 min", "1 h 5 min", or the clock time for later. */
export function fmtWait(at, nowMins) {
  const m = at - nowMins;
  if (m <= 0) return 'now';
  if (m < 60) return `${m} min`;
  if (m < 120) return `1 h ${m - 60} min`;
  return fmtClock(at);
}
