import type { ITheme } from '@xterm/xterm';
import type { ThemeRegistration } from 'shiki';
import {
  DEFAULT_MONO_FONT, DEFAULT_THEME, DEFAULT_UI_FONT, MONO_FONTS, THEMES, UI_FONTS, type FontChoice, type Theme,
} from '../../shared/themes';
import { setCodeTheme } from './highlight';

/** The current choices; read by the terminal and the highlighter when they create things. */
let current = { theme: THEMES[0]!, ui: UI_FONTS[0]!, mono: MONO_FONTS[0]! };

export function currentTheme(): Theme {
  return current.theme;
}

export function monoFamily(): string {
  return current.mono.css;
}

function hex(c: string): [number, number, number] {
  const h = c.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hex(a);
  const [r2, g2, b2] = hex(b);
  const f = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
  return `#${f(r1, r2)}${f(g1, g2)}${f(b1, b2)}`;
}

const channels = (c: string) => hex(c).join(' ');

/** The terminal palette for a theme. The background stays transparent so the window's vibrancy shows through. */
export function xtermThemeFor(t: Theme): ITheme {
  const [black, red, green, yellow, blue, magenta, cyan, white, bBlack, bRed, bGreen, bYellow, bBlue, bMagenta, bCyan, bWhite] = t.ansi;
  const c = t.colors;
  return {
    background: `${c.base}00`, foreground: c.text, cursor: c.text, cursorAccent: c.base,
    selectionBackground: c.iris, selectionForeground: c.base, selectionInactiveBackground: c.hlHigh,
    black, red, green, yellow, blue, magenta, cyan, white,
    brightBlack: bBlack, brightRed: bRed, brightGreen: bGreen, brightYellow: bYellow,
    brightBlue: bBlue, brightMagenta: bMagenta, brightCyan: bCyan, brightWhite: bWhite,
  };
}

/** A Shiki (TextMate) theme from a palette's code colours, for themes without a bundled one. */
export function shikiThemeFor(t: Theme): ThemeRegistration | string {
  if (t.shiki || !t.syntax) return t.shiki ?? 'rose-pine-moon';
  const s = t.syntax;
  const rule = (scope: string[], foreground: string, fontStyle?: string) => ({ scope, settings: { foreground, ...(fontStyle ? { fontStyle } : {}) } });
  return {
    name: `jarvis-${t.id}`,
    type: t.kind,
    colors: { 'editor.background': t.colors.base, 'editor.foreground': s.variable },
    tokenColors: [
      rule(['comment', 'punctuation.definition.comment', 'string.comment'], s.comment, 'italic'),
      rule(['keyword', 'storage', 'storage.type', 'storage.modifier', 'keyword.control', 'keyword.operator.new', 'keyword.operator.expression', 'variable.language'], s.keyword),
      rule(['string', 'string.quoted', 'string.template', 'string.regexp', 'punctuation.definition.string'], s.string),
      rule(['entity.name.function', 'support.function', 'meta.function-call entity.name.function', 'variable.function'], s.function),
      rule(['constant.numeric', 'constant.language', 'constant.character', 'constant.other', 'support.constant'], s.number),
      rule(['entity.name.type', 'entity.name.class', 'support.type', 'support.class', 'entity.other.inherited-class', 'storage.type.primitive'], s.type),
      rule(['variable', 'variable.other', 'variable.parameter', 'meta.definition.variable'], s.variable),
      rule(['variable.other.property', 'variable.other.object.property', 'meta.object-literal.key', 'support.type.property-name', 'entity.name.tag.yaml'], s.property),
      rule(['punctuation', 'meta.brace', 'keyword.operator', 'punctuation.separator', 'punctuation.terminator'], s.punctuation),
      rule(['entity.name.tag', 'meta.tag.sgml', 'punctuation.definition.tag'], s.tag),
      rule(['entity.other.attribute-name'], s.attribute),
      rule(['markup.heading', 'entity.name.section'], s.keyword, 'bold'),
      rule(['markup.bold'], s.variable, 'bold'),
      rule(['markup.italic'], s.variable, 'italic'),
      rule(['markup.inline.raw', 'markup.raw'], s.string),
      rule(['markup.inserted'], t.colors.pine),
      rule(['markup.deleted'], t.colors.love),
      rule(['markup.changed'], t.colors.gold),
    ],
  };
}

/** Is a locally installed font family present? Compares text widths against the generic fallbacks. */
export function fontInstalled(family: string): boolean {
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return true;
  const sample = 'mmmmmmmmmmlliWW@#0123456789';
  return ['monospace', 'serif', 'sans-serif'].some((generic) => {
    ctx.font = `72px ${generic}`;
    const base = ctx.measureText(sample).width;
    ctx.font = `72px '${family}', ${generic}`;
    return ctx.measureText(sample).width !== base;
  });
}

export function missingFonts(): string[] {
  return [...UI_FONTS, ...MONO_FONTS].filter((f: FontChoice) => f.probe && !fontInstalled(f.probe)).map((f) => f.id);
}

/**
 * Apply a theme and fonts: CSS tokens for the app, the macOS chrome (via main), every open terminal, and the
 * code highlighter. Returns the ids actually applied (unknown ids fall back to the defaults).
 */
export function applyAppearance(themeId: string, uiFontId: string, monoFontId: string): { theme: string; uiFont: string; monoFont: string } {
  const theme = THEMES.find((t) => t.id === themeId) ?? THEMES.find((t) => t.id === DEFAULT_THEME)!;
  const ui = UI_FONTS.find((f) => f.id === uiFontId) ?? UI_FONTS.find((f) => f.id === DEFAULT_UI_FONT)!;
  const mono = MONO_FONTS.find((f) => f.id === monoFontId) ?? MONO_FONTS.find((f) => f.id === DEFAULT_MONO_FONT)!;
  current = { theme, ui, mono };

  const c = theme.colors;
  const dark = theme.kind === 'dark';
  const vars: Record<string, string> = {
    base: c.base, surface: c.surface, overlay: c.overlay, muted: c.muted, subtle: c.subtle, text: c.text,
    love: c.love, gold: c.gold, rose: c.rose, pine: c.pine, foam: c.foam, iris: c.iris,
    'hl-low': c.hlLow, 'hl-med': c.hlMed, 'hl-high': c.hlHigh,
    'text-strong': mix(c.text, dark ? '#ffffff' : '#000000', dark ? 0.45 : 0.35),
    'text-soft': mix(c.text, c.base, 0.12),
    'code-bg': mix(c.base, dark ? '#000000' : '#000000', dark ? 0.22 : 0.035),
    'diff-add': mix(c.foam, c.text, 0.3),
    'diff-del': mix(c.love, c.text, 0.3),
    'text-rgb': channels(c.text), 'iris-rgb': channels(c.iris), 'gold-rgb': channels(c.gold), 'foam-rgb': channels(c.foam),
    'base-rgb': channels(c.base), 'love-rgb': channels(c.love), 'pine-rgb': channels(c.pine),
    'shade-rgb': channels(mix(c.base, '#000000', dark ? 0.4 : 0.08)),
    'ui-font': ui.css,
    mono: mono.css,
  };
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(`--${k}`, v);
  root.style.setProperty('color-scheme', theme.kind);
  root.dataset.theme = theme.id;
  setCodeTheme(shikiThemeFor(theme));
  return { theme: theme.id, uiFont: ui.id, monoFont: mono.id };
}
