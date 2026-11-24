import { FinanceWorkspace } from "@/components/finance/FinanceWorkspace";

/**
 * Super Admin > Finance and Business Development > Finance — the whole finance book,
 * browsed per branch.
 *
 * The tabs pick which page of it and the branch dropdown after the last of them picks whose
 * book, and both apply together whichever branch (or All Branches) is selected. Every page
 * here is the same component the Accountant's own board renders, from the same list, so a
 * sign-off, an expense or a closed book entered on either screen is on the other the next
 * time it loads, and the two tab rows cannot come to hold different pages.
 */
export const FinanceWiseBoard = ({ branches }) => (
  <FinanceWorkspace branches={branches || []} testId="finance-wise-board" />
);

export default FinanceWiseBoard;
