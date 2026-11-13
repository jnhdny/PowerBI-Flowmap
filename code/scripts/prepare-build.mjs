import { patchAzureMaps } from './patch-azure-maps.mjs';
import { prepareEmbeddedKey } from './embed-azure-key.mjs';

await patchAzureMaps();
await prepareEmbeddedKey();
