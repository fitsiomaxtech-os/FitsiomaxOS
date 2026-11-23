import { useEffect, useState } from "react";
import { Loader2, MapPin, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { getBranchLocation, resolveBranchLocationLink, saveBranchLocation } from "@/lib/api";

const MAX_LEN = 1000;
const SHORT_HOSTS = /^(maps\.app\.goo\.gl|goo\.gl|g\.co)$/i;
const GOOGLE_HOST = /^((www|maps)\.)?google\.(com|co\.[a-z]{2}|com\.[a-z]{2}|[a-z]{2})$/i;

/** What a Google Maps link points at, as a map search: the place's pin when the link
 *  carries one, else its query or place name, else the spot the map was centred on.
 *  "" for a link the map frame can't draw. */
const queryFromMapsUrl = (raw) => {
  let u;
  try { u = new URL(raw); } catch { return ""; }
  if (!GOOGLE_HOST.test(u.hostname)) return "";
  const pin = raw.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (pin) return `${pin[1]},${pin[2]}`;
  const q = u.searchParams.get("q") || u.searchParams.get("query") || u.searchParams.get("destination") || u.searchParams.get("ll");
  if (q) return q;
  const place = u.pathname.match(/\/maps\/(?:place|search)\/([^/@]+)/);
  if (place) return decodeURIComponent(place[1].replace(/\+/g, " "));
  const at = u.pathname.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  return at ? `${at[1]},${at[2]}` : "";
};

const embedSrc = (q) => (q ? `https://maps.google.com/maps?q=${encodeURIComponent(q)}&z=16&output=embed` : "");

/**
 * Admin Setting > Branch Location: where this branch is, as an address, a "lat,lng" or a
 * Google Maps link. It is the link the appointment WhatsApp sends under "<branch>
 * location:" and the confirmation page's Open in Maps. The map below draws whatever is
 * typed, so the desk sees the place the patient will be sent to before saving it.
 *
 * A plain overlay, like the other popups in the same menu.
 */
export const BranchLocationDialog = ({ branchId, onClose }) => {
  const [branchName, setBranchName] = useState("");
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // The map follows the box after a pause in typing, not on every key.
  const [query, setQuery] = useState("");
  const [resolving, setResolving] = useState(false);
  const [mapNote, setMapNote] = useState("");

  useEffect(() => {
    let live = true;
    getBranchLocation(branchId)
      .then((r) => { if (!live) return; setBranchName(r.branch_name); setValue(r.map_location); setSaved(r.map_location); })
      .catch((e) => { if (live) toast.error(e?.response?.data?.detail || "Couldn't load the branch location"); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [branchId]);

  useEffect(() => {
    const v = value.trim();
    let live = true;
    const t = setTimeout(async () => {
      setMapNote("");
      if (!v) { setQuery(""); return; }
      if (!/^https?:\/\//i.test(v)) { setQuery(v); return; }
      let host = "";
      try { host = new URL(v).hostname; } catch { /* not a link after all */ }
      if (SHORT_HOSTS.test(host)) {
        // A short share link: the server follows it to the full Maps link.
        setResolving(true);
        try {
          const r = await resolveBranchLocationLink(branchId, v);
          if (!live) return;
          const q = queryFromMapsUrl(r.url);
          setQuery(q);
          if (!q) setMapNote("This link can't be shown on the map. It will still be sent as it is.");
        } catch (e) {
          if (!live) return;
          setQuery("");
          setMapNote(e?.response?.data?.detail || "This link can't be shown on the map.");
        } finally {
          if (live) setResolving(false);
        }
        return;
      }
      const q = queryFromMapsUrl(v);
      setQuery(q);
      if (!q) setMapNote("Only a Google Maps link can be shown on the map. It will still be sent as it is.");
    }, 600);
    return () => { live = false; clearTimeout(t); setResolving(false); };
  }, [value, branchId]);

  const save = async () => {
    setSaving(true);
    try {
      const r = await saveBranchLocation(branchId, value.trim());
      setValue(r.map_location);
      setSaved(r.map_location);
      toast.success(r.map_location ? "Branch location saved" : "Branch location cleared");
      onClose();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't save the branch location");
    } finally {
      setSaving(false);
    }
  };

  const dirty = value.trim() !== saved.trim();
  const src = embedSrc(query);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }} data-testid="branch-location-dialog">
      {/* 775 x 560: the box keeps the top, the map takes the rest. */}
      <div className="flex h-[560px] max-h-[90vh] w-full max-w-[775px] flex-col overflow-hidden rounded-[4px] bg-white shadow-2xl">
        {/* The same blue header as the Branch lead popup's. */}
        <div className="flex items-center justify-between gap-3 border-b border-sky-700 bg-[#0284C7] px-5 py-3">
          <h3 className="flex min-w-0 items-center gap-2 text-base font-semibold text-white">
            <MapPin className="h-4 w-4 shrink-0 text-white" />
            <span className="shrink-0">Branch Location</span>
            {branchName && <span className="truncate text-sm font-normal text-white/80">{branchName}</span>}
          </h3>
          <button type="button" onClick={onClose} disabled={saving} className="rounded-[4px] p-1 text-white/90 transition hover:bg-white/15 hover:text-white" aria-label="Close" data-testid="branch-location-close"><X className="h-4 w-4" /></button>
        </div>

        {loading ? (
          <div className="flex flex-1 items-center justify-center text-slate-400"><Loader2 className="h-5 w-5 animate-spin" /></div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
            <div className="flex gap-2">
              <div className="relative min-w-0 flex-1">
                <MapPin aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && dirty && !saving) save(); }}
                  maxLength={MAX_LEN}
                  placeholder="Enter the location or paste the Google Maps link"
                  className="h-10 w-full rounded-[4px] border border-slate-200 pl-9 pr-3 text-sm text-slate-800 placeholder:text-slate-400 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-100"
                  autoFocus
                  data-testid="branch-location-input"
                />
              </div>
              <Button type="button" onClick={save} disabled={saving || !dirty} className="h-10 shrink-0 rounded-[4px] bg-sky-600 px-5 hover:bg-sky-700" data-testid="branch-location-save">
                {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}Save
              </Button>
            </div>

            <div className="relative min-h-0 flex-1 overflow-hidden rounded-[4px] border border-slate-200 bg-slate-50" data-testid="branch-location-map">
              {src ? (
                <iframe
                  key={src}
                  title="Branch location map"
                  src={src}
                  className="h-full w-full border-0"
                  loading="lazy"
                  referrerPolicy="no-referrer-when-downgrade"
                  allowFullScreen
                  data-testid="branch-location-map-frame"
                />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-slate-400">
                  <MapPin className="h-8 w-8 text-slate-300" />
                  {mapNote || "The map shows here as you enter the location."}
                </div>
              )}
              {resolving && (
                <div className="absolute inset-0 flex items-center justify-center bg-white/60"><Loader2 className="h-5 w-5 animate-spin text-sky-600" /></div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
