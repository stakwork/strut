// A Concept's CHECKS and TESTS (plans/claim-trials.md §4–§5): what its
// readers are held to, each check with the messages that test it and a dot
// per verdict, and the changes tried against the page, each a diff with two
// rows of dots — the page, and the page with the change. An admin runs a
// check, adds one, tests a change and puts the wording that did better on
// the page; a member reads.
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check as CheckIcon, Loader2, Minus, Pencil, Play, Plus, X } from "lucide-react";
import { foldDiffLines, lineDiff, useStrutClient } from "@strut/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useChecks } from "../lib/read";
import {
  OUTCOME, allSamples, capped, caseFor, caseLabel, heldOf, messageOf, outcomeOf, replyOf, runningWords, samplesOf, speakerLabel, tally, tallyWords, workflowFor,
  type Check, type ChecksView, type PageTest, type Sample,
} from "../lib/checks";
import { CLAIM_STATUS, byStatus, claimsUnavailable, evidenceLine } from "../lib/learning";
import { SectionLabel } from "./bits";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const ADD = "bg-emerald-500/10 text-emerald-900 dark:text-emerald-100";
const DEL = "bg-red-500/10 text-red-900 dark:text-red-100";

/** A sample picked: where it was clicked, so the same run drawn twice lights once. */
interface Picked {
  at: string;
  sample: Sample;
}

function Dots({ samples, at, picked, onPick }: { samples: readonly Sample[]; at: string; picked: Picked | null; onPick: (p: Picked) => void }) {
  const { more, shown } = capped(samples);
  if (!samples.length) return <span className="text-xs text-muted-foreground">Not run yet</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-[3px]" data-testid="check-dots">
      {more > 0 && (
        <span className="mr-1 text-xs tabular-nums text-muted-foreground" title={`${more} earlier sample${more === 1 ? "" : "s"}`}>
          +{more}
        </span>
      )}
      {shown.map((s) => (
        <button
          key={s.run}
          type="button"
          onClick={() => onPick({ at, sample: s })}
          aria-label={s.supports ? "Passed sample" : "Failed sample"}
          data-pass={s.supports}
          className={cn(
            "size-2.5 rounded-full",
            s.supports ? "bg-emerald-500" : "bg-rose-500",
            picked?.at === at && picked.sample.run === s.run && "ring-2 ring-foreground ring-offset-1 ring-offset-background",
          )}
        />
      ))}
    </span>
  );
}

/** A row of a test, or of the page: a label, the dots, the count. */
function Row({ label, samples, at, picked, onPick }: { label: string; samples: readonly Sample[]; at: string; picked: Picked | null; onPick: (p: Picked) => void }) {
  const t = tally(samples);
  return (
    <div className="flex items-center gap-3 py-0.5">
      <span className="w-28 shrink-0 text-xs">{label}</span>
      <span className="min-w-0 flex-1">
        <Dots samples={samples} at={at} picked={picked} onPick={onPick} />
      </span>
      {t.judged > 0 && (
        <span className="text-xs font-medium tabular-nums">
          {t.passed}/{t.judged}
        </span>
      )}
    </div>
  );
}

/** The sample a dot opened: the message, the reply, the job it would have started (held) and the judge's line. Only a trial's run is opened. */
function SamplePanel({ sample, admin }: { sample: Sample; admin: boolean }) {
  const client = useStrutClient();
  const open = admin && sample.trial === true && !!sample.workflow;
  const q = useQuery({
    queryKey: ["knowledge", "sample", sample.workflow, sample.run],
    enabled: open,
    staleTime: Infinity,
    retry: false,
    queryFn: async () => {
      const r = await client.run("knowledge/sample", { workflow: sample.workflow, run: sample.run });
      return typeof r === "string" ? null : (r as { input: unknown; output?: unknown; error?: string });
    },
  });
  const held = q.data ? heldOf(q.data) : null;
  return (
    <div className="space-y-2 rounded-md bg-muted/50 p-3 text-xs" data-testid="check-sample">
      {open && q.isLoading && <Skeleton className="h-10" />}
      {q.data && (
        <>
          <div>
            <p className="text-muted-foreground">Message</p>
            <p className="whitespace-pre-wrap break-words">{messageOf(q.data.input)}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Reply</p>
            <p className="whitespace-pre-wrap break-words font-serif text-sm">{replyOf(q.data)}</p>
          </div>
          {held && (
            <div data-testid="check-sample-held">
              <p className="text-muted-foreground">The job it would have started (held: a trial starts none)</p>
              {held.title && <p className="font-medium">{held.title}</p>}
              <p className="whitespace-pre-wrap break-words">{held.brief}</p>
              {held.rest.length > 0 && <p className="text-muted-foreground">{held.rest.join(" · ")}</p>}
            </div>
          )}
        </>
      )}
      {!open && !sample.trial && <p className="text-muted-foreground">A person's own work, judged as it happened: it is not opened here.</p>}
      <p className={cn("flex items-start gap-1.5", sample.supports ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300")}>
        {sample.supports ? <CheckIcon className="mt-0.5 size-3.5 shrink-0" /> : <X className="mt-0.5 size-3.5 shrink-0" />}
        <span className="break-words">{sample.content || (sample.supports ? "Holds to the rule." : "Breaks the rule.")}</span>
      </p>
    </div>
  );
}

/** Two wordings, line by line: what the change takes out of the page and what it puts in. */
function TextDiff({ before, after }: { before: string; after: string }) {
  const lines = useMemo(() => foldDiffLines(lineDiff(before, after), 1), [before, after]);
  return (
    <div className="overflow-x-auto rounded-md border font-mono text-xs" data-testid="test-diff">
      {lines.map((l, i) =>
        l.op === "gap" ? (
          <div key={i} className="bg-muted/40 px-2 py-0.5 text-muted-foreground">
            ⋯ {l.count} unchanged line{l.count === 1 ? "" : "s"}
          </div>
        ) : (
          <div key={i} className={cn("grid grid-cols-[1rem_minmax(0,1fr)]", l.op === "add" && ADD, l.op === "del" && DEL)}>
            <span className="select-none text-center text-muted-foreground">{l.op === "add" ? "+" : l.op === "del" ? "−" : ""}</span>
            <span className="whitespace-pre-wrap break-words pr-2">{l.text || " "}</span>
          </div>
        ),
      )}
    </div>
  );
}

const CHIP: Record<"page" | "same" | "change", string> = {
  page: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  same: "text-muted-foreground",
  change: "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300",
};

interface Acts {
  admin: boolean;
  /** Something is being asked of the server: the buttons wait. */
  busy: boolean;
  act: (what: () => Promise<void>) => Promise<void>;
  n: () => number | null;
  picked: Picked | null;
  onPick: (p: Picked) => void;
}

function CheckCard({ check, view, acts }: { check: Check; view: ChecksView; acts: Acts }) {
  const client = useStrutClient();
  const [message, setMessage] = useState("");
  const [flow, setFlow] = useState("");
  const { passed, judged } = tally(check.samples);
  const known = workflowFor(check, view.checks.filter((c) => c.id !== check.id));
  const running = view.running.some((b) => b.claim === check.id);
  const at = `check:${check.id}`;
  // What a person said about it, when that is the newest word on it (a judge's verdict names nobody).
  const said = check.latest?.mode === "asserted" && check.latest.by ? evidenceLine(check.latest) : null;
  const setCases = (cases: Check["cases"]) => acts.act(async () => void (await client.run("knowledge/cases", { claim: check.id, cases })));
  const add = () => {
    const c = caseFor(check, message, known ?? flow);
    if (!c) return;
    void setCases([...check.cases, c]).then(() => setMessage(""));
  };
  return (
    <li className="space-y-2 rounded-lg border p-3" data-testid="concept-check" data-status={check.status}>
      <div className="flex items-start gap-2" title={(CLAIM_STATUS[check.status] ?? CLAIM_STATUS.unknown).means}>
        {!judged ? (
          <Minus className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        ) : passed === judged ? (
          <CheckIcon className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
        ) : passed ? (
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        ) : (
          <X className="mt-0.5 size-4 shrink-0 text-rose-600 dark:text-rose-400" />
        )}
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="break-words text-sm font-medium leading-snug">{check.text}</p>
          <p className="text-xs text-muted-foreground">
            {speakerLabel(check.speaker)} · {judged ? `${tallyWords(check.samples)} on the concept` : "Not run yet"}
          </p>
          {said && <p className="break-words text-xs text-muted-foreground">{said}</p>}
        </div>
        {acts.admin && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 shrink-0"
            disabled={acts.busy || running || !check.cases.length}
            onClick={() => {
              const n = acts.n();
              if (n) void acts.act(async () => void (await client.run("knowledge/trial", { claim: check.id, n })));
            }}
            data-testid="check-run"
          >
            {running ? <Loader2 className="animate-spin" /> : <Play />}
            Run
          </Button>
        )}
      </div>
      <ul className="space-y-0.5 pl-6">
        {check.cases.map((c, k) => (
          <li key={k} className="flex items-center gap-2" data-testid="check-case">
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={caseLabel(c)}>
              {caseLabel(c)}
            </span>
            <Dots samples={check.samples.filter((s) => s.case === k)} at={`${at}:${k}`} picked={acts.picked} onPick={acts.onPick} />
            {acts.admin && (
              <button type="button" aria-label="Remove this message" disabled={acts.busy} onClick={() => void setCases(check.cases.filter((_, i) => i !== k))} className="rounded p-0.5 text-muted-foreground hover:text-foreground">
                <X className="size-3" />
              </button>
            )}
          </li>
        ))}
        {!check.cases.length && <li className="text-xs text-muted-foreground">No message tests this yet.</li>}
        {acts.admin && (
          <li className="flex items-center gap-1.5 pt-1">
            {!known && <Input value={flow} onChange={(e) => setFlow(e.target.value)} placeholder="orchestrator" aria-label="The workflow the message goes to" className="h-7 w-28 text-xs" />}
            <Input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
              placeholder="Can you deploy this for me?"
              aria-label="A message that tests this check"
              className="h-7 min-w-0 flex-1 text-xs"
              data-testid="check-message"
            />
            <Button size="sm" variant="ghost" className="h-7" disabled={acts.busy || !caseFor(check, message, known ?? flow)} onClick={add} data-testid="check-add-message">
              <Plus />
              Add message
            </Button>
          </li>
        )}
      </ul>
      {acts.picked?.at.startsWith(at) && <SamplePanel sample={acts.picked.sample} admin={acts.admin} />}
    </li>
  );
}

function TestCard({ test, view, acts, onUsed }: { test: PageTest; view: ChecksView; acts: Acts; onUsed: (note: string | null) => void }) {
  const client = useStrutClient();
  const running = view.running.some((b) => b.test === test.id);
  const outcome = running ? "none" : outcomeOf(allSamples(test.page), allSamples(test.change));
  const at = `test:${test.id}`;
  // A page from git with nowhere to write it here: its wording is its file's.
  const usable = test.live && !(view.fromGit && !view.fromGit.checkout);
  const use = () =>
    acts.act(async () => {
      const r = (await client.run("knowledge/use", { test: test.id })) as { landed?: true; proposed?: { proposal: string; checkout: string } };
      if (r.proposed) {
        // A page whose text comes from git: the change is written to its file on an admin's yes, given here.
        const out = (await client.run("proposal/decide", { id: r.proposed.proposal, action: "accept" })) as { status: string; result?: { error?: string } };
        onUsed(out.status === "applied" ? `Written to the concept's file in ${r.proposed.checkout}.` : `It could not be written: ${out.result?.error ?? "the step failed"}`);
      } else onUsed(null);
    });
  return (
    <li className="space-y-2 rounded-lg border p-3" data-testid="concept-test">
      <TextDiff before={test.page.docs} after={test.change.docs} />
      {view.checks.map((c) => (
        <div key={c.id}>
          {view.checks.length > 1 && <p className="truncate pt-1 text-xs text-muted-foreground">{c.text}</p>}
          <Row label={test.live ? "The concept" : "The concept then"} samples={test.page.samples[c.id] ?? []} at={`${at}:page:${c.id}`} picked={acts.picked} onPick={acts.onPick} />
          <Row label="With the change" samples={test.change.samples[c.id] ?? []} at={`${at}:change:${c.id}`} picked={acts.picked} onPick={acts.onPick} />
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        {outcome === "none" ? (
          <span className="text-xs text-muted-foreground">{running ? "Running…" : "Not run yet"}</span>
        ) : (
          <span className={cn("rounded border px-1.5 text-[11px]", CHIP[outcome])} data-testid="test-outcome" data-outcome={outcome}>
            {OUTCOME[outcome]}
          </span>
        )}
        {!test.live && <span className="text-xs text-muted-foreground">On an earlier wording of the concept</span>}
        <span className="flex-1" />
        {acts.admin && usable && outcome === "change" && (
          <Button size="sm" variant="outline" className="h-7" disabled={acts.busy} onClick={() => void use()} data-testid="test-use">
            Use it
          </Button>
        )}
        {acts.admin && test.live && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7"
            disabled={acts.busy || running}
            onClick={() => {
              const n = acts.n();
              if (n) void acts.act(async () => void (await client.run("knowledge/test", { test: test.id, n })));
            }}
            data-testid="test-again"
          >
            Test again
          </Button>
        )}
      </div>
      {acts.picked?.at.startsWith(at) && <SamplePanel sample={acts.picked.sample} admin={acts.admin} />}
    </li>
  );
}

/** The checks on the Concept `name` and the tests of its page (`id`, so a namesake elsewhere never lends it its own). */
export function ChecksSection({ id, name, admin, wide, onWide }: { id: string; name: string; admin: boolean; wide: boolean; onWide: (wide: boolean) => void }) {
  const client = useStrutClient();
  const qc = useQueryClient();
  const q = useChecks(name);
  const [typed, setTyped] = useState("4");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [sentence, setSentence] = useState("");

  if (q.isLoading) return <Skeleton className="h-10" />;
  if (q.isError) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="checks-unavailable">
        {claimsUnavailable(errorText(q.error))}
      </p>
    );
  }
  const view = q.data;
  if (!view || view.ref_id !== id) return null;

  const act = async (what: () => Promise<void>) => {
    setBusy(true);
    setNote(null);
    try {
      await what();
      await qc.invalidateQueries({ queryKey: ["knowledge", "checks", name] });
    } catch (err) {
      setNote(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const n = () => {
    const v = samplesOf(typed);
    if (!v) setNote("Samples is a whole number from 1 to 20.");
    return v;
  };
  const acts: Acts = { admin, busy, act, n, picked, onPick: (p) => setPicked(picked?.at === p.at && picked.sample.run === p.sample.run ? null : p) };
  const going = runningWords(view.running);
  const anyCase = view.checks.some((c) => c.cases.length);
  const testIt = () => {
    const samples = n();
    if (!samples || draft === null) return;
    void act(async () => {
      await client.run("knowledge/test", { concept: name, docs: draft, n: samples });
      setDraft(null);
    });
  };

  // Closed, the card says what the page is held to and how it does; opened, everything else.
  if (!wide) {
    return (
      <section className="space-y-1.5" data-testid="concept-checks">
        <SectionLabel>
          Checks <span className="tabular-nums">{view.checks.length || ""}</span>
        </SectionLabel>
        {!view.checks.length && <p className="text-xs text-muted-foreground">No checks on this concept yet.</p>}
        <ul className="space-y-2">
          {[...view.checks].sort(byStatus).map((c) => (
            <li key={c.id} className="space-y-0.5" data-testid="concept-check" data-status={c.status}>
              <p className="break-words text-sm">{c.text}</p>
              <div className="flex items-center gap-2">
                <Dots samples={c.samples} at={`check:${c.id}`} picked={null} onPick={() => onWide(true)} />
                {c.samples.length > 0 && <span className="text-xs text-muted-foreground">{tallyWords(c.samples)}</span>}
              </div>
            </li>
          ))}
        </ul>
        {(admin || view.tests.length > 0) && (
          <button type="button" onClick={() => onWide(true)} className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
            {admin ? "Run them, or test a change" : `${view.tests.length} test${view.tests.length === 1 ? "" : "s"} of this concept`}
          </button>
        )}
      </section>
    );
  }

  return (
    <section className="space-y-3" data-testid="concept-checks">
      <div className="flex flex-wrap items-center gap-2">
        <SectionLabel>
          Checks <span className="tabular-nums">{view.checks.length || ""}</span>
        </SectionLabel>
        {going && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground" data-testid="checks-running">
            <Loader2 className="size-3 animate-spin" />
            {going}
          </span>
        )}
        <span className="flex-1" />
        {admin && (
          <>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Samples
              <Input value={typed} onChange={(e) => setTyped(e.target.value)} inputMode="numeric" aria-label="Samples of each message" className="h-7 w-12 text-center text-xs" data-testid="checks-samples" />
            </label>
            {draft === null && (
              <Button size="sm" variant="outline" className="h-7" onClick={() => setDraft(view.docs)} data-testid="checks-try">
                <Pencil />
                Try a change
              </Button>
            )}
          </>
        )}
      </div>
      {(note ?? view.problem) && (
        <p className="break-words text-xs text-rose-700 dark:text-rose-300" data-testid="checks-note">
          {note ?? view.problem}
        </p>
      )}

      {draft !== null && (
        <div className="space-y-2 rounded-lg border p-3" data-testid="checks-draft">
          <p className="text-xs text-muted-foreground">Change the concept, then test it against the concept as it is. The concept itself stays as it is.</p>
          <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} className="max-h-96 min-h-40 font-mono text-xs md:text-xs" aria-label="The concept's text" data-testid="checks-draft-text" />
          {!anyCase && <p className="text-xs text-muted-foreground">No check here has a message yet: add one first, so there is something to run.</p>}
          <div className="flex items-center justify-end gap-2">
            <Button size="sm" variant="ghost" className="h-7" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button size="sm" variant="outline" className="h-7" disabled={busy || !anyCase || draft.trim() === view.docs.trim() || !draft.trim()} onClick={testIt} data-testid="checks-test-it">
              {busy ? <Loader2 className="animate-spin" /> : <Play />}
              Test it
            </Button>
          </div>
        </div>
      )}

      {!view.checks.length && <p className="text-xs text-muted-foreground">No checks on this concept yet.</p>}
      <ul className="space-y-2">
        {[...view.checks].sort(byStatus).map((c) => (
          <CheckCard key={c.id} check={c} view={view} acts={acts} />
        ))}
      </ul>
      {admin && (
        <div className="flex items-center gap-1.5">
          <Input value={sentence} onChange={(e) => setSentence(e.target.value)} placeholder="It never says it works in the background" aria-label="A new check: one sentence" className="h-7 min-w-0 flex-1 text-xs" data-testid="checks-new" />
          <Button
            size="sm"
            variant="ghost"
            className="h-7"
            disabled={busy || !sentence.trim()}
            onClick={() => void act(async () => void (await client.run("knowledge/add-check", { concept: name, text: sentence }))).then(() => setSentence(""))}
            data-testid="checks-add"
          >
            <Plus />
            Add check
          </Button>
        </div>
      )}

      {view.tests.length > 0 && (
        <>
          <SectionLabel>
            Tests <span className="tabular-nums">{view.tests.length}</span>
          </SectionLabel>
          {admin && view.fromGit && !view.fromGit.checkout && (
            <p className="text-xs text-muted-foreground">This concept's text comes from git ({view.fromGit.set}), so a wording that does better is put in its file, not here.</p>
          )}
          <ul className="space-y-2">
            {view.tests.map((t) => (
              <TestCard
                key={t.id}
                test={t}
                view={view}
                acts={acts}
                onUsed={(said) => {
                  setNote(said);
                  // The page changed: its text, its version and what every reader of it shows.
                  void qc.invalidateQueries();
                }}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
