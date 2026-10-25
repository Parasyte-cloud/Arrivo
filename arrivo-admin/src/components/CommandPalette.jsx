import { useEffect, useMemo, useRef, useState } from "react";
import { OpsIcon } from "./OpsIcon";

// Cmd/Ctrl+K palette. Type to filter, arrow keys to move, Enter to run, Escape to close.
// Each surface offers "Open" and, where it makes sense, "Pop out" (its own workspace window).
export function CommandPalette({ items, onOpen, onPopOut, onClose }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const returnFocus = useRef(typeof document !== "undefined" ? document.activeElement : null);

  const actions = useMemo(() => {
    const out = [];
    for (const item of items) {
      out.push({ key: `open-${item.id}`, label: item.label, hint: "Open", run: () => onOpen(item.id), search: item.label });
      if (item.popOut) out.push({ key: `pop-${item.id}`, label: item.label, hint: "Pop out", icon: "external", run: () => onPopOut(item.id, item.label), search: `${item.label} pop out window` });
    }
    return out;
  }, [items, onOpen, onPopOut]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions;
    const words = q.split(/\s+/);
    return actions.filter((a) => words.every((w) => a.search.toLowerCase().includes(w)));
  }, [actions, query]);

  useEffect(() => { inputRef.current?.focus(); const back = returnFocus.current; return () => { try { back?.focus?.(); } catch { /* element is gone */ } }; }, []);
  useEffect(() => { setIndex(0); }, [query]);
  useEffect(() => { listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [index]);

  function onKeyDown(event) {
    if (event.key === "ArrowDown") { event.preventDefault(); setIndex((i) => (results.length ? (i + 1) % results.length : 0)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setIndex((i) => (results.length ? (i - 1 + results.length) % results.length : 0)); }
    else if (event.key === "Enter") { event.preventDefault(); const pick = results[index]; if (pick) { pick.run(); onClose(); } }
    else if (event.key === "Escape") { event.preventDefault(); onClose(); }
  }

  return (
    <div className="ops-command-backdrop" onMouseDown={onClose}>
      <div className="ops-command-palette" role="dialog" aria-modal="true" aria-label="Command menu" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="ops-command-search">
          <OpsIcon name="search" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to a surface, or type 'pop' to open one in a window"
            aria-label="Search surfaces"
            aria-controls="ops-command-list"
            aria-activedescendant={results[index] ? `ops-cmd-${results[index].key}` : undefined}
            autoComplete="off"
            spellCheck={false}
          />
          <kbd>ESC</kbd>
        </div>
        <div className="ops-command-list" id="ops-command-list" role="listbox" ref={listRef}>
          {results.length ? results.map((a, i) => (
            <button
              key={a.key}
              id={`ops-cmd-${a.key}`}
              type="button"
              role="option"
              aria-selected={i === index}
              className={i === index ? "active" : ""}
              onMouseMove={() => setIndex(i)}
              onClick={() => { a.run(); onClose(); }}
            >
              <span>{a.label}</span>
              <small>{a.icon ? <OpsIcon name={a.icon} size={12} /> : null} {a.hint}</small>
            </button>
          )) : <div className="ops-command-empty">Nothing matches "{query}".</div>}
        </div>
        <div className="ops-command-footer"><span>↑ ↓ to move · Enter to run · Pop out keeps dispatch, the live map or safety open while you work elsewhere.</span></div>
      </div>
    </div>
  );
}
