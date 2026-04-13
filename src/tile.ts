import { readFile, writeFile } from "fs/promises";

/**
 * Tile a list of image file paths into a single contact-sheet PNG
 * using the browser Canvas API (available in Electron/Obsidian — no native deps).
 *
 * Images are laid out left-to-right, top-to-bottom in a roughly square grid.
 *
 * @param imagePaths  Ordered list of absolute image paths.
 * @param outputPath  Absolute path for the output PNG.
 * @param cellWidth   Width of each cell (should match mflux --width).
 * @param cellHeight  Height of each cell (should match mflux --height).
 */
export async function tileImages(
	imagePaths: string[],
	outputPath: string,
	cellWidth: number,
	cellHeight: number
): Promise<void> {
	const count = imagePaths.length;
	if (count === 0) throw new Error("No images to tile.");

	const cols = Math.ceil(Math.sqrt(count));
	const rows = Math.ceil(count / cols);

	const canvas = document.createElement("canvas");
	canvas.width = cols * cellWidth;
	canvas.height = rows * cellHeight;

	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("Could not get 2D canvas context.");

	ctx.fillStyle = "#000000";
	ctx.fillRect(0, 0, canvas.width, canvas.height);

	for (let i = 0; i < imagePaths.length; i++) {
		const imgData = await readFile(imagePaths[i]);
		const blob = new Blob([imgData], { type: "image/png" });
		const url = URL.createObjectURL(blob);

		await new Promise<void>((resolve, reject) => {
			const img = new Image();
			img.onload = () => {
				const col = i % cols;
				const row = Math.floor(i / cols);
				ctx.drawImage(img, col * cellWidth, row * cellHeight, cellWidth, cellHeight);
				URL.revokeObjectURL(url);
				resolve();
			};
			img.onerror = () => {
				URL.revokeObjectURL(url);
				reject(new Error(`Failed to load image: ${imagePaths[i]}`));
			};
			img.src = url;
		});
	}

	// Export to PNG and write to disk.
	const dataUrl = canvas.toDataURL("image/png");
	const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
	await writeFile(outputPath, Buffer.from(base64, "base64"));
}
