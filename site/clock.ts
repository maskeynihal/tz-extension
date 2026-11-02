// Website entry for the world clock (clock.html). Same React app as the
// extension page; the only difference is that settings live in this site's
// localStorage, which the website has to opt in to explicitly.
import { enableWebStorageBackend } from '../src/lib/storage';
import { mountClock } from '../src/clock/mount';

enableWebStorageBackend();
mountClock();
