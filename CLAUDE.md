# Slate — development notes

## Obsidian UI conventions

Follow Obsidian's UI convention of **sentence case** (not title case) for all user-facing strings: setting names, section headers, notices, command names, and descriptions.

- Correct: `Shot breakdown`, `Prompt header`, `MFLUX executable path`
- Wrong: `Shot Breakdown`, `Prompt Header`, `MFLUX Executable Path`

Proper nouns and acronyms (e.g. MFLUX, Ollama) are still capitalised as normal.

## Generated note content

Obsidian has a "Show inline title" setting (Appearance → Show inline title, on by default) that displays the filename as a title. When generating notes, check `(app.vault as any).config?.showInlineTitle !== false` and only prepend an `# H1` header if that setting is off.
