import { promises } from "node:fs";
import { EventEmitter } from "node:events";
import path from "node:path";
import * as frida from "frida";
import WebSocket, { WebSocketServer } from "ws";

import { platform } from "./platform";
import { parse_cli_options, CliOptions } from "./cli";
import { create_logger, Logger } from "./logger";
import { LocationService, LocationConnection } from './location';
import { startRoutePanel } from './route-panel';

const codex = require("./third-party/RemoteDebugCodex.js");
const messageProto = require("./third-party/WARemoteDebugProtobuf.js");

class DebugMessageEmitter extends EventEmitter {}

type StructOffsetConfig = {
    LaunchConfigOffsets: number[];
    RemoteDebugConfigOffsets: number[];
    SceneOffset: number;
    WebSocketURLStringOffset: number;
    RemoteDebugModeOffset: number;
}

type HookConfig = {
    Version: number;
    LoadStartHookOffset: string;
    CDPFilterHookOffset: string;
    CastToJsonHookOffset?: string;
    SceneOffsets?: number[];
    MiniAppConfigStructOffsets?: StructOffsetConfig;
};

const debugMessageEmitter = new DebugMessageEmitter();

const debugServer = (options: CliOptions, logger: Logger, location?: LocationService): WebSocketServer => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: options.debugPort });
    logger.info(`[server] debug server running on ws://127.0.0.1:${options.debugPort}`);
    logger.info('[server] debug server waiting for miniapp to connect...');
    let sequence = 0;
    const send = (ws: WebSocket, category: string, data: Record<string, unknown>) => {
        if (ws.readyState !== WebSocket.OPEN) throw new Error('miniapp disconnected');
        const wrapped = codex.wrapDebugMessageData(data, category, 0);
        const encoded = messageProto.mmbizwxadevremote.WARemoteDebug_DebugMessage.encode({
            seq: ++sequence, category, data: wrapped.buffer, compressAlgo: 0,
            originalSize: wrapped.originalSize,
        }).finish();
        ws.send(encoded, { binary: true });
    };
    wss.on('connection', (ws: WebSocket) => {
        logger.info('[miniapp] miniapp client connected');
        // Install the response listener before enabling Runtime (which emits contexts).
        let controller: LocationConnection | undefined;
        ws.on('message', (message) => {
            try {
                const decoded = messageProto.mmbizwxadevremote.WARemoteDebug_DebugMessage.decode(message);
                const unwrapped = codex.unwrapDebugMessageData(decoded);
                logger.main_debug('[miniapp]', unwrapped);
                if (!unwrapped) return;
                if (controller?.receive(unwrapped.category, unwrapped.data)) return;
                if (unwrapped.category === 'chromeDevtoolsResult') {
                    debugMessageEmitter.emit('cdpmessage', unwrapped.data.payload);
                }
            } catch (error) { logger.error('[miniapp] decode error:', error); }
        });
        ws.on('error', error => logger.error('[miniapp]', error));
        ws.on('close', () => {
            if (controller) location?.disconnect(controller);
            logger.info('[miniapp] miniapp client disconnected');
        });
        if (location) controller = location.connect((category, data) => send(ws, category, data));
    });
    debugMessageEmitter.on('proxymessage', (payload: string) => {
        for (const ws of wss.clients) {
            if (ws.readyState === WebSocket.OPEN) {
                send(ws, 'chromeDevtools', { jscontext_id: '', op_id: ++sequence, payload });
            }
        }
    });
    return wss;
};

const proxyServer = (options: CliOptions, logger: Logger): WebSocketServer => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: options.cdpPort });
    logger.info(`[server] proxy server running on ws://127.0.0.1:${options.cdpPort}`);
    logger.info(`[server] link: devtools://devtools/bundled/inspector.html?ws=127.0.0.1:${options.cdpPort}`);
    // Browser commands use positive wire IDs. Location commands use negative
    // IDs, so evaluating mocks cannot steal a DevTools response or vice versa.
    let nextId = 1;
    const pending = new Map<number, { client: WebSocket; id: number; expires: number; sessionId?: string }>();
    const sweep = setInterval(() => {
        for (const [id, request] of pending) {
            if (Date.now() < request.expires) continue;
            pending.delete(id);
            if (request.client.readyState === WebSocket.OPEN) request.client.send(JSON.stringify({
                id: request.id, error: { code: -32000, message: 'Miniapp response timed out (120s)' },
                ...(request.sessionId ? { sessionId: request.sessionId } : {}) }));
        }
    }, 5000);
    wss.on('close', () => { clearInterval(sweep); pending.clear(); });
    wss.on('connection', (ws: WebSocket) => {
        logger.info('[cdp] CDP client connected');
        ws.on('message', raw => {
            try {
                const command = JSON.parse(raw.toString());
                if (!Number.isInteger(command.id) || typeof command.method !== 'string') {
                    throw new Error('Invalid CDP command');
                }
                const wireId = nextId++;
                pending.set(wireId, { client: ws, id: command.id, expires: Date.now() + 120000,
                    sessionId: command.sessionId });
                debugMessageEmitter.emit('proxymessage', JSON.stringify({ ...command, id: wireId }));
            } catch (error) { logger.error('[cdp]', error); }
        });
        ws.on('error', error => logger.error('[cdp]', error));
        ws.on('close', () => {
            for (const [id, request] of pending) if (request.client === ws) pending.delete(id);
        });
    });
    debugMessageEmitter.on('cdpmessage', (payload: string) => {
        try {
            const message = JSON.parse(payload);
            if (typeof message.id === 'number') {
                const request = pending.get(message.id);
                if (!request) return;
                pending.delete(message.id);
                if (request.client.readyState === WebSocket.OPEN) {
                    request.client.send(JSON.stringify({ ...message, id: request.id }));
                }
            } else {
                for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(payload);
            }
        } catch (error) { logger.error('[cdp] invalid response:', error); }
    });
    return wss;
};
const autoDetectConfig = async (
    session: frida.Session,
    projectRoot: string,
    wmpfVersion: number,
): Promise<HookConfig> => {
    let detectorContent: string;
    try {
        detectorContent = (
            await promises.readFile(
                path.join(
                    projectRoot,
                    "frida/autodetect",
                    `${process.platform}.js`,
                ),
            )
        ).toString();
    } catch (e) {
        throw new Error("[frida] auto-detect script not found");
    }

    const detector = await session.createScript(detectorContent);
    let timer: ReturnType<typeof setTimeout>;
    const detectedConfig = new Promise<Omit<HookConfig, "Version">>(
        (resolve, reject) => {
            timer = setTimeout(() => reject(new Error('[frida] offset detection timed out')), 60000);
            detector.message.connect((message: frida.Message) => {
                if (message.type === "error") {
                    reject(
                        new Error(
                            `[frida] auto-detect failed: ${message.description}`,
                        ),
                    );
                    return;
                }

                const payload = message.payload as {
                    type?: string;
                    config?: Omit<HookConfig, "Version">;
                    error?: string;
                };
                if (payload.type === "wmpf-offsets" && payload.config) {
                    resolve(payload.config);
                } else if (payload.type === "wmpf-offsets-error") {
                    reject(
                        new Error(
                            `[frida] auto-detect failed: ${payload.error ?? "unknown error"}`,
                        ),
                    );
                }
            });
        },
    );

    try {
        await detector.load();
        return { Version: wmpfVersion, ...(await detectedConfig) };
    } finally {
        clearTimeout(timer!);
        await detector.unload();
    }
};

const fridaServer = async (options: CliOptions, logger: Logger): Promise<frida.Session> => {
    const localDevice = await frida.getLocalDevice();
    const { pid: wmpfPid, version: wmpfVersion } = await platform.findWmpfProcess()

    // attach to process
    const session = await localDevice.attach(wmpfPid);

    // find hook script
    const projectRoot = path.join(
        path.dirname(
            (require.main && require.main.filename) ||
                (process.mainModule && process.mainModule.filename) ||
                process.cwd(),
        ),
        "..",
    );
    let scriptContent: string | null = null;
    try {
        scriptContent = (
            await promises.readFile(path.join(projectRoot, "frida/hook.js"))
        ).toString();
    } catch (e) {
        throw new Error("[frida] hook script not found");
    }

    let configContent: string | null = null;
    if (options.autoDetect) {
        logger.info(`[frida] auto-detecting hook offsets...`);
        const config = await autoDetectConfig(session, projectRoot, wmpfVersion);
        configContent = JSON.stringify(config);
        logger.info(`[frida] detected hook offsets: ${configContent}`);
    } else {
        try {
            configContent = (
                await promises.readFile(
                    path.join(
                        projectRoot,
                        `frida/config/${process.platform}`,
                        `addresses.${wmpfVersion}.json`,
                    ),
                )
            ).toString();
            configContent = JSON.stringify(JSON.parse(configContent));
        } catch (e) {
            throw new Error(`[frida] version config not found: ${wmpfVersion}`);
        }
    }

    if (scriptContent === null || configContent === null) {
        throw new Error("[frida] unable to find hook script");
    }

    // load script
    const script = await session.createScript(
        scriptContent.replace("@@CONFIG@@", configContent),
    );
    let startupError: Error | undefined;
    let hookReady = false;
    script.message.connect((message: frida.Message) => {
        if (message.type === "error") {
            logger.error("[frida client]", message);
            startupError = new Error(message.description);
            return;
        }
        if (message.payload?.type === 'wmpf-hook-ready') hookReady = true;
        logger.frida_debug("[frida client]", message.payload);
    });
    await script.load();
    // Frida's load() also resolves when top-level JavaScript throws. Wait for
    // the explicit completion message before reporting successful injection.
    for (let attempt = 0; attempt < 100 && !hookReady && !startupError; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (startupError || !hookReady) {
        await session.detach();
        throw startupError ?? new Error('[frida] hook did not confirm initialization');
    }
    session.detached.connect(reason => {
        logger.error(`[frida] WMPF detached: ${reason}; restart the launcher to reconnect`);
        process.exit(1);
    });
    logger.info(
        `[frida] script loaded, WMPF version: ${wmpfVersion}, pid: ${wmpfPid}`,
    );
    logger.info(`[frida] you can now open any miniapps`);
    return session;
};

const main = async () => {
    const options = parse_cli_options();
    const logger = create_logger(options);
    if (options.panel && (options.panelPort === options.debugPort || options.panelPort === options.cdpPort)) {
        throw new Error('面板端口不可与 debug-port / cdp-port 重复');
    }
    // Keep execution-context discovery active for the injected page badge even
    // when no location configuration or motion panel was requested.
    const location = await LocationService.create(options.locationFile, logger);
    const panel = options.panel ? await startRoutePanel(location!, options.panelPort, logger, options.routeFile) : undefined;
    if (options.panelOnly) {
        logger.info('[route] 独立预览模式，不连接微信。需要注入时用 main.py -x --panel。');
        process.on('SIGINT', () => { panel?.close(); location?.close(); process.exit(0); });
        return;
    }
    const debugWss = debugServer(options, logger, location);
    const proxyWss = proxyServer(options, logger);
    const fridaSession = await fridaServer(options, logger);

    process.on("SIGINT", async () => {
        logger.info("[server] shutting down...");
        location?.close();
        panel?.close();
        debugWss.close();
        proxyWss.close();
        await fridaSession.detach();
        process.exit(0);
    });
};

main().catch(error => {
    console.error(error);
    process.exit(1);
});

