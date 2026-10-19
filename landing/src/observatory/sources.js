// The Sources switch. Every figure on the page carries its provenance line
// (the endpoint, the UTC time, a link to the raw bytes), hidden until asked
// for: the switch in the status bar shows every one in place, and hovering
// a figure, or focusing its link from the keyboard, shows that figure's line
// as a tooltip while the switch is off. On a touch screen the switch is the
// way in — a tap on a figure follows its link to the raw bytes.
// Nothing about what is fetched changes: the lines are filled exactly as
// before, by `readout.provenance`, and only their visibility is a preference.
//
// The choice is kept in localStorage under SOURCES_PREF_KEY, and the page's
// head reads it before the first paint (observatory.mjs, SOURCES_BOOT) so a
// reader who asked for sources never sees them blink in. A storage that
// cannot be read or written (private mode, a full quota) is an off switch
// that forgets: the page works, the preference just does not persist.

export const SOURCES_PREF_KEY = 'observatory:sources';
const ATTRIBUTE = 'data-sources';

/** Whether the reader asked for sources last time; false when there is no answer. Pure; tested. */
export function readSourcesPreference(storage) {
  try {
    return storage?.getItem?.(SOURCES_PREF_KEY) === '1';
  } catch {
    return false;
  }
}

/** Remembers the choice; off is the absence of the key, as a fresh browser is. Never throws. */
export function writeSourcesPreference(storage, on) {
  try {
    if (on) storage.setItem(SOURCES_PREF_KEY, '1');
    else storage.removeItem(SOURCES_PREF_KEY);
  } catch {
    // Nothing to do: the page still shows what was asked for, this once.
  }
}

/** Wires the switch in the status bar to the attribute on <html> and the store. */
export function init(doc, ctx) {
  const html = doc.documentElement;
  const button = doc.querySelector('.sb-sources');
  if (!button) return null;
  const storage = doc.defaultView?.localStorage ?? null;
  const reflect = () => button.setAttribute('aria-checked', html.hasAttribute(ATTRIBUTE) ? 'true' : 'false');
  reflect();
  button.addEventListener('click', () => {
    const on = !html.hasAttribute(ATTRIBUTE);
    html.toggleAttribute(ATTRIBUTE, on);
    writeSourcesPreference(storage, on);
    reflect();
    ctx?.announce?.(on ? 'Sources shown under every figure' : 'Sources hidden; hover a figure, or focus it, for its source');
  });
  return { on: () => html.hasAttribute(ATTRIBUTE) };
}
