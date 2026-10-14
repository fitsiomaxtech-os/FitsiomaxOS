import { useState } from "react";
import { ClipboardCheck, Dumbbell, Music, Settings, User, UserCog } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ZumbaPanel } from "@/components/branch/ZumbaPanel";
import { FitnessPanel } from "@/components/branch/FitnessPanel";
import { BranchReviewPanel } from "@/components/branch/BranchReviewPanel";
import { ZumbaMastersPanel } from "@/components/branch/ZumbaMastersPanel";
import { PatientsPortalPanel } from "@/components/branch/PatientsPortalPanel";
import { BranchDetailPage } from "@/components/branch/BranchDetailPage";

/**
 * The branch's Activity Care tab: Zumba, Fitness and Review, which used to be top-level tabs
 * of their own, and Patients and Manager, which used to be Management's, as sub-tabs under one.
 */
const SUB_TABS = [
  // The other list of people the branch is signing up — but its own list, not a stage of
  // Branch Leads: nobody registering for a Zumba class is consulted, treated or discharged.
  { key: "zumba", label: "Zumba", icon: Music },
  // Beside Zumba because both are class-based memberships the branch sells and renews,
  // rather than treatment a patient is referred for.
  { key: "fitness", label: "Fitness", icon: Dumbbell },
  { key: "review", label: "Review", icon: ClipboardCheck },
  // The branch's registered patients, from the Client Portal.
  { key: "patients", label: "Patients", icon: User },
  // The branch's details and its manager, read-only.
  { key: "manager", label: "Manager", icon: UserCog },
];

// The two desks that only exist in a room. Zumba is a class taught in the branch's studio
// in two fixed morning slots, and Fitness is the gym's membership roll — who is training,
// who is paused, who owes on a package. Neither is something an arm with no floor sells.
export const ROOM_ONLY_TABS = ["zumba", "fitness"];

export const ActivityCarePanel = ({ branchId, withoutRoom = false }) => {
  const tabs = withoutRoom ? SUB_TABS.filter((t) => !ROOM_ONLY_TABS.includes(t.key)) : SUB_TABS;
  // Opens on the first tab it has: Zumba, or Review on an online arm.
  const [active, setActive] = useState(tabs[0].key);
  // Zumba Masters — which master takes each class time. It used to be Management's Zumba
  // sub-tab; it is set once and left, so it sits behind the gear rather than a tab.
  const [mastersOpen, setMastersOpen] = useState(false);

  return (
    <div className="flex flex-col gap-4" data-testid="activity-care-panel">
      {/* The same underlined strip as Records' sub-tabs, with Zumba's gear at its end. */}
      <div className="flex items-center gap-2 border-b border-slate-200">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" data-testid="activity-care-subtabs">
          {tabs.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setActive(t.key)}
                className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-xs font-medium sm:text-sm ${
                  active === t.key ? "border-sky-500 text-sky-700" : "border-transparent text-slate-400 hover:text-slate-600"
                }`}
                data-testid={`activity-care-subtab-${t.key}`}
              >
                <Icon className="h-4 w-4" /> {t.label}
              </button>
            );
          })}
        </div>
        {active === "zumba" && (
          <button
            type="button"
            onClick={() => setMastersOpen(true)}
            className="mb-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-[5px] bg-sky-600 text-white shadow-sm transition hover:bg-sky-700"
            title="Zumba Masters"
            aria-label="Zumba Masters"
            data-testid="activity-care-zumba-settings"
          >
            <Settings className="h-4 w-4" />
          </button>
        )}
      </div>
      <Dialog open={mastersOpen} onOpenChange={setMastersOpen}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto" data-testid="zumba-masters-dialog">
          {/* The panel carries its own Zumba Masters heading; these are for screen readers. */}
          <DialogHeader className="sr-only">
            <DialogTitle>Zumba Masters</DialogTitle>
            <DialogDescription>Which master takes each Zumba class time.</DialogDescription>
          </DialogHeader>
          {mastersOpen && <ZumbaMastersPanel branchId={branchId} />}
        </DialogContent>
      </Dialog>
      {active === "zumba" ? (
        <ZumbaPanel branchId={branchId} />
      ) : active === "fitness" ? (
        <FitnessPanel branchId={branchId} />
      ) : active === "patients" ? (
        <PatientsPortalPanel branchId={branchId} />
      ) : active === "manager" ? (
        <BranchDetailPage branchId={branchId} readOnly />
      ) : (
        <BranchReviewPanel branchId={branchId} />
      )}
    </div>
  );
};
