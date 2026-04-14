## Features

- **Shot breakdown** — paste a screenplay excerpt into a note and run _Generate shot breakdown_ to get a structured markdown table with scene headings, camera type, action, description, and dialogue for every shot. Wikilinks (`[[Character]]`, `[[Location]]`) in the source are preserved throughout.
- **Language translation** — optionally translate the generated breakdown into a target language while keeping the JSON schema keys in English.
- **Custom instructions** — append extra directives to the shot-breakdown prompt for house style, tone, or project-specific rules.
- **Storyboard prompts** — run _Generate storyboard prompts_ on a breakdown note to produce a richly structured markdown file you can inspect and edit. Each shot section includes art style, previous-shot context, location, camera, action, description, and a _Featured in this shot_ block summarising any referenced vault notes.
- **Wikilink resolution** — linked vault notes (characters, locations, props) are read, summarised in a single Ollama request, and injected into the relevant shot prompts so the image model has full visual context.
- **Storyboard image generation** — run _Generate storyboard_ to render a PNG for every shot via mflux. Images are copied into the vault as they finish and immediately visible in the auto-created storyboard note.
- **2-column storyboard gallery** — the storyboard note lays out images in a two-column markdown table using native Obsidian wikilink embeds; no extra plugins required.
- **Style reference image** — optionally supply a reference image path to guide the visual style of every generated frame.
