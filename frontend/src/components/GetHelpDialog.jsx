import { useEffect, useRef, useState } from "react";
import { FileText, MessageSquare, ShieldCheck } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { LegalText, legalTitle } from "@/pages/LegalPage";
import { LEGAL_LAST_UPDATED } from "@/lib/legalContent";

const TABS = [
  { key: "terms", label: "Terms & Conditions", icon: FileText },
  { key: "privacy", label: "Privacy Policy", icon: ShieldCheck },
  { key: "feedback", label: "Send Feedback", icon: MessageSquare },
];

/**
 * My Profile's Get Help, drawn exactly as the header bell's Notifications popup: 980 x 750,
 * the tabs down the left, the open one on the right. Terms and Privacy are the same text as
 * the sign-in screens' /terms and /privacy pages. Send Feedback has nowhere to send to yet.
 */
export function GetHelpDialog({ open, onOpenChange }) {
  const [tab, setTab] = useState("terms");
  const paneRef = useRef(null);

  // Opens on Terms each time, and a new tab starts from its top.
  useEffect(() => { if (open) setTab("terms"); }, [open]);
  useEffect(() => { paneRef.current?.scrollTo?.(0, 0); }, [tab]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="flex h-[100dvh] w-full max-w-none flex-col gap-0 overflow-hidden rounded-none p-0 sm:h-[750px] sm:max-h-[calc(100vh-2rem)] sm:w-[980px] sm:max-w-[calc(100vw-2rem)] sm:rounded-[4px]"
        data-testid="get-help-popover"
      >
        <header className="flex shrink-0 items-center border-b border-slate-200 py-3 pl-5 pr-12">
          <DialogTitle className="text-base font-semibold text-slate-900">Get Help</DialogTitle>
        </header>
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <nav aria-label="Get Help tabs" className="flex shrink-0 gap-1 overflow-x-auto border-b border-slate-200 bg-slate-50/60 p-2 text-xs sm:w-56 sm:flex-col sm:border-b-0 sm:border-r" data-testid="get-help-tabs">
            {TABS.map((t) => {
              const on = tab === t.key;
              const Icon = t.icon;
              return (
                <button
                  type="button"
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  aria-current={on ? "page" : undefined}
                  className={`flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-left focus-visible:outline-sky-600 ${on ? "bg-sky-50 font-semibold text-sky-600" : "text-slate-600 hover:bg-white"}`}
                  data-testid={`get-help-tab-${t.key}`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1">{t.label}</span>
                </button>
              );
            })}
          </nav>

          <div ref={paneRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto" data-testid={`get-help-pane-${tab}`}>
            {tab === "feedback" ? (
              <p className="px-5 py-16 text-center text-sm text-slate-400" data-testid="get-help-feedback-empty">Send Feedback is coming soon</p>
            ) : (
              <div className="px-5 py-4">
                <h2 className="text-base font-semibold text-slate-900">{legalTitle(tab)}</h2>
                <p className="mt-0.5 text-xs text-slate-400">Last updated: {LEGAL_LAST_UPDATED}</p>
                <LegalText kind={tab} onPrivacy={() => setTab("privacy")} className="mt-4" />
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default GetHelpDialog;
