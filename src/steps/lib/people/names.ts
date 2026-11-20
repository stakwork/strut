import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { PEOPLE_READ_MAX, type PeopleReader } from "../../../people.js";

/**
 * `people/names` (plans/people-and-hosts.md §1): the names of a list of
 * people, for a page to show in place of their actors (the kit's
 * `useNames`). It reads `ctx.services.people`: every name on the server's
 * bag, a signed-in visitor's own name alone on theirs, none on an anonymous
 * visitor's. Each actor asked is in the answer, with `name` when one is kept.
 */
export default defineStep({
  type: "people/names",
  effect: "read",
  description:
    `The names of these people, by actor: { people: { "<actor>": { name? } } }, each actor asked, with name when one is kept (a host's sign-in or the person's own). At most ${PEOPLE_READ_MAX} actors. ` +
    "A name is for showing: with none, show the actor as before. A visitor's page gets the visitor's own name alone.",
  input: z.object({
    actors: z.array(z.string().min(1).max(512)).max(PEOPLE_READ_MAX).describe("The actors to name."),
  }),
  output: z.object({ people: z.record(z.string(), z.object({ name: z.string().optional() })) }),
  async run(cfg, ctx?: StepContext) {
    const people = (ctx?.services as { people?: PeopleReader } | undefined)?.people;
    if (!people) return { people: Object.fromEntries(cfg.actors.map((a) => [a, {}])) };
    return { people: await people.names(cfg.actors) };
  },
});
