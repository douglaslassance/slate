# Slate — development notes

## Obsidian UI conventions

Follow Obsidian's UI convention of **sentence case** (not title case) for all user-facing strings: setting names, section headers, notices, command names, and descriptions.

- Correct: `Shot breakdown`, `Prompt header`, `MFLUX executable path`
- Wrong: `Shot Breakdown`, `Prompt Header`, `MFLUX Executable Path`

Proper nouns and acronyms (e.g. MFLUX, Ollama) are still capitalised as normal.

## Punctuation

Do not use em dashes (—) or en dashes (–) anywhere in the codebase: not in strings, prompts, comments, or UI text. Use a hyphen (-) or reword the sentence instead.

## Commit messages

Write commit messages in imperative mood, under 72 characters, with no body or trailer lines. Do not include co-authoring attributions.

- Correct: `Add LoRA support`, `Fix image output path`
- Wrong: `Added LoRA support`, `Co-Authored-By: ...`

## Generated note content

Obsidian has a "Show inline title" setting (Appearance → Show inline title, on by default) that displays the filename as a title. When generating notes, check `(app.vault as any).config?.showInlineTitle !== false` and only prepend an `# H1` header if that setting is off.

## Ollama model

The default breakdown model is `qwen2.5:32b`, matching the switch made in the
yello project. It replaced `codestral:latest`, and on the test scene fixture it
produces about 20 shots where codestral produces 14.

Changing the default means re-running the live suites, because the prompt is
tuned around the model's willingness to split one action per shot rather than
summarise. The switch to qwen surfaced one such tuning problem. Qwen filled the
`dialog` field on only half of its runs, putting the spoken line in `action`
instead, which silently drops the on-screen text instruction from the storyboard
prompt. The DIALOGUE section of `SYSTEM_PROMPT` exists to fix that, so do not
drop it without re-measuring.

### Is chunking still needed?

Yes on qwen2.5:32b, as of 2026-08-22. Measured over the 889 word fixture with
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
- `tests/breakdown.test.ts` calls the real model and skips when Ollama is
  unreachable or the model is not pulled.
- `tests/density.test.ts` is the slow benchmark behind `SLATE_TEST_DENSITY=1`.

Any model change should be validated with `SLATE_TEST_MODEL=<model> npm run
test:live` before it becomes the default.

