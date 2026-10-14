import { HeartHandshake } from "lucide-react";

/**
 * The branch's Activity Care tab. Empty on purpose for now: the tab goes in ahead of what
 * will sit behind it, so its place in the strip is settled while the panel is decided.
 */
export const ActivityCarePanel = () => (
  <div
    className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-slate-200 bg-white px-4 py-16 text-center"
    data-testid="activity-care-panel"
  >
    <HeartHandshake className="h-8 w-8 text-sky-600" />
    <p className="text-sm font-semibold text-slate-700">Activity Care</p>
    <p className="text-xs text-slate-500">Coming soon.</p>
  </div>
);
