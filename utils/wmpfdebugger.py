"""Launch the pinned WMPFDebugger backend for Windows WeChat 4.x."""
import os
from pathlib import Path
import shutil
import subprocess


ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / 'vendor' / 'WMPFDebugger'


def backend_command(pid, version, debug=False, location_file=None, route_file=None, panel=False, panel_only=False, panel_port=8765):
    node = shutil.which('node')
    if not node:
        raise RuntimeError('新版调试后端需要 Node.js 22 或更高版本。')
    runner = BACKEND / 'node_modules' / 'ts-node' / 'dist' / 'bin.js'
    if not runner.is_file():
        raise RuntimeError('请先执行 npm --prefix vendor/WMPFDebugger ci 安装调试后端依赖。')
    command = [node, str(runner), str(BACKEND / 'src' / 'index.ts')]
    config = BACKEND / 'frida' / 'config' / 'win32' / f'addresses.{version}.json'
    if not panel_only and not config.is_file():
        command.append('--auto-detect')
    if debug:
        command.append('--debug-frida')
    if location_file:
        command.extend(['--location-file', str(Path(location_file).resolve())])
    if route_file:
        command.extend(['--route-file', str(Path(route_file).resolve())])
    if panel or panel_only or route_file:
        command.extend(['--panel-port', str(panel_port)])
        command.append('--panel-only' if panel_only else '--panel')
    env = os.environ.copy()
    env['WMPF_TARGET_PID'] = str(pid)
    env['WMPF_TARGET_VERSION'] = str(version)
    return command, env


def run_backend(pid, version, debug=False, location_file=None, **options):
    if not version and not options.get('panel_only'):
        raise RuntimeError('无法识别 WMPF 版本，请先打开一个小程序后重试。')
    command, env = backend_command(pid, version, debug, location_file, **options)
    if not options.get('panel_only'):
        print(f'[+] 使用新版 WMPF 调试后端，版本 {version}，PID {pid}', flush=True)
        print('[+] 等待 script loaded 后，重新打开目标小程序。', flush=True)
    child = subprocess.Popen(command, cwd=BACKEND, env=env)
    try:
        return child.wait()
    except KeyboardInterrupt:
        try:
            return child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.terminate()
            return child.wait()


def check_runtimes(wechatutils):
    instances = wechatutils.get_runtime_processes()
    if not instances:
        print('[-] 未发现小程序主进程。请登录微信并打开一个小程序后重试。')
        return 1
    ready = True
    for pid, version in instances:
        if version in wechatutils.version_list:
            status = '已有旧版偏移配置'
        elif version and version >= 13331:
            config = BACKEND / 'frida' / 'config' / 'win32' / f'addresses.{version}.json'
            status = '已有新版偏移配置' if config.is_file() else '需要自动检测偏移（尚未验证）'
            try:
                backend_command(pid, version)
            except RuntimeError as error:
                status += f'；{error}'
                ready = False
        else:
            status = '尚不支持或无法识别版本'
            ready = False
        print(f'WMPF {version or "未知"} / PID {pid}: {status}')
    return 0 if ready else 1
