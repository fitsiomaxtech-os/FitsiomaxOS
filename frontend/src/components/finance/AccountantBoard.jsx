import { FinanceWorkspace } from "@/components/finance/FinanceWorkspace";

/**
 * Accountant's own login board.
 *
 * The pages themselves — Summary, Approvals, Expense, Profit — live in FinanceWorkspace,
 * which Super Admin > Finance renders too: the same components against the same /finance
 * endpoints, which already answer a super_admin and an accountant identically. So an
 * approval given here, an expense logged here or a book closed here is on that screen the
 * next time it loads, and the other way round. There is one set of books and one set of
 * pages onto it.
 *
 * The only thing that differs between the two boards is what sits after the tabs: Super
 * Admin picks a branch from a dropdown there, where this desk works every branch at once
 * and each page picks its own.
 */
export const AccountantBoard = () => <FinanceWorkspace testId="accountant-board" />;

export default AccountantBoard;
