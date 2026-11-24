import { FinanceWorkspace } from "@/components/finance/FinanceWorkspace";

/**
 * Super Admin > Finance — the whole finance book, browsed per branch.
 *
 * The branch pill row picks whose book and the tab row picks which page of it, and both
 * apply together whichever branch (or All Branches) is selected. Every page here is the
 * same component the Accountant's own board renders, from the same list, so a sign-off, an
 * expense or a closed book entered on either screen is on the other the next time it
 * loads, and the two rows cannot come to hold different pages.
 *
 * Business Development > Finance is this board too, with `branchDropdown`: its branch row
 * is one dropdown rather than the pills.
 */
export const FinanceWiseBoard = ({ branches, branchDropdown = false }) => (
  <FinanceWorkspace branches={branches || []} branchDropdown={branchDropdown} testId="finance-wise-board" />
);

export default FinanceWiseBoard;
