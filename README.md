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

## Fountain

`.fountain` files open in Obsidian's own markdown editor and are formatted as
screenplays while you type. Scene headings, character cues, dialogue,
parentheticals, transitions, sections, and synopses each get their own styling,
with standard screenplay indents.

Source mode and live preview go through CodeMirror. Reading mode does not, and
a Fountain script run through a markdown renderer is wrong in every way that
matters, so reading mode discards that output and rebuilds each block from the
script source. Both surfaces share one stylesheet and one parser, so the layout,
indents, and fonts are identical.

They differ in exactly one way, deliberately. The editor shows the markup,
because you are editing plain text and hiding the syntax would make it
uneditable. Reading mode is the near-print view, so it drops the characters that
exist only to tell the parser what an element is: emphasis markers, the brackets
around centered text, the forcing characters, and the section and synopsis
prefixes. Notes are omitted there too, which is what the spec says they do.

Only one plugin can own the `.fountain` extension. If another Fountain plugin
is enabled it wins, and Slate says so in a notice at load naming the plugin
involved. Disabling that plugin is not enough on its own, because Obsidian
cannot release a file type mid-session. Quit and reopen Obsidian afterwards.

Reusing the markdown editor rather than registering a separate view means undo,
search, and every other editor plugin keep working, and the script stays a
first-class vault file that wikilinks and the graph can see.

Slate parses Fountain itself (`src/fountain.ts`, following the frozen
[Fountain 1.1 spec](https://fountain.io/syntax/)) rather than depending on a
Fountain plugin, because the shot breakdown needs the parse as data and an
Obsidian plugin cannot import another plugin's internals. One parser means a
scene heading is the same thing in the editor and in the breakdown.

The parse also yields the cast and location rosters straight from the script,
since character cues and scene headings are structural elements rather than
guesses. That is what entity resolution matches vault notes against.

Times of day fall back to a built-in list, the same one Slugline offers, so a
page with no scene headings yet still has somewhere to start. The script's own
words come first, which is what keeps a script written in another language
leading with its own vocabulary rather than an English list it will never use.

If another plugin already claims `.fountain`, Slate leaves it alone and only
skips the file association.

### Character and location links

Names resolve to vault notes at render time. The script on disk stays clean
Fountain with no wikilink brackets, so it opens correctly in Highland, Beat, or
Final Draft, and the linking lives in the editor instead of in the file.

The roster comes from the script's own structure, from two sources. Character
cues name everyone who speaks. ALL CAPS inside an action line is how a
screenplay introduces a character on first appearance, which catches the ones
who never speak at all. Either source alone misses real characters: a nearly
wordless script has almost no cues, so the caps pass is what finds `LE ROI
KAGI` in a script where only one character has a line.

A run of capitals only counts inside a line that also holds lower case text,
because a line that is entirely uppercase is a mini slug (`CONTRE CHAMP`) and
not an introduction. Screenplay vocabulary that appears in the same position,
`INSERT`, `MONTAGE`, `POV` and the rest, is filtered out.

Only names that actually have a note are marked, so a character with no note
stays plain text rather than becoming a dead link. Matching is case insensitive
on whole words, so an introduction in caps and a later mention in mixed case
both resolve, while `le roi` on its own never matches `LE ROI KAGI`.

Cmd or Ctrl click follows a name. A plain click still places the cursor,
because a character name is ordinary prose that happens to resolve, and editing
it has to stay the default.

Names resolve in all three modes, and behave like any other link in the vault.
A plain click follows the name, the platform modifier opens it in a new tab. In
reading mode they are real Obsidian internal links, so hover preview works too.

The editor handles the click on mousedown rather than click, because
CodeMirror places the caret on mousedown and a later handler cannot take that
back. The trade is that putting the caret inside a resolved name needs the
keyboard or a click just beside it, which is the same trade Obsidian makes for
wikilinks in live preview.

### Formatting

_Format Fountain_ normalises a `.fountain` file. It uppercases scene headings
and forced character cues, turns doubled and long dashes in headings into single
hyphens, rebuilds the blank lines between elements, strips trailing whitespace,
and ends the file with a single newline.

Spacing is regenerated from the parse rather than merely tidied, so separated
elements end up exactly one blank line apart however many were typed. The one
thing it will not touch is adjacency. Lines that were already adjacent stay
adjacent, because consecutive action lines are a single paragraph and
consecutive dialogue lines are a single speech. Splitting them would leave the
element kinds identical while changing how the script prints, which is the one
mistake the safety test below cannot catch.

It is driven by the parse, so it only touches lines it has positively
identified, and it never changes what a line means. A bare lowercase cue is
left alone because `Mara` over `You said midnight.` is equally two action
lines, and guessing there would rewrite the script. Boneyard, curly blocks,
multi-line notes, and the title page pass through verbatim, and note contents
keep their case because they are vault lookups rather than prose.

The one rule worth knowing is that trailing whitespace is not free to strip.
Two spaces on an otherwise blank line are how the spec keeps a speech open, so
those lines are normalised to exactly two spaces rather than removed. Trimming
them would turn dialogue into action with no visible sign.

The result is applied as the smallest edit that produces it, not by replacing
the document. Replacing everything rebuilds the editor, which drops the scroll
position and the undo history and leaves the view somewhere unrelated. A narrow
edit is mapped through by the editor itself, so nothing has to be restored
afterwards. Trimming a common prefix and suffix cannot split into two hunks, so
a change near the end widens the span, which a file with no trailing newline
hits on its first format.

**Format on save** is off by default. Obsidian saves constantly, formatting
rewrites the file under your cursor, and a parser mistake on save becomes a
file mistake. Run the command by hand until it is boring, then turn the setting
on. The save command is restored untouched when Slate is disabled.

### The spec, and only the spec

The parser implements Fountain 1.1 and adds nothing to it. Where the spec is
stricter than what screenwriters type, the spec wins.

A transition is an uppercase line ending in `TO:`, so `FADE OUT.` and
`CUT TO BLACK.` are action. The spec's own way to make them transitions is the
`>` prefix, which also renders them correctly in Highland, Beat, and Final
Draft rather than only here. `FADE IN:` is action too, and since action sits at
the left margin, that is where convention wants it anyway.

Curly brace blocks like the settings block Slugline appends to its files are
not Fountain, so they parse as action. The spec's way to exclude content is the
boneyard, `/* ... */`.

The parser also follows the parts that are easy to miss. Scene headings need a
blank line on both sides, a line holding only a note is removed without breaking
the dialogue block around it, and two spaces on an otherwise blank line keep a
speech open.

## Testing

The shot breakdown is a prompt plus a model, so its quality is not something the
type checker can protect. The suites under `tests/` exist to catch a regression
when the model changes.

```bash
npm test             # everything, live suites self-skip when Ollama is down
npm run test:offline # parser, chunking, and LoRA suites, no Ollama needed
npm run test:live    # prompt quality against the shipped model
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
