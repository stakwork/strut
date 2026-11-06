// A secret a build asks the person for (plans/member-rights.md "Adding a
// secret"): the builder's reply names it in `ask.secret`, and this box sits
// under the question. Save stores what the person typed with `secret/add` —
// which fills a blank and never overwrites one — then sends the job its next
// turn, `[secret] NAME stored`, naming the conversation so strut wakes it
// when that turn ends. The value goes to strut once and is dropped here: it
// reaches no model, no run log, no transcript.
import { useState, type FormEvent } from "react";
import { Check, KeyRound } from "lucide-react";
import { useStrutClient } from "@strut/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { secretAlreadySet, secretPrompt } from "../lib/jobs";
import { modelParams, sendRefusal } from "../lib/chat";
import { useModelPick } from "../hooks";
import { Notice, errorText } from "./bits";

type State = { kind: "idle" | "busy" | "sent" } | { kind: "failed"; error: string; already?: boolean };

export function SecretBox({ name, job, workflow, conversation }: { name: string; job: string; workflow: string; conversation?: string }) {
  const client = useStrutClient();
  const { sent: model } = useModelPick();
  const [value, setValue] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });

  const tell = async (already: boolean) => {
    try {
      await client.run("run/launch", {
        workflow,
        job,
        input: { prompt: secretPrompt(name, already) },
        // On the viewer's model, as their message would be.
        ...modelParams(model),
        // The server takes a conversation the viewer may continue (plans/jamie-app.md §2.2).
        ...(conversation ? { conversation } : {}),
      });
      setState({ kind: "sent" });
    } catch (err) {
      const r = sendRefusal(errorText(err));
      const why = r.kind === "busy" ? "the build is still working — try again in a minute" : r.text;
      setState({ kind: "failed", error: `${already ? `${name} is already set, but` : `${name} is saved, but`} the build was not told: ${why}`, already: true });
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!value || state.kind === "busy") return;
    setState({ kind: "busy" });
    const typed = value;
    setValue("");
    try {
      await client.run("secret/add", { name, value: typed });
    } catch (err) {
      const msg = errorText(err);
      if (secretAlreadySet(msg)) setState({ kind: "failed", error: `${name} already has a value here. Only an admin can change it.`, already: true });
      else setState({ kind: "failed", error: msg });
      return;
    }
    await tell(false);
  };

  if (state.kind === "sent") {
    return (
      <p className="flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-300" data-testid="secret-sent">
        <Check className="size-3.5" />
        {name} is set. The build goes on.
      </p>
    );
  }
  return (
    <form onSubmit={save} className="space-y-2 rounded-md border bg-muted/30 p-2" data-testid="secret-box">
      <label className="flex items-center gap-1.5 text-xs font-medium" htmlFor={`secret-${job}-${name}`}>
        <KeyRound className="size-3.5 text-amber-600" />
        <span className="font-mono">{name}</span>
      </label>
      <div className="flex items-center gap-2">
        <Input
          id={`secret-${job}-${name}`}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Paste the value"
          className="h-8 flex-1"
          disabled={state.kind === "busy"}
        />
        <Button type="submit" size="sm" disabled={!value || state.kind === "busy"}>
          {state.kind === "busy" ? "Saving…" : "Save"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Stored on this server for everyone's workflows. Nobody sees it here again, and the build never sees the value.</p>
      {state.kind === "failed" && (
        <div className="space-y-1">
          <Notice tone="error">{state.error}</Notice>
          {state.already && (
            <Button type="button" size="sm" variant="outline" onClick={() => void tell(true)}>
              Tell the build to go on
            </Button>
          )}
        </div>
      )}
    </form>
  );
}
