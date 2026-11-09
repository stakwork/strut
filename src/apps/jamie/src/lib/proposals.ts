// Who may accept a proposal, as the card draws it. A proposal only an admin
// accepts (`approver: "admin"`: installing a package) shows its viewer an
// Accept only when they are an admin of this strut server — `proposal/get`
// says (`viewer.admin`, from the app door); anyone else reads that an admin
// must approve it, and may still reject it. Until the live read says who the
// viewer is, neither shows: an Accept that would be refused, or a line an
// admin would not need.

export type AcceptLook = "accept" | "admin" | "unknown";

export function acceptLook(approver: "admin" | undefined, viewer: { admin: boolean } | undefined): AcceptLook {
  if (approver !== "admin") return "accept";
  if (!viewer) return "unknown";
  return viewer.admin ? "accept" : "admin";
}

/** The line a viewer who is not an admin reads in place of Accept. */
export const ADMIN_MUST_APPROVE = "An admin must approve this.";
