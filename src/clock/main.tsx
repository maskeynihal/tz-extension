// Extension entry for the world clock page. Storage is chrome.storage here;
// the website has its own entry (site/clock.ts) that opts in to localStorage.
import { mountClock } from './mount';

mountClock();
