export interface Shot {
	/** Sequential shot number within the scene. */
	number: number;
	/** Scene or sequence label (e.g. "EXT. DESERT - DAY"). */
	scene: string;
	/** Shot type and camera movement combined (e.g. "CU — Dolly in"). */
	camera: string;
	/** Narrative action — what is happening in the shot. Preserve any [[wikilinks]]. */
	action: string;
	/** Visual details worth noting — lighting, colors, props, atmosphere, composition. Preserve any [[wikilinks]]. */
	description: string;
	/** Dialogue or spoken lines that occur during this shot (optional). Preserve any [[wikilinks]]. */
	dialog?: string;
}

const SYSTEM_PROMPT = `You are a professional script supervisor and storyboard artist.
Given a screenplay excerpt, produce a JSON array of shot objects — one object per camera setup.
Be extremely granular. Think like a director shooting a feature film: every line of action, every reaction, every new angle is its own shot.

Rules for shot count:
- The industry rule of thumb is 1 page of screenplay = 1 minute of screen time.
- Estimate the screen time of the excerpt from its page length, then apply these rates:
    - Dialogue and drama scenes: 8–12 shots per minute (per page).
    - Moderate action, suspense, or crowd scenes: 15–20 shots per minute.
    - Intense action, chases, fights, and stunts: 30 or more shots per minute.
- Every character reaction deserves its own shot.
- Every change of subject, angle, or focal point is a new shot.
- Establishing shots, inserts, cutaways, and close-ups all count — include them all.
- When in doubt, split into more shots rather than fewer.
Do NOT merge multiple beats, angles, or moments into one shot object — each deserves its own entry.

Rules for the camera field:
- Always write shot sizes and movements in full words — never use acronyms or abbreviations.
- Use: Extreme Wide Shot, Wide Shot, Medium Wide Shot, Medium Shot, Medium Close-Up, Close-Up, Extreme Close-Up, Insert.
- Combine with a movement where relevant: Static, Pan Left, Pan Right, Tilt Up, Tilt Down, Dolly In, Dolly Out, Tracking, Handheld, Crane Up, Crane Down.
- Example values: "Close-Up — Static", "Wide Shot — Dolly In", "Medium Shot — Tracking", "Extreme Close-Up — Tilt Up".
- Vary shot sizes throughout each scene. Do not repeat the same shot size more than twice in a row.

IMPORTANT — wikilinks: the source text may contain Obsidian wikilinks in the form [[Name]].
You MUST copy these exactly as-is into your output wherever the referenced entity appears.
Do NOT paraphrase, expand, or remove them. Example: write [[Keni]], never just "Keni".

Each object must have exactly these keys:
  number      (integer, sequential across the whole script)
  scene       (string, scene heading — preserve any [[wikilinks]])
  camera      (string, shot type and camera movement in full words as described above)
  action      (string, what is happening narratively in this shot — preserve any [[wikilinks]])
  description (string, visual details worth noting: lighting, colors, props, atmosphere, wardrobe, environment — do NOT repeat camera or action info here; preserve any [[wikilinks]])
  dialog      (string, the speaking character's name followed by a colon and their exact lines, e.g. "[[Keni]]: Hey man, can you get me a Coke?" — preserve any [[wikilinks]]; include this key whenever a character speaks, even a single word; omit only if the shot is completely silent)

REMINDER: every character name, location, or object that appeared as [[wikilink]] in the source must remain a [[wikilink]] in your output.
Return ONLY the JSON array, no markdown, no commentary.`;

export async function generateShotBreakdown(
	host: string,
	model: string,
	scriptText: string,
	language?: string,
	customInstructions?: string,
	onProgress?: (message: string) => void
): Promise<Shot[]> {
	onProgress?.("Connecting to Ollama…");

	const url = `${host.replace(/\/$/, "")}/api/chat`;

	let systemPrompt = SYSTEM_PROMPT;
	if (language?.trim()) {
		systemPrompt += `\n\nTranslate all output text (scene headings, descriptions, dialogue) into ${language.trim()}. Keep JSON keys in English.`;
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
	const cleaned = content
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```\s*$/, "")
		.replace(/[\u201C\u201D]/g, "'")
		.replace(/[\u2018\u2019]/g, "'")
		.split("\n")
		.filter((line) => !unwantedKeys.test(line))
		.join("\n")
		.trim();

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
- Wikilinks: strip all [[ and ]] markers — keep the name inside but remove the brackets entirely (e.g. [[Keni]] becomes Keni)
- Non-standard elements: remove anything that does not belong in a proper screenplay — markdown formatting, headers, bullet points, notes, comments, meta-data, stage directions written as prose asides, emoji, and any other non-Fountain content

Return ONLY the Fountain-formatted text. No explanations, no markdown fences, no commentary.`;

export async function convertToFountain(
	host: string,
	model: string,
	scriptText: string,
	onProgress?: (message: string) => void
): Promise<string> {
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
