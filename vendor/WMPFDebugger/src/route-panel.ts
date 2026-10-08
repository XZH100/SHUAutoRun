import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { RouteMotion } from './route-motion';
import { LocationService } from './location';
import { Logger } from './logger';

export async function startRoutePanel(location: LocationService, port: number, logger: Logger, routeFile?: string) {
    const motion = new RouteMotion(sample => location.setMotion(sample));
    try {
        if (routeFile) motion.load(JSON.parse((await fs.readFile(routeFile, 'utf8')).replace(/^\uFEFF/, '')), path.basename(routeFile));
        const html = await fs.readFile(path.join(__dirname, 'route-panel.html'));
        const js = await fs.readFile(path.join(__dirname, 'route-panel-client.js'));
        const token = randomBytes(24).toString('hex');
        const host = `127.0.0.1:${port}`, origin = `http://${host}`;
        const json = (res: http.ServerResponse, status: number, data: unknown) => {
            res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(data));
        };
        const server = http.createServer(async (req, res) => {
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
            if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== origin)) {
                json(res, 403, { error: '仅允许本机面板访问' }); return;
            }
            if (req.method === 'GET' && req.url === '/') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); return;
            }
            if (req.method === 'GET' && req.url === '/panel.js') {
                res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); res.end(js); return;
            }
            const supplied = Buffer.from(String(req.headers['x-panel-token'] || ''));
            if (supplied.length !== token.length || !timingSafeEqual(supplied, Buffer.from(token))) {
                json(res, 403, { error: '请使用终端中本次启动的完整面板链接' }); return;
            }
            try {
                if (req.method === 'GET' && req.url === '/api/state') {
                    json(res, 200, { ...motion.snapshot(), injection: location.status() }); return;
                }
                if (req.method === 'GET' && req.url === '/api/route') { json(res, 200, motion.route || null); return; }
                if (req.method !== 'POST' || !['/api/route','/api/settings','/api/control'].includes(req.url || '')) {
                    json(res, 404, { error: '接口不存在' }); return;
                }
                if (!String(req.headers['content-type']).startsWith('application/json')) {
                    json(res, 415, { error: '需要 JSON 请求' }); return;
                }
                const chunks: Buffer[] = []; let size = 0;
                for await (const chunk of req) {
                    size += chunk.length;
                    if (size > 1024*1024) { json(res, 413, { error: '路径文件不可超过 1 MB' }); return; }
                    chunks.push(Buffer.from(chunk));
                }
                const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if (req.url === '/api/route') motion.load(data.route, data.name);
                if (req.url === '/api/settings') motion.updateSettings(data);
                if (req.url === '/api/control') motion.control(data.action);
                json(res, 200, motion.snapshot());
            } catch (error) { json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
        });
        server.requestTimeout = 10000;
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
        });
        logger.info(`[route] 网页面板: ${origin}/#${token}`);
        logger.info('[route] 路径加载后立即静止在起点，开始按钮只控制移动。关闭网页不停止运动。');
        return { close: () => { motion.close(); server.closeAllConnections(); server.close(); } };
    } catch (error) { motion.close(); throw error; }
}
