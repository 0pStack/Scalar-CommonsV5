// Motion, kept in one place so every instrument respects the same two rules:
// nothing moves under `prefers-reduced-motion`, and nothing loops forever —
// every tween runs once and stops.

export function createMotion(win = window) {
  const query = win.matchMedia ? win.matchMedia('(prefers-reduced-motion: reduce)') : null;
  return {
    reduced: () => Boolean(query?.matches),
    onChange(fn) {
      query?.addEventListener('change', () => fn(Boolean(query.matches)));
    },
    /**
     * Calls `frame(t)` with t from 0 to 1 over `ms`, once. Under reduced
     * motion or in a hidden tab it calls `frame(1)` immediately. Returns a
     * cancel function.
     */
    tween(ms, frame, { ease = easeOutCubic, done } = {}) {
      if (this.reduced() || win.document?.hidden || ms <= 0) {
        frame(1);
        done?.();
        return () => {};
      }
      let cancelled = false;
      const began = win.performance.now();
      const step = (now) => {
        if (cancelled) return;
        // The first frame's timestamp can precede the instant the tween began.
        const t = Math.min(1, Math.max(0, (now - began) / ms));
        frame(ease(t));
        if (t < 1) win.requestAnimationFrame(step);
        else done?.();
      };
      win.requestAnimationFrame(step);
      return () => {
        cancelled = true;
      };
    },
  };
}

export const easeOutCubic = (t) => 1 - (1 - t) ** 3;
export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
export const linear = (t) => t;
