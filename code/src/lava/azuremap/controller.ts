import * as atlas from 'azure-maps-control';
import { ILocation, IBound, MapView, anchorPixel, bound, anchor, fitOptions, area, defaultZoom, MAX_MERCATOR_LATITUDE } from './converter';
import { IPoint, partial } from '../type';
import { ISelex, selex } from '../d3';
import { configure } from './geoService';

export { defaultZoom } from './converter';
export type PixelReference = 'center' | 'control';

export interface IMapElement {
  label: boolean;
  building: boolean;
}
export interface IMapControl {
  type: 'hidden' | 'aerial' | 'road' | 'grayscale' | 'canvasDark' | 'canvasLight';
  lang: string;
  pan: boolean;
  zoom: boolean;
  subscriptionKey: string;
}
export interface IMapFormat extends IMapControl, IMapElement { }

export class MapFormat implements IMapFormat {
  type: IMapControl['type'] = 'road';
  lang = 'default';
  pan = true;
  zoom = true;
  subscriptionKey = '';
  label = true;
  building = false;

  public static build(...fmts: Partial<IMapFormat>[]): MapFormat {
    const result = new MapFormat();
    for (const fmt of fmts.filter(Boolean)) {
      for (const key of Object.keys(result)) {
        if (key in fmt) result[key] = fmt[key];
      }
    }
    return result;
  }
  public static control<T>(fmt: MapFormat, extra: T): IMapControl & T {
    return Object.assign(partial(fmt, ['type', 'lang', 'pan', 'zoom', 'subscriptionKey']), extra) as IMapControl & T;
  }
  public static element<T>(fmt: MapFormat, extra: T): IMapElement & T {
    return Object.assign(partial(fmt, ['label', 'building']), extra) as IMapElement & T;
  }
}

export function pixel(map: MapView, loc: ILocation, ref?: PixelReference): IPoint {
  return map.tryLocationToPixel(loc, ref);
}
export interface IListener {
  transform?(ctl: Controller, previousZoom: number, end?: boolean): void;
  resize?(ctl: Controller): void;
}

/** Adapts Azure Maps to the renderer's 256-pixel, center-relative geometry. */
export class Controller {
  private _atlas: atlas.Map;
  private _fmt = new MapFormat();
  private _svg: ISelex;
  private _svgroot: ISelex;
  private _canvas: ISelex;
  private _listeners: IListener[] = [];
  private _ready = false;
  private _styleDirty = false;
  private _disposed = false;
  private _zoom = 1;
  private _status: HTMLDivElement;
  private _timeout: ReturnType<typeof setTimeout>;
  private _onReady: (map: MapView) => void;

  public readonly map: MapView = {
    getZoom: () => this._atlas.getCamera().zoom + 1,
    getCenter: () => {
      const [longitude, latitude] = this._atlas.getCamera().center;
      return { longitude, latitude };
    },
    getWidth: () => this._div.clientWidth,
    getHeight: () => this._div.clientHeight,
    tryLocationToPixel: (loc, ref) => {
      const center = this._atlas.getCamera().center[0];
      const longitude = loc.longitude + 360 * Math.round((center - loc.longitude) / 360);
      const latitude = Math.max(-MAX_MERCATOR_LATITUDE, Math.min(MAX_MERCATOR_LATITUDE, loc.latitude));
      const [x, y] = this._atlas.positionsToPixels([[longitude, latitude]])[0];
      return ref === 'control' ? { x, y } : { x: x - this.map.getWidth() / 2, y: y - this.map.getHeight() / 2 };
    }
  };

  constructor(private _div: HTMLElement) {
    this._div.classList.add('flowmap-map');
    const root = selex(_div);
    this._canvas = root.append('canvas').att.class('flowmap-overlay');
    this._svg = root.append('svg').att.class('flowmap-overlay');
    this._svgroot = this._svg.append('g');
    this._status = document.createElement('div');
    this._status.className = 'flowmap-message';
    this._status.setAttribute('role', 'status');
    this._div.appendChild(this._status);
    this.message('Loading Azure Maps…');
  }
  public get format() { return this._fmt; }
  public get svg() { return this._svgroot; }
  public get canvas() { return this._canvas; }

  public location(point: IPoint): ILocation {
    const [longitude, latitude] = this._atlas.pixelsToPositions([
      [point.x + this.map.getWidth() / 2, point.y + this.map.getHeight() / 2]
    ])[0];
    return { longitude: ((longitude + 180) % 360 + 360) % 360 - 180, latitude };
  }
  public setCenterZoom(center: ILocation, zoom: number) {
    if (!this._ready || !center || !Number.isFinite(zoom)) return;
    this._atlas.setCamera({ center: [center.longitude, center.latitude],
      zoom: Math.max(0, Math.min(19, zoom - 1)), bearing: 0, pitch: 0, type: 'jump' });
  }
  public pixel(loc: ILocation | IBound, ref?: PixelReference): IPoint {
    return (loc as IBound).anchor ? anchorPixel(this.map, loc as IBound) : pixel(this.map, loc as ILocation, ref);
  }
  public anchor(locs: ILocation[]) { return anchor(locs); }
  public area(locs: ILocation[], level = 20) { return area(locs, level); }
  public bound(locs: ILocation[]) { return bound(locs); }
  public add(listener: IListener) { this._listeners.push(listener); return this; }
  public fitView(areas: IBound[], backupCenter?: ILocation) {
    if (!this._ready) return;
    const config = fitOptions(areas, { width: this.map.getWidth(), height: this.map.getHeight() });
    this.setCenterZoom(config.center, config.zoom);
    this._viewChange();
  }
  private message(text: string) {
    this._status.textContent = text;
    this._status.hidden = !text;
  }
  private style(): atlas.StyleOptions {
    const types = { road: 'road', aerial: this._fmt.label ? 'satellite_road_labels' : 'satellite',
      grayscale: 'grayscale_light', canvasLight: 'grayscale_light', canvasDark: 'grayscale_dark', hidden: 'blank' };
    return { style: types[this._fmt.type] || 'road',
      language: this._fmt.lang === 'default' ? 'auto' : this._fmt.lang,
      showLabels: this._fmt.label,
      styleOverrides: { buildingFootprint: { visible: this._fmt.building } },
      renderWorldCopies: true, showFeedbackLink: false };
  }
  private interaction(): atlas.UserInteractionOptions {
    return { dragPanInteraction: this._fmt.pan, scrollZoomInteraction: this._fmt.zoom,
      dblClickZoomInteraction: this._fmt.zoom, boxZoomInteraction: this._fmt.zoom,
      touchInteraction: this._fmt.pan && this._fmt.zoom,
      dragRotateInteraction: false, touchRotate: false, keyboardInteraction: false };
  }
  public restyle(fmt: Partial<IMapFormat>, then?: (map: MapView) => void): Controller {
    if (this._disposed) return this;
    const previous = this._fmt;
    this._fmt = MapFormat.build(previous, fmt);
    this._fmt.subscriptionKey = (this._fmt.subscriptionKey || '').trim();
    configure({ subscriptionKey: this._fmt.subscriptionKey, language: this._fmt.lang === 'default' ? undefined : this._fmt.lang });
    if (this._atlas) {
      this._styleDirty = this._styleDirty || ['type', 'lang', 'label', 'building'].some(key => previous[key] !== this._fmt[key]);
      if (this._ready) {
        if (this._styleDirty) this._atlas.setStyle(this.style());
        this._styleDirty = false;
        this._atlas.setUserInteraction(this.interaction());
        then && then(this.map);
      }
      return this;
    }
    this._onReady = then;
    try {
      this._atlas = new atlas.Map(this._div, {
        ...this.style(), ...this.interaction(),
        center: [0, 0], zoom: defaultZoom(this.map.getWidth(), this.map.getHeight()) - 1,
        minZoom: 0, maxZoom: 19, bearing: 0, pitch: 0, enableTelemetry: false,
        authOptions: { authType: atlas.AuthenticationType.subscriptionKey, subscriptionKey: this._fmt.subscriptionKey }
      });
      const container = this._atlas.getCanvasContainer();
      container.appendChild(this._canvas.node());
      container.appendChild(this._svg.node());
      this._div.appendChild(this._status);
      this._atlas.events.add('ready', () => {
        if (this._disposed || this._ready) return;
        this._ready = true;
        clearTimeout(this._timeout);
        this.message('');
        this._zoom = this.map.getZoom();
        if (this._styleDirty) this._atlas.setStyle(this.style());
        this._styleDirty = false;
        this._atlas.setUserInteraction(this.interaction());
        this.resize();
        const callback = this._onReady;
        this._onReady = null;
        callback && callback(this.map);
      });
      this._atlas.events.add('move', () => this._viewChange());
      this._atlas.events.add('moveend', () => this._viewChange(true));
      this._atlas.events.add('resize', () => this.resizeOverlay());
      this._atlas.events.add('error', () => {
        if (!this._disposed) this.message('Azure Maps could not load. Check the subscription key, internet connection, and Power BI web-access permissions.');
      });
      this._atlas.events.add('load', () => { if (!this._disposed) this.message(''); });
      this._timeout = setTimeout(() => {
        if (!this._disposed && !this._ready) this.message('Azure Maps is taking too long to load. Check the subscription key and Power BI web-access permissions.');
      }, 20000);
    } catch (_) {
      this.message('Azure Maps could not start. A browser with WebGL support and a valid Azure Maps subscription key are required.');
    }
    return this;
  }
  private _viewChange(end = false) {
    if (!this._ready || this._disposed) return;
    const zoom = this.map.getZoom();
    for (const listener of this._listeners) listener.transform && listener.transform(this, this._zoom, end);
    this._zoom = zoom;
  }
  private resizeOverlay() {
    if (!this._ready || this._disposed) return;
    const width = this.map.getWidth(), height = this.map.getHeight();
    this._svg.att.size(width, height);
    this._canvas.att.size(width, height);
    this._svgroot.att.translate(width / 2, height / 2);
    for (const listener of this._listeners) listener.resize && listener.resize(this);
    this._viewChange();
  }
  public resize() {
    if (!this._ready || this._disposed) return;
    this._atlas.resize();
    this.resizeOverlay();
  }
  public destroy() {
    this._disposed = true;
    clearTimeout(this._timeout);
    this._onReady = null;
    this._listeners = [];
    if (this._atlas) this._atlas.dispose();
    this._atlas = null;
    this._svg.remove();
    this._canvas.remove();
    this._status.remove();
  }
}
