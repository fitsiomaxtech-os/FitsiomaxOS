// The Branch dropdowns' order (BD Pre Sales View, BD Consultation View), as asked: Anna
// Nagar, Parrys, ECR, T Nagar, Trichy, then the rest -- offline before online, A to Z.
// Matched on the name's letters, so "T.Nagar" and "T Nagar Branch" are the same branch.
// Anna Nagar is tested before T Nagar.
const BRANCH_PICKER_ORDER = ["annanagar", "parry", "ecr", "tnagar", "trichy"];

export const branchNameOf = (b) => b?.branch_name || b?.name || "";

const isOnlineBranch = (b) => String(b?.vertical || "").startsWith("online_");

const branchPickerRank = (b) => {
  const n = branchNameOf(b).toLowerCase().replace(/[^a-z]/g, "");
  const i = BRANCH_PICKER_ORDER.findIndex((key) => n.includes(key));
  return i === -1 ? BRANCH_PICKER_ORDER.length : i;
};

export const sortBranchesForPicker = (list) => [...(list || [])].sort((a, b) => (
  branchPickerRank(a) - branchPickerRank(b)
  || Number(isOnlineBranch(a)) - Number(isOnlineBranch(b))
  || branchNameOf(a).localeCompare(branchNameOf(b))
));
