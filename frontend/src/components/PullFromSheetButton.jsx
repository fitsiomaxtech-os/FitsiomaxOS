import { useState } from "react";
import { FileSpreadsheet, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { gsAutoSyncSources, gsPull } from "@/lib/api";

/**
 * PullFromSheetButton
 * Manually pulls latest leads from connected Google Sheet sources (server-side
 * scoped to the caller — Branch Admin only ever sees/pulls sources tagged with
 * their own branch) using the same backend function as the "Pull from Sheet"
 * button in Source Connection.
 * Props:
 *  - onPulled: () => void  — called after a successful pull, used to refresh leads list
 *  - notConnectedHint / noSourcesHint: optional override text for the empty-state toasts
 *  - iconOnly: renders just the spinning-refresh icon, no label — same action, more compact
 *  - phoneSmall: with iconOnly, 32px below sm to match a phone toolbar of that size
 *  - soft: with iconOnly, a bordered light-green wash with a spreadsheet icon (Pre Sales'
 *    toolbar), so it no longer wears the same arrows as the Refresh button beside it
 */
export const PullFromSheetButton = ({ onPulled, notConnectedHint, noSourcesHint, iconOnly, phoneSmall, soft }) => {
  const [busy, setBusy] = useState(false);

  const pullAll = async () => {
    setBusy(true);
    try {
      const status = await gsAutoSyncSources();
      if (!status.connected) {
        toast.error(notConnectedHint || "Google Sheets not connected. Connect from Marketing Board → Lead Sources first.");
        return;
      }
      const sources = (status.sources || []).filter((s) => s.spreadsheet_id);
      if (sources.length === 0) {
        toast.error(noSourcesHint || "No Google Sheet sources configured yet.");
        return;
      }
      let totalImported = 0;
      let totalDup = 0;
      let totalNoPhone = 0;
      const errors = [];
      // Run pulls in parallel — much faster, avoids serial-timeout cascades
      const results = await Promise.allSettled(sources.map((s) => gsPull(s.id)));
      results.forEach((res, i) => {
        const s = sources[i];
        if (res.status === "fulfilled") {
          const r = res.value || {};
          totalImported += r.imported || 0;
          totalDup += r.skipped_duplicate || 0;
          totalNoPhone += r.skipped_no_phone || 0;
        } else {
          const detail = res.reason?.code === "ECONNABORTED"
            ? "timed out — it may still be importing, refresh in a minute"
            : res.reason?.response?.data?.detail || res.reason?.message || "failed";
          errors.push(`${s.name}: ${String(detail).slice(0, 80)}`);
        }
      });
      if (errors.length) {
        toast.error(`Some sources failed: ${errors.join(" | ")}`);
      }
      if (totalImported > 0) {
        toast.success(`Pulled ${totalImported} new lead${totalImported === 1 ? "" : "s"} from ${sources.length} sheet${sources.length === 1 ? "" : "s"}`);
      } else if (!errors.length) {
        toast(`No new leads. ${totalDup} duplicates skipped, ${totalNoPhone} rows missing phone.`);
      }
      onPulled && onPulled();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Pull failed");
    } finally {
      // In finally, not after the try: the not-connected and no-sources checks return
      // early, and the spinner used to stay on after either until the page was reloaded.
      setBusy(false);
    }
  };

  if (iconOnly && soft) {
    return (
      <Button
        onClick={pullAll}
        disabled={busy}
        title="Pull from Sheet"
        aria-label="Pull from Sheet"
        className="h-10 w-10 shrink-0 border border-slate-200 bg-emerald-50 p-0 text-emerald-600 shadow-none hover:bg-emerald-100"
        data-testid="presales-pull-from-sheet-btn"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
      </Button>
    );
  }

  if (iconOnly) {
    return (
      <Button
        onClick={pullAll}
        disabled={busy}
        title="Pull from Sheet"
        aria-label="Pull from Sheet"
        className={`h-10 w-10 ${phoneSmall ? "max-sm:h-8 max-sm:w-8 max-sm:[&_svg]:!size-3.5" : ""} shrink-0 rounded-full border-emerald-600 bg-emerald-600 p-0 text-white shadow-sm hover:bg-emerald-700`}
        data-testid="presales-pull-from-sheet-btn"
      >
        <RefreshCw className={`h-4 w-4 ${phoneSmall ? "max-sm:h-3.5 max-sm:w-3.5" : ""} ${busy ? "animate-spin" : ""}`} />
      </Button>
    );
  }

  return (
    <Button
      onClick={pullAll}
      disabled={busy}
      className="h-10 border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700"
      data-testid="presales-pull-from-sheet-btn"
    >
      <RefreshCw className={`mr-1 h-4 w-4 ${busy ? "animate-spin" : ""}`} />
      {busy ? "Pulling..." : "Pull from Sheet"}
    </Button>
  );
};
