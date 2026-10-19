// Presenter mode, for a room: the P key or the small "Present" button in the
// status bar turns it on and off, in place — /observatory is the only URL, so
// nothing about it is in the address. The page keeps every instrument live
// and shows one screen at a time, each filling the viewport: the first screen
// (the hero) and then the six sections in order, advancing every ADVANCE_MS
// or on the arrow keys; space pauses the advance; P or Escape leaves. The
// nav, the provenance lines and the footer are hidden by the stylesheet
// (`html[data-present]`); the status bar stays, since it is the one line a
// room needs to see. Nothing here fetches.
//
// The timer is one timeout re-armed after each advance, cleared while the tab
// is hidden, so a projector left on a hidden tab does nothing until it is
// shown again.

export const ADVANCE_MS = 20_000;

/** The next index after a navigation key, or null when the key is not one. Pure; tested. */
export function stepFor(key, index, count) {
  if (count === 0) return null;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
    case 'PageDown':
    case 'Enter':
      return (index + 1) % count;
    case 'ArrowLeft':
    case 'ArrowUp':
    case 'PageUp':
      return (index - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/**
 * What a key asks for. Off presenter mode only P is ours (`{ enter }`), so
 * the arrows still scroll the page. On it: `{ go }` to a screen, `{ pause }`
 * (space), `{ exit }` (P or Escape); null when the key is not ours. Pure; tested.
 */
export function keyAction(key, index, count, presenting) {
  const p = key === 'p' || key === 'P';
  if (!presenting) return p ? { enter: true } : null;
  if (p || key === 'Escape') return { exit: true };
  if (key === ' ') return { pause: true };
  const go = stepFor(key, index, count);
  return go === null ? null : { go };
}

/** Keys typed into a field are text, never commands. */
function typing(target) {
  const tag = target?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || Boolean(target?.isContentEditable);
}

export function init(doc, ctx, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const html = doc.documentElement;
  const button = doc.querySelector('.sb-present');
  const screens = [...doc.querySelectorAll('[data-present-screen]')];
  if (screens.length === 0) return null;

  let presenting = false;
  let index = 0;
  let timer = null;
  let paused = false;
  let counter = null;

  function disarm() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function arm() {
    disarm();
    if (!presenting || doc.hidden || paused) return;
    timer = setTimer(() => show((index + 1) % screens.length), ADVANCE_MS);
  }

  function count() {
    if (counter) counter.textContent = `${index + 1} / ${screens.length}${paused ? ' · paused' : ''}`;
  }

  function show(next) {
    index = next;
    screens.forEach((screen, k) => {
      const active = k === index;
      screen.toggleAttribute('data-present-active', active);
      screen.setAttribute('aria-hidden', active ? 'false' : 'true');
      if (active) screen.scrollTop = 0;
    });
    count();
    ctx?.announce?.(`Showing ${screens[index].querySelector('h2, h1')?.textContent ?? ''}`);
    arm();
  }

  function reflect() {
    button?.setAttribute('aria-pressed', presenting ? 'true' : 'false');
  }

  function enter() {
    presenting = true;
    paused = false;
    html.setAttribute('data-present', '');
    counter = doc.createElement('p');
    counter.className = 'present-counter';
    counter.setAttribute('aria-live', 'off');
    doc.body.append(counter);
    reflect();
    show(0);
  }

  /** Leaves in place: the ordinary page returns where it was, nothing reloads. */
  function exit() {
    presenting = false;
    disarm();
    for (const screen of screens) {
      screen.removeAttribute('data-present-active');
      screen.removeAttribute('aria-hidden');
    }
    html.removeAttribute('data-present');
    counter?.remove();
    counter = null;
    reflect();
    ctx?.announce?.('Presenter mode off');
  }

  function pause() {
    paused = !paused;
    count();
    ctx?.announce?.(paused ? 'Paused' : 'Advancing');
    arm();
  }

  function onKey(event) {
    if (event.altKey || event.ctrlKey || event.metaKey || typing(event.target)) return;
    const action = keyAction(event.key, index, screens.length, presenting);
    if (action === null) return;
    event.preventDefault();
    if (action.enter) enter();
    else if (action.exit) exit();
    else if (action.pause) pause();
    else show(action.go);
  }

  doc.addEventListener('keydown', onKey);
  button?.addEventListener('click', () => (presenting ? exit() : enter()));
  doc.addEventListener('visibilitychange', () => (doc.hidden ? disarm() : arm()));
  reflect();

  return {
    enter,
    exit,
    show,
    pause,
    next: () => show((index + 1) % screens.length),
    current: () => index,
    paused: () => paused,
    presenting: () => presenting,
  };
}
