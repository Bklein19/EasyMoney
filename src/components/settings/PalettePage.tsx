import { useEffect, useRef, useState } from 'react';
import './PalettePage.css';

interface Token { name: string; value: string; group: string; effect: boolean }

export function paletteGroup(name: string): string {
  if (/^--(chart-|tooltip-|series-|account-series-|data-)/.test(name)) return 'Data visualization';
  if (name.startsWith('--bg-')) return 'Surfaces';
  if (name.startsWith('--text-')) return 'Text';
  if (/^--(action-|color-accent|color-link)/.test(name)) return 'Interaction';
  if (name.startsWith('--color-')) return 'Status';
  if (name.startsWith('--cat-')) return 'Categories';
  if (name.startsWith('--shadow-')) return 'Shadows';
  return 'Borders, overlays & focus';
}

// Read the loaded stylesheet declarations rather than maintaining a second palette.
function tokenNames(): string[] {
  const names = new Set<string>();
  const visit = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        for (const name of Array.from(rule.style)) if (name.startsWith('--')) names.add(name);
      }
      if ('cssRules' in rule) visit((rule as CSSGroupingRule).cssRules);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try { visit(sheet.cssRules); } catch { /* Cross-origin font stylesheets are not readable. */ }
  }
  return [...names].sort();
}

export default function PalettePage() {
  const probe = useRef<HTMLDivElement>(null);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [theme, setTheme] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const refresh = () => {
      const root = getComputedStyle(document.documentElement);
      const chart = probe.current ? getComputedStyle(probe.current) : root;
      setTheme(media.matches ? 'Light' : 'Dark');
      setTokens(tokenNames().flatMap(name => {
        const group = paletteGroup(name);
        const value = (group === 'Data visualization' ? chart : root).getPropertyValue(name).trim();
        const effect = name.startsWith('--shadow-');
        return value && (effect || CSS.supports('color', value)) ? [{ name, value, group, effect }] : [];
      }));
    };
    refresh();
    media.addEventListener('change', refresh);
    const observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    return () => { media.removeEventListener('change', refresh); observer.disconnect(); };
  }, []);
  const visible = tokens.filter(token => `${token.name} ${token.value} ${token.group}`.toLowerCase().includes(search.toLowerCase()));
  const groups = [...new Set(visible.map(token => token.group))];
  return <div className="palette-page">
    <header><p className="palette-eyebrow">Developer tools</p><h1>Color palette</h1>
      <p>{theme} system theme · {tokens.length} color and shadow tokens · Live computed values</p>
    </header>
    <div ref={probe} className="page-networth palette-probe" aria-hidden="true" />
    <aside className="palette-note">UI roles and data visualization have independent palettes. These are live token values; saved category colors are user data and can differ. Chart aliases share a small base palette.</aside>
    <input className="palette-search" type="search" aria-label="Filter palette tokens" placeholder="Find a token, color, or group…" value={search} onChange={event => setSearch(event.target.value)} />
    {!visible.length && <p>No matching tokens.</p>}
    {groups.map(group => <section key={group} aria-label={group}><h2>{group}</h2><div className="palette-grid">
      {visible.filter(token => token.group === group).map(token => <article className="palette-card" key={token.name}>
        <div className="palette-swatch-base"><div className="palette-swatch" style={token.effect ? { boxShadow: `var(${token.name})`, background: 'var(--bg-elevated)' } : { background: token.value }} /></div>
        <div className="palette-token"><code>{token.name}</code><span>{token.value}</span></div>
      </article>)}
    </div></section>)}
  </div>;
}
