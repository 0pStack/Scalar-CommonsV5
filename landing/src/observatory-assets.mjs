// Assets shared by the site build and the instrument dev harness: the
// self-hosted fonts /observatory declares, and the stylesheet assembled from
// the design system plus each instrument's own rules. Kept in its own module
// so the harness can use the same list without running the site build.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const FONTS = [
  // Display and figures: Source Serif 4, variable with its optical-size axis
  // (headings and figures are set at opsz 60), latin subset.
  ['@fontsource-variable/source-serif-4/files/source-serif-4-latin-opsz-normal.woff2', 'source-serif-4-latin-opsz-normal.woff2'],
  // Interface and body: Inter, variable weight, latin subset.
  ['@fontsource-variable/inter/files/inter-latin-wght-normal.woff2', 'inter-latin-wght-normal.woff2'],
  // Mono is sources, hashes, addresses and the river's axis only, at one weight.
  ['@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2', 'jetbrains-mono-latin-400-normal.woff2'],
];

/**
 * observatory.css as shipped: the design system (src/observatory.css) followed
 * by every src/observatory/instruments/*.css in name order. An instrument's
 * rules live beside its script and may only use the tokens the design system
 * defines; they never redefine `:root`.
 */
export function observatoryCss() {
  const base = readFileSync(fileURLToPath(new URL('./observatory.css', import.meta.url)), 'utf8');
  const dir = new URL('./observatory/instruments/', import.meta.url);
  const parts = readdirSync(fileURLToPath(dir))
    .filter((name) => name.endsWith('.css'))
    .sort()
    .map((name) => `\n/* ── instruments/${name} ── */\n${readFileSync(fileURLToPath(new URL(name, dir)), 'utf8')}`);
  return base + parts.join('');
}
