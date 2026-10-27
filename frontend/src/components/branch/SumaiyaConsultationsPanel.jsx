import { useState } from "react";
import { HeadPhysioBoard } from "@/components/HeadPhysioBoard";

/**
 * Branch Admin's Sumaiya Consultations tab: the Super Admin's My Consultation board, read
 * at this branch alone.
 *
 * The same board, cards and table, asked for the consultations booked to the Head Chief
 * (headChief) rather than to the reader — a Branch Admin has no consultant record of their
 * own, and `mine` would come back empty. No branch picker: the branch is the one this board
 * is open on, and the server holds a Branch Admin to it.
 */
// `squareTable`: its tables with 4px corners — set on the Branch Admin's own login.
export const SumaiyaConsultationsPanel = ({ branchId, squareTable = false }) => {
  const [search, setSearch] = useState("");
  return (
    <div data-testid="branch-sumaiya-consultations">
      <HeadPhysioBoard
        branchId={branchId}
        headChief
        search={search}
        onSearchChange={setSearch}
        ledgerCards
        rowArrow
        oneLineRows
        squareTable={squareTable}
        // Branch Admin's bottom bar is the phone's navigation here; the board's tabs
        // become the list cards the other Branch Admin tabs show on a phone.
        phoneStack
      />
    </div>
  );
};

export default SumaiyaConsultationsPanel;
