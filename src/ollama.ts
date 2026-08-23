export interface Shot {
	/** Sequential shot number within the scene. */
	number: number;
	/** Scene or sequence label (e.g. "EXT. DESERT - DAY"). */
	scene: string;
	/** Shot type and camera movement combined (e.g. "Close-Up - Static"). */
	camera: string;
	/** Narrative action: what is happening in the shot. Preserve any [[wikilinks]]. */
	action: string;
	/** Visual details worth noting: lighting, colors, props, atmosphere, composition. Preserve any [[wikilinks]]. */
	description: string;
	/** Dialogue or spoken lines that occur during this shot (optional). Preserve any [[wikilinks]]. */
	dialog?: string;
}

const SYSTEM_PROMPT = `You are a professional script supervisor and storyboard artist working on a feature film.
Your job is to break a screenplay excerpt into an exhaustive shot list, one JSON object per camera setup.

STEP 1: COMMIT TO BEING EXHAUSTIVE.
Do not summarize or skip moments. Every beat, reaction, and action in the excerpt deserves its own shot. When in doubt, add a shot rather than skip it. There is no upper limit.

STEP 2: THE ONE RULE THAT OVERRIDES EVERYTHING ELSE.
ONE action = ONE shot. This is non-negotiable.
If a character does two things, that is two shots. If three things, three shots. Never combine them.
  BAD (forbidden): "Keni runs across the room and grabs the phone." This is TWO shots, not one.
  GOOD: Shot A: "Keni sprints across the room." / Shot B: "Keni grabs the phone."
A shot describes exactly ONE moment frozen in time. The moment the subject does a second thing, you must start a new shot object.

SPLIT AGGRESSIVELY. Every single one of the following is its own shot:
- The scene-establishing wide shot at the top of every new location.
- Every character entrance or exit.
- Every sentence or clause of action in the screenplay, each one is its own shot, no exceptions.
- Every line of dialogue: the speaker gets their own shot; the listener's reaction gets its own separate shot.
- Every reaction (a glance, a flinch, a smile, a raised eyebrow) is its own shot.
- Every cutaway or insert (a door handle, a clock, a weapon, a document, an object of importance).
- Every change of angle, focal length, or subject within a continuous moment.
- Any moment where the camera would naturally cut in a professionally edited film.
Do NOT merge two or more of these into one shot object. If in doubt, split.

DIALOGUE GOES IN THE DIALOG FIELD, NEVER IN THE ACTION FIELD.
When a character speaks during a shot, the spoken line belongs in "dialog" and nowhere else.
The "action" field describes what the speaker is physically doing while the line is delivered.
  BAD (forbidden): "action": "MARA: You said midnight.", "dialog": ""
  GOOD: "action": "[[Mara]] stares across the table as she speaks.", "dialog": "[[Mara]]: You said midnight."
Never write a speaker name followed by a colon in the "action" field.
Never leave "dialog" empty on a shot where somebody speaks.

STEP 3: WRITE RICH DESCRIPTIONS for each shot.
- "action": one clear sentence describing exactly what is happening narratively in THIS shot only.
- "description": paint the frame. Include specific lighting quality and direction, color palette, depth of field, textures, wardrobe details, props in frame, background activity, spatial relationships between subjects. Be concrete and visual. Do NOT restate the action or camera info here.
- Every description should give an image-generation model enough to recreate the frame without seeing the script.

Rules for the camera field:
- Always write shot sizes and movements in full words, never use acronyms or abbreviations.
- Shot sizes: Extreme Wide Shot, Wide Shot, Medium Wide Shot, Medium Shot, Medium Close-Up, Close-Up, Extreme Close-Up, Insert.
- Movements: Static, Pan Left, Pan Right, Tilt Up, Tilt Down, Dolly In, Dolly Out, Dolly Left, Dolly Right, Tracking, Handheld, Crane Up, Crane Down, Aerial.
- Format: "{Shot Size} - {Movement}", e.g. "Close-Up - Static", "Wide Shot - Dolly In", "Medium Shot - Tracking".
- Vary shot sizes constantly. Never use the same shot size more than twice in a row.

IMPORTANT: the source text may contain Obsidian wikilinks in the form [[Name]].
You MUST copy these exactly as-is wherever the referenced entity appears.
Do NOT paraphrase, expand, or remove them. Write [[Keni]], never just Keni.

Each object must have exactly these keys:
  number      (integer, sequential across the whole script, starting from 1)
  scene       (string, scene heading, preserve any [[wikilinks]])
  camera      (string, shot type and camera movement in full words as described above)
  action      (string, one sentence of narrative prose describing what is happening in this specific shot, never a quoted line and never prefixed with a speaker name and colon, preserve any [[wikilinks]])
  description (string, rich visual frame description covering lighting, color, texture, wardrobe, props, depth, atmosphere, do NOT repeat camera or action, preserve any [[wikilinks]])
  dialog      (string, speaker name followed by a colon and their spoken lines, e.g. "[[Keni]]: Hey, can you get me a Coke?", REQUIRED whenever anyone speaks even a single word, leave as an empty string only when the shot is completely silent, preserve any [[wikilinks]])

REMINDER: every character name, location, or object that appeared as a [[wikilink]] in the source must remain a [[wikilink]] in your output.
Return ONLY the raw JSON array. No markdown fences, no commentary, no preamble.`;

/**
 * The model Slate runs on. Deliberately not a setting.
 *
 * The system prompt is tuned around this model's willingness to split one
 * action per shot, so swapping it silently changes the output quality. The
 * `model` parameter on the functions below exists so the test suites can
 * measure a candidate before it ever becomes the default.
 */
export const MODEL = "qwen2.5:32b";

/**
 * Ensure a model is available locally, pulling it from the registry if not.
 * Reports download progress via onProgress.
 */
export async function ensureModel(
	host: string,
	model: string,
	onProgress?: (message: string) => void
): Promise<void> {
	const base = host.replace(/\/$/, "");

	// Check installed models.
	let installed = false;
	try {
		const res = await fetch(`${base}/api/tags`);
		if (res.ok) {
			const data = await res.json();
			installed = (data.models ?? []).some(
				(m: { name: string }) => m.name === model
			);
		}
	} catch {
		// If we can't reach the tags endpoint, proceed and let the chat call fail with a clear error.
		return;
	}

	if (installed) return;

	// Pull the model with streaming progress.
	onProgress?.(`Pulling ${model} — this may take a few minutes…`);

	let pullRes: Response;
	try {
		pullRes = await fetch(`${base}/api/pull`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model, stream: true }),
		});
	} catch (err) {
		throw new Error(`Cannot reach Ollama at ${host}. Is it running?\n${err}`);
	}

	if (!pullRes.ok) {
		throw new Error(`Ollama pull failed (${pullRes.status}): ${await pullRes.text()}`);
	}

	const reader = pullRes.body?.getReader();
	const decoder = new TextDecoder();

	if (!reader) return;

	let buffer = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const data = JSON.parse(line);
				if (data.total && data.completed) {
					const pct = Math.round((data.completed / data.total) * 100);
					const done = (data.completed / 1e9).toFixed(1);
					const total = (data.total / 1e9).toFixed(1);
					onProgress?.(`Pulling ${model}: ${done} GB / ${total} GB (${pct}%)`);
				} else if (data.status) {
					onProgress?.(`Pulling ${model}: ${data.status}`);
				}
			} catch {}
		}
	}
}

/**
 * Estimate the number of screenplay pages in a block of text.
 * Standard screenplay: ~250 words per page.
 */
export function estimatePageCount(text: string): number {
	const words = text.trim().split(/\s+/).length;
	return Math.max(0.5, words / 250);
}

// Scene headings in Fountain format (INT./EXT.) and markdown heading format (## INT. / ## EXT.).
const SCENE_HEADING_RE = /^(#{1,3}\s*)?\**(INT\.|EXT\.|INT\/EXT\.|I\/E\.)\s/i;

/**
 * Split a script into chunks at scene boundaries, each capped at
 * maxWordsPerChunk words. A boundary only ever lands on a scene heading, so no
 * scene is ever cut in half. Smaller chunks make the model split more
 * aggressively, which is measured by tests/density.test.ts.
 */
export function splitScriptIntoChunks(text: string, maxWordsPerChunk = 750): string[] {
	const lines = text.split("\n");
	const chunks: string[] = [];
	let current: string[] = [];
	let words = 0;

	for (const line of lines) {
		const isHeading = SCENE_HEADING_RE.test(line.trim());
		const lineWords = line.trim() ? line.trim().split(/\s+/).length : 0;

		if (isHeading && words >= maxWordsPerChunk && current.length > 0) {
			chunks.push(current.join("\n").trim());
			current = [];
			words = 0;
		}

		current.push(line);
		words += lineWords;
	}

	if (current.join("").trim()) {
		chunks.push(current.join("\n").trim());
	}

	return chunks;
}

export async function generateShotBreakdown(
	host: string,
	model: string,
	scriptText: string,
	language?: string,
	customInstructions?: string,
	onProgress?: (message: string) => void
): Promise<Shot[]> {
	await ensureModel(host, model, onProgress);
	onProgress?.("Connecting to Ollama…");

	const url = `${host.replace(/\/$/, "")}/api/chat`;

	let systemPrompt = SYSTEM_PROMPT;
	if (language?.trim()) {
		systemPrompt += `\n\nOUTPUT LANGUAGE (MANDATORY): Every string value in every JSON field MUST be written in ${language.trim()}. Translate each field individually, without exception:
- "scene": translate the full heading including the INT./EXT. prefix and the time of day suffix.
- "camera": translate shot size names and movement names (e.g. "Close-Up", "Wide Shot", "Static", "Tracking").
- "action": translate fully.
- "description": translate fully.
- "dialog": translate the spoken lines into ${language.trim()}. The earlier instruction to keep "exact lines" means exact in the TARGET language, do NOT keep the source-language wording. The speaker prefix (e.g. "[[Keni]]:") stays as-is; only the spoken text is translated.
JSON keys ("number", "scene", "camera", "action", "description", "dialog") stay in English. Every string VALUE must be in ${language.trim()}. Leaving any field in the original source language is an error.`;
	}
	if (customInstructions?.trim()) {
		systemPrompt += `\n\nAdditional instructions: ${customInstructions.trim()}`;
	}

	const body = JSON.stringify({
		model,
		stream: false,
		messages: [
			{ role: "system", content: systemPrompt },
			{ role: "user", content: scriptText },
		],
		options: {
			// Remove the default token cap so a long shot list is never silently truncated.
			num_predict: -1,
			// Large context window to handle long scripts and long outputs simultaneously.
			num_ctx: 32768,
			// Slightly higher temperature for more varied, less repetitive descriptions.
			temperature: 0.7,
		},
	});

	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
		});
	} catch (err) {
		throw new Error(`Cannot reach Ollama at ${host}. Is it running?\n${err}`);
	}

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Ollama error ${response.status}: ${text}`);
	}

	onProgress?.("Parsing shot breakdown…");

	const data = await response.json();
	const content: string = data?.message?.content ?? "";

	// Strip optional markdown code fences the model might add anyway.
	// Replace curly/smart quotes — models emit these inside string values breaking JSON.parse.
	// Also strip any "notes", "shotType", "cameraMovement", "visualDescription" lines the model
	// may emit from old habits — only our current schema fields are wanted.
	const unwantedKeys = /^[\s]*"(notes|shotType|cameraMovement|visualDescription)"\s*:/;
	// Strip single-line JS comments the model sometimes adds (e.g. // Continue generating…)
	const commentLine = /^\s*\/\/.*/;
	let cleaned = content
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```\s*$/, "")
		.replace(/[\u201C\u201D]/g, "'")
		.replace(/[\u2018\u2019]/g, "'")
		.split("\n")
		.filter((line) => !unwantedKeys.test(line) && !commentLine.test(line))
		.join("\n")
		.trim();

	// Recover from malformed arrays: missing opening bracket, missing closing bracket, or both.
	if (!cleaned.startsWith("[")) {
		cleaned = "[\n" + cleaned;
		console.warn("[Slate] Response missing opening bracket — prepending [");
	}
	if (!cleaned.endsWith("]")) {
		const lastBrace = cleaned.lastIndexOf("}");
		if (lastBrace !== -1) {
			cleaned = cleaned.slice(0, lastBrace + 1) + "\n]";
		} else {
			cleaned = cleaned + "\n]";
		}
		console.warn("[Slate] Response was truncated — closing JSON array and recovering partial results.");
	}

	let shots: Shot[];
	try {
		shots = JSON.parse(cleaned);
	} catch {
		throw new Error(`Ollama returned invalid JSON:\n${content}`);
	}

	if (!Array.isArray(shots)) {
		throw new Error("Expected a JSON array from Ollama.");
	}

	// Re-apply any [[wikilinks]] the model dropped from the original script text.
	const knownLinks = extractWikilinks(scriptText);
	return restoreWikilinks(shots, knownLinks);
}

const FOUNTAIN_PROMPT = `You are a professional screenplay formatter.
Convert the provided text into valid Fountain screenplay format, following these rules exactly:

- Scene headings: uppercase, prefixed with INT. or EXT., followed by location and DAY/NIGHT/MORNING/etc. (e.g. INT. POLICE STATION - DAY)
- Action lines: plain paragraphs, sentence case, present tense
- Character cues: character name in UPPERCASE on its own line, immediately above dialogue
- Dialogue: the spoken lines on the line(s) directly below the character cue
- Parentheticals: (in parentheses) on their own line between the character cue and dialogue, or within dialogue
- Transitions: UPPERCASE followed by a colon, right-aligned (e.g. CUT TO:, FADE OUT.)
- Scene numbers: do not add scene numbers unless they are already present in the source
- Character names: always UPPERCASE when used as a dialogue cue
- Wikilinks: strip all [[ and ]] markers, keep the name inside but remove the brackets entirely (e.g. [[Keni]] becomes Keni)
- Non-standard elements: remove anything that does not belong in a proper screenplay, including markdown formatting, headers, bullet points, notes, comments, meta-data, stage directions written as prose asides, emoji, and any other non-Fountain content

Return ONLY the Fountain-formatted text. No explanations, no markdown fences, no commentary.`;

export async function convertToFountain(
	host: string,
	model: string,
	scriptText: string,
	onProgress?: (message: string) => void
): Promise<string> {
	await ensureModel(host, model, onProgress);
	onProgress?.("Connecting to Ollama…");

	const url = `${host.replace(/\/$/, "")}/api/chat`;

	const body = JSON.stringify({
		model,
		stream: false,
		messages: [
			{ role: "system", content: FOUNTAIN_PROMPT },
			{ role: "user", content: scriptText },
		],
	});

	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
		});
	} catch (err) {
		throw new Error(`Cannot reach Ollama at ${host}. Is it running?\n${err}`);
	}

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Ollama error ${response.status}: ${text}`);
	}

	onProgress?.("Formatting screenplay…");

	const data = await response.json();
	const content: string = data?.message?.content ?? "";

	// Strip any accidental markdown fences the model may have added.
	// Also remove any [[wikilink]] brackets the model failed to strip itself.
	return content
		.replace(/^```(?:fountain)?\s*/i, "")
		.replace(/\s*```\s*$/, "")
		.replace(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g, "$1")
		.trim();
}

const SUMMARIZE_PROMPT = `You are preparing reference material for a visual storyboard.
Given a list of named entities (characters, locations, objects) and their descriptions,
return a JSON object where each key is the entity name and the value is a concise
2-3 sentence visual summary focusing strictly on appearance, physical traits, and
visual characteristics useful for image generation. Omit plot details.
Return ONLY the JSON object, no markdown, no commentary.`;

/**
 * Send a single Ollama request to summarize all wikilink contents into
 * compact visual descriptions. Returns a map of { [linkName]: summary }.
 */
export async function summarizeLinks(
	host: string,
	model: string,
	links: { name: string; content: string }[]
): Promise<Record<string, string>> {
	if (links.length === 0) return {};

	const url = `${host.replace(/\/$/, "")}/api/chat`;

	const userMessage = links
		.map(({ name, content }) => `[[${name}]]\n${content}`)
		.join("\n\n---\n\n");

	const body = JSON.stringify({
		model,
		stream: false,
		messages: [
			{ role: "system", content: SUMMARIZE_PROMPT },
			{ role: "user", content: userMessage },
		],
	});

	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
		});
	} catch (err) {
		throw new Error(`Cannot reach Ollama at ${host}. Is it running?\n${err}`);
	}

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Ollama error ${response.status}: ${text}`);
	}

	const data = await response.json();
	const content: string = data?.message?.content ?? "";

	const cleaned = content
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```\s*$/, "")
		.replace(/[\u201C\u201D]/g, "'")
		.replace(/[\u2018\u2019]/g, "'")
		.trim();

	try {
		return JSON.parse(cleaned);
	} catch {
		throw new Error(`Ollama returned invalid JSON for link summaries:\n${content}`);
	}
}

const WIKILINK_RE = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;

/** Extract all unique wikilink target names from a block of text. */
function extractWikilinks(text: string): Set<string> {
	const names = new Set<string>();
	for (const match of text.matchAll(WIKILINK_RE)) {
		names.add(match[1].trim());
	}
	return names;
}

/**
 * Re-apply [[wikilinks]] to shot fields where the model wrote a plain name
 * instead of the bracketed form. Only names that appeared as wikilinks in the
 * original source are touched — everything else is left alone.
 */
function restoreWikilinks(shots: Shot[], knownLinks: Set<string>): Shot[] {
	if (knownLinks.size === 0) return shots;

	const textFields = ["scene", "action", "description", "dialog"] as const;

	return shots.map((shot) => {
		const result = { ...shot };
		for (const field of textFields) {
			const val = result[field];
			if (typeof val !== "string") continue;
			let text = val;
			for (const name of knownLinks) {
				const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
				// Match the plain name only when it is NOT already inside [[ ]]
				text = text.replace(
					new RegExp(`(?<!\\[\\[)\\b${escaped}\\b(?!\\]\\])`, "g"),
					`[[${name}]]`
				);
			}
			(result as any)[field] = text;
		}
		return result;
	});
}
