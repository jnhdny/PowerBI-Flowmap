import { ISize, IPoint, StringMap } from '../type';

export interface ILocation {
    latitude: number;
    longitude: number;
    type?: string;
    name?: string;
    address?: string;
}

/** The projection interface consumed by the existing SVG flow renderer. */
export interface MapView {
    getZoom(): number;
    getWidth(): number;
    getHeight(): number;
    getCenter(): ILocation;
    tryLocationToPixel(loc: ILocation, ref?: 'center' | 'control'): IPoint;
}

export interface IArea {
    points: IPoint[];
    anchor: ILocation;
    margin: { south: number, north: number, east: number, west: number };
    offsets: number[];
    scale(zoom: number): number;
}

export interface IPoints {
    points: IPoint[];
    anchor: ILocation;
    margin: { south: number, north: number, east: number, west: number };
    offsets: StringMap<number>;
}

export interface IBound {
    anchor: ILocation;
    margin: { south: number, north: number, east: number, west: number };
    offsets?: number[];
}

export interface FitOptions {
    center: ILocation;
    zoom: number;
}

export const MAX_MERCATOR_LATITUDE = 85.0511287798066;

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function validLocation(loc: ILocation): boolean {
    return !!loc && Number.isFinite(loc.longitude) && Number.isFinite(loc.latitude)
        && Math.abs(loc.latitude) <= 90;
}

export function normalizeLongitude(longitude: number): number {
    return ((longitude + 180) % 360 + 360) % 360 - 180;
}

/** Logical zoom deliberately keeps the original 256-pixel world convention.
 * Azure Maps camera zoom is one less, because its world uses 512-pixel tiles.
 */
export function mapSize(zoom: number): number {
    return 256 * Math.pow(2, zoom);
}

export function project(loc: ILocation, zoom: number): IPoint {
    const size = mapSize(zoom);
    const latitude = clamp(loc.latitude, -MAX_MERCATOR_LATITUDE, MAX_MERCATOR_LATITUDE);
    const sin = Math.sin(latitude * Math.PI / 180);
    return {
        // Do not clamp longitude: adjacent world copies must remain continuous.
        x: (loc.longitude + 180) / 360 * size,
        y: clamp(0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI), 0, 1) * size
    };
}

export function unproject(point: IPoint, zoom: number): ILocation {
    const size = mapSize(zoom);
    const y = 0.5 - clamp(point.y / size, 0, 1);
    return {
        longitude: normalizeLongitude(point.x / size * 360 - 180),
        latitude: 90 - 360 * Math.atan(Math.exp(-y * 2 * Math.PI)) / Math.PI
    };
}

export function defaultZoom(width: number, height: number): number {
    const size = Math.min(dimension(width), dimension(height));
    return clamp(Math.floor(Math.log2(size / 256)) + 1, 1, 20);
}

function dimension(value: number): number {
    return Number.isFinite(value) && value > 0 ? value : 1;
}

/** Find the shortest interval covering entire longitude ranges, not just their
 * endpoints. Cutting at the largest uncovered gap also handles the date line.
 */
function longitudeExtent(ranges: Array<{ start: number, span: number }>): { start: number, span: number } {
    const intervals: number[][] = [];
    for (const range of ranges) {
        if (range.span >= 360) {
            return { start: -180, span: 360 };
        }
        const start = ((range.start % 360) + 360) % 360;
        const end = start + Math.max(0, range.span);
        if (end > 360) {
            intervals.push([start, 360], [0, end - 360]);
        }
        else {
            intervals.push([start, end]);
        }
    }
    intervals.sort((a, b) => a[0] - b[0]);
    const merged: number[][] = [];
    for (const interval of intervals) {
        const previous = merged[merged.length - 1];
        if (previous && interval[0] <= previous[1]) {
            previous[1] = Math.max(previous[1], interval[1]);
        }
        else {
            merged.push(interval.slice());
        }
    }
    let largestGap = -1, start = 0;
    for (let i = 0; i < merged.length; i++) {
        const nextStart = i + 1 < merged.length ? merged[i + 1][0] : merged[0][0] + 360;
        const gap = nextStart - merged[i][1];
        if (gap > largestGap) {
            largestGap = gap;
            start = nextStart % 360;
        }
    }
    return { start, span: 360 - largestGap };
}

// Missing or invalid coordinates do not contribute to the centroid.
export function anchor(data: ILocation[]): ILocation & { positive: boolean } {
    const valid = (data || []).filter(validLocation);
    if (!valid.length) {
        return null;
    }
    const extent = longitudeExtent(valid.map(loc => ({ start: loc.longitude, span: 0 })));
    const longitude = normalizeLongitude(extent.start + extent.span / 2);
    return {
        longitude,
        latitude: valid.reduce((sum, loc) => sum + loc.latitude, 0) / valid.length,
        positive: longitude >= 0
    };
}

export function bound(data: ILocation[]): IBound {
    const anch = anchor(data);
    if (!anch) {
        return null;
    }
    const margin = { east: 0, west: 0, south: 0, north: 0 };
    const offsets: number[] = [];
    let count = 0;
    for (let i = 0; i < data.length; i++) {
        const loc = data[i];
        if (!validLocation(loc)) {
            continue;
        }
        count++;
        const longitude = normalizeLongitude(loc.longitude);
        const delta = normalizeLongitude(longitude - anch.longitude);
        offsets[i] = Math.round((anch.longitude + delta - longitude) / 360);
        margin.east = Math.max(margin.east, delta);
        margin.west = Math.max(margin.west, -delta);
        margin.north = Math.max(margin.north, loc.latitude - anch.latitude);
        margin.south = Math.max(margin.south, anch.latitude - loc.latitude);
    }
    if (count === 1) {
        margin.east = margin.west = margin.south = margin.north = 0.1;
    }
    return {
        anchor: { longitude: anch.longitude, latitude: anch.latitude },
        margin,
        offsets
    };
}

export function fitOptions(bounds: IBound[], view: ISize, padding = 24): FitOptions {
    const valid = (bounds || []).filter(item => item && validLocation(item.anchor) && item.margin
        && ['north', 'south', 'east', 'west'].every(key => Number.isFinite(item.margin[key]) && item.margin[key] >= 0));
    const width = dimension(view && view.width), height = dimension(view && view.height);
    if (!valid.length) {
        return { zoom: defaultZoom(width, height), center: { latitude: 0, longitude: 0 } };
    }
    let north = -90, south = 90;
    for (const item of valid) {
        north = Math.max(north, item.anchor.latitude + item.margin.north);
        south = Math.min(south, item.anchor.latitude - item.margin.south);
    }
    const extent = longitudeExtent(valid.map(item => ({
        start: item.anchor.longitude - item.margin.west,
        span: item.margin.east + item.margin.west
    })));
    const top = project({ latitude: north, longitude: 0 }, 0).y;
    const bottom = project({ latitude: south, longitude: 0 }, 0).y;
    const pad = Number.isFinite(padding) ? Math.max(0, padding) : 24;
    const availableWidth = Math.max(1, width - 2 * pad);
    const availableHeight = Math.max(1, height - 2 * pad);
    const xSize = extent.span / 360 * 256, ySize = bottom - top;
    const xZoom = xSize > 0 ? Math.log2(availableWidth / xSize) : 20;
    const yZoom = ySize > 0 ? Math.log2(availableHeight / ySize) : 20;
    return {
        zoom: clamp(Math.min(xZoom, yZoom), 1, 20),
        center: {
            longitude: normalizeLongitude(extent.start + extent.span / 2),
            latitude: unproject({ x: 128, y: (top + bottom) / 2 }, 0).latitude
        }
    };
}

export function anchorPixel(map: MapView, bounds: IBound): IPoint {
    const pixel = map.tryLocationToPixel(bounds.anchor);
    const size = mapSize(map.getZoom());
    // Choose the world copy whose entire flow's midpoint is nearest the view.
    const midpoint = pixel.x + (bounds.margin.east - bounds.margin.west) / 720 * size;
    return { x: pixel.x - Math.round(midpoint / size) * size, y: pixel.y };
}

export function area(data: ILocation[], level = 20): IArea {
    const result = bound(data) as IArea;
    if (!result) {
        return null;
    }
    const origin = project(result.anchor, level);
    const size = mapSize(level);
    result.points = data.map((loc, i) => {
        if (!validLocation(loc)) {
            return null;
        }
        const point = project({ latitude: loc.latitude, longitude: normalizeLongitude(loc.longitude) }, level);
        return {
            x: point.x - origin.x + (result.offsets[i] || 0) * size,
            y: point.y - origin.y
        };
    });
    result.scale = zoom => Math.pow(2, zoom - level);
    return result;
}

export class Converter {
    constructor(private _level: number) { }

    public factor(zoom: number): number {
        return Math.pow(2, zoom - this._level);
    }

    public line(data: ILocation[]): IArea {
        const result = this.points(data);
        if (!result) {
            return null;
        }
        const size = mapSize(this._level);
        let previous: IPoint = null;
        for (const point of result.points) {
            if (!point) {
                continue;
            }
            if (previous) {
                point.x += Math.round((previous.x - point.x) / size) * size;
            }
            previous = point;
        }
        return result;
    }

    public points(data: ILocation[]): IArea {
        return area(data, this._level);
    }

    public x(longitude: number): number {
        return project({ longitude, latitude: 0 }, this._level).x;
    }

    public y(latitude: number): number {
        return project({ longitude: 0, latitude }, this._level).y;
    }
}
