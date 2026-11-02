// Bus times: next departures at a stop, by day of week, past midnight, and the rest of the ride.  Run: node tests/test_buses.mjs
import assert from 'node:assert/strict';

Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US' }, configurable: true });
const { Timetable, nowIn, fmtClock, fmtWait, place } = await import(new URL('../app/js/buses.js', import.meta.url));

// a weekday loop and a Sunday-only trip; campus stop 0 is the feed's stop 1, campus stop 1 is stop 2
const schedule = {
  feeds: [{ agency: 'CUE Bus', url: '', tz: 'America/New_York' }],
  services: [
    { days: '1111100', start: '20230828', end: '20501230', add: [], remove: ['20261126'] },
    { days: '0000001', start: '20230828', end: '20501230', add: [], remove: [] },
  ],
  stops: [['Vienna Metro North Bay C', 38.87, -77.27, -1], ['Rappahannock Ln at Patriot Circle', 38.83, -77.30, 0],
    ['Chain Bridge Rd at School St', 38.84, -77.30, 1], ['Country Creek at Village Spring Lane (EB)', 38.85, -77.29, -1]],
  routes: {
    'Green 1': { name: 'Green 1', colour: '#2ba117', feed: 0, patterns: [{
      stops: [0, 1, 2, 0], via: [0, 1, 1, 1], heads: ['Metro-Mason via Pickett', 'Metro-Mason via Jermantown'],
      trips: [[0, [360, 380, 390, 400]], [0, [420, 440, 450, 460]], [0, [1410, 1430, 1440, 1450]], [1, [600, 620, 630, 640]]],
    }] },
    'Gold 1': { name: 'Gold 1', colour: '#f0da1d', feed: 0, patterns: [{
      stops: [0, 2, 3], via: [0, 0, 0], heads: ['Metro-Mason via Jermantown'], trips: [[0, [500, 520, 540]]],
    }] },
  },
};
const tt = new Timetable(schedule, [{}, {}]);

// time zone: 2026-10-27 23:30 UTC is 19:30 on a Tuesday in Fairfax
assert.deepEqual(nowIn('America/New_York', new Date('2026-10-27T23:30:00Z')), { ymd: '20261027', dow: 1, mins: 1170 });

// Tuesday 6:30 AM at Rappahannock: Green 1 at 6:40 and 7:40, the late trip at 23:50; heading back to Vienna Metro
const tue = { ymd: '20261027', dow: 1, mins: 390 };
let [g] = tt.departures(0, tue);
assert.equal(g.ref, 'Green 1');
assert.deepEqual([g.to, g.via], ['Vienna Metro', 'via Jermantown']);
assert.deepEqual(g.deps.map((d) => d.at), [440, 1430, 1440 + 380, 1440 + 440], 'today, then tomorrow morning');

// at School St (campus stop 1) both lines call; the soonest line comes first; Gold 1 ends at Country Creek
const both = tt.departures(1, tue);
assert.deepEqual(both.map((x) => [x.ref, x.to]), [['Green 1', 'Vienna Metro'], ['Gold 1', 'Country Creek at Village Spring Lane']]);

// a trip running past midnight still shows just after midnight (from yesterday's service)
const wedEarly = { ymd: '20261028', dow: 2, mins: 0 };
assert.equal(tt.departures(1, wedEarly)[0].deps[0].at, 1440 - 1440, '00:00 from the 23:50 trip that started yesterday');

// Thanksgiving (service removed) has no weekday trips; Sunday has only the Sunday one
const thanksgiving = { ymd: '20261126', dow: 3, mins: 0 };
assert.ok(tt.departures(0, thanksgiving, 20).every((x) => x.deps.length === 0) || tt.departures(0, thanksgiving, 20).length === 0);
const sun = { ymd: '20261101', dow: 6, mins: 540 };
assert.deepEqual(tt.departures(0, sun, 12)[0].deps.map((d) => d.at), [620]);

// the rest of the ride, and the service hours at this stop
const ride = tt.ride(g.deps[0]);
assert.deepEqual(ride.map((r) => [r.name, r.at, r.campus]),
  [['Rappahannock Ln at Patriot Circle', 440, true], ['Chain Bridge Rd at School St', 450, true], ['Vienna Metro North Bay C', 460, false]]);
assert.deepEqual(tt.hours(g.deps[0].call).map((h) => [h.days, h.first, h.last, h.every]), [['Weekdays', 380, 1430, 60], ['Sunday', 620, 620, null]]);

// formatting
assert.equal(fmtClock(1170), '7:30 PM');
assert.equal(fmtClock(1440 + 30), '12:30 AM');
assert.deepEqual([fmtWait(395, 390), fmtWait(470, 390), fmtWait(900, 390)], ['5 min', '1 h 20 min', '3:00 PM']);
assert.equal(place('Vienna Metro North Bay C'), 'Vienna Metro');
console.log('buses: ok');
