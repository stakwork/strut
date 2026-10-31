import type { ProposalCard } from "./api";

/** The head of a proposal's summary for the row: its first line, cut. The
 *  body shows the whole text (line breaks kept) behind the row's fold. */
export function summaryHead(summary: string, max = 160): string {
  const first = summary.trim().split(/\r?\n/)[0] ?? "";
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}

/** The buttons' labels: the card's, else Accept / Reject. */
export function labelsOf(card: ProposalCard | undefined): { accept: string; reject: string } {
  return card?.actions ?? { accept: "Accept", reject: "Reject" };
}
