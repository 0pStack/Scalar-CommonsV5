// Renders the landing page from chain facts + content. Pure: no I/O, no clock,
// no network — everything the page says is a function of chain-facts.json and
// src/content.mjs, which is what makes the honesty tests meaningful.

const groups = new Intl.NumberFormat('en-US');

/** Every `{{token}}` in a string, filters included. */
export function placeholdersIn(str) {
  return [...String(str).matchAll(/\{\{([^}]+)\}\}/g)].map((m) => m[1].trim());
}

/** Plancks → token units, grouped; exact by default, truncated to whole units when asked. */
function formatTokens(plancks, decimals, { truncate = false } = {}) {
  const scale = 10n ** BigInt(decimals);
  const value = BigInt(plancks);
  const whole = groups.format(value / scale);
  if (truncate) return whole;
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction.length > 0 ? `${whole}.${fraction}` : whole;
}

/** Basis points → percent, e.g. 25 → "0.25%", 3,000 → "30%". Bps are the chain's unit; percent is the reader's. */
function formatPercent(bps) {
  const percent = Number(bps) / 100;
  return `${Number(percent.toFixed(4))}%`;
}

/** Blocks → a human duration, derived from the chain's own expected block time. */
function formatBlocks(blocks, facts) {
  const blockMs = BigInt(facts.constants.babe.expectedBlockTime);
  const seconds = (BigInt(blocks) * blockMs) / 1000n;
  const units = [
    ['day', 86400n],
    ['hour', 3600n],
    ['minute', 60n],
    ['second', 1n],
  ];
  for (const [name, size] of units) {
    if (seconds >= size) {
      const whole = seconds / size;
      const remainder = seconds % size;
      const label = `${groups.format(whole)} ${name}${whole === 1n ? '' : 's'}`;
      return remainder === 0n ? label : `over ${label}`;
    }
  }
  return `${groups.format(seconds)} seconds`;
}

const FILTERS = {
  cmn: (value, facts) => formatTokens(value, facts.token.decimals),
  cmnFloor: (value, facts) => formatTokens(value, facts.token.decimals, { truncate: true }),
  pct: (value) => formatPercent(value),
  commas: (value) => groups.format(BigInt(value)),
  blocks: (value, facts) => formatBlocks(value, facts),
  secs: (value) => groups.format(BigInt(value) / 1000n),
  short: (value) => `${String(value).slice(0, 10)}…${String(value).slice(-6)}`,
};

/**
 * Resolves `path.to.fact|filter` against the facts object. Returns `undefined`
 * for anything the facts do not contain, which the test suite treats as a
 * failure — an unresolvable placeholder means the page wanted to claim
 * something the chain never told us.
 */
export function resolve(facts, token) {
  const [path, ...filters] = String(token)
    .split('|')
    .map((part) => part.trim());
  let value = path.split('.').reduce((acc, key) => (acc === null || acc === undefined ? acc : acc[key]), facts);
  if (value === undefined || value === null) return undefined;
  for (const name of filters) {
    const filter = FILTERS[name];
    if (!filter) throw new Error(`unknown filter "${name}" in placeholder {{${token}}}`);
    value = filter(value, facts);
  }
  return value;
}

/**
 * Every reader-visible string in the content tree, tagged with where it came
 * from. Identifiers (`key`, `id`, `status`, `chainRefs`) and URLs are excluded:
 * they are checked structurally instead, so a GitHub issue number in a URL is
 * not mistaken for an unsourced chain figure.
 */
export function proseOf(content) {
  const skip = new Set(['key', 'id', 'status', 'url', 'chainRefs']);
  const out = [];
  const walk = (node, path) => {
    if (typeof node === 'string') {
      out.push([path, node]);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (skip.has(key)) continue;
        walk(value, path ? `${path}.${key}` : key);
      }
    }
  };
  walk(content, '');
  return out;
}

export const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Fills placeholders and escapes the result — content is data, never markup. */
function fill(str, facts) {
  return escapeHtml(str).replace(/\{\{([^}]+)\}\}/g, (_, token) => {
    const value = resolve(facts, token.trim());
    if (value === undefined) throw new Error(`unresolved placeholder {{${token.trim()}}} — not in chain-facts.json`);
    return escapeHtml(value);
  });
}

function renderChainRefs(refs) {
  if (!refs?.length) return '';
  const chips = refs.map((ref) => `<code>${escapeHtml(ref)}</code>`).join('');
  return `<p class="refs" aria-label="extrinsics">${chips}</p>`;
}

function renderBullet(bullet, facts) {
  const lead = bullet.lead ? `<strong>${fill(bullet.lead, facts)}</strong> ` : '';
  return `      <li>
        <p>${lead}${fill(bullet.text, facts)}</p>
${renderChainRefs(bullet.chainRefs)
  .split('\n')
  .map((line) => (line ? `        ${line}` : ''))
  .join('\n')}
      </li>`;
}

function renderCaveat(caveat, facts) {
  return `      <p class="caveat" data-caveat="${escapeHtml(caveat.key)}"><span>Caveat</span> ${fill(
    caveat.text,
    facts,
  )}</p>`;
}

function renderSection(section, facts) {
  const intro = section.intro ? `      <p class="intro">${fill(section.intro, facts)}</p>\n` : '';
  const bullets = (section.bullets ?? []).map((b) => renderBullet(b, facts)).join('\n');
  const caveats = (section.caveats ?? []).map((c) => renderCaveat(c, facts)).join('\n');
  return `    <section id="${escapeHtml(section.id)}">
      <h2>${fill(section.heading, facts)}</h2>
${intro}${bullets ? `      <ul class="claims">\n${bullets}\n      </ul>\n` : ''}${caveats ? `${caveats}\n` : ''}    </section>`;
}

function renderLinks(links, facts) {
  const cards = links
    .map((link) => {
      const badge =
        link.status === 'planned' ? '<span class="badge planned">Planned</span>' : '<span class="badge">Live</span>';
      return `        <li data-link="${escapeHtml(link.key)}" data-status="${escapeHtml(link.status)}">
          <a href="${escapeHtml(link.url)}">${fill(link.label, facts)}</a>${badge}
          <p>${fill(link.note, facts)}</p>
        </li>`;
    })
    .join('\n');
  return `    <section id="links">
      <h2>Where to go next</h2>
      <ul class="links">
${cards}
      </ul>
    </section>`;
}

function renderVerification(verification, sourceClaims, facts) {
  const rows = sourceClaims
    .map(
      (claim) => `          <tr>
            <td>${escapeHtml(claim.claim)}</td>
            <td><code>${escapeHtml(claim.file)}</code><br><code class="snippet">${escapeHtml(claim.snippet)}</code></td>
          </tr>`,
    )
    .join('\n');
  return `    <section id="verification">
      <h2>${fill(verification.heading, facts)}</h2>
      <p class="intro">${fill(verification.intro, facts)}</p>
      <table>
        <thead><tr><th>Claim</th><th>Where it lives in the runtime</th></tr></thead>
        <tbody>
${rows}
        </tbody>
      </table>
    </section>`;
}

// The site nav. Hrefs are relative so the same build works at the domain root
// (nginx serves /observatory from observatory.html via `try_files $uri.html`)
// and under a GitHub Pages project path.
const NAV = [
  { key: 'overview', label: 'Overview', href: './' },
  { key: 'observatory', label: 'Observatory', href: 'observatory' },
  { key: 'docs', label: 'Docs', href: 'https://scalarnet.io/docs/' },
];

/** The site nav, with `current` marked for assistive tech and styling. */
export function renderNav(current, extra = []) {
  const items = [...NAV, ...extra].map(
    (item) =>
      `<li><a href="${escapeHtml(item.href)}"${item.key === current ? ' aria-current="page"' : ''}>${escapeHtml(item.label)}</a></li>`,
  ).join('');
  return `    <nav class="site-nav" aria-label="Site"><ul>${items}</ul></nav>`;
}

/** The whole page, as a string. Throws rather than emit a page with an unresolved claim. */
export function renderPage({ facts, content, sourceClaims }) {
  const badges = content.hero.badges
    .map(
      (badge) =>
        `        <li><span class="badge-label">${fill(badge.label, facts)}</span><span class="badge-value">${fill(
          badge.value,
          facts,
        )}</span></li>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${fill(content.meta.title, facts)}</title>
<meta name="description" content="${fill(content.meta.description, facts)}">
<link rel="stylesheet" href="styles.css">
</head>
<body>
<header>
${renderNav('overview')}
  <p class="wordmark">${fill(content.meta.siteName, facts)}</p>
  <h1>${fill(content.hero.title, facts)}</h1>
  <p class="tagline">${fill(content.hero.tagline, facts)}</p>
  <p class="lede">${fill(content.hero.lede, facts)}</p>
  <ul class="badges">
${badges}
  </ul>
</header>
<main>
${content.sections.map((section) => renderSection(section, facts)).join('\n')}
${renderLinks(content.links, facts)}
${renderVerification(content.verification, sourceClaims, facts)}
</main>
<footer>
  <p>${fill(content.footer.text, facts)}</p>
  <p class="provenance">${fill(content.footer.provenance, facts)}</p>
</footer>
</body>
</html>
`;
}
