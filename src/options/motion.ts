/** Motion helpers shared by the settings page. Every call is safe in jsdom. */

/** Duration and easing of list and tab animations. */
export const MOTION_MS = 180;
export const MOTION_EASE = 'cubic-bezier(0.2, 0, 0, 1)';

/** True when the user asked the OS for less motion. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Run a Web Animation unless motion is reduced or the engine has no
 * `Element.animate`. Returns null when nothing was animated.
 */
export function animate(
  el: Element,
  keyframes: Keyframe[],
  options: KeyframeAnimationOptions = {},
): Animation | null {
  if (typeof el.animate !== 'function' || prefersReducedMotion()) return null;
  return el.animate(keyframes, { duration: MOTION_MS, easing: MOTION_EASE, ...options });
}

/** Stop every running animation on an element (no-op where unsupported). */
export function cancelAnimations(el: Element): void {
  if (typeof el.getAnimations !== 'function') return;
  for (const a of el.getAnimations()) a.cancel();
}

/** Call `fn` once the animation ends (finished or cancelled), or now when there is none. */
export function afterAnimation(anim: Animation | null, fn: () => void): void {
  if (!anim) {
    fn();
    return;
  }
  let done = false;
  const once = (): void => {
    if (done) return;
    done = true;
    fn();
  };
  anim.addEventListener('finish', once);
  anim.addEventListener('cancel', once);
}
