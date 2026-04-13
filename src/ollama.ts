export interface Shot {
	/** Sequential shot number within the scene. */
	number: number;
	/** Scene or sequence label (e.g. "EXT. DESERT - DAY"). */
	scene: string;
	/** Shot type abbreviation (WS, MS, CU, ECU, OTS, etc.). */
	shotType: string;
	/** Short description of camera movement / framing. */
	cameraMovement: string;
	/** What is happening on screen — fed to mflux as the image prompt. */
	visualDescription: string;
	/** Any relevant dialogue or sound note (optional). */
	notes?: string;
}

const SYSTEM_PROMPT = `You are a professional script supervisor and storyboard artist.
Given a screenplay excerpt, produce a JSON array of shot objects.
Each object must have exactly these keys:
  number            (integer, sequential)
  scene             (string, scene heading)
  shotType          (string, e.g. WS / MS / CU / ECU / OTS / POV)
  cameraMovement    (string, e.g. "Static", "Pan left", "Dolly in")
  visualDescription (string, vivid single-sentence description suitable as an image generation prompt)
  notes             (string, optional dialogue or sound note — omit key if not needed)

Return ONLY the JSON array, no markdown, no commentary.`;

export async function generateShotBreakdown(
	host: string,
	model: string,
	scriptText: string,
	onProgress?: (message: string) => void
): Promise<Shot[]> {
	onProgress?.("Connecting to Ollama…");

	const url = `${host.replace(/\/$/, "")}/api/chat`;

	const body = JSON.stringify({
		model,
		stream: false,
		messages: [
			{ role: "system", content: SYSTEM_PROMPT },
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
	const cleaned = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();

	let shots: Shot[];
	try {
		shots = JSON.parse(cleaned);
	} catch {
		throw new Error(`Ollama returned invalid JSON:\n${content}`);
	}

	if (!Array.isArray(shots)) {
		throw new Error("Expected a JSON array from Ollama.");
	}

	return shots;
}
