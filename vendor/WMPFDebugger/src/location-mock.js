/* Injected into the miniapp JS context, never into the host Node process. */
(function installLocation(config, installMapLocation) {
    'use strict';
    const root = globalThis;
    const key = '__wmpfLocationMock_v1__';
    const previous = root[key];
    if (!config.enabled) {
        if (previous) previous.dispose();
        return { status: 'disabled' };
    }
    const api = typeof wx !== 'undefined' ? wx : root.wx;
    if (!api || !['getLocation', 'getFuzzyLocation'].some(name => typeof api[name] === 'function')) {
        return { status: 'waiting-for-wx', diagnostic: {
            wxType: typeof api,
            getLocation: api ? typeof api.getLocation : 'undefined',
            getFuzzyLocation: api ? typeof api.getFuzzyLocation : 'undefined',
            hasDocument: typeof document !== 'undefined',
            hasWeixinJSBridge: typeof WeixinJSBridge !== 'undefined',
        } };
    }
    const compassAvailable = ['startCompass', 'stopCompass', 'onCompassChange', 'offCompassChange']
        .every(name => typeof api[name] === 'function');
    if (previous && previous.version === 3 && previous.api === api && previous.intact() &&
        previous.compassAvailable === compassAvailable &&
        previous.compassRequested === Number.isFinite(config.heading)) {
        previous.config = config;
        previous.deadline = Date.now() + 30000;
        previous.maps.refresh();
        return previous.report();
    }
    if (previous) previous.dispose();

    // Standard mainland-China WGS84 -> GCJ02 transform; inverse solved iteratively.
    function toGCJ(lat, lon) {
        if (lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271) return [lat, lon];
        const x = lon - 105, y = lat - 35, pi = Math.PI;
        let dy = -100 + 2*x + 3*y + .2*y*y + .1*x*y + .2*Math.sqrt(Math.abs(x));
        let dx = 300 + x + 2*y + .1*x*x + .1*x*y + .1*Math.sqrt(Math.abs(x));
        const wave = (20*Math.sin(6*x*pi) + 20*Math.sin(2*x*pi))*2/3;
        dy += wave + (20*Math.sin(y*pi) + 40*Math.sin(y*pi/3))*2/3
            + (160*Math.sin(y*pi/12) + 320*Math.sin(y*pi/30))*2/3;
        dx += wave + (20*Math.sin(x*pi) + 40*Math.sin(x*pi/3))*2/3
            + (150*Math.sin(x*pi/12) + 300*Math.sin(x*pi/30))*2/3;
        const rad = lat*pi/180, magic = 1 - .00669342162296594323*Math.sin(rad)**2;
        dy = dy*180/((6378245*(1-.00669342162296594323))/(magic*Math.sqrt(magic))*pi);
        dx = dx*180/(6378245/Math.sqrt(magic)*Math.cos(rad)*pi);
        return [lat+dy, lon+dx];
    }
    function coordinates(type) {
        const c = state.config;
        if (type === c.coordinateSystem) return [c.latitude, c.longitude];
        if (type === 'gcj02') return toGCJ(c.latitude, c.longitude);
        let lat = c.latitude, lon = c.longitude;
        for (let i = 0; i < 8; i++) {
            const converted = toGCJ(lat, lon);
            lat -= converted[0] - c.latitude;
            lon -= converted[1] - c.longitude;
        }
        return [lat, lon];
    }
    function position(type = 'wgs84') {
        const [latitude, longitude] = coordinates(type);
        const c = state.config;
        return { latitude, longitude, accuracy: c.accuracy, altitude: c.altitude,
            speed: c.speed, horizontalAccuracy: c.accuracy, verticalAccuracy: c.accuracy };
    }
    const records = [];
    const listeners = new Set();
    const compassListeners = new Set();
    const warnings = [];
    const restore = r => {
        if (api[r.name] !== r.wrapper) return;
        try {
            if (r.descriptor) Object.defineProperty(api, r.name, r.descriptor);
            else delete api[r.name];
        } catch (_) { /* The app may freeze an API after injection. */ }
    };
    const state = {
        version: 3, api, config, deadline: Date.now() + 30000, running: false, type: 'gcj02',
        compassAvailable,
        compassRequested: Number.isFinite(config.heading), compassRunning: false,
        report: () => ({ status: 'installed', methods: records.map(r => r.name),
            latitude: state.config.latitude, longitude: state.config.longitude,
            coordinateSystem: state.config.coordinateSystem, heading: state.config.heading,
            maps: state.maps ? state.maps.report() : null,
            compassListeners: compassListeners.size,
            compass: !state.compassRequested ? 'not-requested' : compassAvailable ? 'supported' :
                typeof document === 'object' ? 'render-context' : 'unsupported',
            warnings }),
        intact: () => records.every(r => api[r.name] === r.wrapper),
        dispose: () => {
            clearInterval(state.timer);
            clearInterval(state.compassTimer);
            if (state.maps) state.maps.dispose();
            listeners.clear();
            compassListeners.clear();
            records.forEach(restore);
            if (root[key] === state) delete root[key];
        }
    };
    function active() {
        if (root[key] === state && Date.now() <= state.deadline) return true;
        state.dispose();
        return false;
    }
    function deliver(options, result, ok) {
        const callback = ok ? options.success : options.fail;
        try { if (typeof callback === 'function') callback(result); }
        finally { if (typeof options.complete === 'function') options.complete(result); }
    }
    function asyncResult(name, options, value, ok = true) {
        const result = { ...value, errMsg: name + (ok ? ':ok' : ':fail invalid coordinate type') };
        if (['success', 'fail', 'complete'].some(k => typeof options[k] === 'function')) {
            setTimeout(() => deliver(options, result, ok), 0);
            return;
        }
        return ok ? Promise.resolve(result) : Promise.reject(result);
    }
    function replace(name, implementation) {
        if (typeof api[name] !== 'function') return;
        const original = api[name];
        const descriptor = Object.getOwnPropertyDescriptor(api, name);
        const wrapper = function (...args) {
            if (!active()) return Reflect.apply(original, this, args);
            return implementation.apply(this, args);
        };
        try {
            if (descriptor && !descriptor.configurable) {
                if (!descriptor.writable) throw new Error('read-only');
                api[name] = wrapper;
            } else {
                Object.defineProperty(api, name, { configurable: true, enumerable: descriptor ? descriptor.enumerable : true,
                    writable: true, value: wrapper });
            }
            if (api[name] !== wrapper) throw new Error('replacement rejected');
            records.push({ name, original, descriptor, wrapper });
        } catch (error) {
            throw new Error(name + ': ' + String(error));
        }
    }
    root[key] = state;
    try {
        for (const name of ['getLocation', 'getFuzzyLocation']) {
            replace(name, function (options = {}) {
                const type = options.type || 'wgs84';
                if (!['wgs84', 'gcj02'].includes(type)) return asyncResult(name, options, {}, false);
                return asyncResult(name, options, position(type));
            });
        }
        // Only install the stream as a complete group so native and mocked
        // listener registrations never get mixed within a newly opened app.
        if (['startLocationUpdate', 'stopLocationUpdate', 'onLocationChange', 'offLocationChange']
            .every(name => typeof api[name] === 'function')) {
            for (const name of ['startLocationUpdate', 'startLocationUpdateBackground']) {
                replace(name, function (options = {}) {
                    // These streaming APIs default to GCJ02, unlike getLocation.
                    // Using WGS84 here moves Shanghai fixes ~485 m northwest
                    // when the consumer plots the returned values as GCJ02.
                    const type = options.type || 'gcj02';
                    if (!['wgs84', 'gcj02'].includes(type)) return asyncResult(name, options, {}, false);
                    state.type = type;
                    state.running = true;
                    return asyncResult(name, options, {});
                });
            }
            replace('stopLocationUpdate', function (options = {}) {
                state.running = false;
                return asyncResult('stopLocationUpdate', options, {});
            });
            replace('onLocationChange', function (callback) {
                if (typeof callback === 'function') listeners.add(callback);
            });
            replace('offLocationChange', function (callback) {
                if (callback === undefined) listeners.clear();
                else listeners.delete(callback);
            });
        }
        if (state.compassRequested && (compassAvailable || typeof document !== 'object')) {
            const compassStart = records.length;
            try {
                if (!compassAvailable) throw new Error('当前环境未提供完整罗盘接口');
                replace('startCompass', function (options = {}) {
                    state.compassRunning = true;
                    return asyncResult('startCompass', options, {});
                });
                replace('stopCompass', function (options = {}) {
                    state.compassRunning = false;
                    return asyncResult('stopCompass', options, {});
                });
                replace('onCompassChange', function (callback) {
                    if (typeof callback === 'function') {
                        compassListeners.add(callback);
                        state.compassRunning = true;
                    }
                });
                replace('offCompassChange', function (callback) {
                    if (callback === undefined) compassListeners.clear();
                    else compassListeners.delete(callback);
                });
                state.compassTimer = setInterval(() => {
                    if (!active() || !state.compassRunning) return;
                    const direction = ((state.config.heading % 360) + 360) % 360;
                    compassListeners.forEach(callback => {
                        try { callback({ direction, accuracy: 'high' }); }
                        catch (error) { console.error('[location] compass listener failed', error); }
                    });
                }, 200);
            } catch (error) {
                // Optional compass support must not break working location APIs.
                records.splice(compassStart).forEach(restore);
                warnings.push('罗盘未模拟: ' + String(error));
            }
        }
        state.timer = setInterval(() => {
            if (!active() || !state.running) return;
            listeners.forEach(callback => {
                try { callback(position(state.type)); }
                catch (error) { console.error('[location] listener failed', error); }
            });
        }, 1000);
        try {
            state.maps = installMapLocation({ position: () => position('gcj02'),
                heading: () => state.config.heading, active });
            state.maps.refresh();
        } catch (error) {
            if (state.maps) state.maps.dispose();
            warnings.push('地图未适配: ' + String(error));
            state.maps = { refresh() {}, dispose() {}, report: () => null };
        }
        return state.report();
    } catch (error) {
        state.dispose();
        return { status: 'failed', error: String(error) };
    }
})
