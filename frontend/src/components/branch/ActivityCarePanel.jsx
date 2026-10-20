import { useState } from "react";
import { Activity, ChevronLeft, ClipboardCheck, Dumbbell, Music, Settings, Stethoscope, User, UserCog } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ZumbaPanel } from "@/components/branch/ZumbaPanel";
import { FitnessPanel } from "@/components/branch/FitnessPanel";
import { BranchReviewPanel } from "@/components/branch/BranchReviewPanel";
import { ZumbaMastersPanel } from "@/components/branch/ZumbaMastersPanel";
import { PatientsPortalPanel } from "@/components/branch/PatientsPortalPanel";
import { BranchDetailPage } from "@/components/branch/BranchDetailPage";
import { TeamPanel } from "@/components/branch/TeamPanel";
import { PortalControlsButton } from "@/components/branch/PortalControlsButton";
import { TabDotFor, useTabDot, useTabDotClick } from "@/components/ui/tab-dot";
import { NotifyCard } from "@/components/ui/notify-card";

/**
 * The branch's Activity Care tab: Zumba, Fitness and Review, which used to be top-level tabs
 * of their own, Patients and Manager, which used to be Management's, and the branch's two
 * teams, as sub-tabs under one.
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
  // Every consultant and every physio across the organisation, filtered by branch and gender.
  { key: "team_consultants", label: "Team Consultants", short: "Consultants", icon: Stethoscope },
  { key: "team_physio", label: "Team Physio", short: "Physio", icon: Activity },
];


// The two desks that only exist in a room. Zumba is a class taught in the branch's studio
// in two fixed morning slots, and Fitness is the gym's membership roll — who is training,
// who is paused, who owes on a package. Neither is something an arm with no floor sells.
export const ROOM_ONLY_TABS = ["zumba", "fitness"];

// The shared grey every phone card list on Branch Admin is drawn in (PHONE_CARD_HEX there).
const PHONE_CARD_HEX = "#64748b";

// One sub-tab as a phone card: Management's sub-tab card, no count, with the tab's red
// new-since-last-opened dot. Its own component so each card can ask for its own dot.
const SubTabCard = ({ tab, active, onClick }) => (
  <NotifyCard
    icon={tab.icon}
    label={tab.label}
    color={PHONE_CARD_HEX}
    showCount={false}
    dot={useTabDot(`activity_care.${tab.key}`)}
    active={active}
    onClick={onClick}
    testid={`activity-care-subtab-card-${tab.key}`}
  />
);

export const ActivityCarePanel = ({ branchId, withoutRoom = false }) => {
  const tabs = withoutRoom ? SUB_TABS.filter((t) => !ROOM_ONLY_TABS.includes(t.key)) : SUB_TABS;
  // Opens on the first tab it has: Zumba, or Review on an online arm.
  const [active, setActive] = useState(tabs[0].key);
  const clickDot = useTabDotClick();
  // Zumba Masters — which master takes each class time. It used to be Management's Zumba
  // sub-tab; it is set once and left, so it sits behind the gear rather than a tab.
  const [mastersOpen, setMastersOpen] = useState(false);
  // The right end of the tab strip, where a Team tab puts its Branch and Gender filters and
  // its Refresh from 2xl up (see TeamPanel's toolbarSlot). A node in state rather than a ref,
  // so the panel re-renders into it once it exists.
  const [toolbar, setToolbar] = useState(null);
  // Phone only, as Management does it: the sub-tabs are a stack of cards, and a tap opens
  // that tab on a screen of its own with a back bar above it. From sm up nothing reads it.
  const [phoneOpen, setPhoneOpen] = useState(false);
  const activeTab = tabs.find((t) => t.key === active) || tabs[0];
  const ActiveIcon = activeTab.icon;
  const zumbaGear = (testid) => (
    <button
      type="button"
      onClick={() => setMastersOpen(true)}
      className="mb-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-[5px] bg-sky-600 text-white shadow-sm transition hover:bg-sky-700"
      title="Zumba Masters"
      aria-label="Zumba Masters"
      data-testid={testid}
    >
      <Settings className="h-4 w-4" />
    </button>
  );

  return (
    <div className="flex flex-col gap-4" data-testid="activity-care-panel">
      {/* Phone, one tab open: where the cards sat, the tab being read, the way back to the
          cards, and that tab's gear -- the bar Management's sub-tabs wear. */}
      {phoneOpen && (
        <div className="sticky top-[61px] z-10 -mx-3 -mt-4 flex items-center gap-2 border-b border-slate-200 bg-white px-2 py-2 sm:hidden" data-testid="activity-care-phone-back">
          <button
            type="button"
            onClick={() => setPhoneOpen(false)}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg p-1 text-left active:bg-slate-100"
            aria-label="Back to the tab cards"
            data-testid="activity-care-phone-back-btn"
          >
            <ChevronLeft aria-hidden className="h-5 w-5 shrink-0 text-slate-600 motion-safe:animate-nudge-left" />
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" style={{ background: `${PHONE_CARD_HEX}1F` }}>
              <ActiveIcon aria-hidden className="h-4 w-4" style={{ color: PHONE_CARD_HEX }} />
            </span>
            <span className="min-w-0 truncate text-sm font-semibold text-slate-800">{activeTab.label}</span>
          </button>
          {active === "zumba" && <span className="[&>button]:mb-0">{zumbaGear("activity-care-phone-zumba-settings")}</span>}
          {active === "patients" && <span className="[&>button]:mb-0"><PortalControlsButton branchId={branchId} /></span>}
        </div>
      )}

      {/* Phone: the sub-tabs as Management's sub-tab cards, one to a row. */}
      {!phoneOpen && (
        <div className="grid grid-cols-1 gap-2.5 sm:hidden" data-testid="activity-care-subtab-cards">
          {tabs.map((t) => (
            <SubTabCard
              key={t.key}
              tab={t}
              active={active === t.key}
              onClick={() => {
                setActive(t.key);
                clickDot(`activity_care.${t.key}`);
                setPhoneOpen(true);
                window.scrollTo({ top: 0 });
              }}
            />
          ))}
        </div>
      )}

      {/* The same underlined strip as Records' sub-tabs, with Zumba's or Patients' gear at its end. On a
          phone the tabs share the width, icon over a short label; seven are more than the
          narrowest phones hold, so each keeps its own width and the strip scrolls as a last
          resort. From sm up they sit in a row with full labels, as Records' do. */}
      <div className="hidden items-center gap-2 border-b border-slate-200 sm:flex">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" data-testid="activity-care-subtabs">
          {tabs.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => { setActive(t.key); clickDot(`activity_care.${t.key}`); }}
                className={`relative flex shrink-0 grow basis-0 flex-col items-center gap-0.5 whitespace-nowrap border-b-2 px-1 py-2 text-[10px] font-medium sm:grow-0 sm:basis-auto sm:flex-row sm:gap-1.5 sm:px-3 sm:text-sm ${
                  active === t.key ? "border-sky-500 text-sky-700" : "border-transparent text-slate-400 hover:text-slate-600"
                }`}
                data-testid={`activity-care-subtab-${t.key}`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="sm:hidden">{t.short || t.label}</span>
                <span className="hidden sm:inline">{t.label}</span>
                <TabDotFor dotKey={`activity_care.${t.key}`} className="right-0.5 top-1" testid={`activity-care-subtab-${t.key}-dot`} />
              </button>
            );
          })}
        </div>
        <div ref={setToolbar} className="mb-1 hidden shrink-0 items-center gap-2 2xl:flex" data-testid="activity-care-toolbar" />
        {active === "zumba" && zumbaGear("activity-care-zumba-settings")}
        {/* Patients' gear: the automatic Client Portal login, which used to be a card above
            the patient list. */}
        {active === "patients" && <PortalControlsButton branchId={branchId} />}
      </div>
      <Dialog open={mastersOpen} onOpenChange={setMastersOpen}>
        {/* A gutter and rounded corners on a phone too. On a phone the panel's header is the
            dialog's, edge to edge with the close ✕ lowered to sit level with it; on a desk
            the panel is held below the ✕ so it does not sit on the panel's Refresh button. */}
        <DialogContent className="max-h-[90vh] w-[calc(100%-2rem)] max-w-3xl gap-0 overflow-y-auto rounded-2xl p-0 [&>button:last-child]:top-5 sm:gap-4 sm:rounded-lg sm:p-6 sm:pt-12 sm:[&>button:last-child]:top-4" data-testid="zumba-masters-dialog">
          {/* The panel carries its own Zumba Masters heading; these are for screen readers. */}
          <DialogHeader className="sr-only">
            <DialogTitle>Zumba Masters</DialogTitle>
            <DialogDescription>Which master takes each Zumba class time.</DialogDescription>
          </DialogHeader>
          {mastersOpen && <ZumbaMastersPanel branchId={branchId} />}
        </DialogContent>
      </Dialog>
      {/* Hidden, not unmounted, behind the phone's cards, so a tab keeps its state for the
          way back; `contents` keeps the panel a flex child as before. */}
      <div className={phoneOpen ? "contents" : "hidden sm:contents"}>
      {active === "zumba" ? (
        <ZumbaPanel branchId={branchId} />
      ) : active === "fitness" ? (
        <FitnessPanel branchId={branchId} />
      ) : active === "patients" ? (
        <PatientsPortalPanel branchId={branchId} />
      ) : active === "manager" ? (
        <BranchDetailPage branchId={branchId} readOnly />
      ) : active === "team_consultants" ? (
        <TeamPanel kind="consultants" branchId={branchId} toolbarSlot={toolbar} />
      ) : active === "team_physio" ? (
        <TeamPanel kind="physio" branchId={branchId} toolbarSlot={toolbar} />
      ) : (
        <BranchReviewPanel branchId={branchId} />
      )}
      </div>
    </div>
  );
};
