/**
 * Colour themes and font choices (View → Theme, View → Interface Font, View → Terminal Font). Shared by the
 * main process (menus, macOS light/dark chrome) and the renderer (CSS tokens, xterm, Shiki).
 *
 * Each theme fills the app's palette roles, which follow Rosé Pine's names: base (background), surface (panels),
 * overlay, muted, subtle, text, love (errors), gold (warnings), rose (accent), pine (primary/ok), foam
 * (links/info), iris (selection/active). The terminal gets the theme's own 16 ANSI colours, and code is
 * highlighted with the matching Shiki theme.
 */

export interface ThemeColors {
  base: string; surface: string; overlay: string; muted: string; subtle: string; text: string;
  love: string; gold: string; rose: string; pine: string; foam: string; iris: string;
  hlLow: string; hlMed: string; hlHigh: string;
}

/** black, red, green, yellow, blue, magenta, cyan, white, then the bright eight. */
export type Ansi16 = [string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string];

/** Code colours for themes that bring their own syntax theme (Jarvis originals); Shiki gets one built from these. */
export interface SyntaxColors {
  comment: string; keyword: string; string: string; function: string; number: string; type: string;
  variable: string; property: string; punctuation: string; tag: string; attribute: string;
}

export interface Theme {
  id: string;
  label: string;
  kind: 'dark' | 'light';
  /** Jarvis originals are listed first in View → Theme. */
  original?: boolean;
  /** A bundled Shiki theme for code blocks, the file viewer and diffs... */
  shiki?: string;
  /** ...or code colours to build one from. */
  syntax?: SyntaxColors;
  colors: ThemeColors;
  ansi: Ansi16;
}

export const THEMES: Theme[] = [
  // ---- Jarvis originals: palettes designed as a set, each with its own code colours ----
  {
    id: 'graphite', label: 'Graphite', kind: 'dark', original: true,
    colors: { base: '#1c1c1e', surface: '#232326', overlay: '#2e2e32', muted: '#6b6b70', subtle: '#9a9a9f', text: '#e8e6df', love: '#ff453a', gold: '#ff9f0a', rose: '#ffb340', pine: '#7ad3a8', foam: '#64d2ff', iris: '#ffd60a', hlLow: '#232326', hlMed: '#3a3a3f', hlHigh: '#4a4a50' },
    ansi: ['#2e2e32', '#ff453a', '#7ad3a8', '#ffd60a', '#64d2ff', '#d4a5ff', '#66d4cf', '#e8e6df', '#6b6b70', '#ff6961', '#a0e4c3', '#ffe55c', '#8fdfff', '#e2c2ff', '#8fe3de', '#ffffff'],
    syntax: { comment: '#6b6b70', keyword: '#ffd60a', string: '#a0e4c3', function: '#f7f5ee', number: '#ff9f0a', type: '#64d2ff', variable: '#e8e6df', property: '#cfcdc6', punctuation: '#8e8e93', tag: '#ff9f0a', attribute: '#ffd60a' },
  },
  {
    id: 'night-city', label: 'Night City', kind: 'dark', original: true,
    colors: { base: '#0b0b14', surface: '#11111c', overlay: '#1b1b2b', muted: '#56608a', subtle: '#8a95bf', text: '#e8f1ff', love: '#ff2a6d', gold: '#f9f871', rose: '#ff6ac1', pine: '#3bf5a6', foam: '#05d9e8', iris: '#ff2a6d', hlLow: '#11111c', hlMed: '#262640', hlHigh: '#34345a' },
    ansi: ['#1b1b2b', '#ff2a6d', '#3bf5a6', '#f9f871', '#05d9e8', '#d300c5', '#3df5ff', '#c8d3f5', '#56608a', '#ff6c95', '#7dffcf', '#ffffa8', '#6cecf5', '#ff4fe1', '#9ffcff', '#ffffff'],
    syntax: { comment: '#56608a', keyword: '#ff2a6d', string: '#f9f871', function: '#05d9e8', number: '#ff6ac1', type: '#3bf5a6', variable: '#e8f1ff', property: '#9ffcff', punctuation: '#8a95bf', tag: '#ff2a6d', attribute: '#ff6ac1' },
  },
  {
    id: 'sunset-drive', label: 'Sunset Drive', kind: 'dark', original: true,
    colors: { base: '#1a1028', surface: '#21142f', overlay: '#2e1c42', muted: '#74609a', subtle: '#a99ac6', text: '#f5e9ff', love: '#ff4f8b', gold: '#ffb347', rose: '#ff8b39', pine: '#72f1b8', foam: '#36f9f6', iris: '#ff7edb', hlLow: '#21142f', hlMed: '#3b2756', hlHigh: '#4d3570' },
    ansi: ['#2e1c42', '#ff4f8b', '#72f1b8', '#fede5d', '#36f9f6', '#ff7edb', '#03edf9', '#f5e9ff', '#74609a', '#ff7aa8', '#a0ffd5', '#fff08a', '#7cfffc', '#ffa8ea', '#6ff7ff', '#ffffff'],
    syntax: { comment: '#74609a', keyword: '#fede5d', string: '#ff8b39', function: '#36f9f6', number: '#f97e72', type: '#72f1b8', variable: '#f5e9ff', property: '#ff7edb', punctuation: '#a99ac6', tag: '#ff4f8b', attribute: '#fede5d' },
  },
  {
    id: 'phosphor', label: 'Phosphor', kind: 'dark', original: true,
    colors: { base: '#120d07', surface: '#18110a', overlay: '#241a0f', muted: '#7a6038', subtle: '#b08a52', text: '#ffc355', love: '#ff6b3d', gold: '#ffd27a', rose: '#ff8c42', pine: '#ffb000', foam: '#ffd27a', iris: '#ffb000', hlLow: '#18110a', hlMed: '#3a2a16', hlHigh: '#4d3820' },
    ansi: ['#241a0f', '#ff6b3d', '#ffc355', '#ffd27a', '#e09b3d', '#ff8c42', '#ffcf8a', '#ffc355', '#7a6038', '#ff8c66', '#ffd27a', '#ffe2a8', '#ffb000', '#ffa366', '#ffe0b0', '#fff1d6'],
    syntax: { comment: '#7a6038', keyword: '#ffe2a8', string: '#e09b3d', function: '#fff1d6', number: '#ff8c42', type: '#ffcf8a', variable: '#ffc355', property: '#ffd27a', punctuation: '#b08a52', tag: '#ff8c42', attribute: '#ffd27a' },
  },
  {
    id: 'matcha', label: 'Matcha', kind: 'dark', original: true,
    colors: { base: '#161c17', surface: '#1b231d', overlay: '#253027', muted: '#647364', subtle: '#9aa99a', text: '#e8e3d3', love: '#e57a6e', gold: '#e3c78a', rose: '#d8a47f', pine: '#9ccf7a', foam: '#8fc9b9', iris: '#9ccf7a', hlLow: '#1b231d', hlMed: '#2e3a30', hlHigh: '#3c4a3e' },
    ansi: ['#253027', '#e57a6e', '#9ccf7a', '#e3c78a', '#7fb3c9', '#c79ad1', '#8fc9b9', '#e8e3d3', '#647364', '#f09a90', '#b9e39b', '#f0dcaa', '#a0cce0', '#dcb8e3', '#b0e0d2', '#f7f3e8'],
    syntax: { comment: '#647364', keyword: '#9ccf7a', string: '#e3c78a', function: '#8fc9b9', number: '#d8a47f', type: '#7fb3c9', variable: '#e8e3d3', property: '#c9d8b8', punctuation: '#9aa99a', tag: '#e57a6e', attribute: '#e3c78a' },
  },
  {
    id: 'oxblood', label: 'Oxblood & Cream', kind: 'light', original: true,
    colors: { base: '#f4ecdf', surface: '#efe5d6', overlay: '#e5d9c5', muted: '#a09080', subtle: '#6f5f52', text: '#2b211d', love: '#c0262d', gold: '#a8650f', rose: '#c2410c', pine: '#3f6b4f', foam: '#285e74', iris: '#8c1c13', hlLow: '#efe5d6', hlMed: '#dccfb9', hlHigh: '#cbbca4' },
    ansi: ['#2b211d', '#a61b1b', '#3f6b4f', '#a8650f', '#285e74', '#8c1c13', '#3b7a78', '#d8cbb6', '#6f5f52', '#c0262d', '#55876a', '#c47d1e', '#3a7a94', '#a8324a', '#4d9a97', '#f4ecdf'],
    syntax: { comment: '#a09080', keyword: '#8c1c13', string: '#3f6b4f', function: '#2b211d', number: '#c2410c', type: '#285e74', variable: '#2b211d', property: '#5c3a2e', punctuation: '#6f5f52', tag: '#a61b1b', attribute: '#a8650f' },
  },
  // ---- classics ----
  {
    id: 'rose-pine-moon', label: 'Rosé Pine Moon', kind: 'dark', shiki: 'rose-pine-moon',
    colors: { base: '#232136', surface: '#2a273f', overlay: '#393552', muted: '#6e6a86', subtle: '#908caa', text: '#e0def4', love: '#eb6f92', gold: '#f6c177', rose: '#ea9a97', pine: '#3e8fb0', foam: '#9ccfd8', iris: '#c4a7e7', hlLow: '#2a283e', hlMed: '#44415a', hlHigh: '#56526e' },
    ansi: ['#393552', '#eb6f92', '#3e8fb0', '#f6c177', '#9ccfd8', '#c4a7e7', '#ea9a97', '#e0def4', '#6e6a86', '#eb6f92', '#3e8fb0', '#f6c177', '#9ccfd8', '#c4a7e7', '#ea9a97', '#e0def4'],
  },
  {
    id: 'rose-pine', label: 'Rosé Pine', kind: 'dark', shiki: 'rose-pine',
    colors: { base: '#191724', surface: '#1f1d2e', overlay: '#26233a', muted: '#6e6a86', subtle: '#908caa', text: '#e0def4', love: '#eb6f92', gold: '#f6c177', rose: '#ebbcba', pine: '#31748f', foam: '#9ccfd8', iris: '#c4a7e7', hlLow: '#21202e', hlMed: '#403d52', hlHigh: '#524f67' },
    ansi: ['#26233a', '#eb6f92', '#31748f', '#f6c177', '#9ccfd8', '#c4a7e7', '#ebbcba', '#e0def4', '#6e6a86', '#eb6f92', '#31748f', '#f6c177', '#9ccfd8', '#c4a7e7', '#ebbcba', '#e0def4'],
  },
  {
    id: 'catppuccin-mocha', label: 'Catppuccin Mocha', kind: 'dark', shiki: 'catppuccin-mocha',
    colors: { base: '#1e1e2e', surface: '#252536', overlay: '#313244', muted: '#6c7086', subtle: '#9399b2', text: '#cdd6f4', love: '#f38ba8', gold: '#f9e2af', rose: '#fab387', pine: '#89b4fa', foam: '#94e2d5', iris: '#cba6f7', hlLow: '#232334', hlMed: '#45475a', hlHigh: '#585b70' },
    ansi: ['#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#bac2de', '#585b70', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8'],
  },
  {
    id: 'tokyo-night', label: 'Tokyo Night', kind: 'dark', shiki: 'tokyo-night',
    colors: { base: '#1a1b26', surface: '#1f2335', overlay: '#292e42', muted: '#565f89', subtle: '#737aa2', text: '#c0caf5', love: '#f7768e', gold: '#e0af68', rose: '#ff9e64', pine: '#7aa2f7', foam: '#7dcfff', iris: '#bb9af7', hlLow: '#1f2335', hlMed: '#3b4261', hlHigh: '#545c7e' },
    ansi: ['#15161e', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6', '#414868', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#c0caf5'],
  },
  {
    id: 'dracula', label: 'Dracula', kind: 'dark', shiki: 'dracula',
    colors: { base: '#282a36', surface: '#2e303e', overlay: '#44475a', muted: '#6272a4', subtle: '#9ea8c7', text: '#f8f8f2', love: '#ff5555', gold: '#f1fa8c', rose: '#ff79c6', pine: '#50fa7b', foam: '#8be9fd', iris: '#bd93f9', hlLow: '#2e303e', hlMed: '#44475a', hlHigh: '#565970' },
    ansi: ['#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2', '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff'],
  },
  {
    id: 'nord', label: 'Nord', kind: 'dark', shiki: 'nord',
    colors: { base: '#2e3440', surface: '#323846', overlay: '#434c5e', muted: '#616e88', subtle: '#9aa3b5', text: '#d8dee9', love: '#bf616a', gold: '#ebcb8b', rose: '#d08770', pine: '#81a1c1', foam: '#88c0d0', iris: '#b48ead', hlLow: '#323846', hlMed: '#434c5e', hlHigh: '#4c566a' },
    ansi: ['#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0', '#4c566a', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4'],
  },
  {
    id: 'gruvbox', label: 'Gruvbox', kind: 'dark', shiki: 'gruvbox-dark-medium',
    colors: { base: '#282828', surface: '#32302f', overlay: '#3c3836', muted: '#7c6f64', subtle: '#a89984', text: '#ebdbb2', love: '#fb4934', gold: '#fabd2f', rose: '#fe8019', pine: '#83a598', foam: '#8ec07c', iris: '#d3869b', hlLow: '#32302f', hlMed: '#504945', hlHigh: '#665c54' },
    ansi: ['#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984', '#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2'],
  },
  {
    id: 'kanagawa', label: 'Kanagawa', kind: 'dark', shiki: 'kanagawa-wave',
    colors: { base: '#1f1f28', surface: '#2a2a37', overlay: '#363646', muted: '#727169', subtle: '#a6a69c', text: '#dcd7ba', love: '#e46876', gold: '#e6c384', rose: '#ffa066', pine: '#7e9cd8', foam: '#7fb4ca', iris: '#957fb8', hlLow: '#2a2a37', hlMed: '#363646', hlHigh: '#54546d' },
    ansi: ['#16161d', '#c34043', '#76946a', '#c0a36e', '#7e9cd8', '#957fb8', '#6a9589', '#c8c093', '#727169', '#e82424', '#98bb6c', '#e6c384', '#7fb4ca', '#938aa9', '#7aa89f', '#dcd7ba'],
  },
  {
    id: 'one-dark', label: 'One Dark', kind: 'dark', shiki: 'one-dark-pro',
    colors: { base: '#282c34', surface: '#2c313a', overlay: '#3e4451', muted: '#5c6370', subtle: '#8b929e', text: '#abb2bf', love: '#e06c75', gold: '#e5c07b', rose: '#d19a66', pine: '#61afef', foam: '#56b6c2', iris: '#c678dd', hlLow: '#2c313a', hlMed: '#3e4451', hlHigh: '#4b5263' },
    ansi: ['#282c34', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#abb2bf', '#5c6370', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#ffffff'],
  },
  {
    id: 'github-dark', label: 'GitHub Dark', kind: 'dark', shiki: 'github-dark-default',
    colors: { base: '#0d1117', surface: '#151b23', overlay: '#212830', muted: '#6e7681', subtle: '#9198a1', text: '#e6edf3', love: '#ff7b72', gold: '#d29922', rose: '#ffa657', pine: '#58a6ff', foam: '#79c0ff', iris: '#d2a8ff', hlLow: '#151b23', hlMed: '#30363d', hlHigh: '#3d444d' },
    ansi: ['#484f58', '#ff7b72', '#3fb950', '#d29922', '#58a6ff', '#bc8cff', '#39c5cf', '#b1bac4', '#6e7681', '#ffa198', '#56d364', '#e3b341', '#79c0ff', '#d2a8ff', '#56d4dd', '#ffffff'],
  },
  {
    id: 'rose-pine-dawn', label: 'Rosé Pine Dawn', kind: 'light', shiki: 'rose-pine-dawn',
    colors: { base: '#faf4ed', surface: '#fffaf3', overlay: '#f2e9e1', muted: '#9893a5', subtle: '#797593', text: '#575279', love: '#b4637a', gold: '#ea9d34', rose: '#d7827e', pine: '#286983', foam: '#56949f', iris: '#907aa9', hlLow: '#f4ede8', hlMed: '#dfdad9', hlHigh: '#cecacd' },
    ansi: ['#f2e9e1', '#b4637a', '#286983', '#ea9d34', '#56949f', '#907aa9', '#d7827e', '#575279', '#9893a5', '#b4637a', '#286983', '#ea9d34', '#56949f', '#907aa9', '#d7827e', '#575279'],
  },
  {
    id: 'catppuccin-latte', label: 'Catppuccin Latte', kind: 'light', shiki: 'catppuccin-latte',
    colors: { base: '#eff1f5', surface: '#e6e9ef', overlay: '#ccd0da', muted: '#9ca0b0', subtle: '#6c6f85', text: '#4c4f69', love: '#d20f39', gold: '#df8e1d', rose: '#fe640b', pine: '#1e66f5', foam: '#179299', iris: '#8839ef', hlLow: '#e6e9ef', hlMed: '#bcc0cc', hlHigh: '#acb0be' },
    ansi: ['#5c5f77', '#d20f39', '#40a02b', '#df8e1d', '#1e66f5', '#ea76cb', '#179299', '#acb0be', '#6c6f85', '#d20f39', '#40a02b', '#df8e1d', '#1e66f5', '#ea76cb', '#179299', '#bcc0cc'],
  },
  {
    id: 'github-light', label: 'GitHub Light', kind: 'light', shiki: 'github-light-default',
    colors: { base: '#ffffff', surface: '#f6f8fa', overlay: '#eaeef2', muted: '#8c959f', subtle: '#59636e', text: '#1f2328', love: '#cf222e', gold: '#9a6700', rose: '#bc4c00', pine: '#0969da', foam: '#1b7c83', iris: '#8250df', hlLow: '#f6f8fa', hlMed: '#d1d9e0', hlHigh: '#c0c8d1' },
    ansi: ['#24292f', '#cf222e', '#116329', '#4d2d00', '#0969da', '#8250df', '#1b7c83', '#6e7781', '#57606a', '#a40e26', '#1a7f37', '#633c01', '#218bff', '#a475f9', '#3192aa', '#8c959f'],
  },
  {
    id: 'solarized-light', label: 'Solarized Light', kind: 'light', shiki: 'solarized-light',
    colors: { base: '#fdf6e3', surface: '#f5efdc', overlay: '#eee8d5', muted: '#93a1a1', subtle: '#657b83', text: '#586e75', love: '#dc322f', gold: '#b58900', rose: '#cb4b16', pine: '#268bd2', foam: '#2aa198', iris: '#6c71c4', hlLow: '#eee8d5', hlMed: '#e4ddc8', hlHigh: '#d6cfb8' },
    ansi: ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5', '#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3'],
  },
];

export const DEFAULT_THEME = 'rose-pine-moon';

export interface FontChoice {
  id: string;
  label: string;
  /** CSS font-family list. */
  css: string;
  /** The family to test for availability; bundled fonts are always available. */
  probe: string | null;
}

/** Nerd Font glyphs (prompt icons) still render with other terminal fonts, from this fallback when installed. */
const NERD_FALLBACK = "'JetBrainsMono Nerd Font', 'Symbols Nerd Font Mono'";

export const UI_FONTS: FontChoice[] = [
  { id: 'system', label: 'System (SF Pro)', css: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif", probe: null },
  { id: 'inter', label: 'Inter', css: "'Inter Variable', -apple-system, sans-serif", probe: null },
  { id: 'geist', label: 'Geist', css: "'Geist Variable', -apple-system, sans-serif", probe: null },
  { id: 'avenir', label: 'Avenir Next', css: "'Avenir Next', -apple-system, sans-serif", probe: 'Avenir Next' },
  { id: 'helvetica', label: 'Helvetica Neue', css: "'Helvetica Neue', -apple-system, sans-serif", probe: 'Helvetica Neue' },
  { id: 'new-york', label: 'New York (serif)', css: "ui-serif, 'New York', Georgia, serif", probe: null },
];

export const MONO_FONTS: FontChoice[] = [
  { id: 'jetbrains-nerd', label: 'JetBrainsMono Nerd Font', css: `'JetBrainsMono Nerd Font', 'JetBrainsMono Nerd Font Mono', 'JetBrains Mono Variable', monospace`, probe: 'JetBrainsMono Nerd Font' },
  { id: 'jetbrains', label: 'JetBrains Mono', css: `'JetBrains Mono Variable', ${NERD_FALLBACK}, monospace`, probe: null },
  { id: 'geist-mono', label: 'Geist Mono', css: `'Geist Mono Variable', ${NERD_FALLBACK}, monospace`, probe: null },
  { id: 'fira-code', label: 'Fira Code', css: `'Fira Code Variable', ${NERD_FALLBACK}, monospace`, probe: null },
  { id: 'plex-mono', label: 'IBM Plex Mono', css: `'IBM Plex Mono', ${NERD_FALLBACK}, monospace`, probe: null },
  { id: 'sf-mono', label: 'SF Mono', css: `ui-monospace, 'SF Mono', ${NERD_FALLBACK}, monospace`, probe: null },
  { id: 'menlo', label: 'Menlo', css: `Menlo, ${NERD_FALLBACK}, monospace`, probe: 'Menlo' },
];

export const DEFAULT_UI_FONT = 'system';
export const DEFAULT_MONO_FONT = 'jetbrains-nerd';

/** How much of the agent's thinking the rich view shows (View → Thinking, ⌥⌘T, or the switch under the composer). */
export type ThinkingDensity = 'focus' | 'normal' | 'detailed';

export const DENSITIES: { id: ThinkingDensity; label: string; detail: string }[] = [
  { id: 'focus', label: 'Focus', detail: 'Hide thinking' },
  { id: 'normal', label: 'Normal', detail: 'Fold each stretch of thinking into one row' },
  { id: 'detailed', label: 'Detailed', detail: 'Show all thinking, expanded' },
];

/** What the renderer tells main, so the View menu shows the current choices and greys out missing fonts. */
export interface AppearanceState {
  density: ThinkingDensity;
  theme: string;
  uiFont: string;
  monoFont: string;
  /** Font ids whose fonts aren't installed. */
  missingFonts: string[];
}
