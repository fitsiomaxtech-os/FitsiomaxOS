import { useState } from "react";
import { ChevronDown, ChevronRight, EyeOff, FileSpreadsheet, Lock } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { layoutLabel, onCount, usableColumn } from "@/lib/pastData";

const n = (v) => (v || 0).toLocaleString("en-IN");
// Radix Select has no empty value: a column kept as an extra detail is this, sent as "".
const EXTRA = "__extra__";
const chip = "inline-flex whitespace-nowrap rounded-[5px] border px-1.5 py-0.5 text-[10px] font-bold";

/**
 * Auto Scan's result, for turning things on and off before Fetch: one card per tab of the
 * workbook, a switch for the tab and a tick for each header under it, with a few of the values
 * it holds (backend past_scan.py).
 *
 * On a custom sheet — anything that is not the register, a revenue sheet or the OS Data
 * workbook — each column also says which OS field it goes into (matched off its header by the
 * scan), or "Keep as extra detail", which keeps it under its own header on the client's card.
 * One field goes to one column a tab: giving it to another takes it off the first.
 *
 * On the three known layouts, what the reader cannot do without is locked on ("Needed"), and a
 * column it does not read at all is shown greyed ("Not read"), since on or off changes nothing.
 */
export const PastDataScanPicker = ({ scan, picks, onChange, problems = {}, disabled = false }) => {
  const custom = scan.layout === "custom";
  const fieldLabels = Object.fromEntries((scan.fields || []).map((f) => [f.key, f.label]));
  // Every tab left on starts open; one turned off, empty or not read starts closed.
  const [open, setOpen] = useState(() => new Set(scan.tabs.filter((t) => t.on).map((t) => t.name)));

  const toggleOpen = (name) => setOpen((cur) => {
    const next = new Set(cur);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });
  const setTab = (name, patch) => onChange({ ...picks, [name]: { ...picks[name], ...patch } });
  const setCol = (name, index, patch) => {
    const cols = { ...picks[name].cols, [index]: { ...picks[name].cols[index], ...patch } };
    if (patch.field) {
      // One OS field, one column: the column that had it goes back to an extra detail.
      Object.keys(cols).forEach((k) => {
        if (Number(k) !== index && cols[k].field === patch.field) cols[k] = { ...cols[k], field: "" };
      });
    }
    setTab(name, { cols });
  };
  const setAll = (tab, on) => setTab(tab.name, {
    cols: Object.fromEntries(tab.columns.map((c) => [c.index, { ...picks[tab.name].cols[c.index], on: usableColumn(c) && (on || c.required) }])),
  });

  const tabsOn = scan.tabs.filter((t) => t.used && picks[t.name]?.on);

  return (
    <div className="space-y-3" data-testid="past-scan">
      <p className="text-sm text-slate-600" data-testid="past-scan-summary">
        <span className={`${chip} mr-2 border-sky-200 bg-sky-50 text-sky-700`}>{layoutLabel(scan.layout)}</span>
        {scan.tabs.length} sheet{scan.tabs.length === 1 ? "" : "s"} found · {tabsOn.length} on ·{" "}
        {n(tabsOn.reduce((sum, t) => sum + onCount(t, picks[t.name]), 0))} headers to fetch
      </p>

      {scan.tabs.map((tab) => {
        const pick = picks[tab.name] || { on: false, cols: {} };
        const expanded = open.has(tab.name) && tab.used;
        const usable = tab.columns.filter(usableColumn).length;
        const tabOff = !pick.on;
        return (
          <div
            key={tab.name}
            className={`rounded-[5px] border bg-white ${problems[tab.name] ? "border-rose-300" : "border-slate-200"} ${tab.used ? "" : "opacity-60"}`}
            data-testid={`past-scan-tab-${tab.name}`}
          >
            <div className="flex items-center gap-3 px-3 py-2.5">
              <Switch
                checked={pick.on}
                onCheckedChange={(v) => setTab(tab.name, { on: v })}
                disabled={disabled || !tab.used || tab.required}
                aria-label={`Fetch ${tab.name}`}
                className="data-[state=checked]:bg-emerald-600"
                data-testid={`past-scan-tab-switch-${tab.name}`}
              />
              <button
                type="button"
                onClick={() => toggleOpen(tab.name)}
                disabled={!tab.used}
                className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default"
                aria-expanded={expanded}
                data-testid={`past-scan-tab-open-${tab.name}`}
              >
                <FileSpreadsheet className="h-4 w-4 shrink-0 text-emerald-600" />
                <span className="min-w-0 truncate text-sm font-semibold text-slate-800">{tab.name}</span>
                {tab.hidden && <span className={`${chip} border-slate-200 bg-slate-50 text-slate-500`}><EyeOff className="mr-1 h-3 w-3" />Hidden</span>}
                {tab.required && <span className={`${chip} border-amber-200 bg-amber-50 text-amber-700`}>Needed</span>}
                <span className="hidden truncate text-xs text-slate-400 sm:inline">
                  {tab.used ? `${n(tab.rows)} rows · headers on row ${tab.header_row}` : tab.note}
                </span>
              </button>
              {tab.used && (
                <span className={`shrink-0 text-xs font-semibold ${tabOff ? "text-slate-400" : "text-slate-600"}`} data-testid={`past-scan-tab-count-${tab.name}`}>
                  {tabOff ? "Off" : `${onCount(tab, pick)} / ${usable}`}
                </span>
              )}
              {tab.used && (expanded ? <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" /> : <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" />)}
            </div>
            {!tab.used && <p className="px-3 pb-2 text-xs text-slate-400 sm:hidden">{tab.note}</p>}

            {expanded && (
              <div className={`border-t border-slate-100 ${tabOff ? "opacity-50" : ""}`}>
                <div className="flex items-center justify-between gap-2 bg-slate-50 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  <span>Header</span>
                  <span className="flex items-center gap-3">
                    <button type="button" className="font-bold uppercase text-sky-600 hover:underline disabled:text-slate-300 disabled:no-underline" onClick={() => setAll(tab, true)} disabled={disabled || tabOff} data-testid={`past-scan-all-${tab.name}`}>All</button>
                    <button type="button" className="font-bold uppercase text-sky-600 hover:underline disabled:text-slate-300 disabled:no-underline" onClick={() => setAll(tab, false)} disabled={disabled || tabOff} data-testid={`past-scan-none-${tab.name}`}>None</button>
                  </span>
                </div>
                <ul className="divide-y divide-slate-100">
                  {tab.columns.map((c) => {
                    const col = pick.cols[c.index] || { on: false, field: "" };
                    const on = c.required || (usableColumn(c) && col.on);
                    const id = `past-scan-${tab.name}-${c.index}`;
                    return (
                      <li key={c.index} className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 sm:flex-nowrap ${usableColumn(c) ? "" : "opacity-50"}`} data-testid={`past-scan-col-${tab.name}-${c.index}`}>
                        <Checkbox
                          id={id}
                          checked={on}
                          onCheckedChange={(v) => setCol(tab.name, c.index, { on: !!v })}
                          disabled={disabled || tabOff || !usableColumn(c) || c.required}
                          className="border-slate-300 data-[state=checked]:border-sky-600 data-[state=checked]:bg-sky-600"
                          data-testid={`past-scan-check-${tab.name}-${c.index}`}
                        />
                        <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer sm:w-44 sm:flex-none">
                          <span className={`block truncate text-sm font-medium ${c.header ? "text-slate-800" : "italic text-slate-400"}`}>{c.header || "(no header)"}</span>
                          <span className="block text-[10px] text-slate-400">Column {c.letter} · {n(c.filled)} filled</span>
                        </label>
                        <p className="order-last w-full min-w-0 truncate text-xs text-slate-500 sm:order-none sm:w-auto sm:flex-1" title={c.samples.join(" · ")}>
                          {c.samples.length ? c.samples.join(" · ") : <span className="italic text-slate-300">empty</span>}
                        </p>
                        {custom ? (
                          <Select
                            value={col.field || EXTRA}
                            onValueChange={(v) => setCol(tab.name, c.index, { field: v === EXTRA ? "" : v, on: true })}
                            disabled={disabled || tabOff || !on}
                          >
                            <SelectTrigger
                              className={`h-8 w-44 shrink-0 text-xs ${col.field ? "border-sky-200 bg-sky-50/60 font-semibold text-sky-800" : "text-slate-500"}`}
                              aria-label={`OS field for ${c.header || `column ${c.letter}`}`}
                              data-testid={`past-scan-field-${tab.name}-${c.index}`}
                            >
                              <SelectValue>{col.field ? fieldLabels[col.field] : "Keep as extra detail"}</SelectValue>
                            </SelectTrigger>
                            <SelectContent className="max-h-72">
                              <SelectItem value={EXTRA} className="text-xs text-slate-500">Keep as extra detail</SelectItem>
                              {scan.fields.map((f) => (
                                <SelectItem key={f.key} value={f.key} className="text-xs">{f.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : c.required ? (
                          <span className="inline-flex w-24 shrink-0 items-center gap-1 text-[10px] font-bold uppercase text-amber-600" title="This sheet cannot be read without it">
                            <Lock className="h-3 w-3" />Needed
                          </span>
                        ) : !usableColumn(c) ? (
                          <span className="w-24 shrink-0 text-[10px] font-bold uppercase text-slate-400" title={`The ${layoutLabel(scan.layout)} reader does not read this column`}>Not read</span>
                        ) : (
                          <span className="w-24 shrink-0" />
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            {problems[tab.name] && (
              <p className="border-t border-rose-100 bg-rose-50 px-3 py-2 text-xs text-rose-700" data-testid={`past-scan-problem-${tab.name}`}>{problems[tab.name]}</p>
            )}
          </div>
        );
      })}
      {problems[""] && <p className="text-xs text-rose-700" data-testid="past-scan-problem">{problems[""]}</p>}
    </div>
  );
};

export default PastDataScanPicker;
