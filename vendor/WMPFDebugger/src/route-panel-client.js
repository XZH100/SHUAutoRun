'use strict';
const $ = id => document.getElementById(id);
const token = location.hash.slice(1);
let route = null, version = -1, initialized = false, historyPoints = [], lastDistance = 0, lastLap = 0;
let projection = null;
const names = { empty:'等待导入路径', ready:'已定位到起点 · 静止等待移动', running:'正在运动', paused:'已暂停 · 保持当前位置', finished:'已到终点 · 保持终点位置', stopped:'已停止模拟' };
async function api(url, data) {
    const response = await fetch(url, { method: data === undefined ? 'GET' : 'POST',
        headers: { 'X-Panel-Token':token, ...(data === undefined ? {} : {'Content-Type':'application/json'}) },
        body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(6000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '请求失败');
    return result;
}
function error(e) { $('error').textContent = e.message || String(e); }
const SVG = 'http://www.w3.org/2000/svg';
function element(name, attrs, text) {
    const e = document.createElementNS(SVG, name);
    for (const [key, value] of Object.entries(attrs)) e.setAttribute(key, value);
    if (text !== undefined) e.textContent = text;
    return e;
}
function drawRoute() {
    const group = $('geometry'); group.replaceChildren(); historyPoints = []; $('trace').setAttribute('points','');
    if (!route) { projection = null; return; }
    const base = route.points[0], cos = Math.cos(base.latitude*Math.PI/180);
    const xy = p => [(p.longitude-base.longitude)*cos*111195, (p.latitude-base.latitude)*111195];
    const values = route.points.map(xy);
    let xmin=Infinity,xmax=-Infinity,ymin=Infinity,ymax=-Infinity;
    for (const [x,y] of values) { xmin=Math.min(xmin,x);xmax=Math.max(xmax,x);ymin=Math.min(ymin,y);ymax=Math.max(ymax,y); }
    const scale = Math.min(680/Math.max(xmax-xmin,20),340/Math.max(ymax-ymin,20));
    projection = p => { const [x,y] = xy(p); return [400+(x-(xmin+xmax)/2)*scale,230-(y-(ymin+ymax)/2)*scale]; };
    group.append(element('polyline',{points:route.points.map(p=>projection(p).join(',')).join(' '),fill:'none',stroke:'#66927b','stroke-width':'3','stroke-linejoin':'round'}));
    route.points.forEach((p,i)=>{
        if (route.points.length>80 && i!==0 && i!==route.points.length-1) return;
        const [x,y]=projection(p);
        group.append(element('circle',{cx:x,cy:y,r:i===0 || i===route.points.length-1 ? 6:3,fill:'#20352d',stroke:'#a5f3bb','stroke-width':'1.5'}));
        if(route.points.length<=30 || i===0 || i===route.points.length-1) group.append(element('text',{x:x+10,y:y-10},i===0?'起点':i===route.points.length-1?'终点':String(i+1)));
    });
    $('empty').setAttribute('visibility','hidden');
}
function render(state) {
    $('routeName').textContent=state.name || '尚未导入路径';
    $('routeMeta').textContent=state.points ? `${state.points} 个标记点 · ${(state.length/1000).toFixed(2)} km · ${state.coordinateSystem.toUpperCase()}` : '离线路线图';
    $('speed').textContent=state.speedKmh.toFixed(1); $('drift').textContent=state.driftMeters.toFixed(2);
    $('distance').textContent=state.distance.toFixed(0); $('laps').textContent=state.laps;
    $('heading').textContent=state.heading.toFixed(1)+'°';
    $('status').textContent=names[state.status]; $('progress').textContent=(state.progress*100).toFixed(1)+'%';
    $('bar').style.width=state.progress*100+'%';
    for(const id of ['start','reset','stop']) $(id).disabled=!state.points;
    $('start').disabled=!state.points || state.status==='running'; $('pause').disabled=state.status!=='running';
    if(!initialized){
        $('speedBase').value=state.settings.speedKmh; $('variation').value=state.settings.variationKmh;
        $('driftMax').value=state.settings.driftMeters; $('loop').checked=state.settings.loop; initialized=true;
        $('headingMode').value=state.settings.headingMode; $('manualHeading').value=state.settings.manualHeading;
        $('manualHeading').disabled=state.settings.headingMode!=='manual';
    }
    const injection=state.injection;
    $('connection').textContent=injection.confirmed ? `定位接口已确认 · ${injection.confirmed} 个环境` : injection.connections ? `微信已连接 · 等待定位确认` : '仅路线预览 · 微信未连接';
    const maps=injection.maps || {};
    const mapNotice=maps.updated ? `地图蓝点已同步 ${maps.updated} 个；朝向箭头 ${maps.heading || 0} 个。` :
        maps.detected ? `检测到地图，等待蓝点创建或适配${maps.unsupported ? '（当前组件不兼容）' : ''}。` : '尚未检测到可适配的地图蓝点。';
    const compassNotice=injection.compassConfirmed ? `逻辑层罗盘接口已安装，监听数 ${injection.compassListeners || 0}。` : '逻辑层罗盘接口尚未确认。';
    $('injection').textContent= !injection.enabled ? '模拟定位未启用。导入路线后会立即定位到第一个点并保持静止；开始按钮只控制移动。' : injection.confirmed ?
        `定位接口已确认。${mapNotice}${compassNotice}${maps.errors?.length ? '地图错误：'+maps.errors.join('；') : ''}${state.status==='ready' ? '当前位置固定在起点，点击开始后才会移动。' : ''}` :
        '模拟位置已准备，正在等待小程序定位接口确认；请确认连接状态后再开始运动记录。';
    if(state.position){
        $('position').textContent=`纬度 ${state.position.latitude.toFixed(7)}　经度 ${state.position.longitude.toFixed(7)}`;
        if(projection){
            const [x,y]=projection(state.position);
            for(const id of ['cursor','cursorRing']) { $(id).setAttribute('cx',x);$(id).setAttribute('cy',y);$(id).setAttribute('visibility','visible'); }
            $('headingArrow').setAttribute('transform',`translate(${x} ${y}) rotate(${state.heading})`);
            $('headingArrow').setAttribute('visibility','visible');
            if(state.laps!==lastLap || state.distance<lastDistance) historyPoints=[];
            const next=`${x.toFixed(2)},${y.toFixed(2)}`;
            if(state.active && historyPoints[historyPoints.length-1]!==next){historyPoints.push(next);if(historyPoints.length>2000)historyPoints.shift();}
            $('trace').setAttribute('points',historyPoints.join(' ')); lastDistance=state.distance;lastLap=state.laps;
        }
    }
}
async function refresh(){
    try {
        const state=await api('/api/state');
        if(state.routeVersion!==version){route=await api('/api/route');version=state.routeVersion;drawRoute();}
        render(state);
    } catch(e){ $('connection').textContent='面板连接断开';error(e); }
    finally { setTimeout(refresh,500); }
}
$('file').addEventListener('change',async()=>{
    const file=$('file').files[0];if(!file)return;
    try { if(file.size>1024*1024)throw new Error('文件不可超过 1 MB');
        await api('/api/route',{name:file.name,route:JSON.parse((await file.text()).replace(/^\uFEFF/,''))});
        $('error').textContent='';
    }catch(e){error(e);}finally{$('file').value='';}
});
$('settings').addEventListener('submit',async event=>{
    event.preventDefault();
    try { await api('/api/settings',{speedKmh:Number($('speedBase').value),variationKmh:Number($('variation').value),
        driftMeters:Number($('driftMax').value),loop:$('loop').checked,
        headingMode:$('headingMode').value,manualHeading:Number($('manualHeading').value)});$('error').textContent='';
    }catch(e){error(e);}
});
$('headingMode').addEventListener('change',()=>{ $('manualHeading').disabled=$('headingMode').value!=='manual'; });
for(const action of ['start','pause','reset','stop']) $(action).addEventListener('click',async()=>{
    try { await api('/api/control',{action});$('error').textContent=''; }catch(e){error(e);}
});
$('download').addEventListener('click',()=>{
    const template={name:'示例路线（请替换为你的坐标）',coordinateSystem:'gcj02',points:[
        {latitude:31.319498,longitude:121.392710},{latitude:31.320498,longitude:121.392710},
        {latitude:31.320498,longitude:121.394710},{latitude:31.319498,longitude:121.394710}]};
    const blob=new Blob([JSON.stringify(template,null,2)],{type:'application/json'}), url=URL.createObjectURL(blob), a=document.createElement('a');
    a.href=url;a.download='route.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
if(!token)error(new Error('请打开终端打印的完整面板链接（包含 # 后的访问码）。'));
else void refresh();
