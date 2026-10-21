import { createRoot } from 'react-dom/client';
import '@xterm/xterm/css/xterm.css';
// Bundled fonts (SIL Open Font License), so every font choice in View → Font works without installing anything.
import '@fontsource-variable/inter';
import '@fontsource-variable/geist';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource-variable/geist-mono';
import '@fontsource-variable/fira-code';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/600.css';
import './styles.css';
import { App } from './App';
import { initStore } from './store';
import { setAppearance } from './actions';

void initStore().then(() => {
  setAppearance(); // the saved theme and fonts, before anything renders
  createRoot(document.getElementById('root')!).render(<App />);
});
