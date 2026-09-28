import { useCallback, useEffect, useState } from "react";
import { Eye, Pencil, Clock, CalendarCheck, RefreshCw } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { listStoreItems, getBranches } from "@/lib/api";
import { StoreInventoryPanel } from "@/components/branch/StoreInventoryPanel";
import { TreatmentTypesBoard } from "@/components/TreatmentTypesBoard";
import {
  TABS,
  SUPER_ADMIN_CATALOGUE_TABS,
  MODE_TAB_KEYS,
  CONSULTATIONS_SUBTABS,
  SESSIONS_SUBTABS,
  HOME_VISIT_SUBTABS,
  PlaceholderPanel,
  itemDurationLabel,
  PriceModeBadges,
  SessionPriceBoxes,
  ViewItemModal,
  CreateConsultationModal,
  CreateSessionPackageModal,
} from "@/components/PackagesBoard";

// Same helper BranchManagementBoard.jsx, PreSalesCRM.jsx and MarketingBoard.jsx each
// carry their own copy of — every default vertical is named "online_.../offline_...", so
// reading the prefix off the branch record can never disagree with how those screens
// group branches.
const isOnlineVertical = (v) => String(v || "").startsWith("online_");

// Every shelf here is editable with Super Admin's own dialog for it: the session form for
// Sessions, Rehab, Zumba, Workshop and Home Visit, the consultation form for Consultations,
// Diet Consultations and Diet Package. Edit only — create and delete stay with Super Admin,
// and the server refuses a branch moving a package to another type or shelf.
const BranchItemsPanel = ({ category, itemType, emptyLabel, testidPrefix, durationLabel = "Consultation Duration", reloadToken, modeFilter = "all" }) => {
  const [items, setItems] = useState([]);
  const [viewingItem, setViewingItem] = useState(null);
  const [editingItem, setEditingItem] = useState(null);
  const isSession = itemType === "session";

  // useCallback so the effect can name it as a dependency — it was an inline function with
  // an empty dep array, which is what the exhaustive-deps warning here was pointing at, and
  // which also meant the list never refetched for any reason at all.
  const loadItems = useCallback(
    () => listStoreItems(category, itemType).then(setItems).catch(() => {}),
    [category, itemType],
  );
  useEffect(() => { loadItems(); }, [loadItems, reloadToken]);

  const handleBook = (it) => {
    toast.info(`Booking "${it.name}" — coming soon`);
  };

  return (
    <div className="space-y-3" data-testid={`${testidPrefix}-panel`}>
      {items.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-slate-400">{emptyLabel}</CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid={`${testidPrefix}-items-grid`}>
          {items.map((it) => (
            <Card key={it.id} data-testid={`${testidPrefix}-item-${it.id}`}>
              <CardContent className="space-y-2 p-4">
                <div className="flex items-start justify-between gap-2">
                  <p className="flex-1 font-semibold text-slate-800">{it.name}</p>
                  <div className="flex shrink-0 gap-1">
                    <button
                      onClick={() => setViewingItem(it)}
                      className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-sky-600"
                      data-testid={`${testidPrefix}-item-${it.id}-view`}
                      title="View"
                    >
                      <Eye className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => setEditingItem(it)}
                      className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-sky-600"
                      data-testid={`${testidPrefix}-item-${it.id}-edit`}
                      title="Edit"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                {it.image_url && <img src={it.image_url} alt={it.name} className="h-[200px] w-full rounded-lg object-cover" />}
                {it.description && <p className="line-clamp-2 text-xs text-slate-500">{it.description}</p>}

                {isSession ? (
                  <SessionPriceBoxes item={it} mode={modeFilter} testid={`${testidPrefix}-item-${it.id}-highlights`} />
                ) : (
                  <div className="rounded-xl border border-slate-100 bg-slate-50/50 p-3" data-testid={`${testidPrefix}-item-${it.id}-highlights`}>
                    <PriceModeBadges item={it} isSession={false} mode={modeFilter} />
                    {itemType !== "diet_package" && it.duration_minutes && (
                      <div className="mt-1.5 flex items-center justify-between rounded-lg bg-sky-50 px-2.5 py-1.5">
                        <span className="inline-flex items-center gap-1.5 text-xs font-bold text-sky-800">
                          <Clock className="h-3.5 w-3.5" />{durationLabel}
                        </span>
                        <span className="text-sm font-extrabold text-sky-900">
                          {itemDurationLabel(it)}
                        </span>
                      </div>
                    )}
                  </div>
                )}

                <Button
                  onClick={() => handleBook(it)}
                  className="w-full bg-emerald-600 text-white hover:bg-emerald-700"
                  data-testid={`${testidPrefix}-item-${it.id}-book`}
                >
                  <CalendarCheck className="mr-1 h-4 w-4" />Book
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {viewingItem && (
        <ViewItemModal
          item={viewingItem}
          kind={itemType}
          onClose={() => setViewingItem(null)}
          onEdit={() => { setEditingItem(viewingItem); setViewingItem(null); }}
        />
      )}
      {editingItem && (isSession ? (
        <CreateSessionPackageModal
          category={category}
          item={editingItem}
          onClose={() => setEditingItem(null)}
          onSaved={loadItems}
        />
      ) : (
        <CreateConsultationModal
          kind={itemType}
          category={category}
          item={editingItem}
          onClose={() => setEditingItem(null)}
          onSaved={loadItems}
        />
      ))}
    </div>
  );
};

export const BranchConsultationsPanel = ({ reloadToken, modeFilter = "all" }) => {
  const [sub, setSub] = useState("physiotherapy");
  return (
    <div className="space-y-4" data-testid="branch-store-panel-consultations">
      <div className="flex flex-wrap gap-2 rounded-lg border border-slate-200 bg-white p-1" data-testid="branch-consultations-subtabs">
        {CONSULTATIONS_SUBTABS.map((t) => {
          const Icon = t.icon;
          const active = sub === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setSub(t.key)}
              data-testid={`branch-consultations-subtab-${t.key}`}
              className={`inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition ${active ? "bg-sky-50 text-sky-600" : "text-slate-600 hover:bg-slate-50"}`}
            >
              <Icon className="h-4 w-4" />{t.label}
            </button>
          );
        })}
      </div>

      {sub === "physiotherapy" && (
        <BranchItemsPanel
          category="physiotherapy"
          itemType="consultation"
          emptyLabel="No consultations available yet."
          testidPrefix="branch-consultation"
          reloadToken={reloadToken}
          modeFilter={modeFilter}
        />
      )}
      {sub === "fitness" && <PlaceholderPanel label="Fitness" testid="branch-consultations-subpanel-fitness" />}
      {/* Real data, not a placeholder like Fitness above — item_type "diet", the bookable
          Diet Consultation catalogue Super Admin prices under Services and Products >
          Consultations > Diet Consultations. Separate from item_type "diet_package"
          (BranchDietPanel below), a plain product with no booking slot. */}
      {sub === "diet" && (
        <BranchItemsPanel
          category="physiotherapy"
          itemType="diet"
          durationLabel="Diet Consultation Duration"
          emptyLabel="No diet consultations available yet."
          testidPrefix="branch-diet-consultation"
          reloadToken={reloadToken}
          modeFilter={modeFilter}
        />
      )}
    </div>
  );
};

export const BranchSessionsPanel = ({ reloadToken, modeFilter = "all" }) => {
  const [sub, setSub] = useState("physiotherapy");
  return (
    <div className="space-y-4" data-testid="branch-store-panel-sessions">
      <div className="flex flex-wrap gap-2 rounded-lg border border-slate-200 bg-white p-1" data-testid="branch-sessions-subtabs">
        {SESSIONS_SUBTABS.map((t) => {
          const Icon = t.icon;
          const active = sub === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setSub(t.key)}
              data-testid={`branch-sessions-subtab-${t.key}`}
              className={`inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition ${active ? "bg-sky-50 text-sky-600" : "text-slate-600 hover:bg-slate-50"}`}
            >
              <Icon className="h-4 w-4" />{t.label}
            </button>
          );
        })}
      </div>

      {sub === "physiotherapy" && (
        <BranchItemsPanel
          category="physiotherapy"
          itemType="session"
          emptyLabel="No session packages available yet."
          testidPrefix="branch-session"
          reloadToken={reloadToken}
          modeFilter={modeFilter}
        />
      )}
      {/* Was a "coming soon" card, which cost nothing while the top-level Fitness tab
          listed this same shelf beside it. That tab is gone, so this is now the only way a
          branch reaches the fitness catalogue and it has to actually list it. */}
      {sub === "fitness" && (
        <BranchItemsPanel
          key="fitness"
          category="fitness"
          itemType="session"
          emptyLabel="No fitness packages available yet."
          testidPrefix="branch-session-fitness"
          reloadToken={reloadToken}
          modeFilter={modeFilter}
        />
      )}
      {/* Rehab arrives here because SESSIONS_SUBTABS is the same list Super Admin's page
          reads, so the sub-tab shows up the moment it is added there. It is the shelf the
          top-level Rehab tab already lists, editable as every shelf here is —
          without this the button would select nothing and leave the panel blank. */}
      {sub === "rehab" && (
        <BranchItemsPanel
          key="rehab"
          category="rehab"
          itemType="session"
          emptyLabel="No rehab packages available yet."
          testidPrefix="branch-session-rehab"
          reloadToken={reloadToken}
          modeFilter={modeFilter}
        />
      )}
    </div>
  );
};

/**
 * Diet Package — what Super Admin has priced, editable here but not added to or deleted.
 *
 * No Physiotherapy/Fitness sub-tabs, matching Super Admin's own Diet Package tab: a diet
 * package is not split by department the way a consultation is, so a sub-tab bar with one
 * live entry would be a control that never does anything.
 *
 * item_type "diet_package" — a plain priced product (a diet chart, say), not a booking
 * slot, so it carries no duration. The actual bookable Diet Consultation is item_type
 * "diet", shown separately under Consultations > Diet Consultations above.
 */
export const BranchDietPanel = ({ reloadToken, modeFilter = "all" }) => (
  <div className="space-y-4" data-testid="branch-store-panel-diet">
    <BranchItemsPanel
      category="physiotherapy"
      itemType="diet_package"
      emptyLabel="No diet packages available yet. Super Admin adds them in Services and Products > Diet Package."
      testidPrefix="branch-diet"
      reloadToken={reloadToken}
      modeFilter={modeFilter}
    />
  </div>
);

/**
 * Rehab, Zumba Class, Workshop and Home Visit — Super Admin's four session-shaped shelves,
 * editable here as every other package shelf is. Same panel, told which category to list;
 * without these the tabs still appear (they come off the shared TABS list) and land on the
 * "coming soon" placeholder, which is not what a branch should see for a shelf that has
 * stock on it.
 *
 * Fitness is not here any more, having lost its top-level tab. It is read from
 * Sessions > Fitness instead, which is the only door onto that shelf now and so had to
 * stop being a placeholder — see BranchSessionsPanel above.
 */
const SESSION_LIKE_TABS = {
  rehab: { category: "rehab", empty: "No rehab packages available yet." },
  zumba: { category: "zumba", empty: "No Zumba classes available yet." },
  workshop: { category: "workshop", empty: "No workshops available yet." },
};

// Home Visit's Consultant / Physiotherapy split, editable here like every other shelf.
// The sub-tabs are Super Admin's own list, so the two pages cannot disagree about them.
const BranchHomeVisitPanel = ({ reloadToken, modeFilter = "all" }) => {
  const [sub, setSub] = useState(HOME_VISIT_SUBTABS[0].key);
  const current = HOME_VISIT_SUBTABS.find((t) => t.key === sub) || HOME_VISIT_SUBTABS[0];
  return (
    <div className="space-y-4" data-testid="branch-store-panel-home-visit">
      <div className="flex flex-wrap gap-2 rounded-lg border border-slate-200 bg-white p-1" data-testid="branch-home-visit-subtabs">
        {HOME_VISIT_SUBTABS.map((t) => {
          const Icon = t.icon;
          const active = sub === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setSub(t.key)}
              data-testid={`branch-home-visit-subtab-${t.key}`}
              className={`inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition ${active ? "bg-sky-50 text-sky-600" : "text-slate-600 hover:bg-slate-50"}`}
            >
              <Icon className="h-4 w-4" />{t.label}
            </button>
          );
        })}
      </div>
      <BranchItemsPanel
        key={current.category}
        category={current.category}
        itemType="session"
        emptyLabel={`No ${current.noun}s available yet.`}
        testidPrefix={`branch-home-visit-${current.key}`}
        reloadToken={reloadToken}
        modeFilter={modeFilter}
      />
    </div>
  );
};

// The three shelves that are stock: a catalogue, a count per branch, and the same add,
// sell and move. One panel serves all of them, told which by its category.
const INVENTORY_TABS = new Set(["tablet", "supplementary", "equipment"]);

// Which tabs have a panel of their own. The rest fall through to the placeholder, and a
// tab graduates by being added here rather than by another branch in the JSX below.
// Vendor lives under Records > Vendor Records for a branch -- one place to add, view and
// pay a vendor from, beside the expenses paid to them -- so it is not offered here as well.
const BRANCH_HIDDEN_TABS = new Set(["vendor"]);

const PANELS_BUILT = new Set(["consultations", "sessions", "diet", "treatment", "home_visit", ...Object.keys(SESSION_LIKE_TABS), ...INVENTORY_TABS]);

/**
 * A branch's own FITSIO STORE — scoped to its own vertical rather than offering every
 * mode's tabs and letting the branch pick. Super Admin's Services and Products page has
 * an All/Offline/Online switch because it oversees every branch; one branch only ever
 * runs one of those two, so here the same MODE_TAB_KEYS split Super Admin's page uses is
 * read off this branch's own vertical instead of a control.
 */
export const FitsiomaxStorePanel = ({ branchId }) => {
  const [tab, setTab] = useState("consultations");
  // Bumped by Refresh and passed to whichever panel is open, so it refetches in place —
  // rather than remounting it by key, which would also throw away the Physiotherapy /
  // Fitness choice inside Consultations and Sessions.
  const [reloadTick, setReloadTick] = useState(0);
  // null while loading — "all" (unrestricted) is what it falls back to rather than
  // guessing offline or online, so a slow fetch shows every tab briefly rather than the
  // wrong scoped set that would then have to swap out from under whoever's looking.
  const [mode, setMode] = useState(null);

  useEffect(() => {
    if (!branchId) return;
    getBranches()
      .then((rows) => {
        const branch = rows.find((b) => b.id === branchId);
        setMode(isOnlineVertical(branch?.vertical) ? "online" : "offline");
      })
      .catch(() => setMode("all"));
  }, [branchId]);

  const modeFilter = mode || "all";
  const branchStoreTabs = TABS.filter(
    (t) => MODE_TAB_KEYS[modeFilter].has(t.key) && !SUPER_ADMIN_CATALOGUE_TABS.has(t.key) && !BRANCH_HIDDEN_TABS.has(t.key),
  );

  // Falls back to Consultations rather than leaving `tab` pointed at a key this branch's
  // own mode doesn't carry, once its vertical is known.
  useEffect(() => {
    if (mode && !MODE_TAB_KEYS[mode].has(tab)) setTab("consultations");
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-4" data-testid="branch-store-board">
      {/* A dropdown on a phone, as Accountant Manage uses: seven tabs wrapped to two rows
          and the shelf being browsed was the least prominent thing on screen. Desktop keeps
          the bar. */}
      <div className="flex items-center gap-2 md:hidden">
        <select
          value={tab}
          onChange={(e) => setTab(e.target.value)}
          className="h-11 min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700"
          data-testid="branch-store-subtab-select"
        >
          {branchStoreTabs.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
        <Button
          onClick={() => setReloadTick((n) => n + 1)}
          title="Refresh"
          aria-label="Refresh"
          className="h-11 w-11 shrink-0 bg-slate-500 p-0 text-white hover:bg-slate-600"
          data-testid="branch-store-refresh"
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      <div className="hidden flex-wrap gap-2 rounded-lg border border-slate-200 bg-white p-1 md:flex" data-testid="branch-store-subtabs">
        {branchStoreTabs.map((t) => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              data-testid={`branch-store-subtab-${t.key}`}
              className={`inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition ${active ? "bg-violet-50 text-violet-600" : "text-slate-600 hover:bg-slate-50"}`}
            >
              <Icon className="h-4 w-4" />{t.label}
            </button>
          );
        })}
      </div>

      {tab === "consultations" && <BranchConsultationsPanel reloadToken={reloadTick} modeFilter={modeFilter} />}
      {tab === "sessions" && <BranchSessionsPanel reloadToken={reloadTick} modeFilter={modeFilter} />}
      {tab === "diet" && <BranchDietPanel reloadToken={reloadTick} modeFilter={modeFilter} />}
      {tab === "home_visit" && <BranchHomeVisitPanel reloadToken={reloadTick} modeFilter={modeFilter} />}
      {/* Keyed by category: without it React keeps the same instance across a tab switch
          and the previous shelf's rows sit there until the new ones land. */}
      {SESSION_LIKE_TABS[tab] && (
        <BranchItemsPanel
          key={tab}
          category={SESSION_LIKE_TABS[tab].category}
          itemType="session"
          emptyLabel={SESSION_LIKE_TABS[tab].empty}
          testidPrefix={`branch-${tab}`}
          reloadToken={reloadTick}
          modeFilter={modeFilter}
        />
      )}
      {INVENTORY_TABS.has(tab) && <StoreInventoryPanel key={tab} category={tab} reloadToken={reloadTick} />}
      {/* The same board Super Admin keeps this catalogue on, read-only. The tab has been
          in this row since it was built and had no panel behind it, so a branch clicking
          Treatments got "setup coming soon" for a list that has been populated all along.
          Read-only rather than hidden: the create, rename and delete endpoints are all
          super_admin-only, so the buttons would 403, but the list itself is exactly what a
          branch needs to see. */}
      {tab === "treatment" && <TreatmentTypesBoard canEdit={false} />}
      {!PANELS_BUILT.has(tab) && branchStoreTabs.map((t) => tab === t.key && (
        <PlaceholderPanel key={t.key} label={t.label} testid={`branch-store-panel-${t.key}`} />
      ))}
    </div>
  );
};
