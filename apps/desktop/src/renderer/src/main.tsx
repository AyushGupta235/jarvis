import { createRoot } from 'react-dom/client';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { App } from './App';
import { initStore } from './store';

void initStore().then(() => {
  createRoot(document.getElementById('root')!).render(<App />);
});
