# Slate

Obsidian plugin to generate shot breakdowns and storyboards from screenplays.

## Features

- **Script to storyboard in one step**. Run _Generate storyboard from script_ on a screenplay note to go straight from script to rendered storyboard. It writes the breakdown, resolves wikilinks, builds the prompts, and renders every frame in a single command. The individual steps are still available when you want to edit the breakdown before rendering.
- **Shot breakdown** — paste a screenplay excerpt into a note and run _Generate shot breakdown_ to get a structured markdown table with scene headings, camera type, action, description, and dialogue for every shot. Wikilinks (`[[Character]]`, `[[Location]]`) in the source are preserved throughout.
- **Language translation** — optionally translate the generated breakdown into a target language while keeping the JSON schema keys in English.
- **Custom instructions** — append extra directives to the shot-breakdown prompt for house style, tone, or project-specific rules.
- **Storyboard prompts** — run _Generate storyboard prompts_ on a breakdown note to produce a richly structured markdown file you can inspect and edit. Each shot section includes art style, previous-shot context, location, camera, action, description, and a _Featured in this shot_ block summarising any referenced vault notes.
- **Wikilink resolution** — linked vault notes (characters, locations, props) are read, summarised in a single Ollama request, and injected into the relevant shot prompts so the image model has full visual context.
- **Storyboard image generation** — run _Generate storyboard_ to render a PNG for every shot via mflux. Images are copied into the vault as they finish and immediately visible in the auto-created storyboard note.
- **2-column storyboard gallery** — the storyboard note lays out images in a two-column markdown table using native Obsidian wikilink embeds; no extra plugins required.
- **Style reference image** — optionally supply a reference image path to guide the visual style of every generated frame.

## Testing

The shot breakdown is a prompt plus a model, so its quality is not something the
type checker can protect. The suites under `tests/` exist to catch a regression
when the model changes.

```bash
npm test             # everything, live suites self-skip when Ollama is down
npm run test:offline # script chunking only, no Ollama needed
npm run test:live    # prompt quality against the configured model
npm run test:density # slow benchmark, see below
```

`tests/breakdown.test.ts` runs the real prompt against a fixture scene and
asserts the things that quietly degrade with a weaker model. Shot count,
schema completeness, camera field format, wikilink survival, and dialogue
capture. Point it at any candidate model to compare on equal footing:

```bash
SLATE_TEST_MODEL=mistral:latest npm run test:live
```

`tests/density.test.ts` answers whether the script still needs to be split into
chunks before it is sent to the model. It measures shots per 100 words for a
whole-script call against the same script sent in pieces, then holds that answer
in place. One assertion guards the chunked density against a model that starts
summarising. Another goes red on good news, when a single call gets close enough
to the chunked result that splitting stops paying for itself.

On `qwen2.5:32b` the split still buys about 29% more shots, so chunking stays.

```bash
npm run test:density
```
