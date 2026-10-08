# WMPFDebugger

The modern Windows backend in `vendor/WMPFDebugger` is vendored from
[evi0s/WMPFDebugger](https://github.com/evi0s/WMPFDebugger), commit
`832b2bb0399d81eda8bad2cea776b68444505287`.

Upstream code is licensed under GPL-2.0-only. Its license, source, attribution,
and contributor notices are preserved in the vendor directory. The files in
`src/third-party` originate from Tencent's wechatdevtools; see upstream notices.
Redistribution of covered or derived code must comply with the upstream license.

Local integration changes (2026-10-01): select the runtime PID/version supplied
by the Python launcher; bind bridge servers to loopback; use an IPv4 loopback
callback URL; bound offset detection time; report startup failures with a
nonzero exit status. Additional local compatibility changes are documented in
`docs/wechat4.md`. `package-lock.json` pins the installed Node dependency tree.
Hook initialization is acknowledged explicitly before reporting success;
runtime detachment terminates the bridge and asks the user to restart it.

Location integration (2026-10-01): `src/location.ts` and `src/location-mock.js`
add an optional JSON-configured mock for the wx location API in connected miniapp
JavaScript contexts. The bridge isolates internal CDP commands from browser
commands by remapping browser request IDs, and routes responses to their owner.
The CLI accepts `--location-file`. See `docs/location.md` for scope and limitations.

Reconnect fix: reset Runtime notifications when no working context is known,
retry initialization, update contexts independently, drop destroyed contexts,
aggregate readiness across connections, and track configuration acknowledgements
by revision. The injected heartbeat lease is now 30 seconds.

Route motion extension: `src/route-motion.ts`, `src/route-panel.ts`, and local
HTML/JavaScript assets add file import, local route rendering, motion controls,
and live samples into LocationService. These use Node built-ins and introduce
no new package dependencies. See `docs/route.md` for formats and behavior.

2026-10-03: Correct streaming location's default CRS to GCJ02 (single-shot
location keeps WGS84), activate stationary first-waypoint positioning on route
load/reset, and add path-tangent/manual compass direction with optional wx
compass API mocks and panel diagnostics. Existing route/config files are preserved.
