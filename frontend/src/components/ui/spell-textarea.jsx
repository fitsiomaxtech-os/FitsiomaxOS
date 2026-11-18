import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { checkText, ignoreIssue, useSpelling } from "@/lib/spellcheck";

/**
 * A textarea that marks spelling (red) and grammar (blue) inside the box as the patient
 * types, medical words first (lib/spellcheck). The marks are drawn on a copy of the text
 * laid exactly under the textarea's own; a word is never marked while it is being typed.
 * Putting the caret on a marked word opens its fixes beside it: tap one to swap it in,
 * Ignore to leave the word be, Fix all for every mark in the box. The count beside the
 * label goes to the first mark.
 */

const BLUE = "#0066ff";
const RED = "#e11d48";
const keepFocus = (e) => e.preventDefault();

export const SpellTextarea = ({ id, label, labelClassName = "", value, onChange, rows = 4, maxLength, placeholder, className = "", testid }) => {
  const spelling = useSpelling();
  const taRef = useRef(null);
  const backRef = useRef(null);
  const blurTimer = useRef(0);
  const [focused, setFocused] = useState(false);
  const [caret, setCaret] = useState(-1);
  // Where the caret was left by the last keystroke: the word there is still being typed.
  // The ref is read by onSelect, which can fire before the state from onChange has landed.
  const [editAt, setEditAtState] = useState(-1);
  const editRef = useRef(-1);
  const setEditAt = (at) => {
    editRef.current = at;
    setEditAtState(at);
  };

  const issues = useMemo(
    () => checkText(value, { skipAt: focused ? editAt : -1 }),
    // `spelling` changes when the word list lands or a word is ignored.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [value, focused, editAt, spelling],
  );
  const active = focused && caret >= 0 ? issues.find((i) => caret >= i.start && caret <= i.end) || null : null;
  const fixable = issues.filter((i) => i.fixes.length);

  const sync = () => {
    if (backRef.current && taRef.current) backRef.current.scrollTop = taRef.current.scrollTop;
  };
  useLayoutEffect(sync, [value, issues]);

  // The fixes sit just under the marked word, above it near the foot of the screen; in a
  // portal, so the popup's scrolling body never clips them.
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    if (!active) { setPos(null); return undefined; }
    const place = () => {
      sync();
      const mark = backRef.current && backRef.current.querySelector(`[data-issue="${active.start}"]`);
      const ta = taRef.current;
      if (!mark || !ta) { setPos(null); return; }
      const r = mark.getClientRects()[0] || mark.getBoundingClientRect();
      const box = ta.getBoundingClientRect();
      if (r.bottom < box.top || r.top > box.bottom) { setPos(null); return; }
      const left = Math.max(8, Math.min(r.left - 4, window.innerWidth - 296));
      setPos(window.innerHeight - r.bottom > 170 ? { left, top: r.bottom + 6 } : { left, bottom: window.innerHeight - r.top + 6 });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active && active.start, active && active.end, value]);

  const putCaret = (at) => {
    setEditAt(-1);
    window.requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(at, at);
      setCaret(at);
    });
  };

  const apply = (issue, text) => {
    const next = value.slice(0, issue.start) + text + value.slice(issue.end);
    if (maxLength && next.length > maxLength) return;
    onChange(next);
    putCaret(issue.start + text.length);
  };

  const fixAll = () => {
    let next = value;
    let at = caret;
    [...fixable].reverse().forEach((issue) => {
      const text = issue.fixes[0].text;
      next = next.slice(0, issue.start) + text + next.slice(issue.end);
      if (issue.end <= at) at += text.length - (issue.end - issue.start);
    });
    if (maxLength && next.length > maxLength) return;
    onChange(next);
    putCaret(Math.max(0, Math.min(at, next.length)));
  };

  const ignore = (issue) => {
    ignoreIssue(issue);
    putCaret(issue.end);
  };

  // The copy under the textarea: the same text, see-through, with the marked words underlined.
  const pieces = [];
  let at = 0;
  issues.forEach((issue) => {
    if (issue.start > at) pieces.push(value.slice(at, issue.start));
    pieces.push(
      <mark
        key={issue.start}
        data-issue={issue.start}
        className="bg-transparent text-transparent underline decoration-wavy underline-offset-[3px] [text-decoration-skip-ink:none] [text-decoration-thickness:1.5px]"
        style={{ textDecorationColor: issue.kind === "spelling" ? RED : BLUE }}
      >
        {value.slice(issue.start, issue.end)}
      </mark>,
    );
    at = issue.end;
  });
  // A trailing line break needs a character after it to take up its line.
  pieces.push(`${value.slice(at)}​`);

  const anySpelling = issues.some((i) => i.kind === "spelling");

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <label htmlFor={id} className={labelClassName}>{label}</label>
        {issues.length > 0 && (
          <button
            type="button"
            onMouseDown={keepFocus}
            onClick={() => putCaret(issues[0].start)}
            className="shrink-0 text-[13px] font-medium hover:underline"
            style={{ color: anySpelling ? RED : BLUE }}
            data-testid={`${testid}-spell-count`}
          >
            {issues.length === 1 ? "1 suggestion" : `${issues.length} suggestions`}
          </button>
        )}
      </div>
      <div className="relative rounded-[8px] bg-white">
        <div
          ref={backRef}
          aria-hidden="true"
          className={`${className} pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words !border-transparent !bg-transparent !text-transparent [scrollbar-gutter:stable]`}
        >
          {pieces}
        </div>
        <textarea
          ref={taRef}
          id={id}
          value={value}
          rows={rows}
          maxLength={maxLength}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(e) => {
            onChange(e.target.value);
            setEditAt(e.target.selectionStart);
          }}
          onSelect={(e) => {
            const { selectionStart: s, selectionEnd: end } = e.target;
            const here = s === end ? s : -1;
            setCaret(here);
            if (here !== editRef.current) setEditAt(-1);
          }}
          onScroll={sync}
          onFocus={() => { window.clearTimeout(blurTimer.current); setFocused(true); }}
          onBlur={() => {
            window.clearTimeout(blurTimer.current);
            blurTimer.current = window.setTimeout(() => { setFocused(false); setEditAt(-1); }, 150);
          }}
          className={`${className} relative block !bg-transparent [scrollbar-gutter:stable]`}
          data-testid={testid}
        />
      </div>

      {active && pos && createPortal(
        <div
          role="dialog"
          aria-label={active.kind === "spelling" ? "Spelling" : "Grammar"}
          onMouseDown={keepFocus}
          className="fixed z-[1000] w-max min-w-[200px] max-w-[288px] rounded-[10px] border border-[#e3e7f2] bg-white p-3 shadow-[0_12px_32px_rgba(15,23,42,0.16)]"
          style={pos}
          data-testid={`${testid}-spell-popover`}
        >
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: active.kind === "spelling" ? RED : BLUE }}>
            {active.kind === "spelling" ? "Spelling" : "Grammar"}
          </p>
          {active.message && <p className="mt-1 text-[13px] leading-snug text-slate-600">{active.message}</p>}
          {active.fixes.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {active.fixes.map((f, k) => (
                <button
                  key={`${f.text}-${k}`}
                  type="button"
                  onClick={() => apply(active, f.text)}
                  className={`h-8 rounded-[8px] px-3 text-[14px] font-medium transition ${k === 0 ? "text-white hover:brightness-95" : "border border-[#c7cdea] text-slate-700 hover:bg-slate-50"}`}
                  style={k === 0 ? { background: BLUE } : undefined}
                  data-testid={`${testid}-spell-fix-${k}`}
                >
                  {f.label || f.text}
                </button>
              ))}
            </div>
          )}
          <div className="mt-2.5 flex items-center gap-4 border-t border-slate-100 pt-2 text-[13px] font-medium">
            <button type="button" onClick={() => ignore(active)} className="text-slate-500 hover:text-slate-800" data-testid={`${testid}-spell-ignore`}>Ignore</button>
            {fixable.length > 1 && (
              <button type="button" onClick={fixAll} className="hover:underline" style={{ color: BLUE }} data-testid={`${testid}-spell-fix-all`}>
                Fix all ({fixable.length})
              </button>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
};
