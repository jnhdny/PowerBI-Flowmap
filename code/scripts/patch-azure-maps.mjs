import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// Azure Maps 3.7.4 embeds MapLibre's worker Actor. In a sandboxed iframe,
// location.origin identifies the URL, whereas globalThis.origin identifies the
// actual (opaque) execution origin shared with its dedicated blob workers.
// Keep the existing origin and map-ID checks; correct the origin they compare.
export function patchWorkerOrigins(source, minified) {
    const replacements = minified ? [
        ['origin:location.origin', 'origin:globalThis.origin', 3],
        ['"file://"!==e.origin&&"file://"!==location.origin&&e.origin!==location.origin',
            '"file://"!==e.origin&&"file://"!==globalThis.origin&&e.origin!==globalThis.origin', 1]
    ] : [
        ['origin: location.origin', 'origin: globalThis.origin', 3],
        ["data.origin !== 'file://' && location.origin !== 'file://' && data.origin !== location.origin",
            "data.origin !== 'file://' && globalThis.origin !== 'file://' && data.origin !== globalThis.origin", 1]
    ];
    for (const [before, after, expected] of replacements) {
        const beforeCount = source.split(before).length - 1;
        const afterCount = source.split(after).length - 1;
        if (beforeCount === 0 && afterCount === expected) continue;
        if (beforeCount !== expected || afterCount !== 0) {
            throw new Error('Azure Maps worker source changed; review the sandbox compatibility patch before building.');
        }
        source = source.split(before).join(after);
    }
    return source;
}

export async function patchAzureMaps() {
    const sdk = new URL('../node_modules/azure-maps-control/', import.meta.url);
    const metadata = JSON.parse(await readFile(new URL('package.json', sdk), 'utf8'));
    if (metadata.version !== '3.7.4') {
        throw new Error('Review the Azure Maps sandbox compatibility patch when changing SDK version 3.7.4.');
    }
    // Validate every file before modifying any of them. Patch both package entry
    // points and the readable distribution used to debug the bundled SDK.
    const files = ['dist/atlas-esm.min.js', 'dist/atlas.min.js', 'dist/atlas-esm.js'];
    const changes = await Promise.all(files.map(async name => {
        const path = new URL(name, sdk);
        const original = await readFile(path, 'utf8');
        return { path, original, patched: patchWorkerOrigins(original, name.includes('.min.')) };
    }));
    for (const { path, original, patched } of changes) {
        if (original !== patched) await writeFile(path, patched);
    }
    console.log('Azure Maps sandbox worker compatibility patch verified.');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    await patchAzureMaps();
}
