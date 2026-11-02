import { describe, it, expect, afterEach } from 'vitest';
import { describeWallClock } from '../src/lib/wall-note';
import { viewInZone } from '../src/lib/tz';
import { wallFieldsToInstant } from '../src/lib/wallclock';

const originalTz = process.env.TZ;
afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe('DST note wording', () => {
  it('names the written time, the day, the place and the time shown', () => {
    const gap = wallFieldsToInstant({ y: 2024, mo: 3, d: 10, h: 2, mi: 30, s: 0 }, 'America/New_York');
    expect(describeWallClock('gap', gap!.epochMs, 'America/New_York', false)).toBe(
      "02:30 doesn't exist on 10 Mar in New York (clocks jump forward); shown as 03:30.",
    );
    const twice = wallFieldsToInstant({ y: 2024, mo: 10, d: 27, h: 1, mi: 30, s: 0 }, 'Europe/London');
    expect(describeWallClock('ambiguous', twice!.epochMs, 'Europe/London', false)).toBe(
      '01:30 happens twice on 27 Oct in London; showing the first (BST).',
    );
  });

  it('says which day it is shown on when the jump crosses midnight (Samoa, 30 Dec 2011)', () => {
    const gap = wallFieldsToInstant({ y: 2011, mo: 12, d: 30, h: 0, mi: 0, s: 0 }, 'Pacific/Apia');
    expect(gap?.wallClock).toBe('gap');
    expect(describeWallClock('gap', gap!.epochMs, 'Pacific/Apia', false)).toBe(
      "00:00 doesn't exist on 30 Dec in Apia (clocks jump forward); shown as 00:00 on 31 Dec.",
    );
  });
});

describe('formatting does not depend on the host timezone', () => {
  // Node re-reads TZ when it changes, so Date's local getters follow it.
  it.each(['America/New_York', 'Europe/London', 'Australia/Sydney', 'UTC'])('host in %s', (host) => {
    process.env.TZ = host;
    // 02:30 UTC on 10 Mar 2024 is inside New York's gap; 01:30 UTC on 31 Mar inside London's.
    expect(viewInZone(Date.UTC(2024, 2, 10, 2, 30), 'UTC', false).time).toBe('02:30:00');
    expect(viewInZone(Date.UTC(2024, 2, 31, 1, 30), 'UTC', false).time).toBe('01:30:00');
    expect(viewInZone(Date.UTC(2024, 2, 9, 17, 30), 'Asia/Tokyo', false).dateTime).toBe('2024-03-10 02:30:00');
    const gap = wallFieldsToInstant({ y: 2024, mo: 3, d: 10, h: 2, mi: 30, s: 0 }, 'America/New_York');
    expect(describeWallClock('gap', gap!.epochMs, 'America/New_York', true)).toBe(
      "2:30 AM doesn't exist on 10 Mar in New York (clocks jump forward); shown as 3:30 AM.",
    );
  });

  it('keeps every field of viewInZone right', () => {
    process.env.TZ = 'America/New_York';
    const v = viewInZone(Date.UTC(2024, 6, 1, 3, 4, 5), 'Asia/Kathmandu', true);
    expect(v).toMatchObject({
      date: '2024-07-01',
      time: '8:49:05 AM',
      dateTime: '2024-07-01 8:49:05 AM',
      offset: '+05:45',
      weekday: 'Mon',
    });
    expect(viewInZone(Date.UTC(2024, 6, 1, 12), 'Europe/Paris', false).abbrev).toBe('CEST');
    expect(viewInZone(Date.UTC(2024, 0, 1, 12), 'America/New_York', false).abbrev).toBe('EST');
    expect(viewInZone(Date.UTC(2024, 0, 1, 12), 'Australia/Sydney', false).abbrev).toBe('AEDT');
    // Round 4: Intl's "GMT+5:45" gives way to the project's own NPT; a zone
    // with no entry (Kabul) keeps Intl's offset form.
    expect(viewInZone(Date.UTC(2024, 0, 1, 12), 'Asia/Kathmandu', false).abbrev).toBe('NPT');
    expect(viewInZone(Date.UTC(2024, 0, 1, 12), 'Asia/Kabul', false).abbrev).toBe('GMT+4:30');
    expect(viewInZone(Date.UTC(2024, 0, 1, 0), 'UTC-08:00', true).time).toBe('4:00:00 PM');
    expect(viewInZone(Date.UTC(2024, 0, 1, 12), 'UTC', true).time).toBe('12:00:00 PM');
    expect(viewInZone(Date.UTC(2024, 0, 1, 0), 'UTC', true).time).toBe('12:00:00 AM');
  });
});
