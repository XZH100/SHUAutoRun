import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Logger } from './logger';
import type { MotionSample } from './route-motion';

export type LocationConfig = {
    enabled: boolean; latitude: number; longitude: number;
    coordinateSystem: 'wgs84' | 'gcj02'; accuracy: number; altitude: number; speed: number;
    heading?: number;
};

export function parseLocationConfig(raw: string): LocationConfig {
    const c = JSON.parse(raw.replace(/^\uFEFF/, ''));
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('配置必须是 JSON 对象');
    if (typeof c.enabled !== 'boolean') throw new Error('enabled 必须是 true 或 false');
    const number = (key: string, low: number, high: number, fallback?: number) => {
        const value = c[key] === undefined ? fallback : c[key];
        if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high) {
            throw new Error(`${key} 必须是 ${low} 到 ${high} 之间的数值`);
        }
        return value;
    };
    if (!c.enabled) return { enabled: false, latitude: 0, longitude: 0,
        coordinateSystem: 'wgs84', accuracy: 10, altitude: 0, speed: 0 };
    if (!['wgs84', 'gcj02'].includes(c.coordinateSystem)) throw new Error('coordinateSystem 必须为 wgs84 或 gcj02');
    return { enabled: true, latitude: number('latitude', -90, 90), longitude: number('longitude', -180, 180),
        coordinateSystem: c.coordinateSystem, accuracy: number('accuracy', 0, 1e7, 10),
        altitude: number('altitude', -12000, 100000, 0), speed: number('speed', 0, 100000, 0),
        ...(c.heading !== undefined ? { heading: number('heading', 0, 360) % 360 } : {}) };
}

type Send = (category: string, data: Record<string, unknown>) => void;
type MapStatus = { detected: number; updated: number; heading: number; unsupported: number; error: string };
type Scope = { id?: number; name: string; busy: boolean; nextProbe: number;
    status: string; lastMessage: string; confirmedAt: number; revision: number; compass: boolean;
    maps?: MapStatus; mapMessage: string; compassListeners: number };
type Channel = { js: string; session?: string; parent?: Channel; contexts: Map<number | undefined, Scope>;
    initBusy: boolean; nextInit: number; autoAttached: boolean };
type Pending = { channel: Channel; resolve: (value: any) => void; reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout> };

// Track readiness per live context, rather than permanently per websocket.
export class LocationConnection {
    private channels = new Map<string, Channel>();
    private pending = new Map<number, Pending>();
    private nextId = -1;
    private closed = false;
    constructor(private service: LocationService, private send: Send, private logger: Logger,
        readonly id: number) { this.openChannel(''); }
    private key(js: string, session?: string) { return JSON.stringify([js, session || '']); }
    private scope(id?: number, name = 'default'): Scope {
        return { id, name, busy: false, nextProbe: 0, status: 'pending', lastMessage: '', confirmedAt: 0, revision: 0,
            compass: false, mapMessage: '', compassListeners: 0 };
    }
    private live(channel: Channel, scope?: Scope) {
        return !this.closed && this.channels.get(this.key(channel.js, channel.session)) === channel &&
            (!scope || channel.contexts.get(scope.id) === scope);
    }
    private request(channel: Channel, method: string, params: Record<string, unknown> = {}): Promise<any> {
        if (!this.live(channel)) return Promise.reject(new Error('execution context disconnected'));
        const id = this.nextId--;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id); reject(new Error(`${method}: 5 秒内未收到响应`));
            }, 5000);
            this.pending.set(id, { channel, resolve, reject, timer });
            try {
                this.send('chromeDevtools', { jscontext_id: channel.js, op_id: Math.abs(id),
                    payload: JSON.stringify({ id, method, params, ...(channel.session ? { sessionId: channel.session } : {}) }) });
            } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
        });
    }
    private openChannel(js: string, session?: string, parent?: Channel): Channel {
        const key = this.key(js, session);
        const existing = this.channels.get(key);
        if (existing) return existing;
        const channel: Channel = { js, session, parent, contexts: new Map([[undefined, this.scope()]]),
            initBusy: false, nextInit: 0, autoAttached: false };
        this.channels.set(key, channel);
        void this.initialize(channel);
        return channel;
    }
    private async initialize(channel: Channel) {
        if (!this.live(channel) || channel.initBusy || Date.now() < channel.nextInit) return;
        channel.initBusy = true;
        channel.nextInit = Date.now() + 10000;
        try {
            // A websocket reconnect can retain WMPF's underlying CDP session.
            // Runtime.enable is idempotent and need not replay existing contexts.
            // Reset notifications if no working context is known.
            const working = [...channel.contexts.values()].some(s => ['installed', 'disabled'].includes(s.status) &&
                Date.now() - s.confirmedAt < 10000);
            if (!working) {
                this.logger.frida_debug(`[location] 连接 ${this.id} 重新枚举执行环境 ${this.key(channel.js, channel.session)}`);
                await this.request(channel, 'Runtime.disable');
                if (!this.live(channel)) return;
                channel.contexts.clear();
                channel.contexts.set(undefined, this.scope());
            }
            await this.request(channel, 'Runtime.enable');
            if (!this.live(channel)) return;
            for (const scope of channel.contexts.values()) void this.apply(channel, scope);
            if (!channel.autoAttached) {
                await this.request(channel, 'Target.setAutoAttach', { autoAttach: true,
                    waitForDebuggerOnStart: false, flatten: true });
                channel.autoAttached = true;
            }
        } catch (error) {
            this.logger.frida_debug(`[location] 连接 ${this.id} 初始化/相关目标发现将重试: ${String(error)}`);
        } finally { channel.initBusy = false; }
    }
    private remove(channel: Channel) {
        for (const child of [...this.channels.values()]) if (child.parent === channel) this.remove(child);
        this.channels.delete(this.key(channel.js, channel.session));
        channel.contexts.clear();
        for (const [id, pending] of this.pending) {
            if (pending.channel !== channel) continue;
            clearTimeout(pending.timer); this.pending.delete(id);
            pending.reject(new Error('execution context disconnected'));
        }
    }
    receive(category: string, data: any): boolean {
        if (this.closed) return false;
        if (category === 'addJsContext' && data.jscontext_id) {
            this.send('connectJsContext', { jscontext_id: data.jscontext_id });
            this.openChannel(String(data.jscontext_id));
        }
        if (category === 'removeJsContext') {
            for (const c of [...this.channels.values()]) if (c.js === String(data.jscontext_id)) this.remove(c);
        }
        if (category !== 'chromeDevtoolsResult') return false;
        let message: any;
        try { message = JSON.parse(data.payload); } catch (_) { return false; }
        const js = String(data.jscontext_id || '');
        // Some WMPF builds advertise a JS context only in CDP envelopes, without
        // a separate addJsContext notification. Do not discard those events.
        if (js && !message.sessionId && !this.channels.has(this.key(js))) this.openChannel(js);
        if (typeof message.id === 'number' && message.id < 0) {
            const pending = this.pending.get(message.id);
            if (pending) {
                clearTimeout(pending.timer); this.pending.delete(message.id);
                if (message.error) pending.reject(new Error(message.error.message));
                else pending.resolve(message.result);
            }
            return true;
        }
        const channel = this.channels.get(this.key(js, message.sessionId));
        if (message.method === 'Target.attachedToTarget') this.openChannel(js, message.params.sessionId, channel);
        if (message.method === 'Target.detachedFromTarget') {
            const child = this.channels.get(this.key(js, message.params.sessionId));
            if (child) this.remove(child);
        }
        if (!channel) return false;
        if (message.method === 'Runtime.executionContextCreated') {
            const context = message.params.context;
            // A resync replays existing contexts; retain working mocks/listeners.
            channel.contexts.delete(undefined);
            let scope = channel.contexts.get(context.id);
            if (!scope) {
                scope = this.scope(context.id, context.name || context.auxData?.type || 'unnamed');
                channel.contexts.set(context.id, scope);
            }
            void this.apply(channel, scope);
        }
        if (message.method === 'Runtime.executionContextDestroyed') {
            channel.contexts.delete(message.params.executionContextId);
            channel.nextInit = 0;
        }
        if (message.method === 'Runtime.executionContextsCleared') {
            channel.contexts.clear();
            channel.contexts.set(undefined, this.scope());
            channel.nextInit = 0;
        }
        return false;
    }
    private async apply(channel: Channel, scope: Scope) {
        if (!this.live(channel, scope) || scope.busy || Date.now() < scope.nextProbe) return;
        scope.busy = true;
        const revision = this.service.revision;
        const label = `连接 ${this.id} / ${scope.name} / ${this.key(channel.js, channel.session)}:${scope.id ?? 'default'}`;
        try {
            const reply = await this.request(channel, 'Runtime.evaluate', {
                expression: this.service.expression(), returnByValue: true, silent: true,
                ...(scope.id !== undefined ? { contextId: scope.id } : {}) });
            if (!this.live(channel, scope)) return;
            const result = reply?.result?.value;
            if (reply?.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text || '执行失败');
            if (!result || !['installed', 'disabled', 'waiting-for-wx', 'failed'].includes(result.status)) {
                throw new Error('执行环境未返回模拟位置状态');
            }
            scope.status = result.status;
            scope.compass = result.status === 'installed' && result.methods?.includes('onCompassChange');
            scope.compassListeners = result.compassListeners || 0;
            scope.maps = result.status === 'installed' ? result.maps : undefined;
            scope.revision = revision;
            if (result.status === 'installed' || result.status === 'disabled') scope.confirmedAt = Date.now();
            scope.nextProbe = Date.now() + (result.status === 'waiting-for-wx' ? 4000 : 1000);
            const mapMessage = JSON.stringify(scope.maps || {});
            if (scope.mapMessage !== mapMessage) {
                scope.mapMessage = mapMessage;
                const maps = scope.maps;
                if (maps?.detected) this.logger.info(`[location-map] ${label}: 地图=${maps.detected}，蓝点同步=${maps.updated}，朝向箭头=${maps.heading}，不兼容=${maps.unsupported}`);
                if (maps?.error) this.logger.error(`[location-map] ${label}: ${maps.error}`);
            }
            const status = this.service.motionMode ? JSON.stringify({ revision, status: result.status, methods: result.methods, warnings: result.warnings }) : JSON.stringify({ revision, ...result });
            if (scope.lastMessage !== status) {
                scope.lastMessage = status;
                if (result.status === 'installed') this.logger.info(
                    `[location] 已生效 配置 #${revision} ${label}: ${result.latitude}, ${result.longitude} (${result.coordinateSystem}); ${result.methods.join(', ')}`);
                else if (result.status === 'failed') this.logger.error(`[location] 安装失败 ${label}: ${result.error}`);
                else if (result.status === 'disabled') this.logger.info(`[location] 已关闭 配置 #${revision} ${label}`);
                else this.logger.frida_debug(`[location] 无 wx 定位接口 ${label}: ${JSON.stringify(result.diagnostic)}`);
                for (const warning of result.warnings || []) this.logger.error(`[location] ${label}: ${warning}`);
            }
        } catch (error) {
            if (!this.live(channel, scope)) return;
            scope.status = 'error'; scope.nextProbe = Date.now() + 4000;
            const text = String(error);
            if (scope.lastMessage !== text) {
                scope.lastMessage = text; this.logger.error(`[location] ${label}: ${text}`);
            }
            // A missed destroy event must not leave a dead context in the probe
            // list forever. Runtime.enable will enumerate the current contexts.
            if (/Cannot find context|Cannot find execution context|Execution context was destroyed/i.test(text)) {
                channel.contexts.delete(scope.id); channel.nextInit = 0;
            }
        } finally {
            scope.busy = false;
            // Do not acknowledge an old in-flight evaluation as a newer edit.
            if (this.live(channel, scope) && revision !== this.service.revision) {
                scope.nextProbe = 0; void this.apply(channel, scope);
            }
        }
    }
    refresh() {
        for (const channel of this.channels.values()) {
            void this.initialize(channel);
            // Independent requests keep a slow render context from starving the
            // working service context's heartbeat/configuration updates.
            for (const scope of channel.contexts.values()) {
                if (scope.revision !== this.service.revision) scope.nextProbe = 0;
                void this.apply(channel, scope);
            }
        }
    }
    summary() {
        const scopes = [...this.channels.values()].flatMap(c => [...c.contexts.values()]);
        const current = scopes.filter(s => s.status === 'installed' && s.revision === this.service.revision &&
            Date.now() - s.confirmedAt < 10000);
        return {
            scopes: scopes.length,
            waiting: scopes.filter(s => s.status === 'waiting-for-wx').length,
            errors: scopes.filter(s => s.status === 'error' || s.status === 'failed').length,
            current: current.length,
            compass: current.filter(s => s.compass).length,
            compassListeners: current.reduce((n, s) => n + s.compassListeners, 0),
            maps: current.reduce((n, s) => n + (s.maps?.detected || 0), 0),
            mapUpdated: current.reduce((n, s) => n + (s.maps?.updated || 0), 0),
            mapHeading: current.reduce((n, s) => n + (s.maps?.heading || 0), 0),
            mapErrors: [...new Set(current.map(s => s.maps?.error).filter(Boolean))],
            mapUnsupported: current.reduce((n, s) => n + (s.maps?.unsupported || 0), 0),
        };
    }
    close() {
        this.closed = true;
        for (const channel of [...this.channels.values()]) this.remove(channel);
    }
}
export class LocationService {
    private motionConfig?: LocationConfig;
    public motionMode = false;
    get config() { return this.motionConfig ?? this.baseConfig; }
    public revision = 1;
    private nextConnection = 1;
    private warningAfter = Date.now() + 15000;
    private lastSummary = '';
    private connections = new Set<LocationConnection>();
    private timer?: ReturnType<typeof setInterval>;
    private reading = false;
    private lastError = '';
    private raw: string;
    private constructor(private file: string | undefined, private baseConfig: LocationConfig,
        private source: string, private mapSource: string, private badgeSource: string,
        private logger: Logger, raw: string) { this.raw = raw; }
    static async create(file: string | undefined, logger: Logger) {
        const absolute = file ? path.resolve(file) : undefined;
        const raw = absolute ? await fs.readFile(absolute, 'utf8') : '{"enabled":false}';
        const service = new LocationService(absolute, parseLocationConfig(raw),
            await fs.readFile(path.join(__dirname, 'location-mock.js'), 'utf8'),
            await fs.readFile(path.join(__dirname, 'location-map.js'), 'utf8'),
            await fs.readFile(path.join(__dirname, 'control-badge.js'), 'utf8'), logger, raw);
        logger.info(`[location] 配置: ${absolute || '定位默认关闭，可由路径面板启用'}；等待小程序连接`);
        service.timer = setInterval(() => void service.reload(), 2000);
        return service;
    }
    expression() {
        // Badge failure must not prevent location injection in an isolated frame.
        return `try { ${this.badgeSource.trim()}(); } catch (_) {}\n` +
            `${this.source.trim()}(${JSON.stringify(this.config)}, ${this.mapSource.trim()})`;
    }
    setMotion(sample: MotionSample) {
        const changedMode = !this.motionMode || this.motionConfig?.enabled !== sample.enabled;
        this.motionMode = true;
        this.motionConfig = { ...this.baseConfig, ...sample, accuracy: this.baseConfig.accuracy };
        if (changedMode) this.revision++;
        // Coordinates are live samples of one configuration, not a new config
        // revision every second. Keep logs/readiness usable during movement.
        for (const connection of this.connections) connection.refresh();
    }
    status() {
        const summaries = [...this.connections].map(c => c.summary());
        return { connections: this.connections.size,
            confirmed: summaries.reduce((n, s) => n+s.current, 0), enabled: this.config.enabled,
            compassConfirmed: summaries.reduce((n, s) => n+s.compass, 0),
            compassListeners: summaries.reduce((n, s) => n+s.compassListeners, 0),
            maps: { detected: summaries.reduce((n, s) => n+s.maps, 0),
                updated: summaries.reduce((n, s) => n+s.mapUpdated, 0),
                heading: summaries.reduce((n, s) => n+s.mapHeading, 0),
                unsupported: summaries.reduce((n, s) => n+s.mapUnsupported, 0),
                errors: [...new Set(summaries.flatMap(s => s.mapErrors))] },
            config: this.config, revision: this.revision };
    }
    connect(send: Send) {
        const connection = new LocationConnection(this, send, this.logger, this.nextConnection++);
        this.connections.add(connection);
        return connection;
    }
    disconnect(connection: LocationConnection) { connection.close(); this.connections.delete(connection); }
    private async reload() {
        if (this.reading) return;
        this.reading = true;
        try {
            const raw = this.file ? await fs.readFile(this.file, 'utf8') : this.raw;
            if (raw !== this.raw) {
                const config = parseLocationConfig(raw);
                this.baseConfig = config; this.raw = raw;
                this.revision++;
                this.warningAfter = Date.now() + 10000;
                this.lastSummary = '';
                this.logger.info(`[location] 配置 #${this.revision} 已读取，等待执行环境确认: ${config.enabled ?
                    `${config.latitude}, ${config.longitude} (${config.coordinateSystem})` : '关闭'}`);
            }
            this.lastError = '';
        } catch (error) {
            const message = String(error);
            if (this.lastError !== message) this.logger.error(`[location] 配置读取失败，保留上次有效配置: ${message}`);
            this.lastError = message;
        } finally {
            for (const connection of this.connections) connection.refresh();
            this.reportReadiness();
            this.reading = false;
        }
    }
    private reportReadiness() {
        if (!this.config.enabled) return;
        const summaries = [...this.connections].map(c => c.summary());
        const current = summaries.reduce((n, s) => n + s.current, 0);
        if (current) {
            this.lastSummary = '';
            this.warningAfter = Date.now() + 15000;
            return;
        }
        if (Date.now() < this.warningAfter) return;
        const counts = {
            connections: this.connections.size,
            scopes: summaries.reduce((n, s) => n + s.scopes, 0),
            waiting: summaries.reduce((n, s) => n + s.waiting, 0),
            errors: summaries.reduce((n, s) => n + s.errors, 0),
        };
        const status = JSON.stringify(counts);
        if (this.lastSummary === status) return;
        this.lastSummary = status;
        this.warningAfter = Date.now() + 15000;
        this.logger.error(`[location] 配置 #${this.revision} 尚无执行环境确认：连接=${counts.connections}，环境=${counts.scopes}，无 wx=${counts.waiting}，错误=${counts.errors}。` +
            (counts.connections ? '将继续重试；请提供 --debug 下的 [location] 日志以定位逻辑环境。' : '请重新打开目标小程序以连接调试服务。'));
    }
    close() {
        clearInterval(this.timer);
        for (const connection of this.connections) connection.close();
        this.connections.clear();
    }
}

