import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const destination = new URL('../src/config/embeddedAzureMaps.ts', import.meta.url);

export async function prepareEmbeddedKey({ placeholder = false } = {}) {
    await mkdir(new URL('.', destination), { recursive: true });
    if (placeholder) {
        // A clean checkout can typecheck and test without an account key.
        // Build/start always replace this placeholder using local configuration.
        try {
            await writeFile(destination, 'export const AZURE_MAPS_KEY: string = "";\n', { flag: 'wx' });
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
        }
        return;
    }
    let key = process.env.AZURE_MAPS_KEY?.trim();
    if (!key) {
        let environment = '';
        try { environment = await readFile(new URL('../../.env', import.meta.url), 'utf8'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const value = environment.match(/^\s*(?:export\s+)?AZURE_MAPS_KEY\s*=\s*(.*?)\s*$/m)?.[1] || '';
        key = /^(['"]).*\1$/.test(value)
            ? value.slice(1, -1).trim() : value.replace(/\s+#.*$/, '').trim();
    }
    if (!key) {
        throw new Error('Set AZURE_MAPS_KEY in PowerBI-Flowmap/.env or the build environment before building this visual.');
    }
    // This module is ignored by Git. JSON encoding keeps arbitrary credential
    // characters out of generated code syntax; the value is never logged.
    await writeFile(destination,
        '// Generated for the local build. Do not commit.\n' +
        `export const AZURE_MAPS_KEY: string = ${JSON.stringify(key)};\n`);
    console.log('Embedded Azure Maps credential prepared from local configuration.');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    await prepareEmbeddedKey({ placeholder: process.argv.includes('--placeholder') });
}
