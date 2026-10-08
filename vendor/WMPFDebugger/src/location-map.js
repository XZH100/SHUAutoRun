/* WMPF's desktop wx-map uses a TMap DOMOverlay for show-location.
 * Adapter shape verified on the connected WMPF 25773 map. Do not guess native
 * map APIs or change page markers/polylines when this shape is unavailable. */
(function installMapLocation(source) {
    'use strict';
    const entries = new Map();
    let disposed = false, nextScan = 0;
    let status = { detected: 0, updated: 0, heading: 0, unsupported: 0, error: '' };
    const doc = typeof document === 'object' ? document : null;
    const sdk = () => globalThis.TMap;
    function patch(object, name, implementation) {
        const original = object[name], descriptor = Object.getOwnPropertyDescriptor(object, name);
        const wrapper = implementation(original);
        Object.defineProperty(object, name, { configurable: true, writable: true,
            enumerable: descriptor ? descriptor.enumerable : false, value: wrapper });
        return () => {
            if (object[name] !== wrapper) return;
            if (descriptor) Object.defineProperty(object, name, descriptor);
            else delete object[name];
        };
    }
    function latLng() {
        const p = source.position();
        return new (sdk().LatLng)(p.latitude, p.longitude);
    }
    function drawHeading(binding) {
        const { marker, arrow } = binding;
        const heading = source.heading();
        if (!Number.isFinite(heading) || !marker.map) { arrow.hidden = true; return; }
        const p = marker.position, rad = heading * Math.PI / 180;
        // Project a short geographic tangent so rotation AND map tilt are
        // accounted for. Never replace the overlay's translate3d transform.
        const ahead = new (sdk().LatLng)(p.getLat() + Math.cos(rad) * 10 / 111195,
            p.getLng() + Math.sin(rad) * 10 / (111195 * Math.max(.001, Math.cos(p.getLat() * Math.PI / 180))));
        const a = marker.map.projectToContainer(p), b = marker.map.projectToContainer(ahead);
        const angle = Math.atan2(b.getX() - a.getX(), a.getY() - b.getY()) * 180 / Math.PI;
        arrow.style.transform = `rotate(${angle}deg)`;
        arrow.hidden = false;
    }
    function releaseMarker(entry) {
        const binding = entry.binding;
        if (!binding) return;
        entry.binding = null;
        binding.arrow.remove();
        binding.restore();
        if (binding.marker.position === binding.assigned) {
            binding.marker.position = binding.originalPosition;
            if (binding.marker.map) binding.marker.updateDOM();
        }
    }
    function release(entry) {
        try { releaseMarker(entry); } catch (_) { /* Map may already be destroyed. */ }
        for (const restore of entry.restores.reverse()) {
            try { restore(); } catch (_) { /* Component may have been frozen. */ }
        }
    }
    function attach(node, component) {
        const entry = { node, component, restores: [], binding: null };
        try {
            entry.restores.push(patch(component, 'getLocation', original => function (options = {}) {
                if (disposed || !source.active()) return Reflect.apply(original, this, arguments);
                const self = this, args = arguments;
                setTimeout(() => {
                    if (disposed || !source.active()) { Reflect.apply(original, self, args); return; }
                    if (typeof options.success === 'function') options.success(latLng());
                }, 0);
            }));
            // The stock marker click closure captures its INITIAL location.
            // Keep anchorpointtap consistent with the moving blue dot too.
            if (typeof component.triggerEvent === 'function') {
                entry.restores.push(patch(component, 'triggerEvent', original => function (name, detail, ...rest) {
                    if (name === 'anchorpointtap' && !disposed && source.active()) {
                        const p = source.position();
                        detail = { ...detail, latitude: p.latitude, longitude: p.longitude };
                    }
                    return Reflect.apply(original, this, [name, detail, ...rest]);
                }));
            }
            entries.set(node, entry);
        } catch (error) { release(entry); throw error; }
    }
    function bindMarker(entry, marker) {
        releaseMarker(entry);
        const arrow = doc.createElement('div');
        arrow.setAttribute('data-wmpf-heading', '');
        arrow.setAttribute('aria-hidden', 'true');
        arrow.style.cssText = 'position:absolute;inset:0;pointer-events:none;transform-origin:50% 50%;';
        const tip = doc.createElement('div');
        tip.style.cssText = 'position:absolute;left:50%;top:-9px;margin-left:-6px;width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:11px solid rgb(31,154,228);';
        arrow.appendChild(tip);
        const binding = { marker, arrow, dom: marker.dom, originalPosition: marker.position,
            assigned: null, error: '', restore: () => {} };
        binding.restore = patch(marker, 'updateDOM', original => function (...args) {
            const result = Reflect.apply(original, this, args);
            if (!disposed) {
                try { drawHeading(binding); binding.error = ''; }
                catch (error) { arrow.hidden = true; binding.error = String(error); }
            }
            return result;
        });
        entry.binding = binding;
        marker.dom.appendChild(arrow);
    }
    function refresh() {
        if (disposed || !doc || !source.active()) return;
        const current = { detected: status.detected, updated: 0, heading: 0, unsupported: status.unsupported, error: '' };
        if (Date.now() >= nextScan) {
            nextScan = Date.now() + 1000;
            const nodes = [...doc.querySelectorAll('wx-map')];
            current.detected = nodes.length; current.unsupported = 0;
            for (const [node, entry] of entries) {
                if (!node.isConnected || node.__wxElement !== entry.component) {
                    release(entry); entries.delete(node);
                }
            }
            for (const node of nodes) {
                if (entries.has(node)) continue;
                const component = node.__wxElement;
                if (!component || typeof component.getLocation !== 'function' || !component.data ||
                    typeof sdk()?.LatLng !== 'function') { current.unsupported++; continue; }
                try { attach(node, component); }
                catch (error) { current.error = String(error); current.unsupported++; }
            }
        }
        for (const entry of entries.values()) {
            try {
                const marker = entry.component.data.locationMarker;
                if (entry.binding && (entry.binding.marker !== marker || entry.binding.dom !== marker?.dom)) releaseMarker(entry);
                if (!marker?.map || !marker.dom?.isConnected || typeof marker.updateDOM !== 'function' ||
                    typeof marker.map.projectToContainer !== 'function' || !marker.position) continue;
                if (!entry.binding) bindMarker(entry, marker);
                const binding = entry.binding, p = source.position();
                if (marker.position.getLat() !== p.latitude || marker.position.getLng() !== p.longitude) {
                    binding.assigned = latLng(); marker.position = binding.assigned;
                }
                marker.updateDOM();
                current.updated++;
                if (binding.error) current.error = binding.error;
                if (!binding.arrow.hidden && binding.arrow.isConnected) current.heading++;
            } catch (error) { current.error = String(error); }
        }
        status = current;
    }
    const timer = doc ? setInterval(refresh, 200) : null;
    return {
        refresh,
        report: () => ({ ...status }),
        dispose: () => {
            disposed = true;
            clearInterval(timer);
            entries.forEach(release); entries.clear();
        }
    };
})
