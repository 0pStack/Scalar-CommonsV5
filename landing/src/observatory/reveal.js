// The scroll reveal: each section below the first screen fades in and rises
// 12 px once, as it enters the viewport. CSS does the moving (a 400 ms
// transition on opacity and transform); this module only says when, with the
// browser's IntersectionObserver — no animation library.
//
// A section is hidden by the stylesheet only while <html> carries
// `reveal-ready`, and only this module sets that class, so a page whose
// script never runs, a browser without IntersectionObserver, and a reader who
// asks for reduced motion all see every section, always. Each section is
// revealed once and then no longer watched; nothing loops.

/** A section starts its reveal when it is this far into the viewport. */
export const REVEAL_MARGIN = '0px 0px -8% 0px';

/**
 * Starts the reveal over `targets`. Returns `{ stop }`, which shows every
 * section and stands the reveal down (used when reduced motion is turned on
 * mid-visit), or null when nothing is hidden at all.
 */
export function start({ targets, html, IntersectionObserver: IO, reduced }) {
  if (!IO || reduced() || targets.length === 0) return null;
  const observer = new IO(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-in');
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: REVEAL_MARGIN, threshold: 0 },
  );
  html.classList.add('reveal-ready');
  for (const target of targets) observer.observe(target);
  return {
    stop() {
      observer.disconnect();
      for (const target of targets) target.classList.add('is-in');
      html.classList.remove('reveal-ready');
    },
  };
}
