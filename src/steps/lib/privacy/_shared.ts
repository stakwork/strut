import { z } from "zod";

export const WarningSchema = z.object({ code: z.string(), message: z.string(), count: z.number().optional() });

export const NOT_ANONYMIZATION =
  "This is PSEUDONYMIZATION, not anonymization: names, places, organisations, dates, phone numbers, emails, addresses and ids become typed numbered tokens ([PERSON_1]) that keep the sentence readable for a model, and the mapping is kept in a vault under a handle. " +
  "Descriptive or indirect clues (\"the night nurse\", a rare job, a small town) are NOT masked; detection is English-oriented, ids are pattern-based, and recall is not guaranteed. " +
  "Run files record every step's input and output, so the original text is in plaintext there wherever it is passed as step input or returned as step output.";
