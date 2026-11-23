// Workers (plans/human-steps.md §9.5): the workers, `new` first: the people
// who signed in and wait, then the rest; above them the Invite a worker box (§5.8, ./Share), whose
// body is the invites made, with who took each (a worker's grant `by` it). Several new ones may be granted a type at
// once (one door call each; the page says which failed); an open type's
// worker took it up themselves (ruling 9), and their grant says so. A worker shows
// their status with its acts, their note, their grants (revoked ones with
// when, who and why: an automatic revoke by `standing` too, §9.7), what they
// did this week and their newest leases, and, when the server answers for
// them, their standing (4) and what they earned (5a). Message opens their
// conversation with Support (plans/support-chat.md §3) where Support answers.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useStrutClient } from "@strut/kit";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  balanceCells, fmtSats, fmtWhen, grantedBy, leaseOutcome, OPEN_GRANT_BY, reviewText, standingLow, standingText, STATUS_WORDS, whoElse, whoOf, type Place, type Shown,
} from "../lib/view";
import type { TaskType, TypeNumbers, TypeShare, Worker, WorkerActivity, WorkerStatus } from "../lib/types";
import { Avatar, Back, Empty, ErrorLine, Figure, Loading, Note, ReasonButton, Section, useAct } from "./bits";
import { BringWorkersIn } from "./Share";

interface Props {
  go: (p: Place) => void;
  place: Place;
  shown: Shown;
  types?: TaskType[];
  /** Tasks' share (`staff/types`' `tasks`): every invite opens it. */
  tasks?: TypeShare;
  workers?: Worker[];
  error: unknown;
}

export function Workers(props: Props) {
  if (props.error) return <ErrorLine error={props.error} />;
  if (!props.workers) return <Loading>Reading the workers…</Loading>;
  if (props.place.worker) return <WorkerDetail {...props} actor={props.place.worker} />;
  return (
    <>
      {props.types && <BringWorkersIn types={props.types} tasks={props.tasks} workers={props.workers} history />}
      <WorkerList {...props} workers={props.workers} waiting={0} />
    </>
  );
}

function WorkerList(props: Props & { workers: Worker[]; waiting: number }) {
  const [find, setFind] = useState("");
  const [reviewWorker, setReviewWorker] = useState<Worker | null>(null);
  const words = find.trim().toLowerCase();
  const list = words ? props.workers.filter((w) => `${whoOf(w)} ${w.name ?? ""} ${w.actor}`.toLowerCase().includes(words)) : props.workers;
  const able = props.workers.filter((w) => w.status === "active").length;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="text-base font-semibold">Workers</h2>
        <span className="text-sm text-muted-foreground">
          {able.toLocaleString("en-US")} can take tasks{props.workers.length > able ? ` · ${props.workers.length - able} suspended or banned` : ""}
        </span>
        {props.workers.length > 5 && (
          <label className="ml-auto flex h-9 items-center gap-2 rounded-md border px-3 text-muted-foreground focus-within:border-ring">
            <Search className="size-4 shrink-0" />
            <input type="search" aria-label="Find a worker" placeholder="Find a worker" className="w-44 bg-transparent text-sm text-foreground outline-none" value={find} onChange={(e) => setFind(e.target.value)} />
          </label>
        )}
      </div>
      {props.workers.length === 0 ? (
        <Empty>
          {props.waiting
            ? "Nobody has been let in yet: the people above are waiting."
            : "No worker has signed in yet. A worker is anyone who signed in to Tasks and asked for work (Invite a worker, above, makes their link). Open work lets them in on their first ask; invite-only work, their invite or you."}
        </Empty>
      ) : list.length === 0 ? (
        <Empty>No worker by that name.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Worker</TableHead>
                <TableHead>Can do</TableHead>
                <TableHead>Joined</TableHead>
                <TableHead className="text-right" title="Answers in the last 7 days">Answers this week</TableHead>
                {props.shown.standing && <TableHead title="Per type with tests: passed of the newest graded, or qualifying">Standing</TableHead>}
                {props.shown.earnings && <TableHead className="text-right" title="Earned, less taken back and withdrawn: what they are owed">Owed</TableHead>}
                <TableHead className="w-6" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((w) => {
                const types = w.grants.filter((g) => g.revokedAt === undefined);
                return (
                  <TableRow key={w.actor} className="cursor-pointer" onClick={() => props.go({ tab: "workers", worker: w.actor })}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <Avatar name={whoOf(w)} />
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2 font-medium" title={w.actor}>
                            {whoOf(w)}
                            {w.status !== "active" && <StatusBadge status={w.status} />}
                            {w.holding && (
                              <span className="inline-flex items-center gap-1.5 text-xs font-normal text-muted-foreground" title={`Working on a task of ${w.holding} now`}>
                                <span aria-hidden className="size-1.5 rounded-full bg-emerald-500" /> working now
                              </span>
                            )}
                          </div>
                          {whoElse(w) && <div className="font-mono text-xs text-muted-foreground">{whoElse(w)}</div>}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      {types.length === 0 ? (
                        <span className="text-muted-foreground">nothing yet</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {types.map((g) => (
                            <Badge key={g.type} variant="outline" title={g.by === OPEN_GRANT_BY ? "Open work: they took it up themselves" : undefined}>
                              {g.type}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{fmtWhen(w.firstSeen)}</TableCell>
                    <TableCell className="text-right tabular-nums">{w.week ?? "—"}</TableCell>
                    {props.shown.standing && (
                      <TableCell className="text-xs">
                        {Object.entries(w.standing ?? {}).map(([t, s]) => (
                          <div key={t} className={cn(standingLow(s) && "text-destructive")}>
                            {t}: {standingText(s)}
                          </div>
                        ))}
                      </TableCell>
                    )}
                    {props.shown.earnings && (
                      <TableCell className="text-right tabular-nums" title={w.balance ? `${fmtSats(w.balance.withdrawableMsat)} can be withdrawn now` : undefined}>
                        {w.balance ? fmtSats(w.balance.totalMsat) : "—"}
                        {w.balance && w.balance.heldMsat > 0 && <div className="text-xs text-muted-foreground">{fmtSats(w.balance.heldMsat)} held</div>}
                      </TableCell>
                    )}
                    <TableCell className="pl-0">
                      <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); setReviewWorker(w); }}>
                        Review
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {reviewWorker && <ReviewModal worker={reviewWorker} types={props.types} shown={props.shown} go={props.go} onClose={() => setReviewWorker(null)} />}
    </section>
  );
}

function ReviewModal(props: { worker: Worker; types: TaskType[] | undefined; shown: Shown; go: (p: Place) => void; onClose: () => void }) {
  const w = props.worker;
  const client = useStrutClient();
  const { act, busy, error } = useAct();
  const [grantType, setGrantType] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const detail = useQuery({ queryKey: ["staff", "worker", w.actor], queryFn: () => client.run<{ worker: Worker } & WorkerActivity>("staff/worker", { actor: w.actor }) });
  const numbers = useQuery({ queryKey: ["staff", "numbers", 90], queryFn: () => client.run<TypeNumbers[]>("staff/numbers", { days: 90 }) });
  const live = w.grants.filter((g) => g.revokedAt === undefined);
  const revoked = w.grants.filter((g) => g.revokedAt !== undefined);
  const grantable = (props.types ?? []).filter((t) => !live.some((g) => g.type === t.name));
  const mine = (numbers.data ?? []).flatMap((t) => {
    const n = t.workers.find((x) => x.worker === w.actor);
    return n ? [{ type: t.type, answered: n.answered }] : [];
  });
  const total = mine.reduce((a, b) => a + b.answered, 0);
  const [earned, held, free] = balanceCells(w.balance);
  const standing = Object.entries(w.standing ?? {});
  return (
    <Dialog open onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent className="max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {whoOf(w)} <StatusBadge status={w.status} />
          </DialogTitle>
          <DialogDescription className="font-mono text-xs break-all">{w.actor}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <Section title="Who">
            {whoElse(w) && <Note>{whoElse(w)}</Note>}
            <Note>
              Joined {fmtWhen(w.firstSeen)}
              {w.grants[0]?.by ? ` · first grant ${grantedBy(w.grants[0])}` : ""}
            </Note>
            {w.note && <p className="text-sm whitespace-pre-wrap">{w.note}</p>}
          </Section>

          {props.shown.earnings && w.balance && (
            <section className="grid grid-cols-3 gap-4 rounded-lg border p-4">
              <Figure label="Earned" value={earned} />
              <Figure label="Held" value={held} />
              <Figure label="Withdrawable" value={free} />
            </section>
          )}

          <Section title="Activity">
            {detail.error ? (
              <ErrorLine error={detail.error} />
            ) : !detail.data ? (
              <Loading>Reading their activity…</Loading>
            ) : (
              <>
                {detail.data.holding ? (
                  <Note>Working on a task of {detail.data.holding.type}, theirs until {fmtWhen(detail.data.holding.expires)}.</Note>
                ) : (
                  <Note>No task in progress.</Note>
                )}
                <Note>
                  {w.week ?? 0} answers this week
                  {detail.data.recent?.[0] ? ` · last took a task ${fmtWhen(detail.data.recent[0].lease.taken)}` : ""}
                </Note>
              </>
            )}
            {numbers.error ? (
              <ErrorLine error={numbers.error} />
            ) : !numbers.data ? (
              <Loading>Reading their numbers…</Loading>
            ) : (
              <Note>
                {total} answered in 90 days{mine.length ? `: ${mine.map((m) => `${m.type} ${m.answered}`).join(", ")}` : ""}
              </Note>
            )}
            {standing.map(([t, s]) => (
              <div key={t} className={cn("text-xs", standingLow(s) && "text-destructive")}>
                {t}: {standingText(s)}
              </div>
            ))}
          </Section>

          <Section title="Grants">
            {live.length === 0 && <Note>Not let in to any work yet.</Note>}
            {live.map((g) => (
              <div key={g.type} className="text-sm">
                <span className="font-medium">{g.type}</span>{" "}
                <span className="text-xs text-muted-foreground">since {fmtWhen(g.at)}{g.by ? ` ${grantedBy(g)}` : ""}</span>
              </div>
            ))}
            {revoked.map((g) => (
              <div key={g.type} className="text-sm">
                <span className="font-medium">{g.type}</span>{" "}
                <span className="text-xs text-muted-foreground">
                  revoked {fmtWhen(g.revokedAt!)} by {g.revokedBy === "standing" ? "standing (automatic)" : (g.revokedBy ?? "someone")}
                  {g.why ? `: ${g.why}` : ""}
                </span>
              </div>
            ))}
          </Section>
          {notice && <Note>{notice}</Note>}
          <ErrorLine error={error} />
        </div>
        <DialogFooter className="flex-wrap items-center gap-2 sm:justify-start">
          {grantable.length > 0 && (
            <>
              <NativeSelect aria-label="Type to grant" value={grantType} onChange={(e) => setGrantType(e.target.value)}>
                <NativeSelectOption value="">Grant a type…</NativeSelectOption>
                {grantable.map((t) => (
                  <NativeSelectOption key={t.name} value={t.name}>
                    {t.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <Button
                size="sm"
                disabled={!grantType || busy !== null}
                onClick={() =>
                  void act("grant", () => client.run<{ notice?: string }>("staff/grant", { actor: w.actor, type: grantType })).then((r) => {
                    if (r) { setNotice(r.notice ?? "Granted."); setGrantType(""); }
                  })
                }
              >
                Grant
              </Button>
            </>
          )}
          {w.status !== "suspended" && w.status !== "banned" && (
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void act("suspend", () => client.run("staff/set-worker", { actor: w.actor, status: "suspended" })).then((r) => r !== undefined && props.onClose())}>
              Suspend
            </Button>
          )}
          <button type="button" className="ml-auto text-sm underline underline-offset-2" onClick={() => { props.go({ tab: "workers", worker: w.actor }); props.onClose(); }}>
            Full page →
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StatusBadge({ status }: { status: WorkerStatus }) {
  return <Badge variant={status === "banned" ? "destructive" : status === "active" ? "secondary" : "outline"}>{status}</Badge>;
}

function WorkerDetail(props: Props & { actor: string }) {
  const client = useStrutClient();
  const { act, busy, error } = useAct();
  const q = useQuery({ queryKey: ["staff", "worker", props.actor], queryFn: () => client.run<{ worker: Worker } & WorkerActivity>("staff/worker", { actor: props.actor }) });
  const [note, setNote] = useState<string | null>(null);
  const [banning, setBanning] = useState(false);
  const [grantType, setGrantType] = useState("");
  const [noQualify, setNoQualify] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const back = <Back onClick={() => props.go({ tab: "workers" })}>Workers</Back>;
  if (q.error) return (<div className="flex flex-col gap-3">{back}<ErrorLine error={q.error} /></div>);
  if (!q.data) return <Loading>Reading the worker…</Loading>;
  const { holding, week, recent } = q.data;
  // Their name as the list carries it (App's `useNames`): the route keeps none.
  const name = props.workers?.find((x) => x.actor === props.actor)?.name;
  const w: Worker = name ? { ...q.data.worker, name } : q.data.worker;
  const live = w.grants.filter((g) => g.revokedAt === undefined);
  const revoked = w.grants.filter((g) => g.revokedAt !== undefined);
  const grantable = (props.types ?? []).filter((t) => !live.some((g) => g.type === t.name));
  const picked = (props.types ?? []).find((t) => t.name === grantType);
  const setStatus = (status: WorkerStatus) => void act(status, () => client.run("staff/set-worker", { actor: w.actor, status }));
  const [earned, held, free] = balanceCells(w.balance);

  return (
    <div className="flex flex-col gap-5">
      {back}
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">{whoOf(w)}</h2>
        {w.name && w.name !== whoOf(w) && <span className="text-sm text-muted-foreground">{w.name}</span>}
        <StatusBadge status={w.status} />
        <span className="font-mono text-xs break-all text-muted-foreground">{w.actor}</span>
      </div>
      <Note>
        First seen {fmtWhen(w.firstSeen)}
        {w.changedBy ? ` · last changed by ${w.changedBy} ${fmtWhen(w.changedAt)}` : ""}
      </Note>

      <div className="flex flex-wrap items-center gap-2">
        {(w.status === "new" || w.status === "suspended" || w.status === "banned") && (
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setStatus("active")}>
            {w.status === "new" ? "Review" : "Lift"}
          </Button>
        )}
        {w.status !== "suspended" && w.status !== "banned" && (
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setStatus("suspended")} title="They take no task until lifted; a lease they hold ends now">
            Suspend
          </Button>
        )}
        {w.status !== "banned" &&
          (banning ? (
            <>
              <Button size="sm" variant="destructive" disabled={busy !== null} onClick={() => { setBanning(false); setStatus("banned"); }}>
                Ban: a lease they hold ends now
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setBanning(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setBanning(true)}>
              Ban
            </Button>
          ))}
        {props.shown.support && (
          <Button size="sm" variant="outline" onClick={() => props.go({ tab: "support", worker: w.actor })} title="Their conversation with Support">
            Message
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => props.go({ tab: "tasks", by: w.actor })}>
          Their answers
        </Button>
        {props.shown.payouts && (
          <Button size="sm" variant="ghost" onClick={() => props.go({ tab: "payouts", worker: w.actor })}>
            Their payouts
          </Button>
        )}
      </div>
      {holding && (
        <p className="text-sm">
          Working on a task of {holding.type}, theirs until {fmtWhen(holding.expires)}:{" "}
          <button type="button" className="underline underline-offset-2" onClick={() => props.go({ tab: "tasks", task: holding.task })}>
            its task
          </button>
        </p>
      )}

      <Section title="Note" aside={<Note>The first line is their name here</Note>}>
        <Textarea value={note ?? w.note ?? ""} onChange={(e) => setNote(e.target.value)} placeholder="Who they are, what to know" className="min-h-16" />
        {note !== null && note !== (w.note ?? "") && (
          <div className="flex gap-2">
            <Button size="sm" disabled={busy !== null} onClick={() => void act("note", () => client.run("staff/set-worker", { actor: w.actor, note: note.trim() ? note : null })).then(() => setNote(null))}>
              Save note
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setNote(null)}>
              Cancel
            </Button>
          </div>
        )}
      </Section>

      {props.shown.earnings && w.balance && (
        <section className="grid grid-cols-3 gap-4 rounded-lg border p-4">
          <Figure label="Earned" value={earned} title="Earned, less taken back and withdrawn" />
          <Figure label="Held" value={held} title={w.balance.nextReleaseAt ? `The next releases ${fmtWhen(w.balance.nextReleaseAt)}` : undefined} />
          <Figure label="Withdrawable" value={free} />
        </section>
      )}

      <Section title="Work they can do">
        {live.length === 0 && <Note>Not let in to any work yet: they take nothing here.</Note>}
        <ul className="flex flex-col gap-1">
          {live.map((g) => {
            const s = w.standing?.[g.type];
            return (
              <li key={g.type} className="flex flex-wrap items-center gap-2 text-sm">
                <button type="button" className="font-medium underline-offset-2 hover:underline" onClick={() => props.go({ tab: "types", type: g.type })}>
                  {g.type}
                </button>
                <span className="text-xs text-muted-foreground">
                  since {fmtWhen(g.at)}
                  {g.by ? ` ${grantedBy(g)}` : ""}
                </span>
                {props.shown.standing && s && <span className={cn("text-xs", standingLow(s) && "text-destructive")}>{standingText(s)}{s.errors ? ` · ${s.errors} grader error${s.errors === 1 ? "" : "s"}` : ""}</span>}
                <span className="ml-auto">
                  <ReasonButton label="Revoke" placeholder="Why (kept with the grant)" disabled={busy !== null} onAct={(why) => void act("revoke", () => client.run("staff/revoke", { actor: w.actor, type: g.type, ...(why ? { why } : {}) }))} />
                </span>
              </li>
            );
          })}
        </ul>
        {grantable.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <NativeSelect aria-label="Type to grant" value={grantType} onChange={(e) => setGrantType(e.target.value)}>
              <NativeSelectOption value="">Grant a type…</NativeSelectOption>
              {grantable.map((t) => (
                <NativeSelectOption key={t.name} value={t.name}>
                  {t.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            {props.shown.tests && picked?.tests && (
              <label className="flex items-center gap-1.5 text-xs">
                <Checkbox checked={noQualify} onCheckedChange={(c) => setNoQualify(c === true)} /> no qualifying (a worker you know)
              </label>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={!grantType || busy !== null}
              onClick={() =>
                void act("grant", () => client.run<{ notice?: string }>("staff/grant", { actor: w.actor, type: grantType, ...(noQualify && picked?.tests ? { qualify: false } : {}) })).then((r) => {
                  setNotice(r ? [w.status === "new" ? `${whoOf(w)} is active now.` : "", r.notice ?? ""].filter(Boolean).join(" ") || null : null);
                  setGrantType("");
                })
              }
            >
              Grant
            </Button>
          </div>
        )}
        {notice && <Note>{notice}</Note>}
        {revoked.length > 0 && (
          <div className="flex flex-col gap-1">
            <div className="text-xs font-medium text-muted-foreground">Revoked</div>
            {revoked.map((g) => (
              <div key={g.type} className="text-sm">
                <span className="font-medium">{g.type}</span>{" "}
                <span className="text-muted-foreground">
                  {fmtWhen(g.revokedAt!)} by {g.revokedBy === "standing" ? "standing (automatic)" : (g.revokedBy ?? "someone")}
                  {g.why ? `: ${g.why}` : ""}
                  {g.by === OPEN_GRANT_BY ? " · an open type: only a grant lets them back" : ""}
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>
      <ErrorLine error={error} />

      <Section title="This week">
        {week && Object.keys(week).length ? (
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Answered</TableHead>
                  <TableHead className="text-right">Skipped</TableHead>
                  <TableHead className="text-right">Ran out</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.entries(week).map(([t, n]) => (
                  <TableRow key={t}>
                    <TableCell>{t}</TableCell>
                    <TableCell className="text-right tabular-nums">{n.answered}</TableCell>
                    <TableCell className="text-right tabular-nums">{n.skipped}</TableCell>
                    <TableCell className="text-right tabular-nums">{n.lost}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <Note>Nothing taken in the last 7 days.</Note>
        )}
      </Section>

      <Section
        title="Newest tasks they took"
        aside={
          props.shown.review ? (
            <span className="flex flex-wrap gap-2 text-xs">
              <button type="button" className="underline underline-offset-2" onClick={() => props.go({ tab: "tasks", by: w.actor, review: "none" })}>
                Their answers to review
              </button>
              <button type="button" className="underline underline-offset-2" onClick={() => props.go({ tab: "tasks", by: w.actor, review: "rejected" })}>
                Rejected
              </button>
            </span>
          ) : undefined
        }
      >
        {recent?.length ? (
          <ul className="flex flex-col gap-1">
            {recent.map(({ lease: l, task: t }) => (
              <li key={l.id}>
                <button type="button" className="flex w-full flex-wrap items-center gap-2 rounded px-1 py-0.5 text-left text-sm hover:bg-muted" onClick={() => props.go({ tab: "tasks", task: t.id })}>
                  <span className="w-28 shrink-0 text-xs text-muted-foreground">{fmtWhen(l.taken)}</span>
                  <span className="font-medium">{t.type}</span>
                  {t.test && <Badge variant="outline">test</Badge>}
                  <span>{leaseOutcome(l)}</span>
                  <span className="text-xs text-muted-foreground">task {STATUS_WORDS[t.status]}</span>
                  {l.review && <span className={cn("text-xs", l.review.verdict === "rejected" && "text-destructive")}>{reviewText(l.review)}</span>}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <Note>They have taken no task yet.</Note>
        )}
      </Section>
    </div>
  );
}
