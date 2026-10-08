
# 模拟小程序定位

仅适用于本项目的 Windows 微信 4.x 调试后端。需先成功完成 WMPF 注入，
小程序连接本地调试服务后，才能向其 JavaScript 执行环境安装模拟接口。
已读取目标小程序的地图实现进行诊断；修改后只做类型/语法检查，实机效果由用户验收。

## 使用

1. 编辑项目根目录的 `location.example.json`。示例为北京坐标，不代表你的真实位置。
2. 先打开一个小程序使微信加载 WMPF，然后运行：

   ```powershell
   .\.venv\Scripts\python.exe main.py -x --location-file location.example.json --debug
   ```

3. 等待 `script loaded` 后，关闭并重新打开目标小程序。不要只最小化窗口。
4. 等到终端出现 **`[location] 已生效`**，并确认日志列出的坐标和方法。
   再在小程序内触发“定位”或“刷新位置”。无需打开浏览器 DevTools。
   有浏览器 DevTools 时也可继续使用。

`miniapp client connected` 只代表调试连接已建立；`已生效` 表示执行环境
确认接口替换成功，最终业务页面是否使用这些接口仍需实际确认。

配置示例：

```json
{
  "enabled": true,
  "latitude": 39.908823,
  "longitude": 116.39747,
  "coordinateSystem": "gcj02",
  "accuracy": 10,
  "altitude": 0,
  "speed": 0
}
```

- `latitude` 是纬度，范围 -90 到 90；`longitude` 是经度，范围 -180 到 180。
- `coordinateSystem` 为 `wgs84`（GPS）或 `gcj02`（高德/腾讯地图坐标）。
  根据小程序请求的 `type` 转换坐标；中国大陆转换为常用近似算法，不用于测绘。
  不接受百度 BD09 坐标。
- `accuracy` 精度单位米，`altitude` 海拔单位米，`speed` 速度单位米/秒。
  三项可省略，默认分别为 10、0、0。
- 可选 `heading` 是罗盘朝向，范围 0–360°，北为 0°、顺时针增加。
  固定定位未设置该字段时不模拟罗盘；路径模式会自动传入计算出的方向。

保存 JSON 后，后端每 2 秒读取一次，随后推送给已连接的执行环境。
更新成功会再次打印带新坐标的 `已生效` 日志。JSON 格式错误或读取失败时，
保留上一次有效配置并输出错误；不会静默切回真实位置。
文件路径含空格时请用双引号包住路径。

## 覆盖范围

- `wx.getLocation`、`wx.getFuzzyLocation`：异步模拟成功结果，支持 success/complete
  回调；无回调时返回 Promise。仅替换环境中实际存在的方法，不创建不存在的 API。
- `wx.startLocationUpdate`、`wx.startLocationUpdateBackground`、`wx.stopLocationUpdate`、
  `wx.onLocationChange`、`wx.offLocationChange`：接口组完整时模拟持续定位，启动后每秒
  发送一次当前配置的位置。方法是否已覆盖以终端列出的清单为准。
- 单次 `getLocation` / `getFuzzyLocation` 默认 WGS84；持续定位的
  `startLocationUpdate` / `startLocationUpdateBackground` 默认 GCJ02。
  小程序显式传入 `type` 时仍以该值为准。
- 配置含 `heading` 时尝试模拟完整罗盘接口组，通过 `onCompassChange`
  返回 `direction`。逻辑层缺失或只读的接口会提示警告，不撤销定位模拟。
  渲染层通常没有罗盘 API，不再把它当作逻辑层罗盘安装失败。
- WMPF 25773 桌面 `wx-map`：识别已有的 TMap `locationMarker`，每 200 ms
  同步 GCJ02 位置；有 `heading` 时在蓝点上添加朝向箭头。地图自身的定位请求、
  蓝点点击事件也使用当前模拟坐标。兼容性检测失败时输出状态，不改写页面轨迹或业务标记。
- 作用于这个后端连接到的各小程序执行环境。多个微信实例可用 `--pid` 选择主进程。
  同一运行时中同时连接多个小程序时会使用同一份位置配置。

不修改系统位置、IP、服务端定位、地址文本、`wx.chooseLocation` 的用户选点结果，
也不覆盖 H5 `navigator.geolocation`。小程序已缓存的坐标、已保存的原始函数引用、
注入前已注册的原生持续定位监听、直接调用原生桥的代码都可能继续得到旧位置。
因此请先重新打开小程序，等待安装确认后再触发定位。

## 关闭和恢复

将配置改成 `{"enabled": false}`，保存后等待 `已关闭` 日志，后续 API 调用恢复原实现。
关闭后如需继续持续定位，应在小程序内重新启动定位并注册监听，或重新打开小程序。
模拟期间返回过的位置和业务缓存不会回滚。

退出脚本或调试连接中断后，注入代码的心跳租约约 30 秒后失效并恢复接口；
若小程序暂停执行，恢复动作需等它继续执行。不要把仍显示的业务缓存当作当前定位结果。
模拟位置可通过 `--location-file` 或导入路径启用，普通 `-x` 不启用。

## 无法生效时

- 仍停在 `auto-detecting hook offsets`：WMPF 注入尚未完成，定位功能无法开始。
- 出现 `配置 #N 尚无执行环境确认`：请检查日志中的连接数、环境数、无 wx 数和错误数。
  后端会重试获取执行环境；使用 `--debug` 可看到重新枚举和具体环境诊断。
  如果首次出现 `已生效`，断线重连后不再生效，请提供重连前后完整的 `[location]` 日志。
- `安装失败` / `read-only`：接口不可写，本次安装会回滚，不会报告成功。
- 页面显示旧位置：先确认 `已生效` 的方法清单和坐标，再重新触发定位；检查小程序
  是否使用了上述未覆盖的定位来源或缓存。

实现参考 [CDP Runtime](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/)
和 [CDP Target](https://chromedevtools.github.io/devtools-protocol/tot/Target/) 的执行环境及相关目标机制。

## 重连与配置更新

调试 WebSocket 重连时重置 Runtime 通知，重新枚举已有的 JavaScript 执行环境。
各环境独立更新，避免失效的渲染环境超时阻塞逻辑环境的心跳。
没有 wx 的连接不会在其他环境正常工作时独立报告整体失败。
配置保存后日志显示 `配置 #N 已读取`，对应环境确认后显示 `已生效 配置 #N`。
这两个版本号应一致；仅看到“已读取”不能判断更新成功。

## 开始运动时固定偏移的修复

旧实现把持续定位的默认坐标系错误地设为 WGS84。运动应用若在开始记录时
调用不带 `type` 的持续定位接口，就会得到 WGS84 数值，地图却按默认 GCJ02
绘制，导致稳定偏移。以示例 GCJ02 起点 `(31.319498, 121.392710)` 计算，
错误返回的 WGS84 为 `(31.3212996161, 121.3880555913)`，约向北 200 m、
向西 442 m，总距离约 485 m。此数值与反馈现象一致；未抓取目标应用调用来
验证其实际参数。本次按接口契约修正默认值，不对坐标额外加固定补偿量。

参考腾讯的 [前台持续定位说明](https://github.com/TencentLBS/tencentmap-miniprogram-skill/blob/main/references/wx_location_api/wx.startLocationUpdate.md)、
[后台持续定位说明](https://github.com/TencentLBS/tencentmap-miniprogram-skill/blob/main/references/wx_location_api/wx.startLocationUpdateBackground.md)
和 [罗盘说明](https://intl.cloud.tencent.com/zh/document/product/1219/57711)。

## 蓝点不移动、朝向不显示（桌面地图）

本次从已连接的目标页面读取到：`wx-map.__wxElement.data.locationMarker`
是独立的 TMap DOMOverlay。`showLocationChanged` 创建蓝点后复用它；
业务刷新定位只更新地图中心、起点和轨迹，没有更新这个蓝点的 `position`。
它的 `createDOM` 只绘制圆点、圆环，本身没有手机朝向图形。
因此只替换 `wx.getLocation` / `onLocationChange` / `onCompassChange` 不足以改变蓝点显示。

地图适配器直接更新已有蓝点位置，调用原绘制方法；箭头使用投影后的路径切线方向，
随地图缩放、旋转、倾斜重新绘制，不覆盖蓝点本身的平移变换。
此箭头表示模拟手机朝向，和地图的 `show-compass`（地图指南针控件）不同。
静止等待、暂停时也同步蓝点及朝向，网页“开始”仍只控制沿路径移动。

终端新增 `[location-map]`，网页分别显示：

- 地图蓝点已同步数量、朝向箭头数量：绘制适配器实际更新的组件数。
- 逻辑层罗盘接口已安装、监听数：API 是否替换，以及应用是否注册了回调。
  应用没有监听罗盘时可以为 0，不妨碍地图适配器显示箭头。
- 检测到地图但等待蓝点创建、组件不兼容、错误：不会算作同步成功。

该适配器针对实际读取到的桌面组件结构；其他版本、原生地图、其他地图引擎
不保证兼容。不会额外申请位置授权或强制显示应用原本隐藏的蓝点。
停止模拟或租约超时会移除箭头、恢复组件方法和接管前的蓝点位置；原组件本身
不会持续定位，若恢复后仍是旧蓝点，应重新打开页面让原组件重新获取位置。
修改代码后需重启调试脚本，再关闭并重新打开小程序；网页刷新不会加载新的注入代码。
