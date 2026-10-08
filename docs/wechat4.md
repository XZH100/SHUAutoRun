# Windows 微信 4.x

按实际 WMPF 运行时版本选择调试后端，而不是按微信设置页中的版本号选择偏移。
本次目标是本机微信 **4.1.15.50 / WMPF 25773**。
已完成新版启动入口和后端集成；25773 走自动偏移检测，尚未完成实际调试验证，
按用户要求交由用户自行测试。首次启动扫描可能需要一些时间；失败时请保留错误输出。

## 安装和运行

需要 64 位 Python 3.10+、Node.js 22+，以及已登录的微信。

```powershell
python -m pip install -r requirements.txt
npm --prefix vendor/WMPFDebugger ci
python main.py --check
python main.py -x
```

本项目已有虚拟环境时可将 `python` 替换为 `.\.venv\Scripts\python.exe`。
先打开任意一个小程序，让微信加载运行时。启动脚本，等待 `script loaded`，
再关闭并重新打开要调试的小程序。看到 `miniapp client connected` 后，在 Edge
或 Chrome 地址栏打开：

```text
devtools://devtools/bundled/inspector.html?ws=127.0.0.1:62000
```

保持脚本运行，Ctrl+C 退出。新版通过浏览器 DevTools 调试，原生小程序窗口的
F12 菜单不会因此恢复。仅绑定本机地址，使用 9421 和 62000 端口。

`--check` 只枚举进程及检查配置/依赖，不执行注入，不能代替实际功能验证。
没有固定配置的新版运行时会使用上游自动检测，无法唯一确定偏移时停止并报错。
多个实例用 `python main.py -x --pid <主进程PID>` 选择。
需要诊断时运行 `python main.py -x --debug`。
如果报告端口被占用，先退出之前启动的调试脚本。

## 内置浏览器

新版 `-c` / `-all` 使用同一个调试桥，需要先打开小程序建立会话。在 DevTools
设置的 Experiments 中启用 Protocol Monitor，然后通过 More tools 打开它。
发送 `Target.getTargets` 找到网页的 targetId，再发送
`Target.attachToTarget`，参数为 `{"targetId":"实际ID"}`。
这是上游的有限支持方案：Elements 不会切换到目标网页，小程序必须保持打开。
参见 [上游说明](../vendor/WMPFDebugger/EXTENSION.md)。

旧版本仍沿用 `configs/address_*_x64.json` 和原 Python Frida 实现。
新版 Frida 由 Node 后端独立安装，不替换旧版 Python Frida 依赖。
