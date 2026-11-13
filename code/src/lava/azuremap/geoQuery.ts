import type { ILocation } from './converter';
import type { Func } from '../type';
import * as geo from './geoService';

export class GeoQuery {
    private _addrs: string[];
    private _controller = new AbortController();
    private _active = 0;
    private _started = false;
    private _pumping = false;
    private _each: Func<ILocation, void>;

    constructor(addrs: ReadonlyArray<string>) {
        this._addrs = addrs.slice();
    }

    cancel(): void {
        this._addrs = [];
        this._controller.abort();
    }

    count(): number {
        return this._controller.signal.aborted ? 0 : this._addrs.length + this._active;
    }

    run(each: Func<ILocation, void>): this {
        if (!this._started && !this._controller.signal.aborted) {
            this._started = true;
            this._each = each;
            this.pump();
        }
        return this;
    }

    private pump(): void {
        if (this._pumping) {
            return;
        }
        this._pumping = true;
        try {
            const limit = Math.max(1, Math.floor(geo.settings.MaxRequests) || 1);
            while (!this._controller.signal.aborted && this._addrs.length && this._active < limit) {
                const address = this._addrs.shift();
                this._active++;
                geo.query(address, location => {
                    this._active--;
                    if (!this._controller.signal.aborted) {
                        try {
                            this._each(location);
                        }
                        finally {
                            this.pump();
                        }
                    }
                }, this._controller.signal);
            }
        }
        finally {
            this._pumping = false;
        }
    }
}
