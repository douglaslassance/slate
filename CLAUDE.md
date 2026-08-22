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
