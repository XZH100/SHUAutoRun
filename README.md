# SHUAutoRun
###注意本项目只能作为学习用途, 造成的任何问题与本库开发者无关, 如侵犯到你的权益，请联系删除。
## 简介
适用于上海中医药大学/上海大学的校园跑助手。

项目通过向小程序进程注入代码，修改小程序通过微信接口获得的位置数据实现“代跑”功能，
非传统的模拟定位。
若未来某日不在此小程序（华体运动汇）上进行记录校园跑，可能程序将失去作用。

注意：使用时其他小程序的定位也会受到波及。
## 新手部署流程

以下步骤面向 **Windows 10 / 11（64 位）**，命令均在 **PowerShell** 中运行。首次使用请按顺序操作；安装完成后，日常使用只需执行第 5 步。

当前适配以 **微信 4.1.15.50 / WMPF 25773** 为基础，其他版本需以实际运行结果为准。

### 1. 安装运行环境

先安装以下软件：

| 软件 | 版本与安装说明 |
| --- | --- |
| [Python](https://www.python.org/downloads/windows/) | 本项目使用 Python 3.12（64 位）的环境完成开发。新手建议使用同一版本系列；安装时勾选 **Add python.exe to PATH**，并安装 Python Launcher。 |
| [Node.js](https://nodejs.org/en/download) | 需要 22 或更高版本，本项目开发环境使用 24。选择 Windows x64 安装包，保留 npm 和 PATH 相关默认选项。 |
| Windows 微信 | 安装后登录账号。 |

安装完成后，重新打开 PowerShell，逐行运行：

```powershell
py --version
node --version
npm.cmd --version
```

三个命令都应显示版本号。若提示找不到命令，先确认软件已安装，再关闭并重新打开终端。

### 2. 下载项目并打开终端

已经安装 Git 的用户也可以用以下命令下载：

```powershell
git clone https://github.com/XZH100/SHUAutoRun.git
cd SHUAutoRun
```

**后续所有命令都在项目根目录执行。**

### 3. 安装项目依赖（首次部署执行）

逐行运行，等上一条命令结束且没有报错后，再执行下一条：

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
npm.cmd --prefix vendor/WMPFDebugger ci
```

这里会创建项目专用的 Python 环境，并安装 Python 和 Node.js 依赖。下载可能需要一些时间。

后面的命令直接使用 `.venv` 中的 Python，**无需执行激活脚本，也无需修改 PowerShell 执行策略**。安装命令使用 `npm.cmd`，避免 PowerShell 将其解析为 `npm.ps1`。



### 4. 连接微信并启动

1. 登录微信，先打开任意一个小程序，让微信加载小程序运行环境。
2. 在项目目录的 PowerShell 中检查运行时：

   ```powershell
   .\.venv\Scripts\python.exe main.py --check
   ```

   终端应列出 WMPF 版本和 PID。提示“需要自动检测偏移”表示启动时会尝试扫描，不代表检查失败，也不代表注入已经成功。

3. 启动调试脚本和路径面板：

   ```powershell
   .\.venv\Scripts\python.exe main.py -x --panel --route-file route.example.json
   ```
4. 终端显示：
    ```powershell
    [location] 配置: 定位默认关闭，可由路径面板启用；等待小程序连接
    [route] 网页面板: http://127.0.0.1:8766/#......
    ```
   点击网址可以打开跑步控制面板
5. 等待终端出现 `[frida]script loaded [frida]you can now open any miniapps`，然后关闭并重新打开目标小程序，不要只最小化窗口。
6. 打开终端打印的完整面板链接。`miniapp client connected` 表示已连接；再查看面板中的定位接口、地图蓝点和朝向状态。
7. 小程序右下角会显示蓝色两行文字 `SHUAutoRun` / `controlled`。该标识表示注入连接，具体定位状态以面板提示为准。

8. **路径加载后会立即将模拟位置固定在第一个点，速度为 0。** 网页中的“开始 / 继续”控制沿路线移动；未点击时保持静止。

示例路线仅用于演示。请先在面板中导入自己的路线、确认起点，再按需启动目标小程序的记录功能及面板中的运动。

使用期间保持脚本运行。关闭网页不会停止运动；要退出程序，请回到终端按 **Ctrl+C**。

### 5. 准备自己的路线

在项目目录中新建 `route.local.json`，用文本编辑器填入以下格式的内容，再替换为自己的坐标：

```json
{
  "name": "我的路线",
  "coordinateSystem": "gcj02",
  "points": [
    { "latitude": 31.319498, "longitude": 121.392710 },
    { "latitude": 31.320498, "longitude": 121.392710 },
    { "latitude": 31.320498, "longitude": 121.394710 }
  ]
}
```

- `latitude` 是纬度，`longitude` 是经度，顺序不要弄反。
- `coordinateSystem` 必须与坐标来源一致：支持 `gcj02` 和 `wgs84`，不支持百度 BD09 坐标。
- 至少需要两个不同的点，相邻点之间默认直线连接。
- JSON 不支持注释，最后一项后面不要加逗号。保存时确认扩展名是 `.json`，不是 `.json.txt`。

可以在网页面板中选择并导入文件，也可以启动时指定：

```powershell
.\.venv\Scripts\python.exe main.py -x --panel --route-file route.local.json
```

自带的`route.local.json`为SHU操场跑步路径

### 6. 面板操作

| 操作 | 效果 |
| --- | --- |
| 开始 / 继续 | 从当前位置沿路线移动；到终点后重新开始会回到起点。 |
| 暂停 | 保持当前位置，速度变为 0。 |
| 回到起点 | 清零进度，定位到第一个点并保持静止。 |
| 停止模拟 | 关闭位置替换，恢复原定位接口；如需恢复原持续定位，请重新打开小程序。 |
| 应用参数 | 保存面板中修改的速度、漂移、循环和方向设置。 |

默认速度为 **12 ± 3 km/h**，横向随机漂移范围为路径左右 **0–3 米**。开启循环后，到达终点会直接回到起点继续。

手机朝向默认跟随当前路段方向，也可以手动输入固定角度：北为 0°、东为 90°、南为 180°、西为 270°。

面板显示的是模拟器生成的路线；是否成功传入小程序，还需查看连接与接口确认状态。

需要更详细的日志时，使用：

```powershell
.\.venv\Scripts\python.exe main.py -x --panel --route-file route.local.json --debug
```

更多说明：[路径文件与运动规则](docs/route.md) · [模拟位置与地图适配](docs/location.md) · [微信 4.x 调试说明](docs/wechat4.md)。

## 致谢 / 站在巨人的肩上

魔改自 [JaveleyQAQ/WeChatOpenDevTools-Python](https://github.com/JaveleyQAQ/WeChatOpenDevTools-Python/) 感谢原项目及其所以贡献者。

新版调试后端基于 [evi0s/WMPFDebugger](https://github.com/evi0s/WMPFDebugger)。第三方来源与许可说明见 [THIRD_PARTY.md](THIRD_PARTY.md)，后端许可证保留在 [vendor/WMPFDebugger/LICENSE](vendor/WMPFDebugger/LICENSE)。
