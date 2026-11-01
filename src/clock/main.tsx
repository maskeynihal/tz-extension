import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ClockApp } from './Clock';
import './clock.css';

// The extension page mounts on #root; the website mounts on a host element
// marked data-embed="site" that already sits inside the site's <main>.
const el = document.getElementById('root') ?? document.getElementById('clock-root');
if (el) {
  createRoot(el).render(
    <StrictMode>
      <ClockApp embedded={el.dataset.embed === 'site'} />
    </StrictMode>,
  );
}
