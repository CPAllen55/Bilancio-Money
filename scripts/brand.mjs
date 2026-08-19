/**
 * Generates every icon the site needs from ONE master: public/brand/owl.png.
 *
 *   npm run brand
 *
 * The master is the artwork as supplied - nothing is redrawn or recoloured.
 * Re-run this after replacing owl.png and every derivative updates together.
 */
import sharp from "sharp";
import { mkdir } from "node:fs/promises";

const MASTER = "public/brand/owl.png";
const OUT = "public/brand";
const SITE_BG = { r: 5, g: 8, b: 11, alpha: 1 };   // --bg, #05080B

await mkdir(OUT, { recursive: true });

const meta = await sharp(MASTER).metadata();
console.log(`master: ${meta.width}x${meta.height} ${meta.format}, alpha=${meta.hasAlpha}\n`);

// Square icons, straight from the master.
const sizes = [16, 32, 48, 180, 192, 512];
for (const size of sizes) {
  const name = size === 180 ? "apple-touch-icon.png" : `icon-${size}.png`;
  await sharp(MASTER)
    .resize(size, size, { fit: "cover", kernel: "lanczos3" })
    .png({ compressionLevel: 9 })
    .toFile(`${OUT}/${name}`);
  console.log(`  ${name.padEnd(24)} ${size}x${size}`);
}

// Social card: the owl on the site's own background, not stretched to fill.
await sharp({
  create: { width: 1200, height: 630, channels: 4, background: SITE_BG },
})
  .composite([{ input: await sharp(MASTER).resize(420, 420, { kernel: "lanczos3" }).toBuffer(), gravity: "centre" }])
  .png({ compressionLevel: 9 })
  .toFile(`${OUT}/og-image.png`);
console.log(`  ${"og-image.png".padEnd(24)} 1200x630`);
