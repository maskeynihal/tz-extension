import { formatCalendarDate, type NumericDateOrder, type ParsedTime } from '../src/types';

/**
 * The date one reading of an ambiguous numeric date stands for, as written in
 * the source ("4 Mar 2024" day first, "Mar 4, 2024" month first). Built from
 * the calendar fields the parser read, never from the instant, so the source
 * zone (often just a label like "PDT") can't shift or break it.
 */
export function readingLabel(p: ParsedTime, order: NumericDateOrder): string | null {
  const d = p.dateOrder;
  if (!d) return null;
  return formatCalendarDate(order === d.order ? d.date : d.alternate.date, order);
}
