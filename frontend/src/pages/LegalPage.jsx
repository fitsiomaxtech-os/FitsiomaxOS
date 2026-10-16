import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { LEGAL_LAST_UPDATED, PRIVACY_TEXT, TERMS_TEXT } from "@/lib/legalContent";

const LOGO_URL =
  "https://customer-assets.emergentagent.com/job_3d74aa9e-a241-4207-b148-2bbe29802707/artifacts/nozl77ti_Logo%20Icon.webp";

const DOCS = {
  terms: { title: "Terms & Conditions", text: TERMS_TEXT, other: "privacy" },
  privacy: { title: "Privacy Policy", text: PRIVACY_TEXT, other: "terms" },
};

// The plain text in legalContent.js, read back into blocks by its own numbering:
//   "4. WHO CAN USE"      a section heading
//   "4.1  Patients ..."   a numbered clause
//   "     a) ..." / "- "  an item under the clause above it
//   anything else         a paragraph
const parse = (text) => {
  const blocks = [];
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    let m;
    if ((m = line.match(/^(\d+)\.\s+(.+)$/))) {
      blocks.push({ type: "heading", num: m[1], text: m[2] });
    } else if ((m = line.match(/^(\d+\.\d+)\s+(.+)$/))) {
      blocks.push({ type: "clause", num: m[1], text: m[2], items: [] });
    } else if ((m = line.match(/^\s+([a-z]\)|-)\s+(.+)$/))) {
      const last = blocks[blocks.length - 1];
      if (last?.type === "clause") last.items.push({ marker: m[1], text: m[2] });
      else blocks.push({ type: "para", text: m[2] });
    } else {
      blocks.push({ type: "para", text: line.trim() });
    }
  }
  return blocks;
};

const Inline = ({ text, from }) =>
  text.split(/(\{\{privacy\}\})/).map((part, i) =>
    part === "{{privacy}}" ? (
      <Link key={i} to="/privacy" state={{ from }} className="font-medium text-sky-600 hover:text-sky-700">
        Privacy Policy
      </Link>
    ) : (
      part
    )
  );

export const LegalPage = ({ kind }) => {
  const doc = DOCS[kind];
  const location = useLocation();
  // Where the reader came from, carried on the link so Back lands on the right sign-in
  // screen — the staff login and the Client Portal both link here.
  const from = location.state?.from || "/";
  const backLabel = from === "/portal" ? "Back to Client Portal" : "Back to sign in";

  useEffect(() => {
    document.title = `${doc.title} — Fitsiomax`;
    window.scrollTo(0, 0);
  }, [doc.title]);

  return (
    <div className="min-h-screen bg-slate-50" data-testid={`legal-page-${kind}`}>
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between px-4">
          <Link
            to={from}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900"
            data-testid="legal-back"
          >
            <ArrowLeft className="h-4 w-4" />
            {backLabel}
          </Link>
          <div className="flex items-center gap-2">
            <img src={LOGO_URL} alt="" className="h-7 w-7 rounded object-contain" />
            <span className="font-heading text-sm font-bold text-slate-900">FITSIOMAX</span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-6 md:py-10">
        <article className="rounded-xl border border-slate-200 bg-white px-5 py-6 shadow-[0_8px_30px_rgb(2,6,23,0.04)] md:px-10 md:py-10">
          <h1 className="font-heading text-2xl font-bold text-slate-900 md:text-3xl">{doc.title}</h1>
          <p className="mt-1 text-xs text-slate-400">Last updated: {LEGAL_LAST_UPDATED}</p>

          <div className="mt-6 space-y-3 text-sm leading-relaxed text-slate-700">
            {parse(doc.text).map((b, i) => {
              if (b.type === "heading") {
                return (
                  <h2 key={i} className="!mt-8 text-sm font-bold uppercase tracking-wide text-slate-900">
                    {b.num}. {b.text}
                  </h2>
                );
              }
              if (b.type === "clause") {
                return (
                  <div key={i} className="flex gap-3">
                    <span className="w-9 shrink-0 tabular-nums text-slate-400">{b.num}</span>
                    <div className="min-w-0">
                      <p><Inline text={b.text} from={from} /></p>
                      {b.items.length > 0 && (
                        <ul className="mt-1.5 space-y-1">
                          {b.items.map((item, j) => (
                            <li key={j} className="flex gap-2">
                              <span className="shrink-0 text-slate-400">{item.marker === "-" ? "•" : item.marker}</span>
                              <span>{item.text}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                );
              }
              return <p key={i}><Inline text={b.text} from={from} /></p>;
            })}
          </div>
        </article>

        <p className="mt-6 text-center text-xs text-slate-400">
          Also read our{" "}
          <Link to={`/${doc.other}`} state={{ from }} className="font-medium text-sky-600 hover:text-sky-700">
            {DOCS[doc.other].title}
          </Link>
        </p>
      </main>
    </div>
  );
};
