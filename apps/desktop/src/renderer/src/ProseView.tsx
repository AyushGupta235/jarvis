import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { enhanceProse, renderProse } from './prose';

/** Folders a relative file path in a reply is looked for in (where the agent is, its repo, their parents). */
export const ProseBases = createContext<string[]>([]);

/**
 * A reply rendered as readable markdown (prose.ts), with a hover toolbar to copy its markdown source or
 * show the raw markdown in place, for when the formatted text is meant to be pasted somewhere else.
 */
export const Prose = memo(function Prose({ text, className }: { text: string; className: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [raw, setRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  const bases = useContext(ProseBases);
  const baseKey = bases.join('|');
  const html = useMemo(() => renderProse(text), [text]);
  useEffect(() => {
    if (ref.current && !raw) void enhanceProse(ref.current, bases);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, raw, baseKey]);
  return (
    <div className={`${className} rv-reply`}>
      <div className="rv-reply-tools">
        <button className="pc-btn" title="Copy this reply as markdown" onClick={() => {
          window.jarvis.copyText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        }}>{copied ? 'Copied' : 'Copy markdown'}</button>
        <button className={`pc-btn${raw ? ' on' : ''}`} title="Show the raw markdown" onClick={() => setRaw((r) => !r)}>
          {raw ? 'Rendered' : 'Raw'}
        </button>
      </div>
      {raw
        ? <pre className="rv-raw">{text}</pre>
        : <div ref={ref} className="prose" dangerouslySetInnerHTML={{ __html: html }} />}
    </div>
  );
});

