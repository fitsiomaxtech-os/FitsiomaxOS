import { useCallback, useEffect, useState } from "react";
import { CalendarCheck, CalendarX, ChevronLeft, ChevronRight, Lock, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { getBranchMonthCalendar, setBranchDayStatus } from "@/lib/api";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const iso = (d) => `${monthKey(d)}-${String(d.getDate()).padStart(2, "0")}`;
const shortDate = (s) => new Date(`${s}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

// MANAGEMENT → CALENDAR → MONTHLY CALENDAR. Which days this branch works and which it is on
// leave, one month at a time.
//
// What is set here is what the Consultant, Physiotherapist and Nutritionists calendars obey.
// A Working day is open for every one of them across their own shift timings — the server
// opens it (backend/auto_availability.py), nobody publishes it person by person. A Leave day
// is open for none of them: its open slots are taken off and no booking popup offers it.
// Taking one person off one day is done on their own calendar under MANAGEMENT.
//
// Changed by the branch's Branch Admin, Super Admin and BDE only — the server says which
// through `can_edit`, and everyone else sees it read-only.
export const BranchMonthlyCalendar = ({ branchId }) => {
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState([]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!branchId) return;
    setLoading(true);
    try {
      setData(await getBranchMonthCalendar(branchId, monthKey(month)));
    } catch (e) {
      setData(null);
      toast.error(e?.response?.data?.detail || "Could not load the monthly calendar");
    }
    setLoading(false);
  }, [branchId, month]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPicked([]); }, [branchId, month]);

  const canEdit = !!data?.can_edit;
  const days = data?.days || [];
  const todayIso = iso(new Date());
  const leadBlanks = new Date(month.getFullYear(), month.getMonth(), 1).getDay();
  const workingCount = days.filter((d) => d.status === "working").length;
  const leaveCount = days.length - workingCount;
  const monthLabel = month.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const shiftMonth = (delta) => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1));
  const toggle = (date) => {
    if (!canEdit) return;
    setPicked((p) => (p.includes(date) ? p.filter((x) => x !== date) : [...p, date].sort()));
  };

  const apply = async (status) => {
    if (picked.length === 0) return;
    const label = picked.length === 1 ? shortDate(picked[0]) : `${picked.length} days`;
    if (status === "leave" && !window.confirm(
      `Mark ${label} as Leave?\n\nConsultants, Physiotherapists and Nutritionists will not be available on ${picked.length === 1 ? "this day" : "these days"}: their open (unbooked) slots are removed and nothing new can be booked. Booked slots are kept.`,
    )) return;
    setSaving(true);
    try {
      const res = await setBranchDayStatus(branchId, picked, status);
      if (status === "leave") {
        const parts = [`${label} marked Leave`];
        if (res?.slots_removed) parts.push(`${res.slots_removed} open slot${res.slots_removed === 1 ? "" : "s"} removed`);
        if (res?.booked_slots_kept) parts.push(`${res.booked_slots_kept} booked slot${res.booked_slots_kept === 1 ? "" : "s"} still need moving`);
        (res?.booked_slots_kept ? toast.warning : toast.success)(parts.join(" · "));
      } else {
        const staff = res?.experts_available || 0;
        toast.success(`${label} marked Working${staff ? ` · ${staff} staff available across their shift timings` : ""}`);
      }
      setPicked([]);
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not update the calendar");
    }
    setSaving(false);
  };

  return (
    <div className="space-y-4" data-testid="branch-monthly-calendar">
      {/* Month switcher on the left, the month's totals on the right. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex w-full items-center justify-between gap-2 sm:w-auto sm:justify-start">
          <Button size="sm" variant="outline" onClick={() => shiftMonth(-1)} className="rounded-[4px]" data-testid="mcal-prev"><ChevronLeft className="h-4 w-4" /></Button>
          <p className="flex-1 text-center text-base font-semibold text-slate-700 sm:w-40 sm:flex-none" data-testid="mcal-month">{monthLabel}</p>
          <Button size="sm" variant="outline" onClick={() => shiftMonth(1)} className="rounded-[4px]" data-testid="mcal-next"><ChevronRight className="h-4 w-4" /></Button>
        </div>
        <div className="flex w-full flex-wrap items-center justify-center gap-2 text-xs sm:w-auto sm:justify-end">
          {canEdit && picked.length > 0 && (
            <div className="flex items-center gap-2" data-testid="mcal-actions">
              <span className="whitespace-nowrap text-sm font-semibold text-slate-700">{picked.length} day{picked.length === 1 ? "" : "s"} selected</span>
              <button type="button" onClick={() => setPicked([])} className="rounded-full p-1 text-slate-400 hover:bg-slate-100" title="Clear selection" data-testid="mcal-clear"><X className="h-4 w-4" /></button>
              <Button size="sm" disabled={saving} onClick={() => apply("working")} className="rounded-[4px] bg-emerald-600 text-white hover:bg-emerald-700" data-testid="mcal-mark-working">
                <CalendarCheck className="mr-1.5 h-4 w-4" />Working
              </Button>
              <Button size="sm" disabled={saving} onClick={() => apply("leave")} className="rounded-[4px] bg-rose-600 text-white hover:bg-rose-700" data-testid="mcal-mark-leave">
                <CalendarX className="mr-1.5 h-4 w-4" />Leave
              </Button>
            </div>
          )}
          {!canEdit && data && (
            <span className="inline-flex items-center gap-1 rounded-[4px] bg-slate-100 px-2.5 py-1.5 font-semibold text-slate-500"><Lock className="h-3 w-3" />View only</span>
          )}
          <span className="inline-flex items-baseline gap-1.5 rounded-[4px] border border-emerald-200 bg-emerald-50 px-3 py-1.5" data-testid="mcal-working-count">
            <span className="text-base font-bold leading-none text-emerald-700">{workingCount}</span>
            <span className="text-[11px] font-semibold uppercase tracking-wide text-emerald-600">Working days</span>
          </span>
          <span className="inline-flex items-baseline gap-1.5 rounded-[4px] border border-rose-200 bg-rose-50 px-3 py-1.5" data-testid="mcal-leave-count">
            <span className="text-base font-bold leading-none text-rose-600">{leaveCount}</span>
            <span className="text-[11px] font-semibold uppercase tracking-wide text-rose-500">Leave days</span>
          </span>
        </div>
      </div>

      <div className="overflow-hidden rounded-[4px] border border-slate-200 bg-white">
        <div className="grid grid-cols-7 border-b border-slate-100 bg-slate-50">
          {WEEKDAYS.map((w) => (
            <div key={w} className="py-2 text-center text-[11px] font-semibold uppercase tracking-wide text-slate-500">{w}</div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {Array.from({ length: leadBlanks }, (_, i) => <div key={`b-${i}`} className="min-h-[3.5rem] border-b border-r border-slate-100 bg-slate-50/40 sm:min-h-[6rem]" />)}
          {days.map((day) => {
            const n = Number(day.date.slice(8));
            const isLeave = day.status === "leave";
            const isPicked = picked.includes(day.date);
            const isToday = day.date === todayIso;
            const chosen = day.source !== "weekly";
            return (
              <button
                key={day.date}
                type="button"
                onClick={() => toggle(day.date)}
                disabled={!canEdit}
                title={isLeave ? `Leave${day.note ? ` — ${day.note}` : day.source === "weekly" ? " — weekly off" : ""}` : "Working"}
                className={`relative flex min-h-[3.5rem] flex-col items-center gap-1 border-b border-r border-slate-100 p-1 text-center sm:items-start sm:gap-0.5 sm:text-left transition sm:min-h-[6rem] sm:p-2 ${
                  isPicked ? "bg-sky-100 ring-2 ring-inset ring-sky-500"
                    : isLeave ? "bg-rose-50/70" : "bg-white"
                } ${canEdit ? "cursor-pointer hover:bg-sky-50" : "cursor-default"}`}
                data-testid={`mcal-day-${day.date}`}
              >
                <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold sm:text-sm ${isToday ? "bg-orange-500 text-white" : isLeave ? "text-rose-600" : "text-slate-700"}`}>{n}</span>
                {/* A phone cell is ~40px wide, where "WORKING" does not fit: a working day is
                    a green dot there, and a leave day keeps its short word. */}
                <span className={`rounded px-1 py-0.5 text-[9px] font-bold uppercase leading-none sm:text-[10px] ${isLeave ? "bg-rose-100 text-rose-600" : "hidden bg-emerald-100 text-emerald-700 sm:inline"}`}>
                  {isLeave ? (day.source === "weekly" ? "Off" : "Leave") : "Working"}
                </span>
                {!isLeave && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 sm:hidden" />}
                {day.note && <span className="hidden w-full break-words sm:line-clamp-2 text-[10px] font-medium text-rose-500">{day.note}</span>}
                {chosen && <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-amber-400" title="Set on this calendar" />}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-3 text-[11px] text-slate-500 sm:justify-start">
        <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded bg-emerald-100" />Working</span>
        <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded bg-rose-100" />Leave / weekly off</span>
        <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-amber-400" />Changed on this calendar</span>
      </div>

      {loading && <p className="text-center text-xs text-slate-400">Loading…</p>}
    </div>
  );
};
