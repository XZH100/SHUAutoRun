/* Shared by the render frames; independent of motion/location enablement. */
(function installControlBadge() {
    'use strict';
    if (typeof document !== 'object') return;
    let host = globalThis;
    try { if (globalThis.top?.document) host = globalThis.top; } catch (_) { /* Isolated frame. */ }
    const key = '__shuAutoRunControlBadge_v1__';
    if (host[key]) {
        host[key].deadline = Date.now() + 30000;
        host[key].refresh();
        return;
    }
    const doc = host.document, badge = doc.createElement('div');
    badge.textContent = 'SHUAutoRun\ncontrolled';
    const styles = {
        all: 'initial', position: 'fixed', right: '10px', bottom: '10px',
        'z-index': '2147483647', color: '#1677ff', 'font-family': 'Arial, sans-serif',
        'font-size': '11px', 'line-height': '14px', 'font-weight': '400',
        'white-space': 'pre', 'text-align': 'right', 'pointer-events': 'none',
        'user-select': 'none', display: 'block', opacity: '1', visibility: 'visible'
    };
    for (const [name, value] of Object.entries(styles)) badge.style.setProperty(name, value, 'important');
    const state = {
        deadline: Date.now() + 30000,
        refresh() {
            if (Date.now() > state.deadline) {
                host.clearInterval(state.timer);
                badge.remove();
                if (host[key] === state) delete host[key];
                return;
            }
            if (!badge.isConnected && doc.body) doc.body.appendChild(badge);
        }
    };
    host[key] = state;
    state.timer = host.setInterval(() => state.refresh(), 2000);
    state.refresh();
})
