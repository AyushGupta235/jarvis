import { getState, setState, type State } from './store';

/** Drag handle on the left edge of a right-hand pane; dragging left makes the pane wider. */
export function Resizer({ field, min, max }: { field: 'navWidth' | 'viewerWidth'; min: number; max: number }) {
  return (
    <div
      className="resizer"
      onMouseDown={(e) => {
        e.preventDefault();
        const startX = e.clientX;
        const start = getState()[field] as number;
        const move = (ev: MouseEvent) => {
          const w = Math.max(min, Math.min(max, start + (startX - ev.clientX)));
          setState({ [field]: w } as Partial<State>);
        };
        const up = () => {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
          document.body.classList.remove('resizing');
        };
        document.body.classList.add('resizing');
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      }}
      onDoubleClick={() => setState({ [field]: field === 'navWidth' ? 380 : 560 } as Partial<State>)}
    />
  );
}
