import argparse
import sys
from pathlib import Path

from utils.wechatutils import WechatUtils


def main():
    parser = argparse.ArgumentParser(description='微信小程序 / 内置浏览器开发者工具')
    actions = parser.add_mutually_exclusive_group(required=True)
    actions.add_argument('-x', action='store_true', help='开启小程序调试（自动选择新版或旧版后端）')
    actions.add_argument('-c', action='store_true', help='开启内置浏览器调试')
    actions.add_argument('-all', action='store_true', help='开启浏览器和小程序调试')
    actions.add_argument('--check', action='store_true', help='仅检查运行时版本和后端依赖，不注入')
    actions.add_argument('--route-panel', action='store_true', help='仅运行路径网页面板，不注入微信')
    parser.add_argument('--debug', action='store_true', help='打印新版 Frida 调试日志')
    parser.add_argument('--pid', type=int, help='指定小程序主进程 PID（多个实例时使用）')
    parser.add_argument('--location-file', type=Path, help='模拟位置 JSON 文件；修改保存后自动更新，仅支持新版 -x/-all')
    parser.add_argument('--route-file', type=Path, help='路径 JSON/GeoJSON 文件；加载后在面板点击开始')
    parser.add_argument('--panel', action='store_true', help='打开本地路径控制网页服务')
    parser.add_argument('--panel-port', type=int, default=8765, help='网页面板端口，默认 8765')
    args = parser.parse_args()
    if args.location_file:
        if not (args.x or args.all or args.route_panel):
            parser.error('--location-file 需与 -x 或 -all 一起使用')
        args.location_file = args.location_file.resolve()
        if not args.location_file.is_file():
            parser.error('位置配置文件不存在：' + str(args.location_file))
    route_options = {}
    if args.panel or args.route_file or args.route_panel:
        if not (args.x or args.all or args.route_panel):
            parser.error('路径功能需与 -x、-all 或 --route-panel 一起使用')
        if not 1 <= args.panel_port <= 65535 or args.panel_port in (9421, 62000):
            parser.error('面板端口需为 1–65535，且不可使用 9421/62000')
        if args.route_file:
            args.route_file = args.route_file.resolve()
            if not args.route_file.is_file():
                parser.error('路径文件不存在：' + str(args.route_file))
        route_options = dict(route_file=args.route_file, panel=True, panel_port=args.panel_port)
    if args.route_panel:
        from utils.wmpfdebugger import run_backend
        return run_backend(0, 0, debug=args.debug, location_file=args.location_file, panel_only=True, **route_options)
    utils = WechatUtils()
    if args.check:
        from utils.wmpfdebugger import check_runtimes
        return check_runtimes(utils)

    if sys.platform == 'win32':
        instances = utils.get_runtime_processes()
        if args.pid is not None:
            instances = [item for item in instances if item[0] == args.pid]
            if not instances:
                parser.error('--pid 必须指向运行中的 WeChatAppEx 主进程')
        modern = [(pid, version) for pid, version in instances if version and version >= 13331]
        if modern:
            if len(modern) > 1:
                parser.error('发现多个新版小程序主进程，请使用 --pid 指定：' + ', '.join(str(p) for p, _ in modern))
            from utils.wmpfdebugger import run_backend
            if args.c or args.all:
                print('[+] 微信 4.x 浏览器调试需先建立小程序调试会话；操作见 docs/wechat4.md。', flush=True)
            if args.location_file or route_options:
                return run_backend(*modern[0], debug=args.debug, location_file=args.location_file, **route_options)
            return run_backend(*modern[0], debug=args.debug)
        if utils.has_modern_wechat():
            print('[-] 检测到微信 4.x，但未发现可识别的小程序运行时。请先打开一个小程序，再运行 --check。')
            return 1

    if args.location_file or route_options:
        parser.error('模拟位置功能需要 Windows 微信 4.x 小程序运行时')
    from utils.commons import Commons
    commons = Commons()
    if args.x:
        commons.load_wechatEx_configs()
    elif args.c:
        commons.load_wechatEXE_configs()
    else:
        commons.load_wechatEXE_and_wechatEx()
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
    except (RuntimeError, OSError) as error:
        print(f'[-] {error}', file=sys.stderr)
        sys.exit(1)
