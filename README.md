## Flowmap custom visual for Power BI (Azure Maps)

This fork replaces Bing Maps with the Azure Maps Web SDK. The flow, arc and straight-line renderer, data roles, bubbles, tooltips and relocation are unchanged.

### Build

Requires Node.js 20.12+. Put `AZURE_MAPS_KEY=your-key` in the repository's `.env` file (ignored by Git), or set it in the build environment. Then, from `code`:

```sh
npm ci
npm run package
```

Import `code/dist/*.pbiviz` into Power BI with **Import a visual from a file**. It appears as **Flow map (Azure)**. `npm start` runs the development server.

### Notes

- **The key is compiled into the `.pbiviz`.** Anyone with the package, the report or browser dev tools can recover it. Only distribute the package to an audience appropriate for that key. `scripts/prepare-build.mjs` writes it to the ignored `code/src/config/embeddedAzureMaps.ts`.
- **SDK patch.** `scripts/patch-azure-maps.mjs` runs on install and build. It patches the pinned `azure-maps-control` 3.7.4 so its rendering workers accept messages inside Power BI's sandboxed iframe. Without it, the basemap renders blank. Review the patch when upgrading the SDK.
- **Web access.** The visual declares web access to `https://atlas.microsoft.com` and `https://*.atlas.microsoft.com`. Azure Maps also requires WebGL.
- **Map options.** Bing's forest, road, city, icon and area options have no Azure equivalent and were removed. Label and building toggles remain.
- **Geocoding.** Place names without latitude/longitude are geocoded with the Azure Maps Geocoding API. See [privacy](docs/privacy.md).

Original documentation: https://weiweicui.github.io/PowerBI-Flowmap
