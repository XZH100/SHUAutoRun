import { performance } from 'node:perf_hooks';

export type Point = { latitude: number; longitude: number };
export type Route = { name: string; coordinateSystem: 'wgs84' | 'gcj02'; points: Point[] };
export type MotionSettings = { speedKmh: number; variationKmh: number; driftMeters: number; loop: boolean;
    headingMode: 'path' | 'manual'; manualHeading: number };
export type MotionSample = Point & { enabled: boolean; speed: number; heading: number; coordinateSystem: 'wgs84' | 'gcj02' };
const R = 6371008.8, RAD = Math.PI / 180;
function finite(v: unknown, min: number, max: number, label: string): number {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new Error(`${label} 应为 ${min}–${max} 的数字`);
    return v;
}
export function parseRoute(input: any, fallbackName = '导入的路线'): Route {
    let geometry = input, crs: 'wgs84' | 'gcj02' = 'gcj02';
    let name = typeof input?.name === 'string' ? input.name.slice(0, 100) : fallbackName.slice(0, 100);
    if (input?.type === 'FeatureCollection') {
        if (!Array.isArray(input.features) || input.features.length !== 1) throw new Error('GeoJSON 请只包含一条 LineString 路径');
        geometry = input.features[0];
    }
    if (geometry?.type === 'Feature') {
        name = typeof geometry.properties?.name === 'string' ? geometry.properties.name.slice(0, 100) : name;
        geometry = geometry.geometry;
    }
    let values: any[];
    if (geometry?.type === 'LineString') {
        values = geometry.coordinates; crs = 'wgs84';
    } else {
        values = Array.isArray(input) ? input : input?.points;
        if (input?.coordinateSystem !== undefined) {
            if (!['wgs84', 'gcj02'].includes(input.coordinateSystem)) throw new Error('coordinateSystem 必须是 wgs84 或 gcj02');
            crs = input.coordinateSystem;
        }
    }
    if (!Array.isArray(values) || values.length < 2 || values.length > 10000) throw new Error('路径需要 2–10000 个标记点');
    const points: Point[] = [];
    for (const value of values) {
        const p = { latitude: finite(Array.isArray(value) ? value[1] : value?.latitude, -85, 85, '纬度'),
            longitude: finite(Array.isArray(value) ? value[0] : value?.longitude, -180, 180, '经度') };
        const last = points[points.length - 1];
        if (!last || last.latitude !== p.latitude || last.longitude !== p.longitude) points.push(p);
    }
    if (points.length < 2) throw new Error('路径至少需要两个不同的位置');
    // Local equirectangular projection keeps straight segments and metre offsets
    // consistent. Reject long/cross-dateline tracks instead of distorting them.
    const origin = points[0];
    for (const p of points) {
        const x = (p.longitude-origin.longitude)*RAD*R*Math.cos(origin.latitude*RAD);
        const y = (p.latitude-origin.latitude)*RAD*R;
        if (Math.hypot(x,y) > 100000) throw new Error('路线范围限于起点周围 100 km，长途路线请分段导入');
    }
    return { name, coordinateSystem: crs, points };
}

export class RouteMotion {
    settings: MotionSettings = { speedKmh: 12, variationKmh: 3, driftMeters: 3, loop: false,
        headingMode: 'path', manualHeading: 0 };
    route?: Route;
    routeVersion = 0;
    private xy: Array<{ x: number; y: number; distance: number }> = [];
    private timer: ReturnType<typeof setInterval>;
    private status: 'empty' | 'ready' | 'running' | 'paused' | 'finished' | 'stopped' = 'empty';
    private distance = 0;
    private laps = 0;
    private speed = 12;
    private drift = 0;
    private effectiveDrift = 0;
    private pathHeading = 0;
    private segment = 0;
    private lastTime = performance.now();
    private randomAge = 0;
    private randomPeriod = 3;
    private speedFrom = 12;
    private speedTo = 12;
    private driftFrom = 0;
    private driftTo = 0;
    private active = false;
    private lastPush = 0;
    private current?: Point;
    constructor(private publish: (sample: MotionSample) => void) {
        this.timer = setInterval(() => this.tick(), 250);
    }
    get length() { return this.xy[this.xy.length-1]?.distance || 0; }
    load(raw: any, name?: string) {
        const route = parseRoute(raw, name);
        const origin = route.points[0];
        const xy: typeof this.xy = [];
        for (const p of route.points) {
            const x = (p.longitude-origin.longitude)*RAD*R*Math.cos(origin.latitude*RAD);
            const y = (p.latitude-origin.latitude)*RAD*R;
            const last = xy[xy.length-1];
            xy.push({ x, y, distance: last ? last.distance + Math.hypot(x-last.x,y-last.y) : 0 });
        }
        if (xy[xy.length-1].distance < 1) throw new Error('路径总长至少为 1 米');
        // Replace routes atomically; never briefly restore the real location.
        this.route = route; this.xy = xy; this.routeVersion++;
        this.distance = 0; this.laps = 0; this.segment = 0; this.drift = 0; this.effectiveDrift = 0;
        this.status = 'ready'; this.active = true;
        this.locate(); this.push();
        return this.snapshot();
    }
    updateSettings(raw: any) {
        if (!raw || typeof raw !== 'object') throw new Error('设置必须是对象');
        const s = { ...this.settings, ...raw };
        finite(s.speedKmh, 1, 100, '基准速度'); finite(s.variationKmh, 0, 50, '速度浮动');
        finite(s.driftMeters, 0, 3, '横向漂移');
        if (s.variationKmh >= s.speedKmh) throw new Error('速度浮动必须小于基准速度');
        if (typeof s.loop !== 'boolean') throw new Error('loop 必须是布尔值');
        if (!['path', 'manual'].includes(s.headingMode)) throw new Error('headingMode 必须是 path 或 manual');
        finite(s.manualHeading, 0, 360, '手动朝向');
        this.settings = { speedKmh: s.speedKmh, variationKmh: s.variationKmh, driftMeters: s.driftMeters, loop: s.loop,
            headingMode: s.headingMode, manualHeading: s.manualHeading % 360 };
        this.speed = Math.max(s.speedKmh-s.variationKmh, Math.min(s.speedKmh+s.variationKmh, this.speed));
        this.drift = Math.max(-s.driftMeters, Math.min(s.driftMeters, this.drift));
        this.chooseRandom(); this.locate();
        if (this.active) this.push();
    }
    private chooseRandom() {
        this.speedFrom = this.speed; this.driftFrom = this.drift;
        this.speedTo = this.settings.speedKmh + (Math.random()*2-1)*this.settings.variationKmh;
        this.driftTo = (Math.random()*2-1)*this.settings.driftMeters;
        this.randomAge = 0; this.randomPeriod = 2 + Math.random()*3;
    }
    control(action: string) {
        if (!this.route) throw new Error('请先导入路径文件');
        if (action === 'start') {
            if (this.status === 'running') return;
            if (this.distance >= this.length || this.status === 'stopped') { this.distance = 0; this.laps = 0; this.segment = 0; }
            this.active = true; this.status = 'running'; this.speed = this.settings.speedKmh;
            this.chooseRandom(); this.lastTime = performance.now(); this.locate(); this.push();
        } else if (action === 'pause') {
            if (this.status !== 'running') return;
            this.status = 'paused'; this.push();
        } else if (action === 'reset') {
            this.distance = 0; this.laps = 0; this.segment = 0; this.drift = 0;
            this.status = 'ready'; this.active = true; this.chooseRandom(); this.locate(); this.push();
        } else if (action === 'stop') {
            this.active = false; this.status = 'stopped';
            this.publish({ ...this.current!, coordinateSystem: this.route.coordinateSystem, speed: 0, heading: this.heading, enabled: false });
        } else throw new Error('未知控制操作');
    }
    private tick() {
        const now = performance.now();
        // Long system suspends do not cause a large teleport on wake.
        const dt = Math.min((now-this.lastTime)/1000, 1); this.lastTime = now;
        if (this.status !== 'running') return;
        if (this.randomAge >= this.randomPeriod) this.chooseRandom();
        const oldSpeed = this.speed;
        this.randomAge = Math.min(this.randomPeriod, this.randomAge+dt);
        const blend = (1-Math.cos(Math.PI*this.randomAge/this.randomPeriod))/2;
        this.speed = this.speedFrom + (this.speedTo-this.speedFrom)*blend;
        this.drift = this.driftFrom + (this.driftTo-this.driftFrom)*blend;
        this.distance += (oldSpeed+this.speed)/2/3.6*dt;
        if (this.distance >= this.length) {
            if (this.settings.loop) {
                this.laps += Math.floor(this.distance/this.length);
                this.distance %= this.length; this.segment = 0;
            } else { this.distance = this.length; this.status = 'finished'; }
        }
        this.locate();
        if (now-this.lastPush >= 1000 || this.status === 'finished') this.push();
    }
    private locate() {
        if (!this.route) return;
        while (this.segment < this.xy.length-2 && this.distance >= this.xy[this.segment+1].distance) this.segment++;
        const a = this.xy[this.segment], b = this.xy[this.segment+1];
        const length = b.distance-a.distance, dx = b.x-a.x, dy = b.y-a.y;
        // Device azimuth approximation: tangent of the planned segment (ignore
        // simulated GPS drift). North=0, east=90, clockwise, in [0,360).
        this.pathHeading = (Math.atan2(dx, dy)/RAD + 360) % 360;
        const t = Math.max(0,Math.min(1,(this.distance-a.distance)/length));
        // Taper to the exact marker at corners/endpoints, keeping the drift
        // perpendicular to its segment and preventing discontinuous corner jumps.
        const offset = this.drift*Math.min(1, (this.distance-a.distance)/5, (b.distance-this.distance)/5);
        this.effectiveDrift = offset;
        const x = a.x+dx*t-dy/length*offset, y = a.y+dy*t+dx/length*offset;
        const origin = this.route.points[0];
        this.current = { latitude: origin.latitude+y/R/RAD,
            longitude: origin.longitude+x/(R*RAD*Math.cos(origin.latitude*RAD)) };
    }
    private push() {
        if (!this.current || !this.route) return;
        this.lastPush = performance.now();
        this.publish({ ...this.current, coordinateSystem: this.route.coordinateSystem,
            speed: this.status === 'running' ? this.speed/3.6 : 0, heading: this.heading, enabled: true });
    }
    private get heading() { return this.settings.headingMode === 'manual' ? this.settings.manualHeading : this.pathHeading; }
    snapshot() {
        return { status: this.status, active: this.active, routeVersion: this.routeVersion,
            name: this.route?.name || '', coordinateSystem: this.route?.coordinateSystem,
            points: this.route?.points.length || 0, length: this.length, distance: this.distance,
            progress: this.length ? this.distance/this.length : 0, laps: this.laps, segment: this.segment,
            speedKmh: this.status === 'running' ? this.speed : 0, driftMeters: this.effectiveDrift,
            position: this.current, heading: this.heading, pathHeading: this.pathHeading, settings: this.settings };
    }
    close() { clearInterval(this.timer); }
}
