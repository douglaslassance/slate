import { Jimp } from "jimp";

/**
 * Parse a CSS-style hex color string ("#rrggbb" or "#rgb") into a 32-bit
 * RGBA integer (0xRRGGBBAA) that Jimp accepts as a pixel value.
 */
function hexToRgba(hex: string): number {
	const h = hex.replace("#", "");
	let r: number, g: number, b: number;
	if (h.length === 3) {
		r = parseInt(h[0] + h[0], 16);
		g = parseInt(h[1] + h[1], 16);
		b = parseInt(h[2] + h[2], 16);
	} else {
		r = parseInt(h.slice(0, 2), 16);
		g = parseInt(h.slice(2, 4), 16);
		b = parseInt(h.slice(4, 6), 16);
	}
	return ((r << 24) | (g << 16) | (b << 8) | 0xff) >>> 0;
}

/**
 * Composite a list of image files into a single tiled PNG.
 *
 * @param imagePaths   Ordered list of absolute file paths to the shot images.
 * @param outputPath   Absolute path where the tiled PNG will be saved.
 * @param columns      Number of columns in the grid (default 2).
 * @param padding      Gap in pixels between images and around the border.
 * @param background   Background / padding colour as a CSS hex string ("#000000").
 */
export async function tileImages(
	imagePaths: string[],
	outputPath: string,
	columns: number = 2,
	padding: number = 16,
	background: string = "#000000"
): Promise<void> {
	if (imagePaths.length === 0) return;

	const frames = await Promise.all(imagePaths.map((p) => Jimp.read(p)));

	const cellW = Math.max(...frames.map((f) => f.width));
	const cellH = Math.max(...frames.map((f) => f.height));
	const rows  = Math.ceil(imagePaths.length / columns);

	const totalW = padding + columns * (cellW + padding);
	const totalH = padding + rows    * (cellH + padding);

	const bg = new Jimp({ width: totalW, height: totalH, color: hexToRgba(background) });

	for (let i = 0; i < frames.length; i++) {
		const col = i % columns;
		const row = Math.floor(i / columns);
		const x   = padding + col * (cellW + padding);
		const y   = padding + row * (cellH + padding);
		bg.composite(frames[i], x, y);
	}

	await bg.write(outputPath as `${string}.${string}`);
}
