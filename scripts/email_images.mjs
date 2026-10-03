// Writes src/lib/email/images.generated.ts from assets/email/*.{png,jpg}: every
// email image as base64, so emails carry their images instead of linking to them.
// Run after changing an image: node scripts/email_images.mjs
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'assets/email');
const types = { '.png': 'image/png', '.jpg': 'image/jpeg' };
const files = readdirSync(dir).filter((f) => types[extname(f)]).sort();
const lines = files.map((f) => {
    const name = f.slice(0, -extname(f).length);
    const b64 = readFileSync(join(dir, f)).toString('base64');
    return `    '${name}': { filename: '${f}', content_type: '${types[extname(f)]}', base64: '${b64}' },`;
});
writeFileSync(join(root, 'src/lib/email/images.generated.ts'), `/**
 * Email images as base64 (generated from assets/email by scripts/email_images.mjs; do not edit).
 */

/** One image an email carries. */
export interface EmailImageData {
    filename: string;
    content_type: string;
    base64: string;
}

export const EMAIL_IMAGES = {
${lines.join('\n')}
} as const satisfies Record<string, EmailImageData>;

/** Name of an email image (its file name without the extension). */
export type EmailImageName = keyof typeof EMAIL_IMAGES;
`);
console.log(`wrote ${files.length} images`);
