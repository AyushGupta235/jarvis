import { getState, setState, type State } from './store';

type Field = 'navWidth' | 'viewerWidth' | 'sidebarWidth';

const DEFAULTS: Record<Field, number> = { navWidth: 380, viewerWidth: 560, sidebarWidth: 264 };

/**
 * Drag handle between panes. Right-hand panes (navigator, viewer) grow when dragged left; the sidebar is on
 * the left (`left`), so it grows when dragged right. Dragging below `collapseBelow` calls `onCollapse` instead.
 */
export function Resizer({ field, min, max, left, collapseBelow, onCollapse }: {
  field: Field; min: number; max: number; left?: boolean; collapseBelow?: number; onCollapse?: () => void;
}) {
  return (
    <div
      className="resizer"
      onMouseDown={(e) => {
        e.preventDefault();
        const startX = e.clientX;
        const start = getState()[field] as number;
        const move = (ev: MouseEvent) => {
          const raw = start + (left ? ev.clientX - startX : startX - ev.clientX);
          if (collapseBelow && onCollapse && raw < collapseBelow) {
            up();
            onCollapse();
            return;
          }
          setState({ [field]: Math.max(min, Math.min(max, raw)) } as Partial<State>);
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
      onDoubleClick={() => setState({ [field]: DEFAULTS[field] } as Partial<State>)}
    />
  );
}
