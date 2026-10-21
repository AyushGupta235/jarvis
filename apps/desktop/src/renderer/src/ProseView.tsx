import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { enhanceProse, renderProse } from './prose';

/**
 * A reply rendered as readable markdown (prose.ts), with a hover toolbar to copy its markdown source or
 * show the raw markdown in place, for when the formatted text is meant to be pasted somewhere else.
 */
export const Prose = memo(function Prose({ text, className }: { text: string; className: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [raw, setRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  const html = useMemo(() => renderProse(text), [text]);
  useEffect(() => {
    if (ref.current && !raw) void enhanceProse(ref.current);
  }, [html, raw]);
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

