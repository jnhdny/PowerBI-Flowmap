# Privacy Statement
This visual uses Microsoft Azure Maps. If latitude/longitude are not provided for a location, the corresponding `Origin` or `Destination` text is sent to the [Azure Maps Geocoding API](https://learn.microsoft.com/rest/api/maps/search/get-geocoding?view=rest-maps-2026-01-01). Providing coordinates for every location avoids these place-name requests; the basemap still makes authenticated network requests to Azure Maps for map resources and the visible area.

The visual does not send flow weights, colors or tooltip fields to the geocoding service. Geocoding results are cached in memory and, when the existing Cache option is enabled, saved in the report. Manually relocated positions and the map view are also saved in report settings. The Azure Maps subscription key is embedded when the visual is built and is recoverable from the visual package/report or browser requests. It is not configurable in the formatting pane. Only distribute the package and report to an audience appropriate for that account/key.

Azure Maps SDK telemetry is disabled by this visual. Microsoft processes map and geocoding requests under the terms applicable to your Azure Maps account.
