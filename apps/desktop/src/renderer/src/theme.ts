import type { ITheme } from '@xterm/xterm';

/** Rosé Pine Moon, matching ~/.wezterm.lua (including its iris selection override). */
export const palette = {
  base: '#232136', surface: '#2a273f', overlay: '#393552', muted: '#6e6a86', subtle: '#908caa',
  text: '#e0def4', love: '#eb6f92', gold: '#f6c177', rose: '#ea9a97', pine: '#3e8fb0', foam: '#9ccfd8',
  iris: '#c4a7e7', hlLow: '#2a283e', hlMed: '#44415a', hlHigh: '#56526e',
};

export const xtermTheme: ITheme = {
  background: '#23213600',
  foreground: palette.text,
  cursor: palette.text,
  cursorAccent: palette.base,
  selectionBackground: palette.iris,
  selectionForeground: palette.base,
  selectionInactiveBackground: palette.hlHigh,
  black: palette.overlay,
  red: palette.love,
  green: palette.pine,
  yellow: palette.gold,
  blue: palette.foam,
  magenta: palette.iris,
  cyan: palette.rose,
  white: palette.text,
  brightBlack: palette.muted,
  brightRed: palette.love,
  brightGreen: palette.pine,
  brightYellow: palette.gold,
  brightBlue: palette.foam,
  brightMagenta: palette.iris,
  brightCyan: palette.rose,
  brightWhite: palette.text,
};

export const FONT_FAMILY =
  '"JetBrainsMono Nerd Font", "JetBrainsMono Nerd Font Mono", "JetBrainsMonoNL Nerd Font", "SF Mono", Menlo, monospace';
export const DEFAULT_FONT_SIZE = 12.5;
