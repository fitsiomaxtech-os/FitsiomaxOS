import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  Check,
  ChevronRight,
  Clock,
  FileText,
  LayoutGrid,
  List,
  MessageSquare,
  Phone,
  Mail,
  Plus,
  Search,
  User,
  X,
  Activity,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import {
  addLeadFollowUp,
  addLeadRemark,
  assignLeadBranch,
  bookAppointment,
  completeLeadFollowUp,
  createManualLead,
  getAvailableDoctors,
  getDoctors,
  getLeadActivity,
  getLeadFollowUps,
  getLeadRemarks,
  getLeads,
  getBranches,
  getMasterBoard,
  moveLeadStage,
  updateLead,
} from "@/lib/api";
import { to12h } from "@/lib/time";
import { MilkDateInput } from "@/components/ui/milk-calendar";
import { displayPhone } from "@/lib/phone";

const PIPELINE_STAGES = [
  "New Lead",
  "Pre-sales Qualified",
  "Assigned to Branch",
  "Branch Confirmed",
  "Appointment Booked",
  "Completed",
];

const STAGE_COLORS = {
  "New Lead": { bg: "bg-blue-500", light: "bg-blue-50 text-blue-700 border-blue-200", col: "border-blue-200 bg-blue-50/50" },
  "Pre-sales Qualified": { bg: "bg-amber-500", light: "bg-amber-50 text-amber-700 border-amber-200", col: "border-amber-200 bg-amber-50/50" },
  "Assigned to Branch": { bg: "bg-violet-500", light: "bg-violet-50 text-violet-700 border-violet-200", col: "border-violet-200 bg-violet-50/50" },
  "Branch Confirmed": { bg: "bg-teal-500", light: "bg-teal-50 text-teal-700 border-teal-200", col: "border-teal-200 bg-teal-50/50" },
  "Appointment Booked": { bg: "bg-green-500", light: "bg-green-50 text-green-700 border-green-200", col: "border-green-200 bg-green-50/50" },
  Completed: { bg: "bg-emerald-500", light: "bg-emerald-50 text-emerald-700 border-emerald-200", col: "border-emerald-200 bg-emerald-50/50" },
};

const KANBAN_STAGES = ["New Lead", "Pre-sales Qualified", "Assigned to Branch"];

const defaultNewLead = { name: "", phone: "", email: "", vertical: "offline_physiotherapy", source_tab: "Manual", notes: "" };

export const PreSalesBoard = () => {
  const [leads, setLeads] = useState([]);
  const [branches, setBranches] = useState([]);
  const [masterBoard, setMasterBoard] = useState({ stage_counts: {} });
  const [loading, setLoading] = useState(false);

  const [viewType, setViewType] = useState("kanban");
  const [stageTab, setStageTab] = useState("All");
  const [searchQuery, setSearchQuery] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [showDateFilter, setShowDateFilter] = useState(false);

  const [showNewLeadModal, setShowNewLeadModal] = useState(false);
  const [newLeadForm, setNewLeadForm] = useState(defaultNewLead);

  const [selectedLead, setSelectedLead] = useState(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (dateFrom) params.start_date = `${dateFrom}T00:00:00`;
      if (dateTo) params.end_date = `${dateTo}T23:59:59`;
      const [leadData, branchData, boardData] = await Promise.all([
        getLeads(params),
        getBranches(),
        getMasterBoard(),
      ]);
      setLeads(leadData);
      setBranches(branchData);
      setMasterBoard(boardData);
    } catch (e) { console.warn("[PreSalesBoard load failed]", e?.message || e); }
    setLoading(false);
  }, [dateFrom, dateTo]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const filteredLeads = useMemo(() => {
    let rows = leads.filter((l) => !l.branch_id || ["New Lead", "Pre-sales Qualified", "Assigned to Branch"].includes(l.stage));
    if (stageTab !== "All") rows = rows.filter((l) => l.stage === stageTab);
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      rows = rows.filter((l) => l.name?.toLowerCase().includes(q) || l.phone?.includes(q) || l.email?.toLowerCase().includes(q));
    }
    return rows;
  }, [leads, stageTab, searchQuery]);

  const totalLeads = filteredLeads.length;

  const createLeadNow = async (e) => {
    e.preventDefault();
    if (!newLeadForm.name.trim() || !newLeadForm.phone.trim()) {
      toast.error("Name and phone required");
      return;
    }
    try {
      await createManualLead({ ...newLeadForm, source_type: "manual" });
      setNewLeadForm(defaultNewLead);
      setShowNewLeadModal(false);
      toast.success("Lead created");
      await loadData();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Create failed");
    }
  };

  const openLeadDetail = (lead) => setSelectedLead(lead);
  const closeLeadDetail = () => setSelectedLead(null);

  const handleStageMove = async (leadId, newStage) => {
    try {
      await moveLeadStage(leadId, { stage: newStage });
      toast.success(`Moved to ${newStage}`);
      await loadData();
      const updated = (await getLeads({})).find((l) => l.id === leadId);
      if (updated) setSelectedLead(updated);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Move failed");
    }
  };

  return (
    <div className="space-y-4" data-testid="presales-board-root">
      {/* Metric Cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="presales-metrics">
        <div className="rounded-lg border border-sky-200 bg-sky-50 p-3" data-testid="presales-metric-total">
          <p className="text-xs font-medium text-slate-500">Total Leads</p>
          <p className="text-2xl font-bold text-sky-700">{totalLeads}</p>
        </div>
        {["New Lead", "Pre-sales Qualified", "Assigned to Branch"].map((stage) => (
          <div key={stage} className={`rounded-lg border p-3 ${STAGE_COLORS[stage]?.col || "border-slate-200 bg-slate-50"}`} data-testid={`presales-metric-${stage}`}>
            <p className="text-xs font-medium text-slate-500">{stage}</p>
            <p className="text-2xl font-bold text-slate-800">{masterBoard.stage_counts?.[stage] || 0}</p>
          </div>
        ))}
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3" data-testid="presales-toolbar">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <Input
            className="pl-9"
            placeholder="Search leads by name, email, phone..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            data-testid="presales-search-input"
          />
        </div>
        <Button size="sm" variant="outline" onClick={() => setShowDateFilter(!showDateFilter)} data-testid="presales-date-toggle-btn">
          <CalendarDays className="mr-1 h-4 w-4" /> Date Filter
        </Button>
        <Button size="sm" onClick={() => setShowNewLeadModal(true)} className="bg-sky-600 text-white hover:bg-sky-700" data-testid="presales-add-lead-btn">
          <Plus className="mr-1 h-4 w-4" /> Add New
        </Button>
        <div className="flex items-center rounded-md border border-slate-200 bg-slate-50 p-0.5" data-testid="presales-view-toggle">
          <button
            type="button"
            onClick={() => setViewType("kanban")}
            className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${viewType === "kanban" ? "bg-white text-sky-700 shadow-sm" : "text-slate-500"}`}
            data-testid="presales-view-kanban-btn"
          >
            <LayoutGrid className="mr-1 inline h-3.5 w-3.5" /> Kanban
          </button>
          <button
            type="button"
            onClick={() => setViewType("list")}
            className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${viewType === "list" ? "bg-white text-sky-700 shadow-sm" : "text-slate-500"}`}
            data-testid="presales-view-list-btn"
          >
            <List className="mr-1 inline h-3.5 w-3.5" /> List
          </button>
        </div>
      </div>

      {/* Date Filter (collapsible) */}
      {showDateFilter && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3" data-testid="presales-date-filter">
          <MilkDateInput  value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="w-40" data-testid="presales-date-from" />
          <span className="text-xs text-slate-400">to</span>
          <MilkDateInput  value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="w-40" data-testid="presales-date-to" />
          <Button size="sm" variant="outline" onClick={() => { setDateFrom(""); setDateTo(""); }} data-testid="presales-date-clear-btn">Clear</Button>
        </div>
      )}

      {/* Stage Tabs */}
      <div className="flex flex-wrap gap-1.5" data-testid="presales-stage-tabs">
        <button
          type="button"
          onClick={() => setStageTab("All")}
          className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${stageTab === "All" ? "border-sky-400 bg-sky-50 text-sky-700" : "border-slate-200 text-slate-500 hover:bg-slate-50"}`}
          data-testid="presales-tab-all"
        >
          All
        </button>
        {PIPELINE_STAGES.map((stage) => {
          const count = filteredLeads.filter((l) => l.stage === stage).length;
          return (
            <button
              key={stage}
              type="button"
              onClick={() => setStageTab(stage)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${stageTab === stage ? STAGE_COLORS[stage]?.light || "border-sky-400 bg-sky-50 text-sky-700" : "border-slate-200 text-slate-500 hover:bg-slate-50"}`}
              data-testid={`presales-tab-${stage}`}
            >
              {stage} <span className="ml-1 rounded-full bg-white/60 px-1.5 text-[10px]">{count}</span>
            </button>
          );
        })}
      </div>

      {/* Kanban View */}
      {viewType === "kanban" && (
        <div className="flex gap-3 overflow-x-auto pb-2" data-testid="presales-kanban">
          {KANBAN_STAGES.map((stage) => {
            const stageLeads = filteredLeads.filter((l) => l.stage === stage);
            return (
              <div key={stage} className={`min-w-[300px] flex-1 rounded-lg border p-3 ${STAGE_COLORS[stage]?.col || "border-slate-200 bg-slate-50"}`} data-testid={`presales-kanban-col-${stage}`}>
                <div className="mb-3 flex items-center justify-between">
                  <p className="text-sm font-semibold text-slate-700">{stage}</p>
                  <span className="rounded-full bg-white px-2 py-0.5 text-xs font-medium text-slate-600 shadow-sm">{stageLeads.length}</span>
                </div>
                <div className="space-y-2">
                  {stageLeads.map((lead) => (
                    <div
                      key={lead.id}
                      onClick={() => openLeadDetail(lead)}
                      className="cursor-pointer rounded-lg border border-slate-200 bg-white p-3 shadow-sm transition-shadow hover:shadow-md"
                      data-testid={`presales-kanban-card-${lead.id}`}
                    >
                      <div className="flex items-start gap-2">
                        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-violet-100 text-sm font-semibold text-violet-700">
                          {lead.name?.charAt(0)?.toUpperCase() || "?"}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-slate-800">{lead.name}</p>
                          <p className="truncate text-xs text-slate-500">{displayPhone(lead.phone)}</p>
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1">
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600">
                          {lead.source_tab || lead.source_type}
                        </span>
                        {lead.vertical && (
                          <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[10px] text-sky-600">
                            {lead.vertical}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                  {stageLeads.length === 0 && (
                    <p className="py-4 text-center text-xs text-slate-400">No leads in this stage</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* List View */}
      {viewType === "list" && (
        <div className="overflow-auto rounded-lg border border-slate-200" data-testid="presales-list-table">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">Lead</th>
                <th className="px-3 py-2 font-medium">Phone</th>
                <th className="px-3 py-2 font-medium">Source</th>
                <th className="px-3 py-2 font-medium">Stage</th>
                <th className="px-3 py-2 font-medium">Date</th>
              </tr>
            </thead>
            <tbody>
              {filteredLeads.length === 0 ? (
                <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-400">No leads found</td></tr>
              ) : (
                filteredLeads.map((lead) => (
                  <tr
                    key={lead.id}
                    onClick={() => openLeadDetail(lead)}
                    className="cursor-pointer border-t border-slate-100 transition-colors hover:bg-slate-50"
                    data-testid={`presales-list-row-${lead.id}`}
                  >
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-violet-100 text-xs font-semibold text-violet-700">
                          {lead.name?.charAt(0)?.toUpperCase() || "?"}
                        </div>
                        <span className="font-medium text-slate-800">{lead.name}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-slate-600">{displayPhone(lead.phone)}</td>
                    <td className="px-3 py-2 text-slate-600">{lead.source_tab || lead.source_type}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-block rounded-full border px-2 py-0.5 text-xs ${STAGE_COLORS[lead.stage]?.light || "bg-slate-50 text-slate-600 border-slate-200"}`}>
                        {lead.stage}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-400">{lead.created_at?.slice(0, 10)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Add New Lead Modal */}
      {showNewLeadModal && (
        <ModalOverlay onClose={() => setShowNewLeadModal(false)}>
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl" data-testid="presales-new-lead-modal">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-slate-800">Add New Lead</h3>
              <button type="button" onClick={() => setShowNewLeadModal(false)} className="rounded-md p-1 hover:bg-slate-100" data-testid="presales-new-lead-close-btn">
                <X className="h-5 w-5 text-slate-400" />
              </button>
            </div>
            <form onSubmit={createLeadNow} className="space-y-3" data-testid="presales-new-lead-form">
              <Input value={newLeadForm.name} onChange={(e) => setNewLeadForm((p) => ({ ...p, name: e.target.value }))} placeholder="Lead Name *" data-testid="presales-new-lead-name" />
              <Input value={newLeadForm.phone} onChange={(e) => setNewLeadForm((p) => ({ ...p, phone: e.target.value }))} placeholder="Phone *" data-testid="presales-new-lead-phone" />
              <Input value={newLeadForm.email} onChange={(e) => setNewLeadForm((p) => ({ ...p, email: e.target.value }))} placeholder="Email" data-testid="presales-new-lead-email" />
              <select value={newLeadForm.vertical} onChange={(e) => setNewLeadForm((p) => ({ ...p, vertical: e.target.value }))} className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm" data-testid="presales-new-lead-vertical">
                <option value="offline_physiotherapy">Offline Physiotherapy</option>
                <option value="online_physiotherapy">Online Physiotherapy</option>
                <option value="online_fitness">Online Fitness</option>
                <option value="offline_fitness_gym">Offline Fitness / Gym</option>
              </select>
              <Input value={newLeadForm.source_tab} onChange={(e) => setNewLeadForm((p) => ({ ...p, source_tab: e.target.value }))} placeholder="Source (e.g. Instagram, Manual)" data-testid="presales-new-lead-source" />
              <textarea
                value={newLeadForm.notes}
                onChange={(e) => setNewLeadForm((p) => ({ ...p, notes: e.target.value }))}
                placeholder="Notes"
                className="min-h-[60px] w-full rounded-md border border-slate-200 p-3 text-sm"
                data-testid="presales-new-lead-notes"
              />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setShowNewLeadModal(false)}>Cancel</Button>
                <Button type="submit" className="bg-sky-600 text-white hover:bg-sky-700" data-testid="presales-new-lead-submit">Create Lead</Button>
              </div>
            </form>
          </div>
        </ModalOverlay>
      )}

      {/* Lead Detail Modal */}
      {selectedLead && (
        <LeadDetailModal
          lead={selectedLead}
          branches={branches}
          onClose={closeLeadDetail}
          onStageMove={handleStageMove}
          onRefresh={loadData}
        />
      )}

      {loading && (
        <div className="fixed bottom-4 right-4 rounded-md bg-slate-900 px-3 py-2 text-sm text-white" data-testid="presales-loading">Loading...</div>
      )}
    </div>
  );
};

/* ─── Modal Overlay ─── */
function ModalOverlay({ children, onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} data-testid="modal-overlay">
      {children}
    </div>
  );
}

/* ─── Lead Detail Modal ─── */
function LeadDetailModal({ lead, branches, onClose, onStageMove, onRefresh }) {
  const [activeTab, setActiveTab] = useState("overview");
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({ name: "", phone: "", email: "", notes: "", extra_fields: {} });

  const [showBranchPicker, setShowBranchPicker] = useState(false);
  const [showBookingFlow, setShowBookingFlow] = useState(false);
  const [selectedBranchId, setSelectedBranchId] = useState("");

  const [doctors, setDoctors] = useState([]);
  const [selectedDate, setSelectedDate] = useState("");
  const [selectedSlot, setSelectedSlot] = useState("");
  const [selectedDoctorId, setSelectedDoctorId] = useState("");
  const [bookedSlots, setBookedSlots] = useState(new Set());

  const [remarks, setRemarks] = useState([]);
  const [newRemark, setNewRemark] = useState("");
  const [followUps, setFollowUps] = useState([]);
  const [newFollowUp, setNewFollowUp] = useState({ note: "", scheduled_date: "" });
  const [activityLog, setActivityLog] = useState([]);

  useEffect(() => {
    setEditForm({
      name: lead.name || "",
      phone: displayPhone(lead.phone),
      email: lead.email || "",
      notes: lead.notes || "",
      extra_fields: lead.extra_fields || {},
    });
    setEditing(false);
  }, [lead]);

  const loadRemarks = async () => {
    try { setRemarks(await getLeadRemarks(lead.id)); } catch (e) { console.warn("[PreSalesBoard load failed]", e?.message || e); }
  };
  const loadFollowUps = async () => {
    try { setFollowUps(await getLeadFollowUps(lead.id)); } catch (e) { console.warn("[PreSalesBoard load failed]", e?.message || e); }
  };
  const loadActivity = async () => {
    try { setActivityLog(await getLeadActivity(lead.id)); } catch (e) { console.warn("[PreSalesBoard load failed]", e?.message || e); }
  };

  useEffect(() => {
    if (activeTab === "remarks") loadRemarks();
    if (activeTab === "followup") loadFollowUps();
    if (activeTab === "activity") loadActivity();
  }, [activeTab, lead.id]);

  const saveEdit = async () => {
    try {
      await updateLead(lead.id, editForm);
      toast.success("Lead updated");
      setEditing(false);
      await onRefresh();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Update failed");
    }
  };

  const addRemarkNow = async () => {
    if (!newRemark.trim()) return;
    try {
      await addLeadRemark(lead.id, { text: newRemark });
      setNewRemark("");
      toast.success("Remark added");
      await loadRemarks();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed");
    }
  };

  const addFollowUpNow = async () => {
    if (!newFollowUp.note.trim() || !newFollowUp.scheduled_date) { toast.error("Note and date required"); return; }
    try {
      await addLeadFollowUp(lead.id, newFollowUp);
      setNewFollowUp({ note: "", scheduled_date: "" });
      toast.success("Follow-up scheduled");
      await loadFollowUps();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed");
    }
  };

  const loadDoctorsForBranch = async (branchId) => {
    if (!branchId) { setDoctors([]); return; }
    try {
      const data = await getDoctors({ branch_id: branchId });
      setDoctors(data);
    } catch { setDoctors([]); }
  };

  const completeFollowUpNow = async (fId) => {
    try {
      await completeLeadFollowUp(lead.id, fId);
      toast.success("Follow-up completed");
      await loadFollowUps();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed");
    }
  };

  const handleStageClick = (stage) => {
    if (stage === "Assigned to Branch") {
      setShowBranchPicker(true);
      setShowBookingFlow(false);
      return;
    }
    if (stage === "Appointment Booked") {
      setShowBookingFlow(true);
      setShowBranchPicker(false);
      loadDoctorsForBranch(lead.branch_id);
      return;
    }
    onStageMove(lead.id, stage);
    setShowBranchPicker(false);
    setShowBookingFlow(false);
  };

  const assignBranchAndMove = async () => {
    if (!selectedBranchId) { toast.error("Select a branch"); return; }
    try {
      await assignLeadBranch(lead.id, { branch_id: selectedBranchId });
      toast.success("Assigned to branch");
      setShowBranchPicker(false);
      setSelectedBranchId("");
      await onRefresh();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Assign failed");
    }
  };

  const checkSlotAvailability = async (doctorId, slot) => {
    if (!lead.branch_id) return;
    try {
      const res = await getAvailableDoctors({ branch_id: lead.branch_id, slot_time: slot });
      const availIds = new Set((res.available_doctors || []).map((d) => d.id));
      return availIds.has(doctorId);
    } catch { return false; }
  };

  const bookNow = async () => {
    if (!selectedDoctorId || !selectedSlot) { toast.error("Select a doctor and time slot"); return; }
    try {
      await bookAppointment(lead.id, { doctor_id: selectedDoctorId, slot_time: selectedSlot });
      toast.success("Appointment booked!");
      setShowBookingFlow(false);
      setSelectedDoctorId("");
      setSelectedSlot("");
      setSelectedDate("");
      await onRefresh();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Booking failed");
    }
  };

  const generateTimeSlots = () => {
    if (!selectedDate) return [];
    const slots = [];
    for (let h = 8; h <= 20; h++) {
      for (let m = 0; m < 60; m += 30) {
        const time = `${selectedDate}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
        slots.push(time);
      }
    }
    return slots;
  };

  const TABS = [
    { key: "overview", label: "Overview", icon: User },
    { key: "remarks", label: "Remarks", icon: MessageSquare },
    { key: "followup", label: "Follow-up", icon: Clock },
    { key: "activity", label: "Activity", icon: Activity },
  ];

  return (
    <ModalOverlay onClose={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-xl bg-white shadow-2xl" data-testid="presales-lead-detail-modal">
        {/* Header */}
        <div className="flex items-start justify-between border-b border-slate-200 p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-violet-100 text-lg font-bold text-violet-700">
              {lead.name?.charAt(0)?.toUpperCase() || "?"}
            </div>
            <div>
              <h3 className="text-lg font-semibold text-slate-800" data-testid="lead-detail-name">{lead.name}</h3>
              <div className="flex flex-wrap gap-1.5">
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700" data-testid="lead-detail-source">{lead.source_tab || lead.source_type}</span>
                <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${STAGE_COLORS[lead.stage]?.light || "bg-slate-100 text-slate-600 border-slate-200"}`} data-testid="lead-detail-stage">{lead.stage}</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setEditing(!editing)} className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-sky-600 hover:bg-sky-50" data-testid="lead-detail-edit-btn">
              {editing ? "Cancel" : "Edit"}
            </button>
            <button type="button" onClick={onClose} className="rounded-md p-1 hover:bg-slate-100" data-testid="lead-detail-close-btn">
              <X className="h-5 w-5 text-slate-400" />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-200" data-testid="lead-detail-tabs">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(tab.key)}
                className={`flex flex-1 items-center justify-center gap-1.5 border-b-2 px-3 py-2.5 text-xs font-medium transition-colors ${
                  activeTab === tab.key ? "border-sky-500 text-sky-700" : "border-transparent text-slate-400 hover:text-slate-600"
                }`}
                data-testid={`lead-detail-tab-${tab.key}`}
              >
                <Icon className="h-3.5 w-3.5" /> {tab.label}
              </button>
            );
          })}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4" data-testid="lead-detail-content">
          {/* Overview */}
          {activeTab === "overview" && (
            <>
              {/* Contact Info */}
              <div className="rounded-lg border border-slate-200 p-4" data-testid="lead-detail-contact">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Contact Information</p>
                {editing ? (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Input value={editForm.name} onChange={(e) => setEditForm((p) => ({ ...p, name: e.target.value }))} placeholder="Name" data-testid="lead-detail-edit-name" />
                    <Input value={editForm.phone} onChange={(e) => setEditForm((p) => ({ ...p, phone: e.target.value }))} placeholder="Phone" data-testid="lead-detail-edit-phone" />
                    <Input value={editForm.email} onChange={(e) => setEditForm((p) => ({ ...p, email: e.target.value }))} placeholder="Email" data-testid="lead-detail-edit-email" />
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2 text-sm text-slate-700">
                      <Phone className="h-4 w-4 text-slate-400" /> {displayPhone(lead.phone) || "—"}
                    </div>
                    <div className="flex items-center gap-2 text-sm text-slate-700">
                      <Mail className="h-4 w-4 text-slate-400" /> {lead.email || "—"}
                    </div>
                  </div>
                )}
              </div>

              {/* Additional Details (extra_fields) */}
              {Object.keys(lead.extra_fields || {}).length > 0 && (
                <div className="rounded-lg border border-slate-200 p-4" data-testid="lead-detail-extra-fields">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Additional Details</p>
                  {editing ? (
                    <div className="grid gap-2 sm:grid-cols-2">
                      {Object.entries(editForm.extra_fields).map(([key, val]) => (
                        <div key={key}>
                          <label className="text-[10px] text-slate-400">{key}</label>
                          <Input value={val} onChange={(e) => setEditForm((p) => ({ ...p, extra_fields: { ...p.extra_fields, [key]: e.target.value } }))} data-testid={`lead-detail-edit-extra-${key}`} />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="grid gap-2 sm:grid-cols-2">
                      {Object.entries(lead.extra_fields).map(([key, val]) => (
                        <div key={key}>
                          <p className="text-[10px] text-slate-400">{key}</p>
                          <p className="text-sm font-medium text-slate-700">{val || "—"}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Lead Summary */}
              <div className="rounded-lg border border-slate-200 p-4" data-testid="lead-detail-summary">
                <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  <FileText className="h-3.5 w-3.5" /> Lead Summary
                </p>
                {editing ? (
                  <div className="space-y-2">
                    <textarea
                      value={editForm.notes}
                      onChange={(e) => setEditForm((p) => ({ ...p, notes: e.target.value }))}
                      className="min-h-[80px] w-full rounded-md border border-slate-200 p-2.5 text-sm"
                      placeholder="Summary notes..."
                      data-testid="lead-detail-edit-notes"
                    />
                    <Button size="sm" onClick={saveEdit} className="bg-sky-600 text-white hover:bg-sky-700" data-testid="lead-detail-save-btn">Save Changes</Button>
                  </div>
                ) : (
                  <p className="text-sm text-slate-600">{lead.notes || "No summary yet"}</p>
                )}
              </div>

              {/* Move to Stage */}
              <div className="rounded-lg border border-slate-200 p-4" data-testid="lead-detail-move-stage">
                <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">Move to Stage</p>
                <div className="flex flex-wrap gap-1.5">
                  {PIPELINE_STAGES.map((stage) => {
                    const isActive = lead.stage === stage;
                    const color = STAGE_COLORS[stage];
                    return (
                      <button
                        key={stage}
                        type="button"
                        disabled={isActive}
                        onClick={() => handleStageClick(stage)}
                        className={`flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs font-medium transition-all ${
                          isActive
                            ? `${color?.bg || "bg-slate-500"} border-transparent text-white`
                            : `${color?.light || "bg-slate-50 text-slate-600 border-slate-200"} hover:shadow-sm`
                        }`}
                        data-testid={`lead-detail-stage-btn-${stage}`}
                      >
                        {stage}
                        {(stage === "Assigned to Branch" || stage === "Appointment Booked") && !isActive && <ChevronRight className="h-3 w-3" />}
                      </button>
                    );
                  })}
                </div>

                {/* Branch Picker Popup */}
                {showBranchPicker && (
                  <div className="mt-3 rounded-lg border border-violet-200 bg-violet-50/50 p-4" data-testid="branch-picker-popup">
                    <p className="mb-2 text-xs font-semibold text-violet-700">Select Branch to Assign</p>
                    <div className="max-h-40 space-y-1.5 overflow-y-auto">
                      {branches.length === 0 ? (
                        <p className="text-xs text-slate-400">No branches available</p>
                      ) : (
                        branches.map((b) => (
                          <label
                            key={b.id}
                            className={`flex cursor-pointer items-center gap-2 rounded-md border p-2.5 transition-colors ${
                              selectedBranchId === b.id ? "border-violet-400 bg-violet-100" : "border-slate-200 bg-white hover:bg-slate-50"
                            }`}
                            data-testid={`branch-picker-option-${b.id}`}
                          >
                            <input
                              type="radio"
                              name="branch_pick"
                              value={b.id}
                              checked={selectedBranchId === b.id}
                              onChange={() => setSelectedBranchId(b.id)}
                              className="accent-violet-600"
                            />
                            <div>
                              <p className="text-sm font-medium text-slate-800">{b.branch_name}</p>
                              <p className="text-[10px] text-slate-400">{b.address}</p>
                            </div>
                          </label>
                        ))
                      )}
                    </div>
                    <div className="mt-3 flex gap-2">
                      <Button size="sm" onClick={assignBranchAndMove} className="bg-violet-600 text-white hover:bg-violet-700" data-testid="branch-picker-assign-btn">Assign to Branch</Button>
                      <Button size="sm" variant="outline" onClick={() => setShowBranchPicker(false)} data-testid="branch-picker-cancel-btn">Cancel</Button>
                    </div>
                  </div>
                )}

                {/* Appointment Booking Flow */}
                {showBookingFlow && (
                  <div className="mt-3 rounded-lg border border-green-200 bg-green-50/50 p-4" data-testid="booking-flow-popup">
                    <p className="mb-2 text-xs font-semibold text-green-700">Book Appointment</p>
                    {!lead.branch_id ? (
                      <p className="text-xs text-red-500">Lead must be assigned to a branch first</p>
                    ) : (
                      <div className="space-y-3">
                        {/* Date Picker */}
                        <div>
                          <label className="text-[10px] font-medium text-slate-500">Select Date</label>
                          <MilkDateInput  value={selectedDate} onChange={(e) => { setSelectedDate(e.target.value); setSelectedSlot(""); setSelectedDoctorId(""); }} data-testid="booking-date-picker" />
                        </div>

                        {/* Time Slots Grid */}
                        {selectedDate && (
                          <div>
                            <label className="text-[10px] font-medium text-slate-500">Select Time Slot</label>
                            <div className="mt-1 grid grid-cols-4 gap-1" data-testid="booking-time-slots">
                              {generateTimeSlots().map((slot) => {
                                const timeStr = to12h(slot.slice(11, 16));
                                const isSelected = selectedSlot === slot;
                                return (
                                  <button
                                    key={slot}
                                    type="button"
                                    onClick={() => setSelectedSlot(slot)}
                                    className={`rounded-md border px-2 py-1.5 text-[11px] font-medium transition-colors ${
                                      isSelected ? "border-green-500 bg-green-100 text-green-800" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                                    }`}
                                    data-testid={`booking-slot-${timeStr}`}
                                  >
                                    {timeStr}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {/* Doctor Selection */}
                        {selectedSlot && (
                          <div>
                            <label className="text-[10px] font-medium text-slate-500">Select CONSULTANT / Doctor</label>
                            <div className="mt-1 space-y-1.5" data-testid="booking-doctor-list">
                              {doctors.length === 0 ? (
                                <p className="text-xs text-slate-400">No doctors in this branch</p>
                              ) : (
                                doctors.map((doc) => {
                                  // Normalize slot comparison - remove seconds if present
                                  const normalizedSlot = selectedSlot?.slice(0, 16) || "";
                                  const hasSlot = (doc.slots || []).some(s => s.slice(0, 16) === normalizedSlot);
                                  const isSelected = selectedDoctorId === doc.id;
                                  return (
                                    <button
                                      key={doc.id}
                                      type="button"
                                      onClick={() => hasSlot && setSelectedDoctorId(doc.id)}
                                      disabled={!hasSlot}
                                      className={`flex w-full items-center gap-3 rounded-md border p-2.5 text-left transition-all ${
                                        !hasSlot
                                          ? "cursor-not-allowed border-slate-100 bg-slate-50 opacity-40"
                                          : isSelected
                                          ? "border-green-400 bg-green-50 shadow-sm"
                                          : "border-slate-200 bg-white hover:bg-slate-50"
                                      }`}
                                      data-testid={`booking-doctor-${doc.id}`}
                                    >
                                      <div className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-bold ${hasSlot ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-400"}`}>
                                        {doc.full_name?.charAt(0)?.toUpperCase() || "D"}
                                      </div>
                                      <div className="flex-1">
                                        <p className={`text-sm font-medium ${hasSlot ? "text-slate-800" : "text-slate-400"}`}>{doc.full_name}</p>
                                        <p className="text-[10px] text-slate-400">{doc.specialization || "Physiotherapist"}</p>
                                      </div>
                                      {hasSlot ? (
                                        <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-700">Available</span>
                                      ) : (
                                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-400">Unavailable</span>
                                      )}
                                    </button>
                                  );
                                })
                              )}
                            </div>
                          </div>
                        )}

                        {/* Book Button */}
                        <div className="flex gap-2">
                          <Button size="sm" onClick={bookNow} disabled={!selectedDoctorId || !selectedSlot} className="bg-green-600 text-white hover:bg-green-700" data-testid="booking-confirm-btn">Book Appointment</Button>
                          <Button size="sm" variant="outline" onClick={() => setShowBookingFlow(false)} data-testid="booking-cancel-btn">Cancel</Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}

          {/* Remarks Tab */}
          {activeTab === "remarks" && (
            <div className="space-y-3" data-testid="lead-detail-remarks">
              <div className="flex gap-2">
                <Input value={newRemark} onChange={(e) => setNewRemark(e.target.value)} placeholder="Add a remark..." className="flex-1" data-testid="lead-detail-remark-input" />
                <Button size="sm" onClick={addRemarkNow} className="bg-sky-600 text-white hover:bg-sky-700" data-testid="lead-detail-remark-submit">Add</Button>
              </div>
              {remarks.length === 0 ? (
                <p className="py-4 text-center text-sm text-slate-400">No remarks yet</p>
              ) : (
                remarks.map((r) => (
                  <div key={r.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3" data-testid={`lead-remark-${r.id}`}>
                    <p className="text-sm text-slate-700">{r.text}</p>
                    <p className="mt-1 text-[10px] text-slate-400">{r.created_by} · {r.created_at?.slice(0, 16).replace("T", " ")}</p>
                  </div>
                ))
              )}
            </div>
          )}

          {/* Follow-up Tab */}
          {activeTab === "followup" && (
            <div className="space-y-3" data-testid="lead-detail-followups">
              <div className="flex flex-wrap gap-2">
                <Input value={newFollowUp.note} onChange={(e) => setNewFollowUp((p) => ({ ...p, note: e.target.value }))} placeholder="Follow-up note..." className="flex-1" data-testid="lead-detail-followup-note" />
                <MilkDateInput  value={newFollowUp.scheduled_date} onChange={(e) => setNewFollowUp((p) => ({ ...p, scheduled_date: e.target.value }))} className="w-36" data-testid="lead-detail-followup-date" />
                <Button size="sm" onClick={addFollowUpNow} className="bg-sky-600 text-white hover:bg-sky-700" data-testid="lead-detail-followup-submit">Schedule</Button>
              </div>
              {followUps.length === 0 ? (
                <p className="py-4 text-center text-sm text-slate-400">No follow-ups scheduled</p>
              ) : (
                followUps.map((f) => (
                  <div key={f.id} className={`flex items-center justify-between rounded-lg border p-3 ${f.status === "completed" ? "border-emerald-200 bg-emerald-50" : "border-slate-200 bg-white"}`} data-testid={`lead-followup-${f.id}`}>
                    <div>
                      <p className={`text-sm ${f.status === "completed" ? "text-emerald-700 line-through" : "text-slate-700"}`}>{f.note}</p>
                      <p className="text-[10px] text-slate-400">{f.scheduled_date} · {f.created_by}</p>
                    </div>
                    {f.status !== "completed" && (
                      <Button size="sm" variant="outline" onClick={() => completeFollowUpNow(f.id)} className="h-7 text-xs" data-testid={`lead-followup-complete-${f.id}`}>
                        <Check className="mr-1 h-3 w-3" /> Done
                      </Button>
                    )}
                  </div>
                ))
              )}
            </div>
          )}

          {/* Activity Tab */}
          {activeTab === "activity" && (
            <div className="space-y-2" data-testid="lead-detail-activity">
              {activityLog.length === 0 ? (
                <p className="py-4 text-center text-sm text-slate-400">No activity yet</p>
              ) : (
                activityLog.map((a) => (
                  <div key={a.id} className="flex items-start gap-2 rounded-lg border border-slate-100 bg-slate-50 p-3" data-testid={`lead-activity-${a.id}`}>
                    <div className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-sky-100">
                      <Activity className="h-3 w-3 text-sky-600" />
                    </div>
                    <div>
                      <p className="text-sm text-slate-700">{a.details}</p>
                      <p className="text-[10px] text-slate-400">{a.created_by} · {a.created_at?.slice(0, 16).replace("T", " ")}</p>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </ModalOverlay>
  );
}
