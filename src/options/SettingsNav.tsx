import { useEffect, useLayoutEffect, useRef, type MouseEvent } from 'react';

export interface NavSection {
  readonly id: string;
  readonly label: string;
}

/**
 * Sticky section tabs for the settings page. Each tab is a real link to its
 * section (`#general` …), so middle-click, copy-link and no-JS all work.
 */
export function SettingsNav({
  sections,
  active,
  onNavigate,
}: {
  readonly sections: readonly NavSection[];
  readonly active: string;
  readonly onNavigate: (id: string) => void;
}): JSX.Element {
  const scrollerRef = useRef<HTMLUListElement>(null);

  // At narrow widths the tabs scroll sideways: keep the active one in view.
  // Only the tab strip scrolls, never the page (that would fight the page's
  // own smooth scroll).
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const link = scroller?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!scroller || !link || scroller.scrollWidth <= scroller.clientWidth) return;
    const left = link.offsetLeft - scroller.offsetLeft;
    const right = left + link.offsetWidth;
    if (left < scroller.scrollLeft) scroller.scrollLeft = left - 8;
    else if (right > scroller.scrollLeft + scroller.clientWidth) scroller.scrollLeft = right - scroller.clientWidth + 8;
  }, [active]);

  function onClick(e: MouseEvent<HTMLAnchorElement>, id: string): void {
    // Let modified clicks (new tab, new window) behave like normal links.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onNavigate(id);
  }

  return (
    <nav className="tzx-snav" aria-label="Settings sections">
      <ul className="tzx-snav-list" ref={scrollerRef}>
        {sections.map((s) => (
          <li key={s.id}>
            <a
              href={`#${s.id}`}
              className="tzx-snav-link"
              aria-current={active === s.id ? 'true' : undefined}
              onClick={(e) => onClick(e, s.id)}
            >
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * Scrollspy: report the first section crossing a band just below the sticky
 * bar. Without IntersectionObserver (old engines, jsdom) it does nothing and
 * the active tab simply follows clicks and deep links.
 *
 * Returns `pause(ms)`, used while a tab click smooth-scrolls past other
 * sections so the active tab does not flicker through them.
 */
export function useScrollSpy(
  ids: readonly string[],
  topInset: number,
  onActive: (id: string) => void,
  enabled: boolean,
): (ms: number) => void {
  const pausedUntil = useRef(0);
  const cb = useRef(onActive);
  cb.current = onActive;
  const idKey = ids.join(' ');

  useEffect(() => {
    if (!enabled || typeof IntersectionObserver !== 'function') return;
    const order = idKey.split(' ');
    const visible = new Set<string>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target.id);
          else visible.delete(e.target.id);
        }
        if (Date.now() < pausedUntil.current) return;
        const first = order.find((id) => visible.has(id));
        if (first) cb.current(first);
      },
      { rootMargin: `-${Math.round(topInset) + 1}px 0px -55% 0px`, threshold: 0 },
    );
    for (const id of order) {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    }
    const resume = (): void => {
      pausedUntil.current = 0;
    };
    window.addEventListener('scrollend', resume);
    return () => {
      io.disconnect();
      window.removeEventListener('scrollend', resume);
    };
  }, [idKey, topInset, enabled]);

  return (ms: number) => {
    pausedUntil.current = Date.now() + ms;
  };
}
