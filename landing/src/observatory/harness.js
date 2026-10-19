// Entry for `scripts/dev-instrument.mjs`: boots one instrument on its own
// section, against the live services, so it can be built and looked at
// without the rest of the page. `instrument-under-test` is an esbuild alias
// the dev script points at src/observatory/instruments/<name>.js.

import { createContext } from './context.js';
import * as instrument from 'instrument-under-test';

const ctx = createContext();
ctx.start();
const root = document.querySelector('[data-instrument]');
try {
  instrument.init(root, ctx);
} catch (error) {
  console.error(error);
  const note = document.createElement('p');
  note.className = 'instrument-failed';
  note.textContent = `This instrument could not start: ${error.message}`;
  root.querySelector('.instrument')?.replaceChildren(note);
}
window.__observatory = { ctx, instrument };
