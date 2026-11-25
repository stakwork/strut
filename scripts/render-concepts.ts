// Writes the Concept pages strut renders from code into src/concepts/, where
// the seeder reads every page from (src/concept-seed.ts). One so far: the
// `Workflow Language` page, the builder's rules for the job agent
// (src/ai/prompts.ts). Run it after changing the rules: `npm run
// render:concepts`. src/ai/prompts.test.ts fails while the file is behind.
import { writeFile } from "node:fs/promises";
import { WORKFLOW_LANGUAGE, workflowLanguagePage } from "../src/ai/prompts.js";

const file = new URL(`../src/concepts/${WORKFLOW_LANGUAGE}.md`, import.meta.url);
await writeFile(file, workflowLanguagePage());
console.log(`wrote src/concepts/${WORKFLOW_LANGUAGE}.md`);
