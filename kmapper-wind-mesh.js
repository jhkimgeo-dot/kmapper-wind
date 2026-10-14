/*
 * 바람길 분석 (3차원 도시모델 메시 기반) v1.1
 * 대상: map.kmapper.sistech3d.com (Acute3D/ContextCapture 웹 뷰어, three.js r69)
 * 사용: 뷰어 페이지가 열린 상태에서 이 스크립트를 실행(콘솔/북마크/주입)
 *
 * 처리 흐름
 *  1) 가상의 수직 카메라로 분석 범위의 상세 메시(LOD)를 불러옴 (사용자 화면 시점은 그대로 둠)
 *  2) 메시를 정사 투영으로 렌더링해 높이 지도(DSM)와 색상(정사영상)을 추출
 *  3) 지면(DTM) 추정, 건물/수목/소형 장애물 구분 (높이층별 실제 메시 단면 사용)
 *  4) 높이층(1.5m, 10m, 30m …)마다 격자 볼츠만(LBM) 2차원 흐름 계산 (작업 스레드 병렬)
 *  5) 3D 화면에 풍속비 색상면, 움직이는 바람 입자, 바람길 형태 지표(거칠기 길이 등) 표시
 */
(async () => {
  'use strict';
  if (window.__kmWind && window.__kmWind.destroy) { try { window.__kmWind.destroy(); } catch (e) { } }
  const DEG = Math.PI / 180;
  const VERSION = '1.1';

  // ================= 엔진 접근 =================
  // 앱이 계속 호출하는 LOD 갱신 함수에 잠깐 갈고리를 걸어 실제 루트 객체를 얻음
  function grabRoot(ms) {
    return new Promise(res => {
      if (!window.AC3D || !AC3D.Ac3dROOT) { res(null); return; }
      const P = AC3D.Ac3dROOT.prototype, orig = P.updateLODTree; let done = false;
      P.updateLODTree = function () { if (!done) { done = true; P.updateLODTree = orig; res(this); } return orig.apply(this, arguments); };
      setTimeout(() => { if (!done) { done = true; P.updateLODTree = orig; res(null); } }, ms);
    });
  }
  async function findEngine() {
    if (!window.THREE || !window.AC3D) return null;
    let root = null;
    for (let i = 0; i < 10 && !root; i++) {
      const r = await grabRoot(3000);
      if (r && r.ui && r.isSceneLoaded && r.isSceneLoaded()) root = r; else if (r && r.ui && i >= 3) root = r;
      if (!root) await sleep(1000);
    }
    if (!root || !root.ui) return null;
    const ui = root.ui; let cam = null, R = null, controls = null;
    for (const k in ui) {
      let v; try { v = ui[k]; } catch (e) { continue; }
      if (!v || typeof v !== 'object') continue;
      if (v instanceof THREE.PerspectiveCamera) { if (!cam || v.far > cam.far) cam = v; }
      else if (v instanceof THREE.WebGLRenderer) R = v;
      else if (window.acute3d && acute3d.page && acute3d.page.OrbitControls && v instanceof acute3d.page.OrbitControls) controls = v;
    }
    let scene = root; while (scene.parent) scene = scene.parent;
    if (!cam || !R) return null;
    return { root, ui, cam, R, gl: R.getContext(), scene, controls };
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // 페이지 시작과 함께 불러와도 동작하도록 뷰어 엔진이 준비될 때까지 최대 2분 대기
  for (let i = 0; i < 240 && !(window.THREE && window.AC3D && AC3D.Ac3dROOT); i++) await sleep(500);
  const E = await findEngine();
  if (!E) { alert('3D 모델이 아직 불러와지지 않았습니다. 모델이 보인 뒤 다시 실행해 주세요.'); return; }
  const ROOTPROTO = AC3D.Ac3dROOT.prototype;
  const origin = (E.root.getSRSOrigin && E.root.getSRSOrigin()) || E.root.SRSOrigin || [0, 0, 0];
  const srsWkt = (E.root.getSRS && E.root.getSRS()) || E.root.SRS || '';

  // 지역 좌표(x=동, y=북, z=위) → 위경도
  let srsDef = null;
  (function initSRS() {
    if (!window.proj4) return;
    try { proj4(srsWkt, 'EPSG:4326', [origin[0], origin[1]]); srsDef = srsWkt; return; } catch (e) { }
    const m = /UTM zone (\d+)([NS])/i.exec(srsWkt);
    if (m) srsDef = `+proj=utm +zone=${m[1]} ${m[2].toUpperCase() === 'S' ? '+south ' : ''}+datum=WGS84 +units=m +no_defs`;
  })();
  function toLL(x, y) {
    if (!srsDef) return { lon: 126.63, lat: 37.53 };
    try { const r = proj4(srsDef, 'EPSG:4326', [x + origin[0], y + origin[1]]); return { lon: r[0], lat: r[1] }; } catch (e) { return { lon: 126.63, lat: 37.53 }; }
  }

  const state = {
    capturing: false, running: false, cancel: null, workers: [],
    area: null,            // 그린 영역 {x0,y0,x1,y1} (지역 좌표)
    geo: null,             // 분석 격자 정보
    layers: [],            // 높이층별 결과
    curLayer: 0,
    morph: null,
  };
  const wind = { dir: 270, spd: 3, gust: 4.5, source: 'none', time: '', hourly: [] };
  const view = { heat: true, parts: true, allLayers: false, morph: false, opacity: 0.6, nParts: 1500, speedX: 15 };

  // 장면에 붙일 그룹
  const group = new THREE.Object3D(); group.name = 'kmWindGroup';
  E.scene.add(group);
  const kick = () => { if (!state.capturing) { try { E.ui.updateCanvas(); } catch (e) { } } };

  // LOD 갱신 가로채기: 캡처 중에는 앱의 LOD 갱신을 막고 가상 카메라 기준으로만 갱신
  const origUpdLOD = E.root.updateLODTree;
  E.root.updateLODTree = function () { if (state.capturing) return; return ROOTPROTO.updateLODTree.apply(this, arguments); };

  // ================= 유틸 =================
  const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()));
  const DIRS = ['북', '북북동', '북동', '동북동', '동', '동남동', '남동', '남남동', '남', '남남서', '남서', '서남서', '서', '서북서', '북서', '북북서'];
  const dirName = d => DIRS[Math.round((((d % 360) + 360) % 360) / 22.5) % 16];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function visibleMeshes() {
    const out = [];
    E.root.traverse(m => {
      if (!(m instanceof THREE.Mesh) || !m.geometry) return;
      let a = m; while (a) { if (!a.visible) return; a = a.parent; }
      out.push(m);
    });
    return out;
  }
  function camRay(ndcX, ndcY) {
    const cam = E.cam; cam.updateMatrixWorld();
    const o = cam.position.clone();
    const d = new THREE.Vector3(ndcX, ndcY, 0.5).unproject(cam).sub(o).normalize();
    return { o, d };
  }
  function pickMesh(ndcX, ndcY) {
    const { o, d } = camRay(ndcX, ndcY);
    const rc = new THREE.Raycaster(o, d, 0.1, 1e7);
    const hit = rc.intersectObjects(visibleMeshes(), false)[0];
    return hit ? hit.point.clone() : null;
  }
  function rayPlane(ndcX, ndcY, z) {
    const { o, d } = camRay(ndcX, ndcY);
    if (Math.abs(d.z) < 1e-6) return null;
    const t = (z - o.z) / d.z; if (t <= 0) return null;
    return { x: o.x + d.x * t, y: o.y + d.y * t };
  }
  function ndcOf(ev) {
    const r = E.R.domElement.getBoundingClientRect();
    return { x: ((ev.clientX - r.left) / r.width) * 2 - 1, y: -((ev.clientY - r.top) / r.height) * 2 + 1, inside: ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom };
  }

  // ================= 화면(UI) =================
  const css = `
  #kmw-rail{position:fixed;left:0;top:44px;bottom:70px;width:64px;z-index:9000;background:rgba(18,24,34,.88);backdrop-filter:blur(6px);border-right:1px solid rgba(255,255,255,.08);display:flex;flex-direction:column;align-items:center;padding-top:8px;gap:4px;font-family:'Malgun Gothic','Apple SD Gothic Neo',sans-serif}
  #kmw-rail .it{width:56px;padding:8px 0 6px;border-radius:8px;color:#b9c4d4;cursor:pointer;text-align:center;font-size:11px;user-select:none;position:relative}
  #kmw-rail .it:hover{background:rgba(255,255,255,.07);color:#fff}
  #kmw-rail .it.on{background:rgba(64,160,255,.22);color:#fff}
  #kmw-rail .it.on:before{content:'';position:absolute;left:-4px;top:10px;bottom:10px;width:3px;border-radius:2px;background:#40a0ff}
  #kmw-rail svg{width:24px;height:24px;display:block;margin:0 auto 3px}
  #kmw-rail .ttl{font-size:10px;color:#7fb8ff;font-weight:700;margin-bottom:6px;line-height:1.2;text-align:center}
  #kmw-rail .x{margin-top:auto;margin-bottom:8px}
  #kmw-drawer{position:fixed;left:72px;top:52px;width:330px;max-height:calc(100vh - 140px);overflow:auto;z-index:9000;background:rgba(18,24,34,.92);backdrop-filter:blur(6px);color:#e6edf6;border:1px solid rgba(255,255,255,.1);border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.4);font:12.5px/1.5 'Malgun Gothic','Apple SD Gothic Neo',sans-serif;transition:transform .22s ease,opacity .22s ease}
  #kmw-drawer.hide{transform:translateX(-20px);opacity:0;pointer-events:none}
  #kmw-drawer h3{margin:0;padding:12px 14px 8px;font-size:14px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,.08)}
  #kmw-drawer h3 span.c{cursor:pointer;color:#8b98a9;font-weight:400;font-size:16px}
  #kmw-drawer .sec{padding:10px 14px;border-bottom:1px solid rgba(255,255,255,.06)}
  #kmw-drawer .sec:last-child{border-bottom:0}
  #kmw-drawer .lb{color:#8fa3bb;font-size:11.5px;margin-bottom:4px}
  #kmw-drawer .row{display:flex;align-items:center;gap:6px;margin:5px 0;flex-wrap:wrap}
  #kmw-drawer input[type=number],#kmw-drawer select{background:#0f1520;color:#e6edf6;border:1px solid #2c3a4d;border-radius:5px;padding:4px 6px;font-size:12px}
  #kmw-drawer input[type=range]{flex:1;accent-color:#40a0ff}
  #kmw-drawer button{background:#22324a;color:#e6edf6;border:1px solid #34506f;border-radius:6px;padding:6px 10px;font-size:12px;cursor:pointer}
  #kmw-drawer button:hover{background:#2b4262}
  #kmw-drawer button.pri{background:#1f6fd1;border-color:#2f86f0}
  #kmw-drawer button.pri:hover{background:#2a7ee6}
  #kmw-drawer button:disabled{opacity:.45;cursor:default}
  #kmw-drawer .chip{display:inline-block;padding:3px 8px;border-radius:12px;border:1px solid #34506f;cursor:pointer;font-size:11.5px;user-select:none}
  #kmw-drawer .chip.on{background:#1f6fd1;border-color:#2f86f0;color:#fff}
  #kmw-drawer .big{font-size:22px;font-weight:700}
  #kmw-drawer .muted{color:#8193a8;font-size:11.5px}
  #kmw-drawer table{width:100%;border-collapse:collapse;font-size:12px}
  #kmw-drawer td{padding:3px 2px;border-bottom:1px solid rgba(255,255,255,.05)}
  #kmw-drawer td.v{text-align:right;font-weight:600}
  #kmw-drawer .bar{height:6px;background:#0f1520;border-radius:3px;overflow:hidden;margin-top:6px}
  #kmw-drawer .bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#2f86f0,#5fd0ff);transition:width .3s}
  #kmw-drawer .fc{max-height:150px;overflow:auto;border:1px solid #243245;border-radius:6px}
  #kmw-drawer .fc div{display:flex;justify-content:space-between;padding:3px 8px;cursor:pointer;font-size:11.5px}
  #kmw-drawer .fc div:hover{background:rgba(64,160,255,.15)}
  #kmw-drawer .leg{height:10px;border-radius:3px;margin-top:4px}
  #kmw-drawer .legl{display:flex;justify-content:space-between;font-size:10.5px;color:#8fa3bb}
  #kmw-drawer .cls{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
  #kmw-drawer .compass{display:grid;grid-template-columns:repeat(8,1fr);gap:3px;margin-top:4px}
  #kmw-drawer .compass span{text-align:center;padding:2px 0;border:1px solid #2c3a4d;border-radius:4px;cursor:pointer;font-size:10.5px}
  #kmw-drawer .compass span.on{background:#1f6fd1;border-color:#2f86f0}
  #kmw-hud{position:fixed;left:236px;bottom:16px;z-index:9000;background:rgba(18,24,34,.86);color:#e6edf6;border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:8px 12px;display:flex;align-items:center;gap:10px;font:12px/1.4 'Malgun Gothic',sans-serif;pointer-events:none}
  #kmw-hud svg{width:40px;height:40px}
  #kmw-tip{position:fixed;z-index:9001;pointer-events:none;background:rgba(10,14,22,.92);color:#fff;border:1px solid rgba(255,255,255,.18);border-radius:6px;padding:5px 8px;font:11.5px/1.45 'Malgun Gothic',sans-serif;display:none;white-space:nowrap}
  #kmw-draw-hint{position:fixed;left:50%;top:60px;transform:translateX(-50%);z-index:9001;background:rgba(31,111,209,.95);color:#fff;padding:7px 14px;border-radius:16px;font:12.5px 'Malgun Gothic',sans-serif;display:none}
  `;
  const styleEl = document.createElement('style'); styleEl.id = 'kmw-style'; styleEl.textContent = css; document.head.appendChild(styleEl);

  const ICON = {
    wx: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 8h11a3 3 0 1 0-3-3"/><path d="M3 12h16a3 3 0 1 1-3 3"/><path d="M3 16h7"/></svg>',
    run: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 20V10l5-3v13M9 20V5l6-2v17M15 20V9l5 2v9"/><path d="M2 20h20"/></svg>',
    res: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/><path d="M3 17.5l9 5 9-5" opacity=".6"/></svg>',
    morph: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>',
    help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.7"/><circle cx="12" cy="17" r=".6" fill="currentColor"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  };
  const rail = document.createElement('div'); rail.id = 'kmw-rail';
  rail.innerHTML = `<div class="ttl">바람길<br>분석</div>
    <div class="it" data-k="wx">${ICON.wx}기상</div>
    <div class="it" data-k="run">${ICON.run}분석</div>
    <div class="it" data-k="res">${ICON.res}결과</div>
    <div class="it" data-k="morph">${ICON.morph}지표</div>
    <div class="it" data-k="help">${ICON.help}도움말</div>
    <div class="it x" data-k="quit" title="바람길 분석 도구 끄기">${ICON.close}끄기</div>`;
  document.body.appendChild(rail);

  const drawer = document.createElement('div'); drawer.id = 'kmw-drawer'; drawer.className = 'hide';
  drawer.innerHTML = `
  <div data-p="wx">
    <h3>실시간 기상 <span class="c" data-close>×</span></h3>
    <div class="sec">
      <div class="lb">현재 바람 (오픈 메테오, 모델 중심 위치)</div>
      <div class="row" style="gap:12px"><svg id="kmw-wx-arrow" viewBox="-20 -20 40 40" width="54" height="54"></svg>
        <div><div class="big" id="kmw-wx-main">-</div><div class="muted" id="kmw-wx-sub">불러오는 중…</div></div></div>
      <div class="row"><button id="kmw-wx-reload">다시 불러오기</button><span class="muted" id="kmw-wx-time"></span></div>
      <label class="row"><input type="checkbox" id="kmw-uselive" checked> 분석에 실시간 바람 사용 (10분마다 갱신)</label>
    </div>
    <div class="sec">
      <div class="lb">24시간 예보 (누르면 그 시각 바람을 적용)</div>
      <div class="fc" id="kmw-fc"></div>
    </div>
    <div class="sec">
      <div class="lb">직접 지정 (실시간 사용을 끄면 적용)</div>
      <div class="row">풍향 <input type="number" id="kmw-dir" min="0" max="359" value="270" style="width:62px">° &nbsp; 풍속(10m) <input type="number" id="kmw-spd" min="0.5" max="30" step="0.5" value="3" style="width:58px"> m/s</div>
      <div class="compass" id="kmw-compass"></div>
    </div>
  </div>
  <div data-p="run">
    <h3>바람길 분석 설정 <span class="c" data-close>×</span></h3>
    <div class="sec">
      <div class="lb">분석 범위</div>
      <div class="row"><select id="kmw-rng"><option value="300">화면 중심 300m</option><option value="500" selected>화면 중심 500m</option><option value="800">화면 중심 800m</option><option value="1200">화면 중심 1.2km</option><option value="area">직접 그린 영역</option></select>
        <button id="kmw-draw">영역 그리기</button></div>
      <div class="muted" id="kmw-area-info">화면 가운데 지점을 중심으로 정사각형 범위를 분석합니다.</div>
    </div>
    <div class="sec">
      <div class="lb">분석 높이층 (지면 기준, 여러 개 선택 가능)</div>
      <div class="row" id="kmw-hs"></div>
      <div class="muted">각 높이에서 실제 메시 단면으로 건물·수목을 판정합니다.</div>
    </div>
    <div class="sec">
      <div class="row">계산 격자 <select id="kmw-res"><option value="128">빠르게</option><option value="180" selected>보통</option><option value="240">정밀</option></select>
        메시 상세도 <select id="kmw-q"><option value="1.0">표준</option><option value="0.5" selected>높음</option></select></div>
      <div class="muted" id="kmw-res-info"></div>
    </div>
    <div class="sec">
      <div class="lb">적용 바람</div>
      <div id="kmw-wind-use" style="font-weight:600">-</div>
    </div>
    <div class="sec">
      <div class="row"><button class="pri" id="kmw-run">분석 시작</button><button id="kmw-stop" disabled>중지</button><button id="kmw-clear">결과 지우기</button></div>
      <div class="muted" id="kmw-status" style="margin-top:6px">대기 중</div>
      <div class="bar"><i id="kmw-bar"></i></div>
    </div>
  </div>
  <div data-p="res">
    <h3>분석 결과 <span class="c" data-close>×</span></h3>
    <div class="sec" id="kmw-res-empty"><div class="muted">아직 결과가 없습니다. [분석] 메뉴에서 분석을 시작해 주세요.</div></div>
    <div id="kmw-res-body" style="display:none">
      <div class="sec">
        <div class="lb">표시할 높이층</div>
        <div class="row" id="kmw-layer-chips"></div>
        <div class="muted" id="kmw-res-meta"></div>
      </div>
      <div class="sec">
        <label class="row"><input type="checkbox" id="kmw-v-heat" checked> 풍속 색상면</label>
        <label class="row"><input type="checkbox" id="kmw-v-parts" checked> 바람 입자 애니메이션</label>
        <label class="row"><input type="checkbox" id="kmw-v-all"> 모든 높이층 입자 함께 보기 (입체 흐름)</label>
        <div class="row">불투명도 <input type="range" id="kmw-v-op" min="0.15" max="0.95" step="0.05" value="0.6"></div>
        <div class="row">입자 수 <input type="range" id="kmw-v-n" min="300" max="4000" step="100" value="1500"></div>
        <div class="row">흐름 속도 <input type="range" id="kmw-v-sp" min="2" max="40" step="1" value="15"> <span class="muted" id="kmw-v-spv">15배</span></div>
        <div class="lb" style="margin-top:6px">풍속비 (유입 바람 대비)</div>
        <div class="leg" id="kmw-legend"></div>
        <div class="legl"><span>0 정체</span><span>0.3</span><span>0.7</span><span>1.0</span><span>1.2</span><span>1.6 이상 강풍</span></div>
      </div>
      <div class="sec">
        <div class="lb">높이층 통계 (분석 영역, 건물 내부 제외)</div>
        <table id="kmw-stats"></table>
      </div>
      <div class="sec">
        <div class="lb">층별 비교</div>
        <table id="kmw-cmp"></table>
      </div>
      <div class="sec"><div class="row"><button id="kmw-dl-csv">격자값 CSV 저장</button><button id="kmw-dl-png">색상 지도 PNG 저장</button></div>
        <div class="muted">마우스를 3D 화면 위에 올리면 그 지점의 풍속을 보여 줍니다.</div></div>
    </div>
  </div>
  <div data-p="morph">
    <h3>바람길 형태 지표 <span class="c" data-close>×</span></h3>
    <div class="sec" id="kmw-m-empty"><div class="muted">분석을 실행하면 메시에서 건물 높이·배치를 읽어 지표를 계산합니다.</div></div>
    <div id="kmw-m-body" style="display:none">
      <div class="sec">
        <label class="row"><input type="checkbox" id="kmw-v-morph"> 지도에 바람길 등급 표시</label>
        <div class="row">구획 크기 <select id="kmw-blk"><option value="30">30m</option><option value="50" selected>50m</option><option value="100">100m</option></select></div>
        <div style="margin-top:4px">
          <div><span class="cls" style="background:#2d7ff9"></span>바람길 매우 양호 (거칠기 길이 0.25m 미만)</div>
          <div><span class="cls" style="background:#3cc47c"></span>바람길 양호 (0.25~0.5m)</div>
          <div><span class="cls" style="background:#f2c94c"></span>보통 (0.5~1.0m)</div>
          <div><span class="cls" style="background:#eb5757"></span>통풍 장애 (1.0m 이상)</div>
        </div>
      </div>
      <div class="sec"><table id="kmw-mstats"></table></div>
      <div class="sec muted">계산식: 건폐율(λp)·전면적 지수(λf, 현재 풍향 기준)·평균 건물높이로 맥도널드(Macdonald, 1998) 식의 영면변위 높이와 거칠기 길이를 구하고, 거칠기 길이 0.5m 미만 구획을 바람길로 분류(Gál & Unger, 2009 방식)했습니다. 수목은 높이의 10%를 거칠기 길이로 반영합니다.</div>
    </div>
  </div>
  <div data-p="help">
    <h3>도움말 <span class="c" data-close>×</span></h3>
    <div class="sec">
      <b>1. 범위 정하기</b><br>원하는 곳을 화면 가운데에 두거나, [영역 그리기]를 누른 뒤 3D 모델 위 두 모서리를 클릭합니다.<br><br>
      <b>2. 분석 시작</b><br>도구가 분석 범위의 상세 메시를 내려받아 위에서 내려다본 높이·색상 지도를 만들고, 높이층별로 건물(막힘)·수목(일부 통과)·작은 장애물을 판정한 뒤 바람 흐름을 계산합니다. 화면 시점은 바뀌지 않습니다.<br><br>
      <b>3. 결과 보기</b><br>색상면은 유입 바람 대비 풍속비입니다. 파랑은 바람이 막혀 정체되는 곳, 초록은 원래 바람과 비슷한 곳, 빨강은 건물 사이로 바람이 몰려 빨라지는 곳입니다. 흰 입자가 실제 흐름을 따라 움직입니다.<br><br>
      <b>참고</b><br>각 높이층을 수평 2차원으로 계산하고, 위쪽 공기와의 섞임은 근사식으로 반영한 간이 해석입니다. 계획 검토용 경향 파악에 쓰고, 정밀 평가는 3차원 전산유체해석(CFD)으로 확인하세요.
    </div>
  </div>`;
  document.body.appendChild(drawer);
  const hud = document.createElement('div'); hud.id = 'kmw-hud';
  hud.innerHTML = `<svg viewBox="-20 -20 40 40" id="kmw-hud-arrow"></svg><div><div id="kmw-hud-1" style="font-weight:700">바람 정보 불러오는 중</div><div id="kmw-hud-2" class="muted" style="color:#9fb0c4"></div></div>`;
  document.body.appendChild(hud);
  const tip = document.createElement('div'); tip.id = 'kmw-tip'; document.body.appendChild(tip);
  const hint = document.createElement('div'); hint.id = 'kmw-draw-hint'; document.body.appendChild(hint);
  const $ = id => document.getElementById('kmw-' + id);

  // 상단 바 높이에 맞춰 위치 조정
  (function placeUI() {
    const nb = document.querySelector('.navigationbar');
    const top = nb ? Math.round(nb.getBoundingClientRect().bottom) : 40;
    rail.style.top = top + 'px'; drawer.style.top = (top + 8) + 'px';
  })();

  // 패널 위 조작이 3D 화면 회전·확대로 넘어가지 않게 막기
  const stopEv = ev => ev.stopPropagation();
  for (const el of [rail, drawer]) for (const t of ['mousedown', 'mouseup', 'click', 'dblclick', 'wheel', 'touchstart', 'touchmove', 'touchend', 'pointerdown', 'pointerup', 'keydown', 'keyup', 'keypress', 'contextmenu']) el.addEventListener(t, stopEv);

  // 메뉴 전환
  function openDrawer(k) {
    const cur = drawer.dataset.open;
    if (!k || (cur === k && !drawer.classList.contains('hide'))) { drawer.classList.add('hide'); drawer.dataset.open = ''; rail.querySelectorAll('.it').forEach(i => i.classList.remove('on')); return; }
    drawer.dataset.open = k; drawer.classList.remove('hide');
    drawer.querySelectorAll('[data-p]').forEach(p => p.style.display = p.dataset.p === k ? '' : 'none');
    rail.querySelectorAll('.it').forEach(i => i.classList.toggle('on', i.dataset.k === k));
  }
  rail.querySelectorAll('.it').forEach(it => it.onclick = () => { if (it.dataset.k === 'quit') { api.destroy(); return; } openDrawer(it.dataset.k); });
  drawer.querySelectorAll('[data-close]').forEach(b => b.onclick = () => openDrawer(null));

  // 높이층 선택
  const H_OPTS = [1.5, 10, 30, 60, 100];
  const hSel = new Set([1.5, 30]);
  $('hs').innerHTML = H_OPTS.map(h => `<span class="chip${hSel.has(h) ? ' on' : ''}" data-h="${h}">${h === 1.5 ? '1.5m 보행자' : h + 'm'}</span>`).join('');
  $('hs').querySelectorAll('.chip').forEach(c => c.onclick = () => { const h = +c.dataset.h; if (hSel.has(h)) { if (hSel.size > 1) hSel.delete(h); } else hSel.add(h); c.classList.toggle('on', hSel.has(h)); updResInfo(); });
  function updResInfo() {
    const L = $('rng').value === 'area' ? (state.area ? areaSize().L : 0) : +$('rng').value;
    const M = +$('res').value;
    $('res-info').textContent = L ? `격자 간격 약 ${(L / M).toFixed(1)}m · 높이층 ${hSel.size}개 · 예상 소요 ${M <= 128 ? '20~40' : M <= 180 ? '40~90' : '80~180'}초` : '영역을 먼저 그려 주세요.';
  }
  $('res').onchange = updResInfo; $('rng').onchange = () => { updResInfo(); updAreaInfo(); drawAreaBox(); };

  // 나침반 버튼
  $('compass').innerHTML = DIRS.map((n, i) => `<span data-d="${i * 22.5}" title="${n}풍 ${i * 22.5}°">${n}</span>`).join('');
  $('compass').querySelectorAll('span').forEach(s => s.onclick = () => { $('dir').value = Math.round(+s.dataset.d); $('uselive').checked = false; onWindInput(); });
  $('dir').oninput = () => { $('uselive').checked = false; onWindInput(); };
  $('spd').oninput = () => { $('uselive').checked = false; onWindInput(); };
  $('uselive').onchange = onWindInput;
  function onWindInput() {
    const d = ((+$('dir').value % 360) + 360) % 360;
    $('compass').querySelectorAll('span').forEach(s => s.classList.toggle('on', !$('uselive').checked && Math.abs(+s.dataset.d - d) < 0.1));
    updWindUse(); updHud();
  }
  function curWind() {
    if ($('uselive').checked && wind.source !== 'none') return { dir: wind.dir, spd: wind.spd, gust: wind.gust, label: (wind.source === 'forecast' ? '예보 ' : '실시간 ') + wind.time };
    return { dir: ((+$('dir').value % 360) + 360) % 360, spd: Math.max(0.5, +$('spd').value || 3), gust: Math.max(0.5, +$('spd').value || 3) * 1.5, label: '직접 지정' };
  }
  function updWindUse() { const w = curWind(); $('wind-use').textContent = `${dirName(w.dir)}풍 ${Math.round(w.dir)}° · ${w.spd.toFixed(1)} m/s (${w.label})`; }

  function arrowSvg(dir) {
    // 바람이 불어가는 방향으로 화살표
    const rot = dir + 180;
    return `<circle r="18" fill="rgba(255,255,255,.04)" stroke="rgba(255,255,255,.25)"/><text y="-11" text-anchor="middle" font-size="7" fill="#9fb0c4">N</text>
      <g transform="rotate(${rot})"><path d="M0 -13 L5 3 L1.6 1.5 L1.6 12 L-1.6 12 L-1.6 1.5 L-5 3 Z" fill="#5fd0ff"/></g>`;
  }
  function updHud() {
    const w = curWind();
    $('hud-arrow').innerHTML = arrowSvg(w.dir);
    $('hud-1').textContent = `${dirName(w.dir)}풍 ${Math.round(w.dir)}° · ${w.spd.toFixed(1)} m/s`;
    const L = state.layers[state.curLayer];
    $('hud-2').textContent = `${w.label}${w.gust ? ` · 돌풍 ${w.gust.toFixed(1)} m/s` : ''}${L && L.ux ? ` · 표시: ${L.h}m 높이층` : ''}`;
  }

  // ================= 실시간 기상 =================
  let wxTimer = null;
  async function loadWeather() {
    const c = (E.controls && E.controls.target) ? E.controls.target : { x: 0, y: 0 };
    const ll = toLL(c.x, c.y);
    $('wx-sub').textContent = '불러오는 중…';
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${ll.lat.toFixed(4)}&longitude=${ll.lon.toFixed(4)}&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m,temperature_2m&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m&forecast_days=2&wind_speed_unit=ms&timezone=Asia%2FSeoul`;
      const r = await fetch(url); const j = await r.json();
      const cu = j.current;
      if (!cu || cu.wind_speed_10m == null) throw new Error('값 없음');
      wind.dir = cu.wind_direction_10m; wind.spd = cu.wind_speed_10m; wind.gust = cu.wind_gusts_10m || cu.wind_speed_10m * 1.5;
      wind.source = 'live'; wind.time = cu.time.slice(11, 16); wind.temp = cu.temperature_2m;
      $('wx-main').textContent = `${dirName(wind.dir)}풍 ${wind.spd.toFixed(1)} m/s`;
      $('wx-sub').textContent = `풍향 ${Math.round(wind.dir)}° · 돌풍 ${wind.gust.toFixed(1)} m/s · 기온 ${wind.temp}℃`;
      $('wx-time').textContent = `${cu.time.replace('T', ' ')} 기준 · 위치 ${ll.lat.toFixed(3)}, ${ll.lon.toFixed(3)}`;
      $('wx-arrow').innerHTML = arrowSvg(wind.dir);
      const H = j.hourly; const nowIso = cu.time.slice(0, 13);
      let i0 = H.time.findIndex(t => t.slice(0, 13) >= nowIso); if (i0 < 0) i0 = 0;
      wind.hourly = [];
      for (let i = i0; i < Math.min(H.time.length, i0 + 24); i++) wind.hourly.push({ t: H.time[i], dir: H.wind_direction_10m[i], spd: H.wind_speed_10m[i], gust: H.wind_gusts_10m[i] });
      $('fc').innerHTML = wind.hourly.map((h, i) => `<div data-i="${i}"><span>${h.t.slice(5, 10).replace('-', '/')} ${h.t.slice(11, 16)}</span><span>${dirName(h.dir)}풍 ${Math.round(h.dir)}°</span><span>${h.spd.toFixed(1)} m/s</span></div>`).join('');
      $('fc').querySelectorAll('div').forEach(d => d.onclick = () => { const h = wind.hourly[+d.dataset.i]; wind.dir = h.dir; wind.spd = h.spd; wind.gust = h.gust; wind.source = 'forecast'; wind.time = h.t.slice(5, 16).replace('T', ' '); $('uselive').checked = true; onWindInput(); $('wx-main').textContent = `${dirName(h.dir)}풍 ${h.spd.toFixed(1)} m/s`; $('wx-sub').textContent = `예보 ${wind.time} 적용 중 · 돌풍 ${h.gust.toFixed(1)} m/s`; $('wx-arrow').innerHTML = arrowSvg(h.dir); });
    } catch (e) {
      $('wx-sub').textContent = '기상 정보를 불러오지 못했습니다. 직접 지정 값을 씁니다.';
      if (wind.source === 'none') $('uselive').checked = false;
    }
    onWindInput();
  }
  $('wx-reload').onclick = loadWeather;
  wxTimer = setInterval(() => { if (wind.source !== 'forecast') loadWeather(); }, 10 * 60 * 1000);

  // ================= 영역 그리기 =================
  const drawSt = { on: false, p0: null, down: null, prev: null };
  function areaSize() { const a = state.area; const w = Math.abs(a.x1 - a.x0), h = Math.abs(a.y1 - a.y0); const L = Math.min(2000, Math.max(150, Math.ceil(Math.max(w, h) + Math.max(80, Math.max(w, h) * 0.25)))); return { w, h, L, cx: (a.x0 + a.x1) / 2, cy: (a.y0 + a.y1) / 2 }; }
  function updAreaInfo() {
    if ($('rng').value === 'area') {
      if (state.area) { const s = areaSize(); $('area-info').textContent = `그린 영역 ${Math.round(s.w)}m × ${Math.round(s.h)}m (주변 포함 ${s.L}m 범위로 계산)`; }
      else $('area-info').textContent = '[영역 그리기]를 누르고 3D 모델 위에서 두 모서리를 클릭하세요.';
    } else $('area-info').textContent = '화면 가운데 지점을 중심으로 정사각형 범위를 분석합니다.';
  }
  $('draw').onclick = () => {
    if (drawSt.on) { endDraw(); return; }
    drawSt.on = true; drawSt.p0 = null; $('draw').textContent = '그리기 취소';
    hint.textContent = '3D 모델 위에서 영역의 첫 번째 모서리를 클릭하세요 (끌면 화면 회전)'; hint.style.display = 'block';
  };
  function endDraw() { drawSt.on = false; drawSt.p0 = null; $('draw').textContent = '영역 그리기'; hint.style.display = 'none'; removeObj('preview'); kick(); }
  const objs = {};
  function removeObj(k) { const o = objs[k]; if (!o) return; group.remove(o); o.traverse(c => { if (c.geometry) c.geometry.dispose(); if (c.material) { if (c.material.map) c.material.map.dispose(); c.material.dispose(); } }); delete objs[k]; }
  function setObj(k, o) { removeObj(k); objs[k] = o; group.add(o); o.updateMatrixWorld(true); }
  function rectLine(x0, y0, x1, y1, z, color) {
    const g = new THREE.Geometry();
    for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]) g.vertices.push(new THREE.Vector3(x, y, z));
    const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false }));
    l.frustumCulled = false; return l;
  }
  function onDown(ev) { if (!drawSt.on || ev.button !== 0 || (ev.target.closest && ev.target.closest('#kmw-drawer,#kmw-rail'))) return; drawSt.down = { x: ev.clientX, y: ev.clientY, t: performance.now() }; }
  function onUp(ev) {
    if (!drawSt.on || !drawSt.down) return;
    const d = drawSt.down; drawSt.down = null;
    if (Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > 5 || performance.now() - d.t > 600) return;
    const n = ndcOf(ev); if (!n.inside) return;
    const p = pickMesh(n.x, n.y); if (!p) { hint.textContent = '모델이 없는 곳입니다. 3D 모델 위를 클릭하세요.'; return; }
    if (!drawSt.p0) { drawSt.p0 = p; hint.textContent = '두 번째(대각선 반대쪽) 모서리를 클릭하세요'; return; }
    const p0 = drawSt.p0;
    state.area = { x0: Math.min(p0.x, p.x), y0: Math.min(p0.y, p.y), x1: Math.max(p0.x, p.x), y1: Math.max(p0.y, p.y), z: Math.min(p0.z, p.z) };
    if (state.area.x1 - state.area.x0 < 20 || state.area.y1 - state.area.y0 < 20) { state.area = null; hint.textContent = '영역이 너무 작습니다. 첫 모서리부터 다시 클릭하세요.'; drawSt.p0 = null; return; }
    $('rng').value = 'area'; endDraw(); updAreaInfo(); updResInfo(); drawAreaBox();
  }
  function drawAreaBox() {
    removeObj('area');
    if ($('rng').value === 'area' && state.area && !state.geo) { const a = state.area; setObj('area', rectLine(a.x0, a.y0, a.x1, a.y1, a.z + 2, 0xffd84a)); }
    kick();
  }

  // ================= 마우스 이동: 그리기 미리보기 + 지점 풍속 =================
  let lastMove = 0;
  function onMove(ev) {
    const now = performance.now(); if (now - lastMove < 60) return; lastMove = now;
    const n = ndcOf(ev);
    if (drawSt.on && drawSt.p0 && n.inside) {
      const q = rayPlane(n.x, n.y, drawSt.p0.z);
      if (q) { const p0 = drawSt.p0; setObj('preview', rectLine(p0.x, p0.y, q.x, q.y, p0.z + 2, 0xffd84a)); kick(); }
    }
    if (!n.inside || ev.target.closest && ev.target.closest('#kmw-drawer,#kmw-rail')) { tip.style.display = 'none'; return; }
    const G = state.geo; const L = state.layers[state.curLayer];
    if (!G || !L || !L.ux) { tip.style.display = 'none'; return; }
    const q = rayPlane(n.x, n.y, G.gz + L.h);
    if (!q) { tip.style.display = 'none'; return; }
    const e = q.x - G.cx, nn = q.y - G.cy;
    if (Math.abs(e) > G.L / 2 || Math.abs(nn) > G.L / 2) { tip.style.display = 'none'; return; }
    const ci = cellOf(e, nn); let html;
    if (L.obsW[ci]) html = `<b>${L.h}m 높이층</b><br>건물 내부 (바람 막힘)`;
    else {
      const v = fieldAt(L, e, nn); const r = Math.hypot(v[0], v[1]);
      const deg = (Math.atan2(-v[0], -v[1]) / DEG + 360) % 360; // 불어오는 방향
      const grade = r < 0.3 ? '정체' : r < 0.7 ? '약풍' : r < 1.2 ? '양호' : r < 1.6 ? '강해짐' : '강풍';
      html = `<b>${L.h}m 높이층</b> · ${grade}<br>풍속 ${(r * L.Uin).toFixed(1)} m/s (풍속비 ${r.toFixed(2)})<br>흐름 방향: ${dirName(deg)}풍 ${Math.round(deg)}°` + (L.veg[ci] ? '<br>수목 구역 (바람 일부 통과)' : '');
    }
    if (state.morph && view.morph) { const b = morphAt(e, nn); if (b) html += `<br>구획 거칠기 길이 ${b.z0.toFixed(2)}m · ${b.label}`; }
    tip.innerHTML = html; tip.style.display = 'block'; tip.style.left = (ev.clientX + 14) + 'px'; tip.style.top = (ev.clientY + 12) + 'px';
  }
  // 이 뷰어는 포인터 이벤트 기본 동작을 막아 마우스 이벤트가 오지 않으므로 포인터 이벤트 사용
  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointermove', onMove, { passive: true, capture: true });

  // ================= 메시 캡처 (높이·색상) =================
  const heightMat = new THREE.ShaderMaterial({
    uniforms: { zMin: { type: 'f', value: 0 }, zRng: { type: 'f', value: 800 } },
    vertexShader: 'uniform float zMin; uniform float zRng; varying float vD; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vD = (w.z - zMin)/zRng; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: 'precision highp float; varying float vD; void main(){ float d = clamp(vD, 0.0, 0.999); float h = floor(d*255.0); float l = floor(fract(d*255.0)*255.0); gl_FragColor = vec4(h/255.0, l/255.0, 1.0, 1.0); }',
    side: THREE.DoubleSide
  });
  function lodSignature() {
    let nObj = 0, nMesh = 0;
    E.root.traverse(o => { nObj++; if (o instanceof THREE.Mesh) nMesh++; });
    return { sig: nObj + ':' + nMesh, busy: AC3D.toProcessGeometries.length + AC3D.toProcessImages.length + E.root.downloadQueue.length };
  }
  async function captureMesh(cx, cy, L, pxWant, gz, prog, isCancelled) {
    const S = clamp(Math.ceil(L / pxWant), 256, 2048);
    const vc = new THREE.PerspectiveCamera(40, 1, 1, 100000);
    const H = (L / 2) / Math.tan(20 * DEG) * 1.12;
    vc.position.set(cx, cy, gz + H); vc.up.set(0, 1, 0); vc.lookAt(new THREE.Vector3(cx, cy, gz)); vc.updateMatrixWorld(true);
    vc.matrixWorldInverse.getInverse(vc.matrixWorld);
    const fr = new THREE.Frustum(); fr.setFromMatrix(new THREE.Matrix4().multiplyMatrices(vc.projectionMatrix, vc.matrixWorldInverse));
    const lodH = clamp(S * 1.12, 700, 2600);
    group.visible = false;
    state.capturing = true;
    const hidden = [];
    try {
      const t0 = performance.now(); let lastSig = '', stableAt = performance.now();
      while (true) {
        if (isCancelled()) throw new Error('중지됨');
        for (let k = 0; k < 8; k++) ROOTPROTO.updateLODTree.call(E.root, fr, vc.matrixWorldInverse, vc.projectionMatrix.elements[5], lodH, lodH * 1.414, vc.near);
        await sleep(16);
        const s = lodSignature(); const el = performance.now() - t0;
        if (s.sig !== lastSig || s.busy > 0) { lastSig = s.sig; stableAt = performance.now(); }
        prog(Math.min(1, el / 15000), s);
        if ((performance.now() - stableAt > 1200 && el > 1500) || el > 25000) break;
      }
      // 마지막으로 한 번 더 갱신해 화면 표시 상태 확정
      for (let k = 0; k < 30; k++) ROOTPROTO.updateLODTree.call(E.root, fr, vc.matrixWorldInverse, vc.projectionMatrix.elements[5], lodH, lodH * 1.414, vc.near);
      const R = E.R, gl = E.gl, scene = E.scene;
      scene.children.forEach(c => { if (c instanceof THREE.PointCloud && c.visible) { c.visible = false; hidden.push(c); } });
      const oc = new THREE.OrthographicCamera(-L / 2, L / 2, L / 2, -L / 2, 1, 5000);
      oc.position.set(cx, cy, gz + 2500); oc.up.set(0, 1, 0); oc.lookAt(new THREE.Vector3(cx, cy, gz)); oc.updateMatrixWorld(true);
      const rt = new THREE.WebGLRenderTarget(S, S, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, format: THREE.RGBAFormat, type: THREE.UnsignedByteType, generateMipmaps: false });
      const cc = R.getClearColor().clone(), ca = R.getClearAlpha();
      const zMin = gz - 100, zRng = 900;
      heightMat.uniforms.zMin.value = zMin; heightMat.uniforms.zRng.value = zRng;
      R.setClearColor(0x000000, 0);
      scene.overrideMaterial = heightMat;
      R.render(scene, oc, rt, true);
      scene.overrideMaterial = null;
      const hb = new Uint8Array(S * S * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, rt.__webglFramebuffer); gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, hb);
      R.setClearColor(0x000000, 0);
      R.render(scene, oc, rt, true);
      const cb = new Uint8Array(S * S * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, rt.__webglFramebuffer); gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, cb);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      R.setClearColor(cc, ca);
      rt.dispose();
      // 디코딩: 행 0 = 남쪽
      const hm = new Float32Array(S * S);
      for (let i = 0; i < S * S; i++) hm[i] = hb[i * 4 + 2] < 128 ? NaN : zMin + (hb[i * 4] + hb[i * 4 + 1] / 255) / 255 * zRng;
      return { S, hm, col: cb };
    } finally {
      scene_restore(hidden);
      state.capturing = false; group.visible = true;
    }
    function scene_restore(h) { h.forEach(c => c.visible = true); }
  }

  // 지면 높이 추정 (형태학적 열림 연산)
  //  - 셀 최저값의 3x3 중앙값으로 구멍 잡음 제거
  //  - 건물보다 큰 창(약 60m)으로 최솟값 → 최댓값 필터: 건물은 지워지고 넓은 지형 단차(호숫가·제방)는 유지
  //  - 더 큰 창(약 180m) 결과보다 6m 이상 높은 넓은 대지(대형 건물 지붕)는 큰 창 값으로 대체
  function minMaxFilter(src, M, r, isMin) {
    const tmp = new Float32Array(M * M), out = new Float32Array(M * M);
    for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
      let v = isMin ? Infinity : -Infinity; const x0 = Math.max(0, x - r), x1 = Math.min(M - 1, x + r);
      for (let i = x0; i <= x1; i++) { const s = src[y * M + i]; v = isMin ? (s < v ? s : v) : (s > v ? s : v); }
      tmp[y * M + x] = v;
    }
    for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
      let v = isMin ? Infinity : -Infinity; const y0 = Math.max(0, y - r), y1 = Math.min(M - 1, y + r);
      for (let j = y0; j <= y1; j++) { const s = tmp[j * M + x]; v = isMin ? (s < v ? s : v) : (s > v ? s : v); }
      out[y * M + x] = v;
    }
    return out;
  }
  function boxBlur(src, M, r) {
    const out = new Float32Array(M * M);
    for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
      let s = 0, n = 0;
      for (let j = Math.max(0, y - r); j <= Math.min(M - 1, y + r); j++) for (let i = Math.max(0, x - r); i <= Math.min(M - 1, x + r); i++) { s += src[j * M + i]; n++; }
      out[y * M + x] = s / n;
    }
    return out;
  }
  function estimateDTM(low, M, dx, water) {
    // 빈 셀 채우기 + 구멍 잡음 제거
    const vals = []; for (let c = 0; c < M * M; c++) if (!isNaN(low[c]) && !(water && water[c])) vals.push(low[c]);
    vals.sort((a, b) => a - b);
    const med = vals.length ? vals[Math.floor(vals.length / 2)] : 0;
    const f0 = new Float32Array(M * M);
    for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
      const nb = [];
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) { const xx = x + i, yy = y + j; if (xx < 0 || yy < 0 || xx >= M || yy >= M) continue; const v = low[yy * M + xx]; if (!isNaN(v)) nb.push(v); }
      if (nb.length) { nb.sort((a, b) => a - b); f0[y * M + x] = nb[nb.length >> 1]; } else f0[y * M + x] = NaN;
    }
    // 남은 빈 셀은 주변 값으로 몇 차례 확산, 그래도 없으면 중앙값
    for (let it = 0; it < 6; it++) {
      let any = false;
      for (let c = 0; c < M * M; c++) if (isNaN(f0[c])) {
        const x = c % M, y = (c / M) | 0; let s = 0, n = 0;
        for (const [i, j] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const xx = x + i, yy = y + j; if (xx < 0 || yy < 0 || xx >= M || yy >= M) continue; const v = f0[yy * M + xx]; if (!isNaN(v)) { s += v; n++; } }
        if (n) f0[c] = s / n; else any = true;
      }
      if (!any) break;
    }
    for (let c = 0; c < M * M; c++) if (isNaN(f0[c])) f0[c] = med;
    // 수면은 최솟값 필터에서 빼서(무한대) 호수 때문에 주변 지면이 낮게 잡히지 않게 함
    const r1 = Math.max(2, Math.round(35 / dx));
    const fw = new Float32Array(M * M); for (let c = 0; c < M * M; c++) fw[c] = (water && water[c]) ? Infinity : f0[c];
    const er = minMaxFilter(fw, M, r1, true);
    for (let c = 0; c < M * M; c++) if (!isFinite(er[c])) er[c] = f0[c];
    const g = minMaxFilter(er, M, r1, false);
    // 가장자리에 걸친 대형 건물 등: 더 넓은 주변 최저 지면보다 15m 이상 높은 지면은 잘라냄
    const er2 = minMaxFilter(fw, M, Math.max(r1 + 2, Math.round(90 / dx)), true);
    const capA = new Float32Array(M * M);
    for (let c = 0; c < M * M; c++) { const cap = (isFinite(er2[c]) ? er2[c] : (isFinite(med) ? med : f0[c])) + 15; capA[c] = cap; if (g[c] > cap) g[c] = cap; }
    const out = boxBlur(boxBlur(g, M, Math.max(1, Math.round(6 / dx))), M, Math.max(1, Math.round(6 / dx)));
    return { dtm: out, med, surf: f0, cap: capA };
  }
  // (이전 방식: 구획별 하위 백분위) — 참고용으로 남김
  function estimateDTM_block(low, M, dx) {
    const B = Math.max(4, Math.round(30 / dx));
    const nb = Math.ceil(M / B);
    const blk = new Float32Array(nb * nb).fill(NaN);
    const all = [];
    for (let by = 0; by < nb; by++) for (let bx = 0; bx < nb; bx++) {
      const vals = [];
      for (let y = by * B; y < Math.min(M, (by + 1) * B); y++) for (let x = bx * B; x < Math.min(M, (bx + 1) * B); x++) { const v = low[y * M + x]; if (!isNaN(v)) vals.push(v); }
      if (vals.length >= B) { vals.sort((a, b) => a - b); const g = vals[Math.floor(vals.length * 0.1)]; blk[by * nb + bx] = g; all.push(g); }
    }
    all.sort((a, b) => a - b);
    const med = all.length ? all[Math.floor(all.length / 2)] : 0;
    const g2 = new Float32Array(nb * nb);
    for (let by = 0; by < nb; by++) for (let bx = 0; bx < nb; bx++) {
      const vs = [];
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) { const x = bx + i, y = by + j; if (x >= 0 && y >= 0 && x < nb && y < nb && !isNaN(blk[y * nb + x])) vs.push(blk[y * nb + x]); }
      vs.sort((a, b) => a - b);
      g2[by * nb + bx] = vs.length ? vs[Math.min(1, vs.length - 1)] : med;
    }
    const out = new Float32Array(M * M);
    for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
      const fx = clamp((x + 0.5) / B - 0.5, 0, nb - 1.001), fy = clamp((y + 0.5) / B - 0.5, 0, nb - 1.001);
      const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(nb - 1, x0 + 1), y1 = Math.min(nb - 1, y0 + 1), ax = fx - x0, ay = fy - y0;
      out[y * M + x] = g2[y0 * nb + x0] * (1 - ax) * (1 - ay) + g2[y0 * nb + x1] * ax * (1 - ay) + g2[y1 * nb + x0] * (1 - ax) * ay + g2[y1 * nb + x1] * ax * ay;
    }
    return { dtm: out, med };
  }

  // ================= 격자 볼츠만 계산 (작업 스레드) =================
  const workerSrc = `
  let stopFlag = false;
  onmessage = e => { if (e.data.cmd === 'stop') { stopFlag = true; return; } run(e.data); };
  function run(d) {
    const { Nx, Ny, solid, drag, ent, u0, tau0, Cs, steps, avgFrom, reportEvery } = d;
    const N = Nx * Ny;
    const ex = [0,1,0,-1,0,1,-1,-1,1], ey = [0,0,1,0,-1,1,1,-1,-1];
    const w = [4/9,1/9,1/9,1/9,1/9,1/36,1/36,1/36,1/36];
    const opp = [0,3,4,1,2,7,8,5,6];
    let f = new Float32Array(9 * N), g = new Float32Array(9 * N);
    const ux = new Float32Array(N), uy = new Float32Array(N);
    const sx = new Float64Array(N), sy = new Float64Array(N); let nAvg = 0;
    const eq = (i, r, u, v) => { const eu = ex[i]*u + ey[i]*v; return w[i]*r*(1 + 3*eu + 4.5*eu*eu - 1.5*(u*u + v*v)); };
    for (let c = 0; c < N; c++) { for (let i = 0; i < 9; i++) f[i*N + c] = solid[c] ? w[i] : eq(i, 1, u0, 0); ux[c] = solid[c] ? 0 : u0; }
    const fin = new Float64Array(9); for (let i = 0; i < 9; i++) fin[i] = eq(i, 1, u0, 0);
    const fl = new Float64Array(9), fq = new Float64Array(9);
    const C18 = 18 * Math.SQRT2 * Cs * Cs;
    for (let t = 1; t <= steps; t++) {
      if (stopFlag) { postMessage({ type: 'stopped' }); return; }
      for (let y = 0; y < Ny; y++) {
        for (let x = 0; x < Nx; x++) {
          const c = y * Nx + x;
          if (solid[c]) continue;
          const edgeIn = (x === 0 || y === 0 || y === Ny - 1);
          const edgeOut = (x === Nx - 1);
          if (edgeIn) { for (let i = 0; i < 9; i++) fl[i] = fin[i]; }
          else if (edgeOut) { const cc = c - 1; const u = ux[cc], v = uy[cc]; for (let i = 0; i < 9; i++) fl[i] = eq(i, 1, u, v); }
          else {
            let r = 0, mx = 0, my = 0;
            for (let i = 0; i < 9; i++) { const v = f[i*N + c]; fl[i] = v; r += v; mx += v*ex[i]; my += v*ey[i]; }
            if (!(r > 0.2 && r < 5)) { postMessage({ type: 'error', msg: 'unstable' }); return; }
            let u = mx / r, v = my / r;
            const sp = Math.sqrt(u*u + v*v); if (sp > 0.35) { u *= 0.35/sp; v *= 0.35/sp; }
            ux[c] = u; uy[c] = v;
            let pxx = 0, pyy = 0, pxy = 0;
            for (let i = 0; i < 9; i++) { const q = eq(i, r, u, v); fq[i] = q; const ne = fl[i] - q; pxx += ne*ex[i]*ex[i]; pyy += ne*ey[i]*ey[i]; pxy += ne*ex[i]*ey[i]; }
            const Q = Math.sqrt(pxx*pxx + pyy*pyy + 2*pxy*pxy);
            const tau = 0.5 * (tau0 + Math.sqrt(tau0*tau0 + C18 * Q / r));
            const om = 1 / tau;
            for (let i = 0; i < 9; i++) fl[i] = fl[i] - om * (fl[i] - fq[i]);
            const kd = drag[c], en = ent[c];
            if (kd > 0 || en > 0) {
              const u2 = (u + en * (u0 - u)) * (1 - kd), v2 = (v - en * v) * (1 - kd);
              for (let i = 0; i < 9; i++) fl[i] += eq(i, r, u2, v2) - fq[i];
            }
          }
          for (let i = 0; i < 9; i++) {
            const nx = x + ex[i], ny = y + ey[i];
            if (nx < 0 || ny < 0 || nx >= Nx || ny >= Ny) continue;
            const nc = ny * Nx + nx;
            if (solid[nc]) g[opp[i]*N + c] = fl[i]; else g[i*N + nc] = fl[i];
          }
        }
      }
      const tmp = f; f = g; g = tmp;
      if (t >= avgFrom) { for (let c = 0; c < N; c++) { sx[c] += ux[c]; sy[c] += uy[c]; } nAvg++; }
      if (t % reportEvery === 0 || t === steps) {
        const ox = new Float32Array(N), oy = new Float32Array(N);
        if (nAvg > 0) { for (let c = 0; c < N; c++) { ox[c] = sx[c] / nAvg / u0; oy[c] = sy[c] / nAvg / u0; } }
        else { for (let c = 0; c < N; c++) { ox[c] = ux[c] / u0; oy[c] = uy[c] / u0; } }
        postMessage({ type: t === steps ? 'done' : 'progress', t, steps, averaged: nAvg > 0, ux: ox, uy: oy }, [ox.buffer, oy.buffer]);
      }
    }
  }`;
  const workerURL = URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' }));

  // ================= 색상 =================
  const STOPS = [[0, [30, 40, 120]], [0.3, [40, 110, 220]], [0.7, [60, 200, 200]], [1.0, [120, 220, 80]], [1.2, [250, 210, 40]], [1.6, [230, 60, 40]]];
  function colorOf(r) {
    if (r <= 0) return STOPS[0][1];
    for (let i = 1; i < STOPS.length; i++) if (r <= STOPS[i][0]) {
      const [a, ca] = STOPS[i - 1], [b, cb] = STOPS[i]; const t = (r - a) / (b - a);
      return [ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t];
    }
    return STOPS[STOPS.length - 1][1];
  }
  $('legend').style.background = `linear-gradient(90deg,${STOPS.map(([v, c]) => `rgb(${c.join(',')}) ${(v / 1.6 * 100).toFixed(0)}%`).join(',')})`;

  // ================= 격자 표본 추출 =================
  function cellOf(e, n) { const G = state.geo; const ix = clamp(Math.floor((e + G.L / 2) / G.dx), 0, G.M - 1), iy = clamp(Math.floor((G.L / 2 - n) / G.dx), 0, G.M - 1); return iy * G.M + ix; }
  function dtmAt(e, n) { const G = state.geo; return G.dtm[cellOf(e, n)]; }
  function fieldAt(L, e, n) {
    const G = state.geo;
    const s = e * G.fx + n * G.fy, t = e * G.nx + n * G.ny;
    const x = s / G.dx + L.Nx / 2 - 0.5, y = t / G.dx + L.Ny / 2 - 0.5;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    if (x0 < 0 || y0 < 0 || x0 >= L.Nx - 1 || y0 >= L.Ny - 1) return [0, 0];
    const ax = x - x0, ay = y - y0; let u = 0, v = 0, ws = 0;
    const c0 = y0 * L.Nx + x0, c1 = c0 + 1, c2 = c0 + L.Nx, c3 = c2 + 1, S_ = L.solid, UX = L.ux, UY = L.uy;
    let w = (1 - ax) * (1 - ay); if (!S_[c0]) { u += UX[c0] * w; v += UY[c0] * w; ws += w; }
    w = ax * (1 - ay); if (!S_[c1]) { u += UX[c1] * w; v += UY[c1] * w; ws += w; }
    w = (1 - ax) * ay; if (!S_[c2]) { u += UX[c2] * w; v += UY[c2] * w; ws += w; }
    w = ax * ay; if (!S_[c3]) { u += UX[c3] * w; v += UY[c3] * w; ws += w; }
    if (ws < 1e-6) return [0, 0];
    u /= ws; v /= ws;
    return [u * G.fx + v * G.nx, u * G.fy + v * G.ny];
  }

  // ================= 분석 실행 =================
  function setStatus(t, p) { $('status').textContent = t; if (p != null) $('bar').style.width = clamp(p, 0, 100) + '%'; }
  function setRunning(r) { state.running = r; $('run').disabled = r; $('stop').disabled = !r; }
  function stopWorkers() { state.workers.forEach(w => { try { w.terminate(); } catch (e) { } }); state.workers = []; }

  async function runAnalysis() {
    if (state.running) return;
    if (drawSt.on) endDraw();
    clearResults(); setRunning(true);
    let cancelled = false; state.cancel = () => { cancelled = true; };
    const isCancelled = () => cancelled;
    const T0 = performance.now();
    try {
      const w = curWind();
      const dir = Math.round(w.dir), U10 = Math.max(0.3, w.spd);
      const M = +$('res').value, pxWant = +$('q').value;
      const heights = [...hSel].sort((a, b) => a - b);
      let cx, cy, L, gz, mask = null, areaLabel;
      setStatus('분석 중심 찾는 중', 1);
      if ($('rng').value === 'area') {
        if (!state.area) throw new Error('먼저 [영역 그리기]로 분석할 영역을 그려 주세요.');
        const s = areaSize(); cx = s.cx; cy = s.cy; L = s.L; gz = state.area.z;
        areaLabel = `그린 영역 ${Math.round(s.w)}m × ${Math.round(s.h)}m`;
      } else {
        L = +$('rng').value;
        const p = pickMesh(0, 0) || (E.controls && E.controls.target ? E.controls.target.clone() : null);
        if (!p) throw new Error('화면 가운데에서 3D 모델을 찾지 못했습니다. 모델이 화면 가운데 오도록 옮겨 주세요.');
        cx = p.x; cy = p.y; gz = p.z;
        areaLabel = `화면 중심 ${L}m × ${L}m`;
      }
      // 1) 메시 캡처
      const cap = await captureMesh(cx, cy, L, pxWant, gz, (f, s) => setStatus(`상세 메시 불러오는 중 (대기 ${s.busy}건)`, 2 + f * 18), isCancelled);
      setStatus('높이·색상 지도 처리 중', 21); await nextFrame();
      const { S, hm, col } = cap;
      if (api.debug) state.lastCap = { ...cap, cx, cy, L };
      const dx = L / M;
      // 2) 셀 단위 요약 (iy=0 이 북쪽)
      const N2 = M * M;
      const zmax = new Float32Array(N2).fill(NaN), zlow = new Float32Array(N2).fill(NaN), cnt = new Uint16Array(N2), vegC = new Uint16Array(N2), watC = new Uint16Array(N2);
      const cellIdx = new Int32Array(S * S);
      for (let sy = 0; sy < S; sy++) {
        const iy = M - 1 - Math.floor(sy * M / S);
        for (let sx = 0; sx < S; sx++) {
          const ix = Math.floor(sx * M / S); const c = iy * M + ix; const i = sy * S + sx; cellIdx[i] = c;
          const z = hm[i]; if (isNaN(z)) continue;
          cnt[c]++;
          if (!(zmax[c] >= z)) zmax[c] = z;
          if (!(zlow[c] <= z)) zlow[c] = z;
          const r = col[i * 4], g = col[i * 4 + 1], b = col[i * 4 + 2];
          if (g > r + 6 && g > b + 2 && (2 * g - r - b) > 22) vegC[c]++;
          // 수면: 짙은 청록색 (색상각 120~200°, 채도 0.12 이상, 밝기 130 이하)
          const mx = r > g ? (r > b ? r : b) : (g > b ? g : b), mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
          if (mx <= 130 && mx > mn && (mx - mn) >= 0.12 * mx) {
            let hh; if (mx === g) hh = 60 * ((b - r) / (mx - mn) + 2); else if (mx === b) hh = 60 * ((r - g) / (mx - mn) + 4); else hh = -1;
            if (hh >= 120 && hh <= 200) watC[c]++;
          }
        }
      }
      let dataN = 0; for (let c = 0; c < N2; c++) if (cnt[c]) dataN++;
      if (dataN < N2 * 0.1) throw new Error('이 범위에서 3D 모델 메시를 거의 찾지 못했습니다. 모델이 있는 곳으로 옮겨 다시 시도해 주세요.');
      const water = new Uint8Array(N2); let watN = 0;
      for (let c = 0; c < N2; c++) if (cnt[c] && watC[c] >= cnt[c] * 0.5) { water[c] = 1; watN++; }
      const { dtm, med: gMed, surf, cap: dtmCap } = estimateDTM(zlow, M, dx, water);
      for (let c = 0; c < N2; c++) if (isNaN(zmax[c])) zmax[c] = dtm[c];
      // 지형 둔덕 보정: 높은 덩어리 중 경계에서 높이가 완만하게 오르는 것(섬·조경 둔덕·제방)은 지면으로 처리
      {
        const hi = new Uint8Array(N2), lab = new Int32Array(N2); let lb = 0, fixedN = 0;
        for (let c = 0; c < N2; c++) if (cnt[c] && surf[c] - dtm[c] > 2.0) hi[c] = 1;
        for (let s0 = 0; s0 < N2; s0++) {
          if (!hi[s0] || lab[s0]) continue;
          lb++; const st = [s0], comp = []; lab[s0] = lb;
          while (st.length) { const q = st.pop(); comp.push(q); const x = q % M, y = (q / M) | 0;
            for (const r of [x > 0 ? q - 1 : -1, x < M - 1 ? q + 1 : -1, y > 0 ? q - M : -1, y < M - 1 ? q + M : -1]) if (r >= 0 && hi[r] && !lab[r]) { lab[r] = lb; st.push(r); } }
          if (comp.length < 6) continue;
          let jS = 0, jN = 0; const hs = [];
          for (const q of comp) {
            hs.push(surf[q] - dtm[q]);
            const x = q % M, y = (q / M) | 0;
            for (const r of [x > 0 ? q - 1 : -1, x < M - 1 ? q + 1 : -1, y > 0 ? q - M : -1, y < M - 1 ? q + M : -1]) if (r >= 0 && lab[r] !== lb && !water[r]) { jS += Math.max(0, surf[q] - surf[r]); jN++; }
          }
          hs.sort((a, b) => a - b); const H90 = hs[Math.floor(hs.length * 0.9)];
          const ratio = jN ? jS / jN / Math.max(0.5, H90) : 1;
          if (H90 < 15 && ratio < 0.4) { for (const q of comp) dtm[q] = surf[q]; fixedN += comp.length; }
        }
        state.terrainFixed = fixedN;
        for (let c = 0; c < N2; c++) if (dtm[c] > dtmCap[c]) dtm[c] = dtmCap[c];
      }
      const vegFrac = new Float32Array(N2); for (let c = 0; c < N2; c++) vegFrac[c] = cnt[c] ? vegC[c] / cnt[c] : 0;
      const hgt = new Float32Array(N2); for (let c = 0; c < N2; c++) hgt[c] = Math.max(0, zmax[c] - dtm[c]);
      // 높이층별 메시 단면 점유율 (서브픽셀 단위)
      const thr = heights.map(h => Math.max(h, 2.5));
      const above = heights.map(() => new Uint16Array(N2));
      for (let i = 0; i < S * S; i++) {
        const z = hm[i]; if (isNaN(z)) continue; const c = cellIdx[i]; const dz = z - dtm[c];
        for (let k = 0; k < thr.length; k++) if (dz > thr[k]) above[k][c]++;
      }
      // 영역 마스크
      mask = new Uint8Array(N2).fill(1);
      if ($('rng').value === 'area') {
        const a = state.area;
        for (let iy = 0; iy < M; iy++) for (let ix = 0; ix < M; ix++) {
          const e = -L / 2 + (ix + 0.5) * dx, n = L / 2 - (iy + 0.5) * dx;
          const x = cx + e, y = cy + n; mask[iy * M + ix] = (x >= a.x0 && x <= a.x1 && y >= a.y0 && y <= a.y1) ? 1 : 0;
        }
      }
      // 회전 격자 (유입: x=0)
      const to = (dir + 180) * DEG; const fx = Math.sin(to), fy = Math.cos(to); const nx = -fy, ny = fx;
      state.geo = { cx, cy, L, M, dx, gz: gMed, dtm, hgt, vegFrac, cnt, mask, water, waterRatio: watN / Math.max(1, dataN), fx, fy, nx, ny, dir, U10, gust: w.gust, windLabel: w.label, areaLabel, S };
      removeObj('area'); drawFrame();
      const span = L * (Math.abs(Math.cos(dir * DEG)) + Math.abs(Math.sin(dir * DEG)));
      const base = Math.ceil(span / dx); const Nx = base + 36, Ny = base + 12;
      // 3) 층별 장애물 구성
      const jobs = heights.map((h, k) => {
        const high = new Uint8Array(N2), isVeg = new Uint8Array(N2);
        for (let c = 0; c < N2; c++) if (cnt[c] && above[k][c] >= cnt[c] * 0.5) high[c] = 1;
        for (let c = 0; c < N2; c++) if (high[c] && vegFrac[c] >= 0.4 && hgt[c] < 30) isVeg[c] = 1;
        const obs = new Uint8Array(N2), dragM = new Float32Array(N2), lab = new Int32Array(N2);
        const minCells = Math.max(1, Math.round(40 / (dx * dx))); let lb = 0;
        for (let s0 = 0; s0 < N2; s0++) {
          if (!high[s0] || isVeg[s0] || lab[s0]) continue;
          lb++; const stack = [s0], comp = []; lab[s0] = lb;
          while (stack.length) {
            const q = stack.pop(); comp.push(q); const x = q % M, y = (q / M) | 0;
            if (x > 0) { const r = q - 1; if (high[r] && !isVeg[r] && !lab[r]) { lab[r] = lb; stack.push(r); } }
            if (x < M - 1) { const r = q + 1; if (high[r] && !isVeg[r] && !lab[r]) { lab[r] = lb; stack.push(r); } }
            if (y > 0) { const r = q - M; if (high[r] && !isVeg[r] && !lab[r]) { lab[r] = lb; stack.push(r); } }
            if (y < M - 1) { const r = q + M; if (high[r] && !isVeg[r] && !lab[r]) { lab[r] = lb; stack.push(r); } }
          }
          const solidComp = comp.length >= minCells;
          for (const q of comp) { if (solidComp) obs[q] = 1; else dragM[q] = 0.03; }
        }
        for (let c = 0; c < N2; c++) if (high[c] && isVeg[c]) dragM[c] = h < 3 ? 0.008 : 0.022;
        // 위쪽 공기 섞임(개방도 기반)
        const Rr = Math.max(2, Math.round(15 / dx));
        const integ = new Float64Array((M + 1) * (M + 1));
        for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) integ[(y + 1) * (M + 1) + x + 1] = (obs[y * M + x] ? 0 : 1) + integ[y * (M + 1) + x + 1] + integ[(y + 1) * (M + 1) + x] - integ[y * (M + 1) + x];
        const entM = new Float32Array(N2); const entK = 0.004 * (1 + Math.min(2, h / 40));
        for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
          const x0 = Math.max(0, x - Rr), y0 = Math.max(0, y - Rr), x1 = Math.min(M, x + Rr + 1), y1 = Math.min(M, y + Rr + 1);
          const open = (integ[y1 * (M + 1) + x1] - integ[y0 * (M + 1) + x1] - integ[y1 * (M + 1) + x0] + integ[y0 * (M + 1) + x0]) / ((x1 - x0) * (y1 - y0));
          entM[y * M + x] = entK * open * open;
        }
        const solid = new Uint8Array(Nx * Ny), drag = new Float32Array(Nx * Ny), ent = new Float32Array(Nx * Ny).fill(entK);
        for (let y = 1; y < Ny - 1; y++) for (let x = 1; x < Nx - 1; x++) {
          const s = (x + 0.5 - Nx / 2) * dx, t = (y + 0.5 - Ny / 2) * dx;
          const e = s * fx + t * nx, n = s * fy + t * ny;
          const ix = Math.floor((e + L / 2) / dx), iy = Math.floor((L / 2 - n) / dx);
          if (ix < 0 || iy < 0 || ix >= M || iy >= M) continue;
          const q = iy * M + ix;
          if (obs[q]) solid[y * Nx + x] = 1;
          drag[y * Nx + x] = dragM[q]; ent[y * Nx + x] = entM[q];
        }
        const Uin = U10 * Math.pow(Math.max(h, 2) / 10, 0.28);
        let oN = 0, vN = 0, dN = 0;
        for (let c = 0; c < N2; c++) if (mask[c] && cnt[c]) { dN++; if (obs[c]) oN++; else if (isVeg[c] && high[c]) vN++; }
        return { h, Nx, Ny, solid, drag, ent, obsW: obs, veg: isVeg, Uin, obsRatio: oN / Math.max(1, dN), vegRatio: vN / Math.max(1, dN), ux: null, uy: null, pct: 0 };
      });
      state.layers = jobs; state.curLayer = 0;
      buildLayerChips();
      // 바람길 형태 지표
      computeMorph();
      // 4) LBM 병렬 계산
      const u0 = 0.1, steps = Math.round(1.6 * Nx / u0), avgFrom = Math.round(steps * 0.5);
      const par = Math.max(1, Math.min(jobs.length, (navigator.hardwareConcurrency || 4) - 2, 4));
      const tStart = performance.now();
      const updProg = () => {
        const p = jobs.reduce((a, j) => a + j.pct, 0) / jobs.length;
        const el = (performance.now() - tStart) / 1000; const remain = p > 0.02 ? el / p * (1 - p) : 0;
        setStatus(`바람 흐름 계산 중 ${Math.round(p * 100)}% (${jobs.map(j => `${j.h}m ${Math.round(j.pct * 100)}%`).join(' · ')}${remain ? ` · 남은 시간 약 ${Math.ceil(remain)}초` : ''})`, 24 + 76 * p);
      };
      let nextJob = 0; const lastHeat = {};
      await new Promise((resolve, reject) => {
        let active = 0, done = 0, failed = false;
        const launch = () => {
          while (!failed && active < par && nextJob < jobs.length) {
            const J = jobs[nextJob++]; active++;
            const wk = new Worker(workerURL); state.workers.push(wk);
            wk.onmessage = ev => {
              const m = ev.data;
              if (m.type === 'error') { failed = true; reject(new Error(`${J.h}m 층 계산이 불안정해졌습니다. 격자를 바꾸거나 범위를 줄여 다시 시도해 주세요.`)); return; }
              if (m.type === 'stopped') return;
              J.ux = m.ux; J.uy = m.uy; J.pct = m.t / m.steps; J.averaged = m.averaged;
              updProg();
              const k = jobs.indexOf(J); const now = performance.now();
              if (m.type === 'done' || !lastHeat[k] || now - lastHeat[k] > 2500) { lastHeat[k] = now; onLayerData(k, m.type === 'done'); }
              if (m.type === 'done') { J.done = true; try { wk.terminate(); } catch (e) { } active--; done++; if (done === jobs.length) resolve(); else launch(); }
            };
            wk.onerror = e => { failed = true; reject(new Error(e.message || '계산 오류')); };
            wk.postMessage({ Nx: J.Nx, Ny: J.Ny, solid: J.solid, drag: J.drag, ent: J.ent, u0, tau0: 0.53, Cs: 0.2, steps, avgFrom, reportEvery: 80 });
          }
        };
        state.cancel = () => { cancelled = true; failed = true; state.workers.forEach(w => { try { w.postMessage({ cmd: 'stop' }); } catch (e) { } }); setTimeout(() => reject(new Error('중지됨')), 200); };
        launch();
      });
      stopWorkers();
      jobs.forEach(J => J.stats = layerStats(J));
      showStats();
      setStatus(`분석 완료 · ${dirName(dir)}풍 ${dir}° ${U10.toFixed(1)} m/s · 총 ${((performance.now() - T0) / 1000).toFixed(0)}초`, 100);
      openDrawer('res');
    } catch (e) {
      stopWorkers();
      setStatus(e.message === '중지됨' ? '중지했습니다' + (state.layers.some(l => l.ux) ? ' (중간 결과 표시 중)' : '') : '오류: ' + e.message);
      if (state.layers.some(l => l.ux)) { state.layers.forEach(J => { if (J.ux) J.stats = layerStats(J); }); showStats(); }
    } finally { setRunning(false); state.cancel = null; updHud(); }
  }
  $('run').onclick = runAnalysis;
  $('stop').onclick = () => { if (state.cancel) state.cancel(); };
  $('clear').onclick = () => { clearResults(); setStatus('대기 중', 0); drawAreaBox(); };

  function clearResults() {
    stopWorkers();
    for (const k of Object.keys(objs)) if (k !== 'area' && k !== 'preview') removeObj(k);
    state.layers = []; state.geo = null; state.morph = null; parts.sys = [];
    $('res-empty').style.display = ''; $('res-body').style.display = 'none';
    $('m-empty').style.display = ''; $('m-body').style.display = 'none';
    tip.style.display = 'none'; updHud(); kick();
  }

  // ================= 결과 표시 =================
  function buildLayerChips() {
    $('res-empty').style.display = 'none'; $('res-body').style.display = '';
    $('layer-chips').innerHTML = state.layers.map((L, i) => `<span class="chip${i === state.curLayer ? ' on' : ''}" data-i="${i}">${L.h === 1.5 ? '1.5m 보행자' : L.h + 'm'}</span>`).join('');
    $('layer-chips').querySelectorAll('.chip').forEach(c => c.onclick = () => { state.curLayer = +c.dataset.i; $('layer-chips').querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === c)); refreshVisual(); showStats(); updHud(); });
    const G = state.geo;
    $('res-meta').textContent = `${G.areaLabel} · 격자 ${G.dx.toFixed(1)}m · ${dirName(G.dir)}풍 ${G.dir}° ${G.U10.toFixed(1)} m/s (${G.windLabel})`;
  }
  function onLayerData(k, final) {
    if (k === state.curLayer || view.allLayers) { buildHeat(k); }
    ensureParticles();
    if (final) { const J = state.layers[k]; J.stats = layerStats(J); if (k === state.curLayer) showStats(); }
    kick();
  }
  function refreshVisual() {
    state.layers.forEach((L, k) => { if (k !== state.curLayer) removeObj('heat' + k); });
    if (view.heat) buildHeat(state.curLayer); else removeObj('heat' + state.curLayer);
    ensureParticles(true);
    kick();
  }
  function drawFrame() {
    const G = state.geo; if (!G) return;
    const h = G.L / 2;
    setObj('frame', rectLine(G.cx - h, G.cy - h, G.cx + h, G.cy + h, G.gz + 1.5, 0x5fd0ff));
    if ($('rng').value === 'area' && state.area) { const a = state.area; setObj('area2', rectLine(a.x0, a.y0, a.x1, a.y1, G.gz + 2, 0xffd84a)); }
  }
  function terrainPlane(z0, tex, opacity) {
    // three.js r69는 꼭짓점 65,535개를 넘으면 면을 나눠 그리다 일부가 빠지므로 분할 수를 100 이하로 제한
    const G = state.geo; const seg = Math.min(G.M, 100);
    const geo = new THREE.PlaneGeometry(G.L, G.L, seg, seg);
    // 이 뷰어는 장면 위치 행렬을 자동 갱신하지 않으므로 실제 좌표를 꼭짓점에 직접 넣음
    for (const v of geo.vertices) { const e = clamp(v.x, -G.L / 2 + 0.01, G.L / 2 - 0.01), n = clamp(v.y, -G.L / 2 + 0.01, G.L / 2 - 0.01); v.z = dtmAt(e, n) + z0; v.x += G.cx; v.y += G.cy; }
    geo.computeBoundingSphere();
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide });
    const m = new THREE.Mesh(geo, mat); m.frustumCulled = false; m.updateMatrixWorld(true);
    return m;
  }
  function heatCanvas(L) {
    const G = state.geo; const R = Math.min(600, G.M * 3);
    const cv = document.createElement('canvas'); cv.width = R; cv.height = R;
    const c2 = cv.getContext('2d'); const id = c2.createImageData(R, R);
    for (let py = 0; py < R; py++) for (let px = 0; px < R; px++) {
      const e = -G.L / 2 + (px + 0.5) * G.L / R, n = G.L / 2 - (py + 0.5) * G.L / R;
      const ci = cellOf(e, n); const o = (py * R + px) * 4;
      if (!G.mask[ci] || L.obsW[ci] || !G.cnt[ci]) { id.data[o + 3] = 0; continue; }
      const v = fieldAt(L, e, n); const c = colorOf(Math.hypot(v[0], v[1]));
      id.data[o] = c[0]; id.data[o + 1] = c[1]; id.data[o + 2] = c[2]; id.data[o + 3] = 235;
    }
    c2.putImageData(id, 0, 0);
    return cv;
  }
  function buildHeat(k) {
    const L = state.layers[k]; if (!L || !L.ux || !view.heat) return;
    const cv = heatCanvas(L); L.canvas = cv;
    const tex = new THREE.Texture(cv); tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = false; tex.needsUpdate = true;
    setObj('heat' + k, terrainPlane(L.h + 0.3, tex, view.opacity));
  }

  // ---------- 바람 입자 ----------
  const partVS = `varying vec3 vC; varying float vA; void main(){ vC = color; vA = normal.x; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;
  const partFS = `varying vec3 vC; varying float vA; void main(){ gl_FragColor = vec4(vC, vA); }`;
  const headVS = `varying vec3 vC; varying float vA; uniform float ps; void main(){ vC = color; vA = normal.x; gl_PointSize = ps; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;
  const headFS = `varying vec3 vC; varying float vA; void main(){ vec2 d = gl_PointCoord - 0.5; if (dot(d,d) > 0.25) discard; gl_FragColor = vec4(vC, vA); }`;
  const TRAIL = 14;
  const parts = { sys: [], raf: 0, last: 0, lastRender: 0 };
  function makeSystem(k, count) {
    const segN = count * (TRAIL - 1), nv = segN * 2;
    const g = new THREE.BufferGeometry();
    g.addAttribute('position', new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
    g.addAttribute('color', new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
    g.addAttribute('normal', new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
    const mat = new THREE.ShaderMaterial({ vertexShader: partVS, fragmentShader: partFS, vertexColors: THREE.VertexColors, transparent: true, depthWrite: false });
    const line = new THREE.Line(g, mat, THREE.LinePieces); line.frustumCulled = false;
    const hg = new THREE.BufferGeometry();
    hg.addAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    hg.addAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    hg.addAttribute('normal', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    const hmat = new THREE.ShaderMaterial({ uniforms: { ps: { type: 'f', value: 3.2 * (window.devicePixelRatio || 1) } }, vertexShader: headVS, fragmentShader: headFS, vertexColors: THREE.VertexColors, transparent: true, depthWrite: false });
    const head = new THREE.PointCloud(hg, hmat); head.frustumCulled = false;
    const o = new THREE.Object3D(); o.add(line); o.add(head);
    setObj('parts' + k, o);
    const P = [];
    for (let i = 0; i < count; i++) P.push({ tr: new Float32Array(TRAIL * 3), n: 0, age: 0, life: 0, r: 0 });
    const sys = { k, count, line, head, P };
    P.forEach(p => spawn(sys, p, true));
    return sys;
  }
  function spawn(sys, p, fresh) {
    const G = state.geo, L = state.layers[sys.k];
    for (let tries = 0; tries < 30; tries++) {
      const e = (Math.random() - 0.5) * G.L, n = (Math.random() - 0.5) * G.L;
      const ci = cellOf(e, n); if (!G.mask[ci] || L.obsW[ci] || !G.cnt[ci]) continue;
      const z = G.dtm[ci] + L.h + 0.6;
      for (let t = 0; t < TRAIL; t++) { p.tr[t * 3] = e; p.tr[t * 3 + 1] = n; p.tr[t * 3 + 2] = z; }
      p.n = 1; p.age = fresh ? Math.random() * 4 : 0; p.life = 3 + Math.random() * 5; p.r = 0; return;
    }
    p.n = 0; p.life = 0.5; p.age = 0;
  }
  function ensureParticles(rebuild) {
    const want = [];
    if (state.geo && view.parts) {
      if (view.allLayers) state.layers.forEach((L, k) => { if (L.ux) want.push(k); });
      else if (state.layers[state.curLayer] && state.layers[state.curLayer].ux) want.push(state.curLayer);
    }
    const per = want.length > 1 ? Math.round(view.nParts / Math.min(want.length, 3) * 0.8) : view.nParts;
    parts.sys = parts.sys.filter(s => { const keep = want.includes(s.k) && !rebuild && s.count === per; if (!keep) removeObj('parts' + s.k); return keep; });
    for (const k of want) if (!parts.sys.find(s => s.k === k)) parts.sys.push(makeSystem(k, per));
    if (view.allLayers) state.layers.forEach((L, k) => { if (L.ux && view.heat && k !== state.curLayer && !objs['heat' + k]) { } });
    if (parts.sys.length && !parts.raf) { parts.last = performance.now(); parts.raf = requestAnimationFrame(animate); }
  }
  function animate(now) {
    parts.raf = 0;
    if (!parts.sys.length) return;
    const dt = Math.min(0.05, (now - parts.last) / 1000); parts.last = now;
    const G = state.geo;
    if (G && !state.capturing) {
      for (const sys of parts.sys) {
        const L = state.layers[sys.k]; if (!L || !L.ux) continue;
        const pos = sys.line.geometry.attributes.position.array, colA = sys.line.geometry.attributes.color.array, alA = sys.line.geometry.attributes.normal.array;
        const hp = sys.head.geometry.attributes.position.array, hc = sys.head.geometry.attributes.color.array, ha = sys.head.geometry.attributes.normal.array;
        const scale = L.Uin * view.speedX;
        let vi = 0;
        for (let i = 0; i < sys.P.length; i++) {
          const p = sys.P[i];
          p.age += dt;
          let e = p.tr[0], n = p.tr[1];
          if (p.n > 0) {
            const v = fieldAt(L, e, n); const r = Math.hypot(v[0], v[1]); p.r = p.r * 0.8 + r * 0.2;
            const ne = e + v[0] * scale * dt, nn = n + v[1] * scale * dt;
            const out = Math.abs(ne) > G.L / 2 || Math.abs(nn) > G.L / 2;
            const ci = out ? -1 : cellOf(ne, nn);
            if (out || p.age > p.life || !G.mask[ci] || L.obsW[ci] || r < 0.015) { spawn(sys, p, false); }
            else {
              p.tr.copyWithin(3, 0, (TRAIL - 1) * 3);
              p.tr[0] = ne; p.tr[1] = nn; p.tr[2] = G.dtm[ci] + L.h + 0.6;
              if (p.n < TRAIL) p.n++;
            }
          } else if (p.age > p.life) spawn(sys, p, false);
          const c = colorOf(p.r);
          const cr = (c[0] * 0.45 + 140) / 255, cg = (c[1] * 0.45 + 140) / 255, cb = (c[2] * 0.45 + 140) / 255;
          const fade = Math.min(1, p.age / 0.4) * Math.min(1, (p.life - p.age) / 0.6 + 0.05);
          for (let t = 0; t < TRAIL - 1; t++) {
            const ok = t + 1 < p.n;
            const a0 = ok ? (1 - t / (TRAIL - 1)) * fade : 0, a1 = ok ? (1 - (t + 1) / (TRAIL - 1)) * fade : 0;
            for (let s = 0; s < 2; s++) {
              const tt = t + s; const o3 = vi * 3;
              pos[o3] = G.cx + p.tr[tt * 3]; pos[o3 + 1] = G.cy + p.tr[tt * 3 + 1]; pos[o3 + 2] = p.tr[tt * 3 + 2];
              colA[o3] = cr; colA[o3 + 1] = cg; colA[o3 + 2] = cb; alA[o3] = (s ? a1 : a0) * 0.95;
              vi++;
            }
          }
          hp[i * 3] = G.cx + p.tr[0]; hp[i * 3 + 1] = G.cy + p.tr[1]; hp[i * 3 + 2] = p.tr[2];
          hc[i * 3] = Math.min(1, cr + 0.15); hc[i * 3 + 1] = Math.min(1, cg + 0.15); hc[i * 3 + 2] = Math.min(1, cb + 0.15); ha[i * 3] = p.n > 0 ? fade : 0;
        }
        sys.line.geometry.attributes.position.needsUpdate = true; sys.line.geometry.attributes.color.needsUpdate = true; sys.line.geometry.attributes.normal.needsUpdate = true;
        sys.head.geometry.attributes.position.needsUpdate = true; sys.head.geometry.attributes.color.needsUpdate = true; sys.head.geometry.attributes.normal.needsUpdate = true;
      }
      if (now - parts.lastRender > 30) { parts.lastRender = now; kick(); }
    }
    parts.raf = requestAnimationFrame(animate);
  }

  // ---------- 통계 ----------
  function layerStats(L) {
    const G = state.geo; let n = 0, s = 0, stag = 0, weak = 0, good = 0, strong = 0, mx = 0;
    for (let iy = 0; iy < G.M; iy++) for (let ix = 0; ix < G.M; ix++) {
      const c = iy * G.M + ix; if (!G.mask[c] || !G.cnt[c] || L.obsW[c]) continue;
      const e = -G.L / 2 + (ix + 0.5) * G.dx, nn = G.L / 2 - (iy + 0.5) * G.dx;
      const v = fieldAt(L, e, nn); const r = Math.hypot(v[0], v[1]);
      n++; s += r; if (r < 0.3) stag++; else if (r < 0.7) weak++; else if (r < 1.2) good++; else strong++;
      if (r > mx) mx = r;
    }
    n = Math.max(1, n);
    return { mean: s / n, stag: stag / n, weak: weak / n, good: good / n, strong: strong / n, max: mx };
  }
  const pct = v => (v * 100).toFixed(0) + '%';
  function showStats() {
    const L = state.layers[state.curLayer]; if (!L) return;
    const st = L.stats || (L.ux ? layerStats(L) : null);
    $('stats').innerHTML = st ? `
      <tr><td>유입 풍속 (${L.h}m 높이 환산)</td><td class="v">${L.Uin.toFixed(1)} m/s</td></tr>
      <tr><td>평균 풍속</td><td class="v">${(st.mean * L.Uin).toFixed(1)} m/s (비 ${st.mean.toFixed(2)})</td></tr>
      <tr><td>최대 풍속</td><td class="v">${(st.max * L.Uin).toFixed(1)} m/s</td></tr>
      <tr><td><span class="cls" style="background:rgb(40,110,220)"></span>정체 (풍속비 0.3 미만)</td><td class="v">${pct(st.stag)}</td></tr>
      <tr><td><span class="cls" style="background:rgb(60,200,200)"></span>약풍 (0.3~0.7)</td><td class="v">${pct(st.weak)}</td></tr>
      <tr><td><span class="cls" style="background:rgb(120,220,80)"></span>바람길 양호 (0.7~1.2)</td><td class="v">${pct(st.good)}</td></tr>
      <tr><td><span class="cls" style="background:rgb(230,60,40)"></span>강해짐 (1.2 이상)</td><td class="v">${pct(st.strong)}</td></tr>
      <tr><td>건물이 막은 면적</td><td class="v">${pct(L.obsRatio)}</td></tr>
      <tr><td>수목 면적 (일부 통과)</td><td class="v">${pct(L.vegRatio)}</td></tr>
      <tr><td>수면 면적 (호수·수로)</td><td class="v">${pct(state.geo.waterRatio || 0)}</td></tr>` : '<tr><td>계산 중…</td></tr>';
    $('cmp').innerHTML = '<tr><td>높이</td><td class="v">평균 풍속</td><td class="v">정체</td><td class="v">건물 점유</td></tr>' + state.layers.map(J => { const s2 = J.stats; return `<tr><td>${J.h}m</td><td class="v">${s2 ? (s2.mean * J.Uin).toFixed(1) + ' m/s' : '-'}</td><td class="v">${s2 ? pct(s2.stag) : '-'}</td><td class="v">${pct(J.obsRatio)}</td></tr>`; }).join('');
  }

  // ---------- 바람길 형태 지표 ----------
  function computeMorph() {
    const G = state.geo; if (!G) return;
    const B = +$('blk').value; const nb = Math.max(1, Math.round(G.L / B)); const bs = G.L / nb;
    const M = G.M, dx = G.dx;
    // 건물 마스크 (2.5m 이상, 수목 제외, 40㎡ 이상)
    const bl = new Uint8Array(M * M);
    for (let c = 0; c < M * M; c++) if (G.cnt[c] && G.hgt[c] > 2.5 && !(G.vegFrac[c] >= 0.4 && G.hgt[c] < 30)) bl[c] = 1;
    const hB = new Float32Array(M * M); for (let c = 0; c < M * M; c++) hB[c] = bl[c] ? G.hgt[c] : 0;
    const sX = Math.sign(G.fx), sY = Math.sign(G.fy); // 바람이 불어가는 방향(동, 북)
    const NB = nb * nb;
    const aN = new Float64Array(NB), aIn = new Float64Array(NB), aB = new Float64Array(NB), aH = new Float64Array(NB), aAf = new Float64Array(NB), aV = new Float64Array(NB), aVH = new Float64Array(NB);
    for (let iy = 0; iy < M; iy++) {
      const by = Math.min(nb - 1, Math.floor((iy + 0.5) * dx / bs));
      for (let ix = 0; ix < M; ix++) {
        const bx = Math.min(nb - 1, Math.floor((ix + 0.5) * dx / bs)); const b = by * nb + bx;
        const c = iy * M + ix; if (!G.cnt[c]) continue; aN[b]++; if (G.mask[c]) aIn[b]++;
        if (bl[c]) { aB[b]++; aH[b] += hB[c]; }
        else if (G.vegFrac[c] >= 0.4 && G.hgt[c] > 1.5) { aV[b]++; aVH[b] += G.hgt[c]; }
        // 바람을 정면으로 받는 면: 바람 상류 쪽 이웃보다 높은 만큼 (북쪽이 iy 감소)
        const ux = ix - sX, uy = iy + sY;
        const hu = (ux >= 0 && ux < M) ? hB[iy * M + ux] : 0, hv = (uy >= 0 && uy < M) ? hB[uy * M + ix] : 0;
        aAf[b] += Math.max(0, hB[c] - hu) * dx * Math.abs(G.fx) + Math.max(0, hB[c] - hv) * dx * Math.abs(G.fy);
      }
    }
    const blocks = [];
    for (let b = 0; b < NB; b++) {
      const n = aN[b], nIn = aIn[b], nb_ = aB[b], sh = aH[b], Af = aAf[b], nv = aV[b], svh = aVH[b];
      if (n < 4 || nIn < n * 0.5) { blocks.push(null); continue; }
      const area = n * dx * dx; const lp = nb_ / n; const H = nb_ ? sh / nb_ : 0; const lf = Af / area;
      let zd = 0, z0 = 0.03;
      if (H > 0 && lp > 0) {
        zd = H * (1 + Math.pow(4.43, -lp) * (lp - 1));
        z0 = H * (1 - zd / H) * Math.exp(-Math.pow(0.5 * 1.0 * 1.2 / (0.4 * 0.4) * (1 - zd / H) * Math.max(lf, 1e-4), -0.5));
      }
      const vc = nv / n, vh = nv ? svh / nv : 0;
      z0 = Math.max(z0, 0.03 + 0.1 * vh * vc);
      const cls = z0 < 0.25 ? 0 : z0 < 0.5 ? 1 : z0 < 1.0 ? 2 : 3;
      blocks.push({ lp, lf, H, zd, z0, cls, label: ['바람길 매우 양호', '바람길 양호', '보통', '통풍 장애'][cls], vc });
    }
    state.morph = { B: bs, nb, blocks };
    const cnt = [0, 0, 0, 0]; let tot = 0, sz0 = 0, slp = 0, slf = 0, sH = 0, nH = 0;
    blocks.forEach(b => { if (!b) return; cnt[b.cls]++; tot++; sz0 += b.z0; slp += b.lp; slf += b.lf; if (b.H > 0) { sH += b.H; nH++; } });
    tot = Math.max(1, tot);
    $('m-empty').style.display = 'none'; $('m-body').style.display = '';
    $('mstats').innerHTML = `
      <tr><td>평가 구획 수 (${Math.round(bs)}m 구획)</td><td class="v">${tot}개</td></tr>
      <tr><td><span class="cls" style="background:#2d7ff9"></span>바람길 매우 양호</td><td class="v">${pct(cnt[0] / tot)}</td></tr>
      <tr><td><span class="cls" style="background:#3cc47c"></span>바람길 양호</td><td class="v">${pct(cnt[1] / tot)}</td></tr>
      <tr><td><span class="cls" style="background:#f2c94c"></span>보통</td><td class="v">${pct(cnt[2] / tot)}</td></tr>
      <tr><td><span class="cls" style="background:#eb5757"></span>통풍 장애</td><td class="v">${pct(cnt[3] / tot)}</td></tr>
      <tr><td>평균 건폐율 λp</td><td class="v">${(slp / tot).toFixed(2)}</td></tr>
      <tr><td>평균 전면적 지수 λf (${dirName(G.dir)}풍 기준)</td><td class="v">${(slf / tot).toFixed(2)}</td></tr>
      <tr><td>평균 건물 높이 (건물 있는 구획)</td><td class="v">${nH ? (sH / nH).toFixed(1) + 'm' : '-'}</td></tr>
      <tr><td>평균 거칠기 길이 z0</td><td class="v">${(sz0 / tot).toFixed(2)}m</td></tr>`;
    if (view.morph) buildMorph();
  }
  function morphAt(e, n) { const m = state.morph; if (!m) return null; const G = state.geo; const bx = Math.floor((e + G.L / 2) / m.B), by = Math.floor((G.L / 2 - n) / m.B); if (bx < 0 || by < 0 || bx >= m.nb || by >= m.nb) return null; return m.blocks[by * m.nb + bx]; }
  function buildMorph() {
    removeObj('morph'); const m = state.morph; if (!m || !view.morph) { kick(); return; }
    const R = 512; const cv = document.createElement('canvas'); cv.width = R; cv.height = R; const c2 = cv.getContext('2d');
    const COLS = ['rgba(45,127,249,0.75)', 'rgba(60,196,124,0.75)', 'rgba(242,201,76,0.8)', 'rgba(235,87,87,0.8)'];
    const s = R / m.nb;
    m.blocks.forEach((b, i) => { if (!b) return; const bx = i % m.nb, by = (i / m.nb) | 0; c2.fillStyle = COLS[b.cls]; c2.fillRect(bx * s + 1, by * s + 1, s - 2, s - 2); });
    const tex = new THREE.Texture(cv); tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false; tex.needsUpdate = true;
    setObj('morph', terrainPlane(0.8, tex, 0.75)); kick();
  }
  $('v-morph').onchange = () => { view.morph = $('v-morph').checked; buildMorph(); };
  $('blk').onchange = () => { computeMorph(); };

  // ---------- 표시 설정 ----------
  $('v-heat').onchange = () => { view.heat = $('v-heat').checked; refreshVisual(); };
  $('v-parts').onchange = () => { view.parts = $('v-parts').checked; ensureParticles(true); kick(); };
  $('v-all').onchange = () => { view.allLayers = $('v-all').checked; ensureParticles(true); kick(); };
  $('v-op').oninput = () => { view.opacity = +$('v-op').value; for (const k of Object.keys(objs)) if (k.startsWith('heat')) objs[k].material.opacity = view.opacity; kick(); };
  $('v-n').onchange = () => { view.nParts = +$('v-n').value; ensureParticles(true); };
  $('v-sp').oninput = () => { view.speedX = +$('v-sp').value; $('v-spv').textContent = view.speedX + '배'; };

  // ---------- 내려받기 ----------
  function download(name, blob) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); }
  $('dl-csv').onclick = () => {
    const G = state.geo, L = state.layers[state.curLayer]; if (!G || !L || !L.ux) return;
    const rows = ['utm_x,utm_y,local_x,local_y,ground_z,layer_h,building,vegetation,speed_ratio,speed_ms,flow_dir_deg'];
    for (let iy = 0; iy < G.M; iy++) for (let ix = 0; ix < G.M; ix++) {
      const c = iy * G.M + ix; if (!G.mask[c]) continue;
      const e = -G.L / 2 + (ix + 0.5) * G.dx, n = G.L / 2 - (iy + 0.5) * G.dx;
      const v = L.obsW[c] ? [0, 0] : fieldAt(L, e, n); const r = Math.hypot(v[0], v[1]);
      const deg = r > 0 ? ((Math.atan2(-v[0], -v[1]) / DEG + 360) % 360).toFixed(0) : '';
      rows.push([(G.cx + e + origin[0]).toFixed(2), (G.cy + n + origin[1]).toFixed(2), (G.cx + e).toFixed(2), (G.cy + n).toFixed(2), G.dtm[c].toFixed(2), L.h, L.obsW[c], L.veg[c], r.toFixed(3), (r * L.Uin).toFixed(2), deg].join(','));
    }
    download(`바람길_${L.h}m_${dirName(G.dir)}풍.csv`, new Blob(['\ufeff' + rows.join('\n')], { type: 'text/csv' }));
  };
  $('dl-png').onclick = () => { const L = state.layers[state.curLayer]; if (!L || !L.ux) return; const cv = L.canvas || heatCanvas(L); cv.toBlob(b => download(`바람길_${L.h}m_풍속비.png`, b)); };

  // ================= 정리 =================
  const api = {
    version: VERSION, state, view, wind, engine: E,
    run: runAnalysis, clear: clearResults, open: openDrawer, setLayer: k => { state.curLayer = k; refreshVisual(); showStats(); },
    destroy() {
      try { if (state.cancel) state.cancel(); } catch (e) { }
      stopWorkers(); clearInterval(wxTimer); if (parts.raf) cancelAnimationFrame(parts.raf); parts.sys = [];
      for (const k of Object.keys(objs)) removeObj(k);
      E.scene.remove(group);
      E.root.updateLODTree = origUpdLOD === ROOTPROTO.updateLODTree ? ROOTPROTO.updateLODTree : origUpdLOD;
      if (E.root.updateLODTree === ROOTPROTO.updateLODTree) delete E.root.updateLODTree;
      window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('pointerup', onUp, true); window.removeEventListener('pointermove', onMove, true);
      [rail, drawer, hud, tip, hint, styleEl].forEach(el => el.remove());
      try { URL.revokeObjectURL(workerURL); } catch (e) { }
      state.capturing = false; kick();
      delete window.__kmWind;
    }
  };
  window.__kmWind = api;

  // 시작
  updResInfo(); updAreaInfo(); onWindInput(); updHud();
  openDrawer('wx');
  loadWeather();
})();
