import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ClockApp } from './Clock';
import './clock.css';

/**
 * Mount the world clock. The extension page mounts on #root; the website
 * mounts on a host element marked data-embed="site" that already sits inside
 * the site's <main>. Kept apart from the entry points so the website can pick
 * its storage backend before anything renders.
 */
export function mountClock(): void {
  const el = document.getElementById('root') ?? document.getElementById('clock-root');
  if (!el) return;
  createRoot(el).render(
    <StrictMode>
      <ClockApp embedded={el.dataset.embed === 'site'} />
    </StrictMode>,
  );
}
