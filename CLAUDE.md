# Slate

## Conventions

### Working with the repository

- Make changes in the work tree and stop there. Do not `git add`, `git commit`, `git push`, or open a pull request unless asked to.
- When asked to commit, split the work tree into logical commits rather than one lump. Each commit should stand on its own.
- Work on the current branch (usually `main`). Do not create branches or open pull requests unless asked to.
- Never rewrite history (rebase, amend, squash) or force push a branch that has already been pushed without asking first.

### Commit messages

- A single line. No body, no bullet points, no trailers.
- Sentence case, imperative mood, no trailing period: `Add LoRA support`, not `Added LoRA support`, `add lora support`, or `Add LoRA support.`
- 72 characters maximum. Drop detail rather than go over.
- No `Co-Authored-By`, no "Generated with" footer, no emoji, no AI attribution of any kind.
- If a change seems to need a body, split it into several focused commits instead.

### Pull requests

- Keep the description short and objective. State what the change does, not the story of how it got there, unless a reviewer genuinely needs it.
- No narration of rejected approaches, no open questions, no pre-emptive self review. If a decision needs input, ask it as one plain line.
- No wall of generated text, no AI attribution.

### Writing

- No em dashes (—), en dashes (–), or any other non-hyphen dash character anywhere: code, comments, UI copy, commit messages, pull request descriptions, chat. Use a comma, a colon, parentheses, or a second sentence. A spaced hyphen (" - ") standing in for a dash counts as a dash. Plain hyphens are fine in compound words and as the ASCII minus in code.
- Sentence case for user facing strings: labels, section headers, notices, command names, settings. Acronyms and proper nouns keep their capitalization.
- Keep prose short and human. No generated wall of text, no filler, no comments restating the obvious.

## Generated note content

Obsidian has a "Show inline title" setting (Appearance → Show inline title, on by default) that displays the filename as a title. When generating notes, check `(app.vault as any).config?.showInlineTitle !== false` and only prepend an `# H1` header if that setting is off.

## Ollama model

Slate runs on `qwen3.6:27b`, matching the yello and kitsch projects. It is a constant in
`src/ollama.ts`, deliberately not a setting, because the system prompt is tuned
around this model and a user swapping it silently degrades the output. The
`model` parameter on the ollama.ts functions exists only so the test suites can
measure a candidate before it is promoted.

Lineage: `codestral:latest`, then `qwen2.5:32b` (on the test scene fixture it produced
about 20 shots where codestral produced 14), then `qwen3.6:27b` from 2026-09-09.

`qwen3.8:27b` was considered and rejected. It runs extended reasoning by default, at
roughly half the throughput of 3.6 on comparable hardware, and emits reasoning traces.
Both are pure cost here: the breakdown is one-shot structured extraction against a
fixed schema, not an agentic loop that reasoning would rescue from correction cycles.
The traces are an active hazard for this file specifically, because the request below
sets no `format` and the parser only strips fences, smart quotes, stray keys and `//`
comments. If a future model emits a thinking block, JSON.parse dies. Set `format: "json"`
before promoting any reasoning model.

The 2026-09-09 swap to `qwen3.6:27b` has not been validated against the live suites.
Every measured number below, and every threshold in `tests/`, was calibrated on
`qwen2.5:32b`. Run `npm run test:live` and `npm run test:density` and re-measure before
trusting any of it. A stronger model producing fewer, better shots will read as a
threshold failure while actually being an improvement, so read the output, not just
the pass/fail.

Changing the default means re-running the live suites, because the prompt is
tuned around the model's willingness to split one action per shot rather than
summarise. The switch to qwen surfaced one such tuning problem. Qwen filled the
`dialog` field on only half of its runs, putting the spoken line in `action`
instead, which silently drops the on-screen text instruction from the storyboard
prompt. The DIALOGUE section of `SYSTEM_PROMPT` exists to fix that, so do not
drop it without re-measuring.

That fragility is not only about the DIALOGUE section. The prompt used to close
on a REMINDER line about wikilinks. Removing it, when scripts stopped carrying
wikilinks, broke dialogue capture on the very next live run even though the
DIALOGUE section itself was untouched: the model had lost the last thing it
read. The closing REMINDER is now about dialogue instead, and it is load
bearing. Keep the prompt ending on a reminder of whatever is most fragile.

### Is chunking still needed?

Yes on qwen2.5:32b, as of 2026-08-22. NOT re-measured since the 2026-09-09 move to
qwen3.6:27b. Measured over the 889 word fixture with
`npm run test:density`, three chunks of 250 words:

| model            | one call        | chunked         | time (one / chunked) |
| ---------------- | --------------- | --------------- | -------------------- |
| qwen2.5:32b      | 87 shots, 9.79  | 112 shots, 12.60| 644s / 901s          |
| codestral:latest | 73 shots, 8.21  | 43 shots, 4.84  | 462s / 298s          |

Densities are shots per 100 words. Two things worth knowing.

Chunking buys qwen about 29% more shots, so keep it. It did the opposite for
codestral, which produced 70% more shots in a single call than split up. The
"smaller excerpt means more aggressive splitting" theory is therefore model
specific and should be re-measured on every model change rather than assumed.

Neither model truncated its whole-script response, so the bracket recovery in
`generateShotBreakdown` is no longer load bearing the way the comments suggest.
The split is now a density tradeoff, not a correctness one.

Caveat: one sample per configuration at temperature 0.7. The gaps above are wide
enough to act on, but small differences in a re-run are noise.

## Tests

Tests live in `tests/` and run on Node's built-in runner with native TypeScript,
so there is no test framework dependency and no build step.

- `tests/chunking.test.ts` is offline and always runs.
- `tests/fountain.test.ts`, `tests/entities.test.ts`, `tests/format.test.ts`
  and `tests/suggest.test.ts` are offline and always run.
- `tests/breakdown.test.ts` calls the real model and skips when Ollama is
  unreachable or the model is not pulled.
- `tests/lora.test.ts` is offline and always runs.
- `tests/density.test.ts` is not a routine test. It is a 25 to 45 minute
  experiment behind `SLATE_TEST_DENSITY=1`, run when changing model or
  revisiting chunking, not as part of a normal pass. Its current answer is
  recorded above, so re-running it only makes sense when that answer is in
  doubt.

Any model change should be validated with `SLATE_TEST_MODEL=<model> npm run
test:live` before it becomes the default.
