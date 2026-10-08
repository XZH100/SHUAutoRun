import { parseArgs } from "node:util";

type CliOptions = {
    debugPort: number;
    cdpPort: number;
    debugMain: boolean;
    debugFrida: boolean;
    autoDetect: boolean;
    locationFile?: string;
    routeFile?: string;
    panel: boolean;
    panelOnly: boolean;
    panelPort: number;
};

// default debugging port, do not change
const DEBUG_PORT = 9421;
// CDP port, change to whatever you like
// use this port by navigating to devtools://devtools/bundled/inspector.html?ws=127.0.0.1:${CDP_PORT}
const CDP_PORT = 62000;

const print_help = () => {
    console.log(`Usage: npx ts-node src/index.ts [options]

Options:
  --debug-port <port>  Remote debug server port (default: ${DEBUG_PORT})
  --cdp-port <port>    CDP proxy server port (default: ${CDP_PORT})
  --debug-main         Output main process debug messages
  --debug-frida        Output Frida client messages
  --auto-detect        Automatically detect hook offsets (Windows x64)
  --location-file <path>  Mock wx location from a reloadable JSON file
  --route-file <path>  Load JSON/GeoJSON route (starts paused)
  --panel             Open local route control server
  --panel-only        Run route panel without injecting WeChat
  --panel-port <port>  Local panel port (default: 8765)
  -h, --help           Show this help message`);
};

const parse_port = (
    name: string,
    value: string | undefined,
    defaultValue: number,
) => {
    if (value === undefined) {
        return defaultValue;
    }

    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`[main] invalid ${name}: ${value}`);
    }

    return port;
};

const parse_cli_options = (): CliOptions => {
    const { values } = parseArgs({
        options: {
            "debug-port": { type: "string" },
            "cdp-port": { type: "string" },
            "debug-main": { type: "boolean" },
            "debug-frida": { type: "boolean" },
            "auto-detect": { type: "boolean" },
            "location-file": { type: "string" },
            "route-file": { type: "string" },
            panel: { type: 'boolean' },
            'panel-only': { type: 'boolean' },
            'panel-port': { type: 'string' },
            help: { type: "boolean", short: "h" },
        },
        allowPositionals: false,
    });

    if (values.help) {
        print_help();
        process.exit(0);
    }

    return {
        debugPort: parse_port("--debug-port", values["debug-port"], DEBUG_PORT),
        cdpPort: parse_port("--cdp-port", values["cdp-port"], CDP_PORT),
        debugMain: values["debug-main"] ?? false,
        debugFrida: values["debug-frida"] ?? false,
        autoDetect: values["auto-detect"] ?? false,
        locationFile: values['location-file'],
        routeFile: values['route-file'],
        panel: Boolean(values.panel || values['panel-only'] || values['route-file']),
        panelOnly: values['panel-only'] ?? false,
        panelPort: parse_port('--panel-port', values['panel-port'], 8765),
    };
};

export { CliOptions, parse_cli_options };
