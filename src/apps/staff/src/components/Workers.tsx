// Workers (plans/human-steps.md §9.5): `new` first — the people who signed
// in and wait — then the rest. Several new ones may be granted a type at
// once (one door call each; the page says which failed). A worker shows
// their status with its acts, their note, their grants (revoked ones with
// when, who and why: an automatic revoke by `standing` too, §9.7), what they
// did this week and their newest leases, and, when the server answers for
// them, their standing (4) and what they earned (5a).
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useStrutClient } from "@strut/kit";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  balanceCells, fmtWhen, leaseOutcome, liveTypes, reviewText, shortActor, standingLow, standingText, STATUS_WORDS, whoOf, workersInOrder, type Place, type Shown,
} from "../lib/view";
import type { TaskType, Worker, WorkerActivity, WorkerStatus } from "../lib/types";
import { Back, Empty, ErrorLine, Figure, Loading, Note, ReasonButton, Section, useAct } from "./bits";

interface Props {
  go: (p: Place) => void;
  place: Place;
  shown: Shown;
  types?: TaskType[];
  workers?: Worker[];
  error: unknown;
}

export function Workers(props: Props) {
  if (props.error) return <ErrorLine error={props.error} />;
  if (!props.workers) return <Loading>Reading the workers…</Loading>;
  if (props.place.worker) return <WorkerDetail {...props} actor={props.place.worker} />;
  return <WorkerList {...props} workers={props.workers} />;
}

function WorkerList(props: Props & { workers: Worker[] }) {
  const client = useStrutClient();
  const { act, busy, error } = useAct();
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [type, setType] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const list = workersInOrder(props.workers);
  const fresh = list.filter((w) => w.status === "new");
  const tick = (a: string, on: boolean) => setTicked((s) => (on ? new Set(s).add(a) : new Set([...s].filter((x) => x !== a))));
  /** One door call per worker; the page says which failed. */
  const grantAll = async () => {
    const failed: string[] = [];
    let done = 0;
    await act("grant", async () => {
      for (const actor of ticked) {
        try {
          await client.run("staff/grant", { actor, type });
          done++;
        } catch (err) {
          failed.push(`${shortActor(actor)}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });
    setTicked(new Set());
    setResult(`Granted ${type} to ${done} worker${done === 1 ? "" : "s"}; each is active now.${failed.length ? ` Failed: ${failed.join("; ")}` : ""}`);
  };

  return (
    <Section title="Workers" aside={<Note>{fresh.length ? `${fresh.length} new, waiting for a grant` : `${list.length} here`}</Note>}>
      {list.length === 0 ? (
        <Empty>No worker has signed in yet. A worker is anyone who signed in to a worker app and asked for a task; they appear here as new, and a grant lets them in.</Empty>
      ) : (
        <>
          {fresh.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span>Grant the {ticked.size || "ticked"} new worker{ticked.size === 1 ? "" : "s"}</span>
              <NativeSelect aria-label="Type to grant" value={type} onChange={(e) => setType(e.target.value)}>
                <NativeSelectOption value="">a type…</NativeSelectOption>
                {(props.types ?? []).map((t) => (
                  <NativeSelectOption key={t.name} value={t.name}>
                    {t.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <Button size="sm" disabled={!type || ticked.size === 0 || busy !== null} onClick={() => void grantAll()}>
                Grant
              </Button>
            </div>
          )}
          {result && <p className="text-sm text-muted-foreground" role="status">{result}</p>}
          <ErrorLine error={error} />
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  {fresh.length > 0 && <TableHead className="w-8" />}
                  <TableHead>Who</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>First seen</TableHead>
                  <TableHead>Types</TableHead>
                  <TableHead className="text-right" title="Answers in the last 7 days">This week</TableHead>
                  <TableHead>Holding</TableHead>
                  {props.shown.standing && <TableHead title="Per type with tests: passed of the newest graded, or qualifying">Standing</TableHead>}
                  {props.shown.earnings && (
                    <>
                      <TableHead className="text-right" title="Earned, less taken back and withdrawn: what they are owed">Earned</TableHead>
                      <TableHead className="text-right" title="Of it, still in its hold">Held</TableHead>
                      <TableHead className="text-right" title="Past its hold: theirs to withdraw">Withdrawable</TableHead>
                    </>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((w) => {
                  const [earned, held, free] = balanceCells(w.balance);
                  return (
                    <TableRow key={w.actor} className="cursor-pointer" onClick={() => props.go({ tab: "workers", worker: w.actor })}>
                      {fresh.length > 0 && (
                        <TableCell onClick={(e) => e.stopPropagation()}>{w.status === "new" && <Checkbox aria-label={`Tick ${whoOf(w)}`} checked={ticked.has(w.actor)} onCheckedChange={(c) => tick(w.actor, c === true)} />}</TableCell>
                      )}
                      <TableCell>
                        <div className="font-medium">{whoOf(w)}</div>
                        {w.note && <div className="font-mono text-xs text-muted-foreground">{shortActor(w.actor)}</div>}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={w.status} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{fmtWhen(w.firstSeen)}</TableCell>
                      <TableCell>{liveTypes(w).join(", ") || "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{w.week ?? "—"}</TableCell>
                      <TableCell>{w.holding ?? "—"}</TableCell>
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
                        <>
                          <TableCell className="text-right tabular-nums">{earned}</TableCell>
                          <TableCell className="text-right tabular-nums">{held}</TableCell>
                          <TableCell className="text-right tabular-nums">{free}</TableCell>
                        </>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </Section>
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
  const { worker: w, holding, week, recent } = q.data;
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
            {w.status === "new" ? "Activate" : "Lift"}
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
        <Button size="sm" variant="ghost" onClick={() => props.go({ tab: "tasks", by: w.actor })}>
          Their answers
        </Button>
      </div>
      {holding && (
        <p className="text-sm">
          Holding a lease of {holding.type} until {fmtWhen(holding.expires)}:{" "}
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

      <Section title="Grants">
        {live.length === 0 && <Note>No live grant: they take nothing here.</Note>}
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
                  {g.by ? ` by ${g.by}` : ""}
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
        title="Newest leases"
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
          <Note>No lease yet.</Note>
        )}
      </Section>
    </div>
  );
}
