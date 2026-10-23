/**
 * node-llama-cpp held to the shape src/audio/fixer-engine.ts calls
 * (`LlamaLib`). strut never installs node-llama-cpp, so its own tsc never
 * sees these types; this file does, once fixer/ is installed:
 *
 *   yarn --cwd fixer install --frozen-lockfile --ignore-scripts
 *   npm run check:fixer
 *
 * The desktop job runs it before it packages, so a bump of node-llama-cpp
 * that drops or changes what the fixer calls fails there: a method or a
 * field it reads (the assignment below), or an option it passes (`Unknown`:
 * assignability alone lets an option node-llama-cpp no longer takes through;
 * `contextSequence`, required there, is held by the assignment).
 */
import * as llama from "node-llama-cpp";
import type {
  ControlledEvaluateInputItem,
  LlamaCompletionGenerationOptions,
  LlamaContextOptions,
  LlamaContextSequence,
  LlamaModelOptions,
  LlamaOptions,
  Token,
} from "node-llama-cpp";
import type { ContextOptions, GenerateNext, GenerateOptions, GetLlamaOptions, LoadModelOptions, LlamaLib } from "../src/audio/fixer-engine.js";

export const lib: LlamaLib<Token, LlamaContextSequence> = llama;

/** The keys of A, at any depth, that B does not have (never: none). */
type Unknown<A, B> = A extends readonly unknown[]
  ? never
  : A extends object
    ? { [K in keyof A]-?: K extends keyof Shape<B> ? Unknown<A[K], Shape<B>[K]> : K }[keyof A]
    : never;
/** B's object part: `logits?: boolean | { filter }` is read as `{ filter }`. */
type Shape<B> = Extract<NonNullable<B>, object>;
/** `true` when nothing is unknown; else the unknown keys, which the error names. */
type Known<A, B> = [Unknown<A, B>] extends [never] ? true : Unknown<A, B>;

type RealGenerateNext = Extract<ControlledEvaluateInputItem, readonly unknown[]>[1]["generateNext"];
export const known: [
  Known<GetLlamaOptions, LlamaOptions>,
  Known<LoadModelOptions, LlamaModelOptions>,
  Known<ContextOptions, LlamaContextOptions>,
  Known<GenerateOptions, LlamaCompletionGenerationOptions>,
  Known<GenerateNext<Token>, RealGenerateNext>,
] = [true, true, true, true, true];
