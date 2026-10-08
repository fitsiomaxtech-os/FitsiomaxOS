import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Copy, Phone, PhoneCall, RefreshCw, Trash2, User, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatTile } from "@/components/ui/stat-tile";
import { toast } from "@/components/ui/sonner";
import { WhatsAppIcon } from "@/components/ui/whatsapp-icon";
import { QuickDateFilterBar } from "@/components/QuickDateFilterBar";
import {
  getBranchBoard, updateLead, listFitness, listZumba,
  getPortalAccountStatus, createOrResetPortalAccount,
  emailPortalLogin, setPortalBlocked, setPortalAutoSkip,
} from "@/lib/api";
import { PortalControlsCard } from "@/components/branch/PortalControlsCard";
import { DeleteLeadDialog } from "@/components/DeleteLeadDialog";
// Was a local copy of waNumber, identical to the three still inlined elsewhere. Now that
// lib/phone.js exists this one points at it — the others can follow as they're touched.
import { waNumber } from "@/lib/phone";

import { credentialLines, portalCopyText, portalUrl, portalWhatsAppText } from "@/lib/portalCredentials";

const phoneDigits = (raw) => String(raw || "").replace(/\D/g, "");

/**
 * Whether this patient is on a course of treatment.
 *
 * Mirrors has_treatment() in backend/routers/v3_patient_portal.py — the server enforces
 * it on the Client Portal account itself, and this keeps the popup from offering access
 * the server will then refuse. Change one and change the other.
 *
 * Presence, never an amount: a patient on a 10,000 package who has paid 2,000 is
 * mid-treatment and belongs here. Excluded are "Consultation Only" and anyone who came
 * for a Diet Consultation alone — paying patients both, treatment patients neither.
 */
const hasTreatment = (l) => (
  l.treatment_fee_paid != null
  || !!l.session_package_id
  || l.consultation_decision === "consultation_treatment"
);

/**
 * Whether the branch has actually consulted this patient, rather than merely holding a
 * lead for them. Either the Consultation Fee is in, or the Head Physio has closed the
 * visit with a decision — the two ends of a consultation that happened.
 *
 * A booked appointment is deliberately not enough. Branch Leads is where a lead waiting
 * for a slot is worked; this roll is the people the branch has seen.
 */
const onConsultation = (l) => l.package_paid != null || !!l.consultation_decision;

/**
 * Whether a rehab programme exists for this patient: a course bought, a fee collected, or
 * a physio and days booked by branch/assign-rehab.
 *
 * `rehab_referred` on its own is deliberately not enough, for the same reason a Zumba
 * referral is not a membership — it is the Head Physio recommending rehab, which nobody
 * has acted on yet.
 */
const onRehab = (l) => (
  l.rehab_fee_paid != null || !!l.rehab_package_id || !!l.rehab_physio_id
);

/** Everything this patient has paid the branch through their lead. Many carry more than
    one fee — a Consultation Fee and a Treatment Fee, sometimes Rehab or Diet beside them —
    so the column reports the total rather than a single fee that only ever tells part of
    it. The gym and class rolls add their own on top; see buildRoll. */
const feesPaid = (l) => (
  (l.package_paid || 0) + (l.treatment_fee_paid || 0)
  + (l.rehab_fee_paid || 0) + (l.diet_fee_paid || 0)
);

/** Green once any money is in, amber while none is. Deliberately not a judgement about
    whether the whole package is settled — a partial payer is a normal treatment patient,
    and Accountant Manage is where a balance is chased. */
const PaidBadge = ({ paid }) => (
  paid > 0 ? (
    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">Paid</span>
  ) : (
    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">Awaiting</span>
  )
);

/** Which fees make up that figure. A patient whose treatment package is chosen but whose
    money has not come in yet belongs on this list and has none, so that case is named
    rather than rendering an empty pair of brackets. */
const feeParts = (l) => [
  l.package_paid != null ? "Consultation" : null,
  l.treatment_fee_paid != null ? "Treatment" : null,
  l.rehab_fee_paid != null ? "Rehab" : null,
  l.diet_fee_paid != null ? "Diet" : null,
].filter(Boolean).join(" + ") || "nothing collected yet";

/**
 * The cards over the list, in the order they are shown.
 *
 * `key` is both what the filter carries and what a row's service tags are named with, so
 * a card and the rows it counts can never be named differently in two places.
 */
const CARDS = [
  { key: "all", label: "All", color: "#6366f1" },
  { key: "consultation", label: "Consultations", color: "#0284c7" },
  { key: "treatment", label: "Treatments", color: "#059669" },
  { key: "rehab", label: "Rehab", color: "#d97706" },
  { key: "fitness", label: "Fitness", color: "#7c3aed" },
  { key: "zumba", label: "Zumba", color: "#db2777" },
];

const SERVICE_LABEL = {
  consultation: "Consultation", treatment: "Treatment", rehab: "Rehab",
  fitness: "Fitness", zumba: "Zumba",
};

// Written out rather than built off the card's hex above: Tailwind reads class names out
// of the source, so a `bg-${tone}-100` put together at runtime compiles to nothing. The
// tones follow the card colours — change one and change the other.
const SERVICE_CHIP = {
  consultation: "bg-sky-100 text-sky-700",
  treatment: "bg-emerald-100 text-emerald-700",
  rehab: "bg-amber-100 text-amber-700",
  fitness: "bg-violet-100 text-violet-700",
  zumba: "bg-pink-100 text-pink-700",
};

/** What a patient is here for, said on the row itself. One patient can be on several at
    once, which is the whole reason the cards count a person and not a purchase. */
const ServiceChips = ({ services }) => (
  <span className="flex flex-wrap gap-1">
    {services.map((s) => (
      <span key={s} className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold ${SERVICE_CHIP[s]}`}>
        {SERVICE_LABEL[s]}
      </span>
    ))}
  </span>
);

/** Last ten digits — how a gym or class registration, which carries no lead id, is matched
    back to the patient's lead. The same number is stored with +91, with a leading 0 and
    with spaces through it, so anything less than comparing the subscriber digits finds
    nothing. Returns "" for a number too short to be one, which is never matched against. */
const phoneKey = (raw) => {
  const d = String(raw || "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : "";
};

/** A stored stamp as a Date, or null. A bare "YYYY-MM-DD" — which is what a gym joining
    date is — is read as that day locally; through `new Date` it would be UTC midnight,
    landing on the day before for any viewer west of Greenwich. */
const asDate = (value) => {
  if (!value) return null;
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (ymd) return new Date(+ymd[1], +ymd[2] - 1, +ymd[3]);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * The branch's patient roll, out of the three places somebody can be on it: a lead who has
 * been consulted, treated or sent to rehab, and the gym and class rolls, which are
 * registrations in collections of their own and mostly carry no lead at all.
 *
 * One row per person, not per thing they bought. A patient on treatment who also holds a
 * gym membership is one row with two service tags — counted on both cards, listed once —
 * because the alternative is a roll whose patient count is larger than its number of
 * patients. Registrations are matched back to a lead by its id where the row carries one
 * (an accepted Zumba referral does) and by phone otherwise.
 *
 * A lead with no tag at all is not on the roll: that is somebody still being worked, and
 * Branch Leads is the board for them.
 */
const buildRoll = (leads, gymRows, classRows) => {
  const rows = new Map();
  const byLeadId = new Map();
  const byPhone = new Map();

  for (const l of leads) {
    const row = {
      key: l.id,
      lead: l,
      name: l.name || "",
      phone: l.phone || "",
      joinedAt: asDate(l.created_at),
      paid: feesPaid(l),
      services: [],
    };
    if (onConsultation(l)) row.services.push("consultation");
    if (hasTreatment(l)) row.services.push("treatment");
    if (onRehab(l)) row.services.push("rehab");
    rows.set(row.key, row);
    byLeadId.set(l.id, row);
    // First lead on a number keeps it. A second is a duplicate record of one person, and
    // the gym row that would hang off either of them is the same row.
    const pk = phoneKey(l.phone);
    if (pk && !byPhone.has(pk)) byPhone.set(pk, row);
  }

  const attach = (reg, service) => {
    const found = (reg.lead_id && byLeadId.get(reg.lead_id)) || byPhone.get(phoneKey(reg.phone));
    if (found) {
      if (!found.services.includes(service)) found.services.push(service);
      found.paid += Number(reg.fee_paid || 0);
      return;
    }
    // Nothing among the leads to hang this on: somebody who walked into the gym or the
    // class and has never been a patient anywhere else. They are on the branch's roll and
    // on their own card, but there is no lead behind them, so the row does not open — see
    // the list below.
    const key = `${service}:${reg.id}`;
    rows.set(key, {
      key,
      lead: null,
      name: reg.name || "",
      phone: reg.phone || "",
      joinedAt: asDate(reg.joined_date || reg.joined_on || reg.created_at),
      paid: Number(reg.fee_paid || 0),
      services: [service],
    });
  };

  for (const reg of gymRows) attach(reg, "fitness");
  // A referral is not a member. Those rows are read live off a lead the consultation
  // recommended Zumba for and nobody has registered yet (see _referred_rows in
  // backend/routers/v3_zumba.py); that lead is already on this roll under whatever it has
  // actually been through, and counting it here would stand the Zumba card over people who
  // never joined the class.
  for (const reg of classRows) if (reg.origin !== "consultation") attach(reg, "zumba");

  // Newest first, undated last: three sources have to be put into one order, and the
  // leads' own arrival order says nothing about where a gym row belongs among them.
  return [...rows.values()].filter((r) => r.services.length > 0).sort((a, b) => {
    if (!a.joinedAt) return b.joinedAt ? 1 : 0;
    if (!b.joinedAt) return -1;
    return b.joinedAt - a.joinedAt;
  });
};

export const PatientsPortalPanel = ({ branchId }) => {
  const [leads, setLeads] = useState([]);
  const [gym, setGym] = useState([]);
  const [classes, setClasses] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [card, setCard] = useState("all");
  // null is All Time rather than an open-ended range: the absence of a narrowing and a
  // range that happens to match everything read the same on screen but not in the code,
  // and null is the shape QuickDateFilterBar already speaks.
  const [dateFilter, setDateFilter] = useState(null);
  const [selected, setSelected] = useState(null);

  const load = useCallback(async () => {
    if (!branchId) return;
    setLoading(true);
    // Three rolls, asked for together and each allowed to fail on its own: a desk that may
    // read the branch board but not the gym's still gets its patients, with the Fitness
    // card reading zero rather than the whole panel coming up empty.
    const [board, fitness, zumba] = await Promise.all([
      getBranchBoard(branchId).catch(() => null),
      listFitness(branchId).catch(() => null),
      listZumba(branchId).catch(() => null),
    ]);
    setLeads(board?.leads || []);
    setGym(fitness?.registrations || []);
    setClasses(zumba?.registrations || []);
    setLoading(false);
  }, [branchId]);

  useEffect(() => { load(); }, [load]);

  const roll = useMemo(() => buildRoll(leads, gym, classes), [leads, gym, classes]);

  // The date narrowing comes first and the cards count what survives it, so a card's
  // figure always describes exactly the list pressing it gives you. A row with no date on
  // it at all drops out of any range asked for — it cannot be shown to be inside one.
  const inRange = useMemo(() => {
    const from = dateFilter?.from || null;
    const to = dateFilter?.to || null;
    if (!from && !to) return roll;
    return roll.filter((r) => {
      if (!r.joinedAt) return false;
      if (from && r.joinedAt < from) return false;
      if (to && r.joinedAt > to) return false;
      return true;
    });
  }, [roll, dateFilter]);

  const counts = useMemo(() => {
    const out = { all: inRange.length };
    for (const c of CARDS) {
      if (c.key === "all") continue;
      out[c.key] = inRange.filter((r) => r.services.includes(c.key)).length;
    }
    return out;
  }, [inRange]);

  const visible = useMemo(() => {
    const list = card === "all" ? inRange : inRange.filter((r) => r.services.includes(card));
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((r) => r.name.toLowerCase().includes(q) || r.phone.includes(q)
      || (r.lead?.patient_number || "").toLowerCase().includes(q));
  }, [inRange, card, search]);

  const openLead = (row) => { if (row.lead) setSelected(row.lead); };

  return (
    <div className="space-y-4" data-testid="branch-patients-panel">
      <PortalControlsCard branchId={branchId} />

      {/* Six columns for six cards on a wide screen, so the row finishes flush with the
          page. Written as literal class names because Tailwind reads them out of the
          source — a count built from CARDS.length at runtime compiles to nothing.

          `arrow` on each tile: no corner disc and no icon, just the ledger card's chevron
          on a 5px corner — the same strip the Fitness tab carries, so the two boards read
          as one family beside the Zumba strip. "desk": the chevron is sm-up only, a phone
          card is label and figure alone. */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {CARDS.map((c) => (
          <StatTile
            key={c.key}
            label={c.label}
            value={counts[c.key] ?? 0}
            arrow="desk"
            color={c.color}
            active={card === c.key}
            onClick={() => setCard(c.key)}
            testid={`branch-patients-card-${c.key}`}
          />
        ))}
      </div>

      {/* Which service, then when they joined, then who — three narrowings of one list on
          one line, in the order they cut it. The ranges sit directly under the cards they
          re-count, and the search looks inside whatever the two of them leave.

          `inline` is what lets the six ranges share a line: it tightens them to about
          330px and stops them wrapping, so the search field beside them gives up the
          width instead of the row breaking in two. The row still wraps as a whole on a
          phone, where six buttons and a text field cannot honestly share 390px — the
          field drops to its own line there rather than being squeezed to nothing. */}
      <div className="flex flex-wrap items-center gap-2" data-testid="branch-patients-toolbar">
        <QuickDateFilterBar value={dateFilter} onChange={setDateFilter} testid="branch-patients-date" inline />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search patient by name or phone..."
          className="h-10 min-w-[11rem] flex-1"
          data-testid="branch-patients-search"
        />
        {/* Refresh beside the search, icon-only and grey, as the other boards carry it. The
            list is a snapshot of the branch — a patient who pays, starts treatment or joins
            the gym in another tab appears only on a reload, and there was no way to ask
            for one. */}
        <Button
          onClick={load}
          disabled={loading}
          title="Refresh"
          aria-label="Refresh"
          className="h-10 w-10 shrink-0 bg-slate-500 p-0 text-white hover:bg-slate-600"
          data-testid="branch-patients-refresh"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      <div>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-700">
            Patients
            {card !== "all" && (
              <span className="ml-2 font-normal text-slate-400">· {CARDS.find((c) => c.key === card)?.label}</span>
            )}
          </h3>
          <span className="rounded-full bg-sky-100 px-2.5 py-0.5 text-[10px] font-semibold text-sky-700">{visible.length} patients</span>
        </div>

        {visible.length === 0 && !loading ? (
          <div className="py-16 text-center">
            <User className="mx-auto mb-3 h-10 w-10 text-slate-200" />
            {/* Two different nothings. An empty roll means nobody has reached this branch
                yet; an empty card means the filters have narrowed a roll that does have
                people on it, and saying "no patients yet" there sends the reader looking
                for missing records instead of at the card they pressed. */}
            <p className="text-sm text-slate-400">
              {roll.length === 0
                ? "No patients yet — somebody shows up here once they have been consulted, put on treatment or rehab, or joined the gym or a class"
                : "No patients under this card in the range chosen"}
            </p>
          </div>
        ) : (
          <>
          {/* Cards on a phone. Four columns can't hold their width there — the phone
              column was cut off mid-number, which is the one thing this list is used to
              look up. Call and WhatsApp sit on the card for the same reason. */}
          <div className="space-y-2 md:hidden" data-testid="branch-patients-mobile">
            {visible.map((r, i) => {
              const wa = waNumber(r.phone);
              // Only a lead has a record to open. A gym or class member registered at the
              // desk has none, so their card is a card and not a button — offering a popup
              // that cannot load anything is worse than not offering one.
              const openable = !!r.lead;
              return (
                // A div, not a button: the actions below are interactive themselves.
                <div
                  key={r.key}
                  {...(openable ? {
                    role: "button",
                    tabIndex: 0,
                    onClick: () => openLead(r),
                    onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openLead(r); } },
                  } : {})}
                  className={`w-full rounded-xl border border-slate-200 bg-white p-3 text-left ${openable ? "cursor-pointer active:bg-slate-50" : ""}`}
                  data-testid={`branch-patient-card-${r.key}`}
                >
                  <div className="flex items-start gap-2.5">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-sky-50 text-xs font-bold text-sky-700">
                      {r.name?.charAt(0)?.toUpperCase() || "?"}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        {/* The same running number the table column carries, so a reader
                            switching between phone and desk is counting one list. */}
                        <span className="truncate font-semibold text-slate-800">
                          <span className="mr-1.5 font-normal tabular-nums text-slate-400">{i + 1}.</span>
                          {r.name}
                        </span>
                        <span className="shrink-0"><PaidBadge paid={r.paid} /></span>
                      </div>
                      <p className="truncate text-xs text-slate-600">{r.phone || "—"}</p>
                      <p className="mt-0.5 text-[11px] text-slate-500">
                        Rs.{r.paid} paid
                        {r.lead && <span className="text-slate-400"> · {feeParts(r.lead)}</span>}
                      </p>
                      <div className="mt-1.5"><ServiceChips services={r.services} /></div>
                    </div>
                  </div>
                  {wa && (
                    <div className="mt-2.5 flex gap-2 border-t border-slate-100 pt-2.5">
                      <a
                        href={`tel:${wa}`}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                        className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-slate-200 py-2 text-xs font-semibold text-slate-700 active:bg-slate-100"
                        data-testid={`branch-patient-call-${r.key}`}
                      >
                        <Phone className="h-3.5 w-3.5" /> Call
                      </a>
                      <a
                        href={`https://wa.me/${wa}`}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                        className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-[#25D366]/40 bg-[#25D366]/10 py-2 text-xs font-semibold text-[#128C7E] active:bg-[#25D366]/20"
                        data-testid={`branch-patient-whatsapp-${r.key}`}
                      >
                        <WhatsAppIcon className="h-3.5 w-3.5" /> WhatsApp
                      </a>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="hidden overflow-hidden rounded-xl border border-slate-200 bg-white md:block">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-500 text-left text-xs uppercase text-white">
                <tr>
                  {/* A counted list, so "the third one down" and "17 of 53" are things the
                      reader can say out loud. The number is the row's position in what is
                      on screen, not an identity — narrow by a card, a range or the search
                      and it renumbers from 1, because it answers "how far down is this"
                      rather than "which patient is this". The patient number that does
                      identify somebody is the one on their record. */}
                  <th className="w-14 px-4 py-2.5">S:No</th>
                  <th className="px-4 py-2.5">Patient</th>
                  <th className="px-4 py-2.5">Phone</th>
                  <th className="px-4 py-2.5">Services</th>
                  <th className="px-4 py-2.5">Fees Paid</th>
                  <th className="px-4 py-2.5">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visible.map((r, i) => (
                  <tr
                    key={r.key}
                    onClick={() => openLead(r)}
                    className={`transition-colors ${r.lead ? "cursor-pointer hover:bg-slate-50" : ""}`}
                    data-testid={`branch-patient-row-${r.key}`}
                  >
                    <td className="px-4 py-3 tabular-nums text-slate-400" data-testid={`branch-patient-sno-${r.key}`}>{i + 1}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sky-50 text-xs font-bold text-sky-700">
                          {r.name?.charAt(0)?.toUpperCase() || "?"}
                        </span>
                        <span className="font-medium text-slate-800">{r.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{r.phone || "—"}</td>
                    <td className="px-4 py-3"><ServiceChips services={r.services} /></td>
                    {/* The lead's own fees are named; a gym or class membership has no
                        breakdown to name, so that row shows the figure alone rather than
                        an empty pair of brackets. */}
                    <td className="px-4 py-3 text-slate-600">
                      Rs.{r.paid} {r.lead && <span className="text-slate-400">({feeParts(r.lead)})</span>}
                    </td>
                    {/* Not a blanket "Paid": a patient can be on treatment with a balance
                        still owed, or with nothing collected yet, and both belong here. */}
                    <td className="px-4 py-3"><PaidBadge paid={r.paid} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </div>

      {selected && (
        <PatientPortalDetailModal
          lead={selected}
          onClose={() => setSelected(null)}
          onSaved={(updated) => {
            setLeads((prev) => prev.map((l) => (l.id === updated.id ? { ...l, ...updated } : l)));
            setSelected((prev) => (prev ? { ...prev, ...updated } : prev));
          }}
          onDeleted={(id) => {
            setLeads((prev) => prev.filter((l) => l.id !== id));
            setSelected(null);
          }}
        />
      )}
    </div>
  );
};

function PatientPortalDetailModal({ lead, onClose, onSaved, onDeleted }) {
  const [name, setName] = useState(lead.name || "");
  const [phone, setPhone] = useState(lead.phone || "");
  const [savingProfile, setSavingProfile] = useState(false);

  const [account, setAccount] = useState(null); // { exists, email? } | null while loading
  const [emailInput, setEmailInput] = useState(lead.email || "");
  const [creating, setCreating] = useState(false);
  const [justCreated, setJustCreated] = useState(null); // { email, password } | null
  // A reset is not undoable and changes the login for everyone on it, so the button asks
  // before it fires rather than resetting on the click that reached it.
  const [confirmingReset, setConfirmingReset] = useState(false);

  // The same dialog and the same call as the Delete button on Pre-Sales' lead list — one
  // record, one way of deleting it. See DeleteLeadDialog.
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const loadAccount = useCallback(async () => {
    try { setAccount(await getPortalAccountStatus(lead.id)); } catch { setAccount({ exists: false }); }
  }, [lead.id]);

  useEffect(() => { loadAccount(); }, [loadAccount]);

  const saveProfile = async () => {
    if (!name.trim() || !phone.trim()) { toast.error("Name and phone are required"); return; }
    setSavingProfile(true);
    try {
      const updated = await updateLead(lead.id, { name: name.trim(), phone: phone.trim() });
      toast.success("Patient details updated");
      onSaved(updated);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to update patient");
    }
    setSavingProfile(false);
  };

  // The portal logs in on the phone saved on the lead — the server reads it from there, so
  // an unsaved edit in the field above is not what the login will be.
  const savedPhoneOk = phoneDigits(lead.phone).length >= 10;

  const generateAccess = async () => {
    setCreating(true);
    setConfirmingReset(false);
    try {
      const result = await createOrResetPortalAccount(lead.id, { email: emailInput.trim() || undefined });
      setJustCreated(result);
      // Carry the new password straight onto the panel — what is shown above must be the
      // password that now signs in, without waiting for the popup to be reopened.
      setAccount((a) => ({
        ...a,
        exists: true,
        phone: result.phone,
        email: result.email,
        password: result.password || a?.password || "",
        shared_with: result.shared_with || [],
      }));
      toast.success(
        result.joined_existing ? "Added to the family's existing portal login"
          : account?.exists ? "Portal password reset" : "Portal access created",
      );
      // A patient joining a family's login inherits its password and is handed none back,
      // so the panel asks the server what it now is rather than showing nothing.
      if (result.joined_existing) await loadAccount();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to create portal access");
    }
    setCreating(false);
  };

  // One key for whichever per-client control is in flight, so a double-tap cannot fire two.
  const [working, setWorking] = useState("");

  // A password is stored only hashed, so "send it again" is a reset that emails the new one
  // — and like any reset it changes the whole family's login, which the panel says above.
  const emailAgain = async () => {
    setWorking("email");
    try {
      const result = await emailPortalLogin(lead.id);
      setJustCreated(result);
      // Sending again is a reset on the server, so the password shown above changes too.
      setAccount((a) => ({ ...a, password: result.password || a?.password || "", email_status: result.email_status }));
      if (result.email_status === "sent") toast.success(`New password emailed to ${result.email}`);
      else toast.warning("Password reset, but the email did not go — share it on WhatsApp below");
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Could not send the login");
    }
    setWorking("");
  };

  const toggleBlock = async () => {
    const next = !account?.blocked;
    setWorking("block");
    try {
      await setPortalBlocked(lead.id, next);
      setAccount((a) => ({ ...a, blocked: next }));
      if (next) setJustCreated(null);
      toast.success(next ? "Portal access blocked — signed out everywhere" : "Portal access restored");
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Could not change portal access");
    }
    setWorking("");
  };

  const toggleAutoSkip = async () => {
    const next = !account?.auto_skip;
    setWorking("skip");
    try {
      await setPortalAutoSkip(lead.id, next);
      setAccount((a) => ({ ...a, auto_skip: next }));
      toast.success(next ? "No login will be made automatically for this patient" : "Login will be made automatically when treatment is booked");
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Could not save");
    }
    setWorking("");
  };

  const shareOnWhatsApp = () => {
    if (!justCreated?.password) return;
    const num = waNumber(justCreated.phone || phone);
    if (!num) { toast.error("This patient has no phone number on file"); return; }
    // Same-tab handoff, not window.open(..., "_blank") — that leaves the tab on a
    // blank white screen on the way back on mobile (see PhysioBoard's Call/WhatsApp fix).
    window.location.href = `https://wa.me/${num}?text=${encodeURIComponent(portalWhatsAppText(name, justCreated))}`;
  };

  const copyPassword = async () => {
    if (!account?.password) return;
    try {
      await navigator.clipboard.writeText(account.password);
      toast.success("Password copied");
    } catch {
      toast.error("Could not copy — read it out instead");
    }
  };

  const copyCredentials = async () => {
    if (!justCreated?.password) return;
    const text = portalCopyText(justCreated);
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Could not copy — copy manually");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl bg-white shadow-2xl" data-testid="branch-patient-detail-modal">
        <div className="flex items-center justify-between border-b p-5">
          <h3 className="text-base font-semibold text-slate-800">{lead.name}</h3>
          <button type="button" onClick={onClose} className="rounded p-1 hover:bg-slate-100"><X className="h-5 w-5 text-slate-400" /></button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto p-5">
          <div className="space-y-3 rounded-lg border border-slate-200 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Patient Details</p>
            <div>
              <label className="mb-1 block text-[11px] font-medium text-slate-500">Name</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} className="h-9" data-testid="branch-patient-name-input" />
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-medium text-slate-500">Phone</label>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} className="h-9" data-testid="branch-patient-phone-input" />
            </div>
            <Button
              size="sm"
              className="bg-sky-600 text-xs hover:bg-sky-700"
              onClick={saveProfile}
              disabled={savingProfile || (name.trim() === lead.name && phone.trim() === lead.phone)}
              data-testid="branch-patient-save"
            >
              {savingProfile ? "Saving..." : "Save Changes"}
            </Button>
          </div>

          {/* Each fee that was actually collected, rather than a Treatment Fee row that
              read "Rs.undefined" for a patient who never had one. */}
          <div className="rounded-lg border border-slate-200 p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Fees Paid</p>
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">Rs.{feesPaid(lead)}</span>
            </div>
            <div className="space-y-1 text-xs text-slate-600">
              {feesPaid(lead) === 0 && <p className="text-slate-400">Nothing collected yet.</p>}
              {lead.package_paid != null && (
                <p>Consultation Rs.{lead.package_paid} <span className="capitalize text-slate-400">via {lead.package_payment_mode}</span></p>
              )}
              {lead.treatment_fee_paid != null && (
                <p>Treatment Rs.{lead.treatment_fee_paid} <span className="capitalize text-slate-400">via {lead.treatment_fee_payment_mode}</span></p>
              )}
              {lead.rehab_fee_paid != null && (
                <p>Rehab Rs.{lead.rehab_fee_paid} <span className="capitalize text-slate-400">via {lead.rehab_fee_payment_mode}</span></p>
              )}
              {lead.diet_fee_paid != null && (
                <p>Diet Rs.{lead.diet_fee_paid} <span className="capitalize text-slate-400">via {lead.diet_fee_payment_mode}</span></p>
              )}
            </div>
          </div>

          {/* The portal is for a course of sessions — progress to follow, a plan to read
              between visits, a balance to watch — and create_or_reset_portal_account
              refuses anyone else. Now that this list carries consultation, rehab, gym and
              class patients too, the panel says so instead of offering a button whose only
              possible outcome for most of them is the server's refusal. */}
          <div className="space-y-3 rounded-lg border border-violet-200 bg-violet-50/40 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-violet-600">Client Portal</p>

            {!hasTreatment(lead) ? (
              <p className="text-xs text-slate-500" data-testid="branch-patient-portal-unavailable">
                Only treatment patients get the Client Portal — there are no sessions here to follow yet.
              </p>
            ) : account === null ? (
              <p className="text-xs text-slate-400">Loading...</p>
            ) : (
              <>
                {account.exists && (
                  <div className="space-y-0.5 text-xs text-slate-600" data-testid="branch-patient-portal-login">
                    {account.phone && <p>Login phone: <span className="font-semibold text-slate-800">{account.phone}</span></p>}
                    {account.email && <p>Login email: <span className="font-semibold text-slate-800">{account.email}</span></p>}
                    {/* The password as it stands, shown without asking — staff are the ones
                        who read it out to the patient, and hiding it behind a reset locked
                        the rest of a shared family login out over a single lost password. */}
                    {account.password ? (
                      <p className="flex items-center gap-1.5">
                        Password: <span className="font-mono font-semibold text-slate-800" data-testid="branch-patient-portal-password">{account.password}</span>
                        <button
                          type="button"
                          onClick={copyPassword}
                          className="rounded p-1 text-slate-400 hover:bg-white hover:text-slate-600"
                          title="Copy password"
                          aria-label="Copy password"
                          data-testid="branch-patient-portal-copy-password"
                        >
                          <Copy className="h-3 w-3" />
                        </button>
                      </p>
                    ) : (
                      <p className="text-slate-500" data-testid="branch-patient-portal-password-unknown">
                        Password: not stored for this older login — reset it to see one.
                      </p>
                    )}
                    {!account.phone && !account.email && <p className="text-amber-700">This login has no phone or email — reset it after saving a phone number.</p>}
                  </div>
                )}
                {account.exists && (account.shared_with || []).length > 0 && (
                  // Resetting changes everyone on this login, so say who before the click.
                  <p className="rounded-md bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800" data-testid="branch-patient-portal-shared">
                    Shared login — also used by {account.shared_with.join(", ")}. A password reset changes it for all of them.
                  </p>
                )}

                {account.exists && (
                  <div className="space-y-2" data-testid="branch-patient-portal-controls">
                    <div className="flex flex-wrap gap-1.5 text-[10px] font-semibold">
                      {account.blocked
                        ? <span className="rounded-full bg-rose-100 px-2 py-0.5 text-rose-700">Blocked</span>
                        : <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-700">Active</span>}
                      {account.created_via && (
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">
                          {account.created_via === "auto" ? "Made automatically"
                            : account.created_via === "approved" ? "Made on approval"
                            : "Made by hand"}
                        </span>
                      )}
                      {account.email_status === "sent" && (
                        <span className="rounded-full bg-sky-100 px-2 py-0.5 text-sky-700">Email sent</span>
                      )}
                      {["failed", "not_configured"].includes(account.email_status) && (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-800">Email not sent</span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 text-xs"
                        onClick={emailAgain}
                        disabled={!!working || creating || account.blocked || !account.email}
                        data-testid="branch-patient-portal-email-again"
                      >
                        {working === "email" ? "Sending…" : "Email login again"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className={`h-8 text-xs ${account.blocked ? "" : "border-rose-200 text-rose-700 hover:bg-rose-50"}`}
                        onClick={toggleBlock}
                        disabled={!!working || creating}
                        data-testid="branch-patient-portal-block"
                      >
                        {working === "block" ? "Saving…" : account.blocked ? "Unblock access" : "Block access"}
                      </Button>
                    </div>
                    {!account.email && (
                      <p className="text-[10px] text-slate-400">No email on this login — use Reset Password and share it on WhatsApp.</p>
                    )}
                  </div>
                )}

                {!account.exists && (
                  <label className="flex items-start gap-2 text-[11px] text-slate-600" data-testid="branch-patient-portal-auto-skip">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={!!account.auto_skip}
                      disabled={!!working}
                      onChange={toggleAutoSkip}
                    />
                    <span>Don&apos;t make a login automatically when treatment is booked</span>
                  </label>
                )}

                {!account.exists && (
                  <div className="space-y-2">
                    <p className="text-[11px] text-slate-500">
                      Login phone:{" "}
                      {savedPhoneOk
                        ? <span className="font-semibold text-slate-700">{lead.phone}</span>
                        : <span className="font-semibold text-amber-700">none saved — add a 10-digit number above, or use email</span>}
                    </p>
                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-slate-500">Email (optional second login)</label>
                      <Input
                        type="email"
                        value={emailInput}
                        onChange={(e) => setEmailInput(e.target.value)}
                        placeholder="patient@example.com"
                        className="h-9"
                        data-testid="branch-patient-portal-email"
                      />
                    </div>
                  </div>
                )}

                {/* A first Generate makes a login where there was none, so it goes on the
                    click. A Reset throws away a password the patient may be using right
                    now — and every family member's with it — so it asks first. */}
                {account.exists && confirmingReset ? (
                  <div className="space-y-2 rounded-md border border-violet-300 bg-white p-3" data-testid="branch-patient-portal-reset-confirm">
                    <p className="text-xs text-slate-700">
                      Reset the password for {lead.name || "this patient"}? The password above stops working straight away
                      {(account.shared_with || []).length > 0 && <> — for {account.shared_with.join(", ")} too</>}, and a new one takes its place.
                    </p>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        className="bg-violet-600 text-xs text-white hover:bg-violet-700"
                        onClick={generateAccess}
                        disabled={creating}
                        data-testid="branch-patient-portal-reset-yes"
                      >
                        {creating ? "Working..." : "Confirm Reset"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-xs"
                        onClick={() => setConfirmingReset(false)}
                        disabled={creating}
                        data-testid="branch-patient-portal-reset-cancel"
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-xs"
                    onClick={() => (account.exists ? setConfirmingReset(true) : generateAccess())}
                    disabled={creating || (!account.exists && !savedPhoneOk && !emailInput.trim())}
                    data-testid="branch-patient-portal-generate"
                  >
                    {creating ? "Working..." : account.exists ? "Reset Password" : "Generate Portal Access"}
                  </Button>
                )}

                {justCreated?.joined_existing && (
                  <div className="rounded-md border border-violet-300 bg-white p-3 text-xs text-slate-700" data-testid="branch-patient-portal-joined">
                    Added to the login already used by {(justCreated.shared_with || []).join(", ")}. The password stays
                    the same, so nothing new needs sending — they pick this patient after signing in. Use Reset Password
                    only if the family has lost it.
                  </div>
                )}

                {justCreated?.password && (
                  <div className="space-y-2 rounded-md border border-violet-300 bg-white p-3" data-testid="branch-patient-portal-credentials">
                    <p className="text-[11px] font-semibold text-violet-700">Share these once — the password won't be shown again</p>
                    <p className="text-xs text-slate-700">Link: <span className="break-all font-mono">{portalUrl()}</span></p>
                    {credentialLines(justCreated).map(([label, value]) => (
                      <p key={label} className="text-xs text-slate-700">{label}: <span className="font-mono">{value}</span></p>
                    ))}
                    {(justCreated.shared_with || []).length > 0 && (
                      <p className="text-[11px] text-amber-700">This password now also applies to {justCreated.shared_with.join(", ")}.</p>
                    )}
                    <div className="flex gap-2 pt-1">
                      <Button size="sm" className="flex-1 bg-[#25D366] text-xs text-white hover:bg-[#1da851]" onClick={shareOnWhatsApp} data-testid="branch-patient-portal-whatsapp">
                        <WhatsAppIcon className="mr-1.5 h-3.5 w-3.5" /> Share on WhatsApp
                      </Button>
                      <Button size="sm" variant="outline" className="text-xs" onClick={copyCredentials} data-testid="branch-patient-portal-copy">
                        <Copy className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="outline" className="text-xs" onClick={() => { if (phone) window.location.href = `tel:${phone.replace(/[^0-9+]/g, "")}`; }} data-testid="branch-patient-portal-call">
                        <PhoneCall className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Real delete, not archive — permanently removes this patient and every record
              that points back at them (Branch Leads, Consultant, Physio, Diet, Zumba, the
              client portal, every fee on file), no undo. Set apart at the bottom of the
              popup, past everything else, so it can't be the thing a scroll lands on. */}
          <div className="space-y-2 rounded-lg border border-rose-200 bg-rose-50/50 p-3" data-testid="branch-patient-danger-zone">
            <p className="text-xs font-semibold uppercase tracking-wide text-rose-600">Delete Patient</p>
            <Button
              size="sm"
              variant="outline"
              className="border-rose-300 text-xs text-rose-700 hover:bg-rose-100"
              onClick={() => setConfirmingDelete(true)}
              data-testid="branch-patient-delete-open"
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete Patient
            </Button>
          </div>
        </div>
      </div>

      {confirmingDelete && (
        <DeleteLeadDialog
          lead={lead}
          noun="patient"
          extraWarning={feesPaid(lead) > 0 ? `Rs.${feesPaid(lead)} collected from this patient will no longer trace back to a record.` : ""}
          onClose={() => setConfirmingDelete(false)}
          onDeleted={onDeleted}
        />
      )}
    </div>
  );
}
