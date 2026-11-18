import { useEffect, useState } from "react";
import { ABBREVIATIONS, CANON, CONTEXT, MISSPELT, TERMS } from "./medicalTerms";

/**
 * Spelling and grammar for the Consultation Form's free-text boxes, medical first. It all
 * runs in the browser: what a patient types about their health never leaves the device.
 *
 * Retrieval-based: a word that is not known is looked up in the medical knowledge base
 * (./medicalTerms) and in the English word list (public/spell/en-words.txt, loaded once in
 * the background), and the closest entries become its fixes -- medical words first, then
 * the commoner English word. Grammar is a short set of rules: a capital I and sentence
 * start, a / an, a repeated word, the space around commas and full stops, a missing
 * apostrophe.
 *
 * checkText() returns issues as { start, end, kind, message, fixes: [{ text, label }] },
 * kind "spelling" or "grammar", in text order, never overlapping.
 */

// ---- the knowledge base, built once --------------------------------------------------

const MEDICAL = new Set();
const CANON_OF = new Map();
TERMS.forEach((t) => {
  MEDICAL.add(t);
  if (!/[sx]$/.test(t)) MEDICAL.add(`${t}s`);
});
CANON.forEach((c) => {
  const low = c.toLowerCase();
  if (!/[\s-]/.test(c)) CANON_OF.set(low, c);
  low.split(/[\s-]+/).forEach((part) => MEDICAL.add(part.replace(/'s$/, "")));
});
// What a misspelt word can be matched to on the medical side (no made-up plurals).
const MEDICAL_POOL = [...new Set([...TERMS, ...CANON_OF.keys()])];

// ---- the English word list, fetched on first use ------------------------------------

let english = null;
let loading = null;
let version = 0;
const listeners = new Set();
const ignored = new Set();
const cache = new Map();

const bump = () => {
  version += 1;
  listeners.forEach((l) => l(version));
};

// Most common words first, one a line, to "#"; then the rarer ones A to Z, each written as
// the count of letters it shares with the word before it and the rest of it.
const parseWords = (text) => {
  // A Windows checkout may hand the file back with \r\n.
  const lines = text.split(/\r?\n/);
  if (!lines[0].startsWith("#fitsiomax-words")) throw new Error("Not the word list");
  const known = new Set();
  const rank = new Map();
  let i = 1;
  for (; i < lines.length && lines[i] !== "#"; i += 1) {
    if (!lines[i]) continue;
    rank.set(lines[i], rank.size);
    known.add(lines[i]);
  }
  let prev = "";
  for (i += 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    const word = prev.slice(0, line.charCodeAt(0) - 48) + line.slice(1);
    known.add(word);
    prev = word;
  }
  const byInitial = new Map();
  known.forEach((w) => {
    if (!byInitial.has(w[0])) byInitial.set(w[0], []);
    byInitial.get(w[0]).push(w);
  });
  return { known, rank, byInitial };
};

export const loadSpelling = () => {
  if (loading) return loading;
  loading = fetch(`${process.env.PUBLIC_URL || ""}/spell/en-words.txt?v=1`)
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((text) => { english = parseWords(text); })
    // Without it, only the medical words and the grammar are checked; nothing else is marked.
    .catch(() => { english = null; })
    .finally(() => { cache.clear(); bump(); });
  return loading;
};

/** Starts the word list loading; the number it returns changes when it lands or a word is ignored. */
export const useSpelling = () => {
  const [v, setV] = useState(version);
  useEffect(() => {
    loadSpelling();
    listeners.add(setV);
    setV(version);
    return () => { listeners.delete(setV); };
  }, []);
  return v;
};

const signature = (kind, text) => `${kind}:${text.toLowerCase()}`;
export const ignoreIssue = (issue) => {
  ignored.add(signature(issue.kind, issue.original));
  bump();
};

// ---- retrieval -----------------------------------------------------------------------

// Edits between two words (a swap of two letters side by side counts as one), or max + 1
// as soon as it is clearly more than max.
const distance = (a, b, max) => {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let before = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    let low = i;
    for (let j = 1; j <= b.length; j += 1) {
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, before[j - 2] + 1);
      cur.push(v);
      if (v < low) low = v;
    }
    if (low > max) return max + 1;
    before = prev;
    prev = cur;
  }
  return prev[b.length];
};

const ALPHABET = "abcdefghijklmnopqrstuvwxyz";
// Every word one edit away, for typos in the first letter the A-to-Z scan would miss.
const oneEdit = (w) => {
  const out = new Set();
  for (let i = 0; i <= w.length; i += 1) {
    const head = w.slice(0, i);
    const tail = w.slice(i);
    if (tail) out.add(head + tail.slice(1));
    if (tail.length > 1) out.add(head + tail[1] + tail[0] + tail.slice(2));
    for (const c of ALPHABET) {
      if (tail) out.add(head + c + tail.slice(1));
      out.add(head + c + tail);
    }
  }
  return out;
};

const isKnown = (low) => {
  if (MEDICAL.has(low) || CANON_OF.has(low)) return true;
  if (english && english.known.has(low)) return true;
  if (low.endsWith("'s")) return isKnown(low.slice(0, -2));
  return false;
};

const rankOf = (w) => (english && english.rank.has(w) ? english.rank.get(w) : 90000);

// The closest known words to an unknown one, best first: fewest edits, then a medical word,
// then the more common English word.
const suggest = (low) => {
  if (cache.has(low)) return cache.get(low);
  const max = low.length <= 4 ? 1 : 2;
  const found = new Map();
  const consider = (w, medical) => {
    const d = distance(low, w, max);
    if (d > max) return;
    const had = found.get(w);
    if (!had || d < had.d || (medical && !had.medical)) found.set(w, { w, d, medical: Boolean(medical || (had && had.medical)) });
  };
  MEDICAL_POOL.forEach((w) => consider(w, true));
  if (english) {
    (english.byInitial.get(low[0]) || []).forEach((w) => consider(w, MEDICAL.has(w)));
    oneEdit(low).forEach((w) => { if (english.known.has(w)) consider(w, MEDICAL.has(w)); });
  }
  const best = [...found.values()]
    .sort((x, y) => x.d - y.d || Number(y.medical) - Number(x.medical) || rankOf(x.w) - rankOf(y.w))
    .slice(0, 3)
    .map((c) => c.w);
  cache.set(low, best);
  return best;
};

const withCase = (orig, word) => {
  const canon = CANON_OF.get(word.toLowerCase());
  if (canon) return canon;
  if (/[A-Z]/.test(word)) return word;
  if (orig.length > 1 && orig === orig.toUpperCase()) return word.toUpperCase();
  if (orig[0] !== orig[0].toLowerCase()) return word[0].toUpperCase() + word.slice(1);
  return word;
};
const capital = (w) => w[0].toUpperCase() + w.slice(1);

// ---- the check -----------------------------------------------------------------------

const TOKEN = /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu;
const LATIN = /^[A-Za-z]+(?:'[A-Za-z]+)*$/;
const LINKS = /\S+@\S+\.\S+|https?:\/\/\S+|www\.\S+/gi;
const REPEAT_OK = new Set(["had", "that", "very", "so", "bye", "no", "is"]);
const LETTER_NAMES = new Set(["vitamin", "grade", "type", "class", "category", "hepatitis", "plan", "option", "point", "section", "part", "group", "blood"]);
const I_FORMS = new Set(["i", "i'm", "i've", "i'll", "i'd"]);

// Does a word start with a vowel sound? null where spelling alone cannot tell (u-words).
const vowelSound = (word) => {
  if (word.length > 1 && word === word.toUpperCase()) return "AEFHILMNORSX".includes(word[0]);
  const w = word.toLowerCase();
  if (/^(one|once|eu|ewe)/.test(w)) return false;
  if (/^(hour|honest|honou?r|heir)/.test(w)) return true;
  if (/^u/.test(w)) return null;
  return /^[aeio]/.test(w);
};

export const checkText = (text, { skipAt = -1 } = {}) => {
  if (!text) return [];
  const links = [...text.matchAll(LINKS)].map((m) => [m.index, m.index + m[0].length]);
  const inLink = (s) => links.some(([a, b]) => s >= a && s < b);
  const tokens = [...text.matchAll(TOKEN)]
    .filter((m) => !inLink(m.index))
    .map((m) => ({ raw: m[0], start: m.index, end: m.index + m[0].length, low: m[0].replace(/’/g, "'").toLowerCase() }));

  const issues = [];
  const add = (issue, from = issue.start, to = issue.end) => {
    if (skipAt >= from && skipAt <= to) return;
    const original = text.slice(issue.start, issue.end);
    if (ignored.has(signature(issue.kind, original))) return;
    issues.push({ ...issue, original });
  };
  const gap = (a, b) => text.slice(a.end, b.start);
  const spaceOnly = (s) => /^[ \t]+$/.test(s);

  tokens.forEach((t, i) => {
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    const before = prev ? gap(prev, t) : text.slice(0, t.start);
    const firstOfText = !prev && /^[\s"'([]*$/.test(before);
    // A full stop after a short form ("Dr. Rao", "e.g. walking") ends no sentence.
    const endsSentence = Boolean(prev) && /^[.!?]["')\]]*\s+$/.test(before)
      && !(before[0] === "." && (ABBREVIATIONS.has(prev.low)
        || /(?:^|[^a-z])[ei]\.?g?$/i.test(text.slice(Math.max(0, prev.start - 2), prev.end))));
    const sentenceStart = firstOfText || endsSentence;
    // The first word of a line or a list item ("1. Knee pain", "- Back pain").
    const lineStart = sentenceStart || (prev ? /\n[\s\d.)\-•*]*$/ : /^[\s\d.)\-•*"'([]*$/).test(before);
    const nearDigit = /\d/.test(text[t.start - 1] || "") || /\d/.test(text[t.end] || "");
    if (!LATIN.test(t.raw.replace(/’/g, "'")) || nearDigit) return;

    // A small i.
    if (I_FORMS.has(t.raw.replace(/’/g, "'"))) {
      add({ start: t.start, end: t.end, kind: "grammar", message: "Write “I” as a capital letter.", fixes: [{ text: capital(t.raw) }] });
      return;
    }

    // The same word twice.
    if (prev && prev.low === t.low && t.low.length > 1 && !REPEAT_OK.has(t.low) && spaceOnly(gap(prev, t))) {
      add({ start: prev.end, end: t.end, kind: "grammar", message: "This word is repeated.", fixes: [{ text: "", label: `Remove “${t.raw}”` }] }, prev.start);
      return;
    }

    // a / an. A capital A inside a sentence is a letter ("vitamin A", "grade A"), not "a".
    if ((t.low === "a" || t.low === "an") && next && spaceOnly(gap(t, next)) && !(prev && LETTER_NAMES.has(prev.low))
      && (t.raw !== "A" || sentenceStart)) {
      const vowel = vowelSound(next.raw);
      const want = vowel === true ? "an" : vowel === false ? "a" : t.low;
      if (want !== t.low) {
        const fix = t.raw[0] === t.raw[0].toUpperCase() ? capital(want) : want;
        add({ start: t.start, end: t.end, kind: "grammar", message: `Use “${want}” before “${next.raw}”.`, fixes: [{ text: fix }] }, t.start, next.end);
      }
      return;
    }

    if (t.raw.length < 2) return;
    if (t.raw === t.raw.toUpperCase()) return; // MRI, LBP, TENS: short forms are left alone
    const small = t.raw[0] === t.raw[0].toLowerCase();
    // A sentence in small letters: its first word's fix carries the capital, or the capital
    // is the fix.
    const cap = sentenceStart && small;
    const fixOf = (w) => ({ text: cap ? capital(withCase(t.raw, w)) : withCase(t.raw, w) });
    const spelling = () => {
      // A known misspelling, or a missing apostrophe.
      const misspelt = Object.prototype.hasOwnProperty.call(MISSPELT, t.low) ? MISSPELT[t.low] : null;
      if (misspelt) {
        const apostrophe = misspelt.includes("'") && misspelt.replace(/'/g, "").toLowerCase() === t.low;
        return { issue: { kind: apostrophe ? "grammar" : "spelling", message: apostrophe ? "Add the apostrophe." : "", fixes: [fixOf(misspelt)] } };
      }
      // A real word that a medical answer almost never means ("lumber pain").
      const context = Object.prototype.hasOwnProperty.call(CONTEXT, t.low) ? CONTEXT[t.low] : null;
      if (context) {
        const hitNext = next && context.next && spaceOnly(gap(t, next)) && context.next.includes(next.low);
        const hitPrev = prev && context.prev && spaceOnly(gap(prev, t)) && context.prev.includes(prev.low);
        if (context.always || hitNext || hitPrev) {
          return {
            issue: { kind: "spelling", message: "Did you mean the medical word?", fixes: [fixOf(context.fix)] },
            from: hitPrev ? prev.start : t.start,
            to: hitNext ? next.end : t.end,
          };
        }
      }
      // Without the English list, a word that is not medical cannot be judged.
      if (isKnown(t.low) || !english) return null;
      const found = suggest(t.low);
      // A capital inside a sentence is most likely a name (a doctor, a hospital, a brand):
      // marked only when it is one slip from a medical word.
      if (!small && !lineStart && !(t.low.length >= 5 && found.length && MEDICAL_POOL.includes(found[0]) && distance(t.low, found[0], 1) <= 1)) return null;
      return { issue: { kind: "spelling", message: found.length ? "" : "No suggestions found.", fixes: found.map(fixOf) } };
    };
    const hit = spelling();
    if (hit) add({ start: t.start, end: t.end, ...hit.issue }, hit.from, hit.to);
    else if (cap) add({ start: t.start, end: t.end, kind: "grammar", message: "Start the sentence with a capital letter.", fixes: [{ text: capital(t.raw) }] });
  });

  // A space before a comma or full stop, and none after a comma.
  for (const m of text.matchAll(/([\p{L}\d)])([ \t]+)([,.;:!?])(?=\s|$)/gu)) {
    const start = m.index + m[1].length;
    add({ start, end: start + m[2].length + 1, kind: "grammar", message: "Remove the space before the punctuation.", fixes: [{ text: m[3] }] });
  }
  for (const m of text.matchAll(/([A-Za-z]),(?=[A-Za-z])/g)) {
    const start = m.index + 1;
    add({ start, end: start + 1, kind: "grammar", message: "Add a space after the comma.", fixes: [{ text: ", " }] });
  }

  issues.sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  issues.forEach((issue) => {
    const last = out[out.length - 1];
    if (!last || issue.start >= last.end) out.push(issue);
  });
  return out;
};
