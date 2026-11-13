import type { ILocation } from './converter';
import type { Func, StringMap } from '../type';

export interface GeocodingOptions {
    subscriptionKey: string;
    language?: string;
}

export const settings = {
    MaxRequests: 6,
    MaxCacheSize: 3000,
    MaxCacheSizeOverflow: 1000,
    RequestTimeoutMs: 15000
};

interface CachedLocation {
    coordinate: ILocation;
    hits: number;
}

interface Subscriber {
    address: string;
    then: Func<ILocation, void>;
    signal?: AbortSignal;
    cancel?: () => void;
}

interface Request {
    address: string;
    key: string;
    generation: number;
    options: GeocodingOptions;
    subscribers: Subscriber[];
    controller: AbortController;
    timer?: ReturnType<typeof setTimeout>;
    active: boolean;
    done: boolean;
}

let options: GeocodingOptions = { subscriptionKey: '' };
let generation = 0;
let activeRequests = 0;
let pumping = false;
const injected = new Map<string, ILocation>();
const initialCache = new Map<string, ILocation>();
const cache = new Map<string, CachedLocation>();
const pending = new Map<string, Request>();
const queue: Request[] = [];

function normalize(address: string): string {
    return (address == null ? '' : String(address)).trim().toLowerCase();
}

function validLocation(location: ILocation): boolean {
    return !!location && Number.isFinite(location.latitude) && Number.isFinite(location.longitude)
        && Math.abs(location.latitude) <= 90 && Math.abs(location.longitude) <= 180;
}

function withAddress(location: ILocation, address: string): ILocation {
    return location ? { ...location, address } : null;
}

/** Supply the same Azure Maps credentials and language as the map control. */
export function configure(value: GeocodingOptions): void {
    const next = {
        subscriptionKey: (value && value.subscriptionKey || '').trim(),
        language: value && value.language || ''
    };
    if (next.subscriptionKey !== options.subscriptionKey || next.language !== options.language) {
        generation++;
        cache.clear();
    }
    options = next;
}

export function inject(locations: StringMap<ILocation>, reset = false): void {
    if (reset) {
        injected.clear();
    }
    for (const address of Object.keys(locations || {})) {
        const location = locations[address];
        if (validLocation(location)) {
            injected.set(normalize(address), { ...location });
        }
        else {
            injected.delete(normalize(address));
        }
    }
}

export function remove(where: Func<ILocation, boolean>): void {
    injected.forEach((location, key) => {
        if (where(location)) {
            injected.delete(key);
        }
    });
}

export function initCache(locations: StringMap<ILocation>): void {
    initialCache.clear();
    for (const address of Object.keys(locations || {})) {
        if (validLocation(locations[address])) {
            initialCache.set(normalize(address), { ...locations[address] });
        }
    }
}

export function latitude(address: string): number {
    const location = query(address);
    return location ? location.latitude : null;
}

export function longitude(address: string): number {
    const location = query(address);
    return location ? location.longitude : null;
}

export function getCacheSize(): number {
    return cache.size;
}

export function query(address: string): ILocation;
export function query(address: string, then: Func<ILocation, void>, signal?: AbortSignal): void;
export function query(address: string, then?: Func<ILocation, void>, signal?: AbortSignal): ILocation | void {
    if (signal && signal.aborted) {
        return;
    }
    const key = normalize(address);
    let location = injected.get(key) || initialCache.get(key);
    if (!location) {
        const entry = cache.get(key);
        if (entry) {
            entry.hits++;
            location = entry.coordinate;
        }
    }
    if (!then) {
        return withAddress(location, address);
    }
    if (location || !key || !options.subscriptionKey) {
        then(withAddress(location, address));
        return;
    }

    // Coalesce repeated addresses without sharing the caller's cancellation or address text.
    const requestKey = generation + ':' + key;
    let request = pending.get(requestKey);
    if (!request) {
        request = {
            address: address.trim(), key: requestKey, generation, options: { ...options },
            subscribers: [], controller: new AbortController(), active: false, done: false
        };
        pending.set(requestKey, request);
        queue.push(request);
    }
    const subscriber: Subscriber = { address, then, signal };
    request.subscribers.push(subscriber);
    if (signal) {
        subscriber.cancel = () => {
            const index = request.subscribers.indexOf(subscriber);
            if (index !== -1) {
                request.subscribers.splice(index, 1);
            }
            signal.removeEventListener('abort', subscriber.cancel);
            if (!request.subscribers.length) {
                request.controller.abort();
                complete(request, null);
            }
        };
        signal.addEventListener('abort', subscriber.cancel, { once: true });
    }
    pump();
}

function pump(): void {
    if (pumping) {
        return;
    }
    pumping = true;
    try {
        const limit = Math.max(1, Math.floor(settings.MaxRequests) || 1);
        while (activeRequests < limit && queue.length) {
            const request = queue.shift();
            if (!request.done) {
                if (request.subscribers.every(subscriber => subscriber.signal && subscriber.signal.aborted)) {
                    complete(request, null);
                    continue;
                }
                request.active = true;
                activeRequests++;
                makeRequest(request);
            }
        }
    }
    finally {
        pumping = false;
    }
}

async function makeRequest(request: Request): Promise<void> {
    request.timer = setTimeout(() => {
        request.controller.abort();
        complete(request, null);
    }, settings.RequestTimeoutMs);
    try {
        // Azure Maps Geocoding returns GeoJSON [longitude, latitude], not Bing's [latitude, longitude].
        // https://learn.microsoft.com/rest/api/maps/search/get-geocoding?view=rest-maps-2026-01-01
        const url = 'https://atlas.microsoft.com/geocode?api-version=2026-01-01&top=1&query='
            + encodeURIComponent(request.address);
        const headers: { [key: string]: string } = { 'subscription-key': request.options.subscriptionKey };
        if (request.options.language) {
            headers['Accept-Language'] = request.options.language;
        }
        const response = await fetch(url, { headers, signal: request.controller.signal });
        if (!response.ok) {
            complete(request, null);
            return;
        }
        const data = await response.json();
        const feature = data && Array.isArray(data.features) && data.features[0];
        const point = feature && feature.geometry;
        const coordinates = point && point.type === 'Point' && point.coordinates;
        let location: ILocation = null;
        if (Array.isArray(coordinates) && coordinates.length >= 2) {
            const properties = feature.properties || {};
            location = {
                longitude: coordinates[0], latitude: coordinates[1],
                type: properties.type,
                name: properties.address && properties.address.formattedAddress || request.address
            };
            if (!validLocation(location)) {
                location = null;
            }
        }
        complete(request, location);
    }
    catch (_) {
        // HTTP, CORS, network, JSON and timeout failures each complete the address once.
        complete(request, null);
    }
}

function complete(request: Request, location: ILocation): void {
    if (request.done) {
        return;
    }
    request.done = true;
    clearTimeout(request.timer);
    pending.delete(request.key);
    if (request.active) {
        activeRequests--;
    }
    else {
        const index = queue.indexOf(request);
        if (index !== -1) {
            queue.splice(index, 1);
        }
    }
    if (location && request.generation === generation) {
        cache.set(normalize(request.address), { coordinate: location, hits: 0 });
        if (cache.size > settings.MaxCacheSize + settings.MaxCacheSizeOverflow) {
            const entries = Array.from(cache.entries()).sort((a, b) => a[1].hits - b[1].hits);
            const count = cache.size - settings.MaxCacheSize;
            for (let i = 0; i < count; i++) {
                cache.delete(entries[i][0]);
            }
        }
    }
    for (const subscriber of request.subscribers) {
        if (subscriber.signal && subscriber.cancel) {
            subscriber.signal.removeEventListener('abort', subscriber.cancel);
        }
        if (!subscriber.signal || !subscriber.signal.aborted) {
            try {
                subscriber.then(withAddress(location, subscriber.address));
            }
            catch (error) {
                // A consumer error must not strand unrelated requests in the queue.
                setTimeout(() => { throw error; }, 0);
            }
        }
    }
    request.subscribers = [];
    pump();
}
