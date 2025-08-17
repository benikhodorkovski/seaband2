import React, { useEffect, useRef, useState, useMemo } from "react";
import { motion } from "framer-motion";
import * as PIXI from "pixi.js"; // PixiJS (v7/v8 compatible usage)
import { Music2, Play, Pause, Upload, Drum, Guitar, Settings2, AudioLines, Clock, Sparkles } from "lucide-react"; // SAFE icons

// ====== Helpers ======
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const formatMs = (ms) => `${ms.toFixed(0)} ms`;
const shouldHit = (beatIndex, subdivision = 1) => beatIndex % subdivision === 0; // 1=every beat, 2=every 2 beats, etc.

// ====== Tiny runtime tests (non-breaking) ======
(function runTests(){
  const results = [];
  const assertEq = (name, actual, expected) => results.push({ name, ok: Object.is(actual, expected), actual, expected });
  // clamp tests
  assertEq("clamp-mid", clamp(5,0,10), 5);
  assertEq("clamp-low", clamp(-1,0,10), 0);
  assertEq("clamp-high", clamp(20,0,10), 10);
  assertEq("clamp-edge-low", clamp(0,0,10), 0);
  assertEq("clamp-edge-high", clamp(10,0,10), 10);
  // formatMs tests
  assertEq("formatMs-0", formatMs(0), "0 ms");
  assertEq("formatMs-1000", formatMs(1000), "1000 ms");
  assertEq("formatMs-1.5", formatMs(1500.49), "1500 ms");
  // interval calc sanity (BPM 120)
  const bpm = 120, beatMs = 60000 / bpm; // 500
  assertEq("interval-1/1", Math.round(beatMs*1), 500);
  assertEq("interval-1/2", Math.round(beatMs*0.5), 250);
  assertEq("interval-1/4", Math.round(beatMs*0.25), 125);
  // shouldHit tests
  assertEq("hit-every-beat", shouldHit(8,1), true);
  assertEq("hit-every-2-false", shouldHit(3,2), false);
  assertEq("hit-every-2-true", shouldHit(4,2), true);
  assertEq("hit-every-4-true", shouldHit(8,4), true);
  // NEW: guard math
  assertEq("guard-negative-bpm", clamp(-20, 40, 240), 40);
  console.table(results);
})();

// ====== Stage & Style (header + controls) ======
function StageChrome({ children, beatPulse, realism }) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-950">
      {/* ambient bg */}
      <div className="pointer-events-none absolute inset-0">
        <motion.div
          className="absolute -inset-24 bg-gradient-to-br from-fuchsia-700/15 via-sky-500/10 to-cyan-400/10 blur-3xl"
          animate={{ scale: beatPulse ? [1,1.03,1] : 1, opacity: realism>0 ? [0.3,0.45,0.3] : 0.25 }}
          transition={{ duration: 0.5 }}
        />
        <motion.div className="absolute -top-24 left-10 h-64 w-40 rotate-12 bg-fuchsia-400/20 blur-2xl" animate={{ opacity: [0.15, 0.5, 0.15] }} transition={{ duration: 4, repeat: Infinity }} />
        <motion.div className="absolute -top-20 right-10 h-64 w-40 -rotate-12 bg-cyan-400/20 blur-2xl" animate={{ opacity: [0.15, 0.55, 0.15] }} transition={{ duration: 5, repeat: Infinity }} />
        <div className="absolute bottom-0 left-1/2 h-32 w-[130%] -translate-x-1/2 rounded-[50%] bg-gradient-to-t from-black/40 to-transparent"/>
      </div>
      <div className="relative p-4 md:p-6">{children}</div>
    </div>
  );
}

function MeterBars({ active }){
  const bars = new Array(12).fill(0);
  return (
    <div className="flex items-end gap-1 h-16">
      {bars.map((_,i)=> (
        <motion.div key={i}
          className="w-1.5 rounded-sm bg-emerald-400/70"
          animate={{ height: active? [8, 40 + (i%4)*6, 10] : 8 }}
          transition={{ duration: 0.6, repeat: Infinity, delay: i*0.02 }}
        />
      ))}
    </div>
  );
}

// ====== PIXI RENDERER (WebGL realism) ======
function PixiAnimals({ width=900, height=360, beatPulse, activeArm, hitDrums, hitViolin, hitBass, realism, debug=false }){
  const containerRef = useRef(null);
  const appRef = useRef(null);

  // Helpers
  const getTicker = (app) => (app && app.ticker && typeof app.ticker.add === 'function') ? app.ticker : (PIXI?.Ticker?.shared || null);
  const addTick = (app, fn) => {
    const t = getTicker(app);
    if (t && typeof t.add === 'function') return t.add(fn);
    app.__fallbackIntervals = app.__fallbackIntervals || [];
    const id = setInterval(()=>fn(1), 16);
    app.__fallbackIntervals.push(id);
  };
  const addOnce = (app, fn) => {
    const t = getTicker(app);
    if (t && typeof t.addOnce === 'function') return t.addOnce(fn);
    setTimeout(fn, 16);
  };

  // Fit canvas to container & keep aspect
  const applyLayout = (app) => {
    if (!containerRef.current || !app) return;
    const canvasEl = app.canvas ?? app.view;
    let cw = containerRef.current.clientWidth;
    let ch = containerRef.current.clientHeight;
    // If layout not ready yet, fall back to logical size
    if (!cw || !ch) { cw = width; ch = height; }
    // CSS size
    if (canvasEl) { canvasEl.style.width = '100%'; canvasEl.style.height = '100%'; canvasEl.style.display = 'block'; }
    // Renderer size (pixel ratio aware)
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    try { app.renderer?.resize?.(Math.max(1, Math.floor(cw*dpr)), Math.max(1, Math.floor(ch*dpr))); } catch {}
    // Stage scale & center
    const sx = cw / width; const sy = ch / height; const s = Math.max(0.01, Math.min(sx, sy));
    app.stage.scale.set(s, s);
    app.stage.position.set((cw - width*s)/2, (ch - height*s)/2);
  };

  // Load assets (optional) then render; always render vector placeholders if any asset fails
  const loadAssets = async () => {
    // Map your assets here (place files in /public or reachable URLs)
    const ASSETS = {
      // example: octopus: '/assets/octopus.png', seahorse: '/assets/seahorse.png', seal: '/assets/seal.png'
    };
    const keys = Object.keys(ASSETS);
    if (!keys.length) return {}; // nothing to load
    const out = {};
    for (const k of keys){
      try { out[k] = await PIXI.Assets.load(ASSETS[k]); }
      catch (e) { console.warn('[assets] failed to load', k, ASSETS[k], e); out[k] = null; }
    }
    return out;
  };

  useEffect(()=>{
    let destroyed = false;
    let app = null;

    const mount = async () => {
      if (!containerRef.current) return;

      try {
        app = new PIXI.Application();
        if (typeof app.init === 'function') {
          await app.init({ width, height, backgroundAlpha: 0, antialias: true });
        } else {
          app = new PIXI.Application({ width, height, backgroundAlpha: 0, antialias: true });
        }
      } catch (e) {
        if (!app) app = new PIXI.Application({ width, height, backgroundAlpha: 0, antialias: true });
      }

      if (destroyed) { try { app.destroy(true); } catch {} return; }

      app.__isReady = true;
      app.__fallbackIntervals = [];
      appRef.current = app;

      const canvasEl = app.canvas ?? app.view;
      if (canvasEl && containerRef.current) {
        containerRef.current.innerHTML = "";
        containerRef.current.appendChild(canvasEl);
      }

      // DEBUG overlay
      let debugText = null;
      if (debug){
        try {
          debugText = new PIXI.Text({ text: 'Pixi: init...', style: { fill: 0x66ff99, fontSize: 14 } });
        } catch {
          // v7 style fallback
          // @ts-ignore
          debugText = new PIXI.Text('Pixi: init...', { fill: 0x66ff99, fontSize: 14 });
        }
        debugText.position.set(8, 6);
        app.stage.addChild(debugText);
      }

      // Basic BG so you always see something
      const bg = new PIXI.Graphics();
      bg.beginFill(0x0b1220, 0.5).drawRoundedRect(0, 0, width, height, 12).endFill();
      app.stage.addChild(bg); bg.zIndex = 0;

      // After init: layout, then assets, then scene
      applyLayout(app);

      let textures = {};
      try {
        textures = await loadAssets();
        if (debug && debugText) debugText.text = 'Pixi: assets loaded';
      } catch (e) {
        console.warn('[assets] load error', e);
        if (debug && debugText) debugText.text = 'Pixi: asset load error (using placeholders)';
      }

      // Layers & stage
      const stage = app.stage; stage.sortableChildren = true;

      // Helpers
      const makeShadow = (x,y,w,h) => {
        const g = new PIXI.Graphics();
        g.beginFill(0x000000, 0.35).drawEllipse(0,0,w,h).endFill();
        g.position.set(x,y);
        try { g.filters = [new PIXI.filters.BlurFilter(8)]; } catch {}
        return g;
      };

      // Displacement
      const noiseGfx = new PIXI.Graphics();
      for (let i=0;i<120;i++){
        noiseGfx.beginFill(0xffffff*Math.random(), 0.08+Math.random()*0.12);
        noiseGfx.drawCircle(Math.random()*width, Math.random()*height, 4+Math.random()*10);
        noiseGfx.endFill();
      }
      let noiseTex = null; try { noiseTex = app.renderer?.generateTexture?.(noiseGfx) || null; } catch {}
      const noiseSpr = noiseTex ? new PIXI.Sprite(noiseTex) : new PIXI.Container();
      if (noiseSpr instanceof PIXI.Sprite) noiseSpr.alpha = 0.25;
      let displacement = null; try { displacement = new PIXI.filters.DisplacementFilter(noiseSpr); displacement.scale.set(0,0); } catch {}
      stage.addChild(noiseSpr);

      // === Animals — use textures if present, else vector placeholders ===
      const octo = new PIXI.Container(); octo.zIndex = 5; stage.addChild(octo);
      if (textures.octopus) {
        const spr = new PIXI.Sprite(textures.octopus);
        spr.anchor.set(0.5); spr.position.set(160,180); spr.scale.set(0.5);
        octo.addChild(spr);
      } else {
        const body = new PIXI.Graphics(); body.beginFill(0x25E2C4).lineStyle(2,0x93fff1,0.9).drawEllipse(0,0,70,60).endFill(); body.position.set(160,180);
        const eyeL = new PIXI.Graphics(); eyeL.beginFill(0x0f172a).drawCircle(0,0,6).endFill(); eyeL.position.set(140,170);
        const eyeR = new PIXI.Graphics(); eyeR.beginFill(0x0f172a).drawCircle(0,0,6).endFill(); eyeR.position.set(180,170);
        stage.addChild(body, eyeL, eyeR);
      }
      const pads = []; const arms = [];
      for (let i=0;i<8;i++){
        const angle = (i/8)*Math.PI*2;
        const pad = new PIXI.Graphics(); pad.beginFill(0xe5e7eb).lineStyle(1,0x94a3b8,0.8).drawEllipse(0,0,22,14).endFill();
        pad.position.set(160+Math.cos(angle)*120, 180+Math.sin(angle)*85); pad.zIndex = 4; stage.addChild(pad); pads.push(pad);
        const a = (i/8)*Math.PI*2; const arm = new PIXI.Graphics(); arm.lineStyle(8, 0x10b981).moveTo(160+Math.cos(a)*48, 180+Math.sin(a)*44).quadraticCurveTo(160+Math.cos(a)*70 + Math.sin(a)*20,180+Math.sin(a)*60 - Math.cos(a)*18,160+Math.cos(a)*105,180+Math.sin(a)*76); arm.zIndex = 3; stage.addChild(arm); arms.push(arm);
      }

      // Seahorse
      if (textures.seahorse){
        const sh = new PIXI.Sprite(textures.seahorse); sh.anchor.set(0.5); sh.position.set(450,190); sh.zIndex = 5; stage.addChild(sh);
      } else {
        const seahorse = new PIXI.Graphics(); seahorse.beginFill(0x60a5fa).lineStyle(2,0xbfdbfe,0.9).drawEllipse(0,0,40,58).endFill(); seahorse.position.set(450, 190); seahorse.zIndex = 5; stage.addChild(seahorse);
        const bow = new PIXI.Graphics(); bow.lineStyle(6, 0x0f172a).moveTo(390,170).lineTo(510,190); stage.addChild(bow); appRef.current && (appRef.current._bow = bow);
      }

      // Seal
      if (textures.seal){
        const sl = new PIXI.Sprite(textures.seal); sl.anchor.set(0.5); sl.position.set(720,200); sl.zIndex = 5; stage.addChild(sl);
      } else {
        const seal = new PIXI.Graphics(); seal.beginFill(0x93c5fd).lineStyle(2,0xdbeafe,0.9).drawEllipse(0,0,60,36).endFill(); seal.position.set(720, 200); seal.zIndex = 5; stage.addChild(seal);
        const bass = new PIXI.Graphics(); bass.beginFill(0x0b1220).drawRoundedRect(760,140,16,90,7).endFill(); stage.addChild(bass);
      }

      // Shadows
      const sh1 = makeShadow(160, 240, 70, 16); const sh2 = makeShadow(450, 248, 60, 14); const sh3 = makeShadow(720, 252, 74, 16);
      sh1.zIndex = sh2.zIndex = sh3.zIndex = 1; stage.addChild(sh1); stage.addChild(sh2); stage.addChild(sh3);

      // Filters
      let cmOcto, cmSea, cmSeal; try { cmOcto = new PIXI.filters.ColorMatrixFilter(); } catch {}
      try { cmSea = new PIXI.filters.ColorMatrixFilter(); } catch {}
      try { cmSeal = new PIXI.filters.ColorMatrixFilter(); } catch {}
      if (cmOcto || displacement) octo.filters = [cmOcto, displacement].filter(Boolean);

      // Beat reaction
      const onBeat = () => {
        if (!app || !app.__isReady) return;
        if (displacement) { const s = realism>0 ? (realism===1 ? 6 : 10) : 3; displacement.scale.set(s, s); addOnce(app, ()=> displacement.scale.set(0,0)); }
        octo.scale.set(1.05, 1.05); addOnce(app, ()=> octo.scale.set(1,1));
        try { cmOcto && cmOcto.brightness(1.15, true); cmSea && cmSea.brightness(1.12, true); cmSeal && cmSeal.brightness(1.10, true); setTimeout(()=>{ cmOcto?.reset?.(); cmSea?.reset?.(); cmSeal?.reset?.(); }, 120); } catch {}
      };
      appRef.current = app; appRef.current._onBeat = onBeat; appRef.current._pads = pads; appRef.current._arms = arms;

      // Idle motion
      let t = 0; addTick(app, (delta)=>{ t += (delta || 1)/60; const b = 1 + 0.02*Math.sin(t*2); octo.scale.set(b,b); });

      // Initial layout + resize (defer to next frames in case container width is 0 at mount)
      const kickLayout = () => applyLayout(app);
      requestAnimationFrame(kickLayout);
      requestAnimationFrame(kickLayout);
      setTimeout(kickLayout, 50);
      const onResize = () => applyLayout(app);
      window.addEventListener('resize', onResize);
      app.__onResize = onResize;

      if (debug && debugText){
        debugText.text = `Pixi ready. stageChildren=${stage.children?.length || 0}`;
      }
    };

    mount();

    return ()=>{
      const app = appRef.current; if (!app) return;
      try { (app.__fallbackIntervals || []).forEach(clearInterval); } catch {}
      try { window.removeEventListener('resize', app.__onResize); } catch {}
      try { app.destroy(true); } catch { try { app.destroy?.(); } catch {} }
      appRef.current = null;
      if (containerRef.current) containerRef.current.innerHTML = "";
    };
  }, [width, height, realism, debug]);

  // React to beat/hits from parent — guard until ready
  useEffect(()=>{
    const app = appRef.current; if (!app || !app.__isReady) return;
    if (typeof activeArm === 'number' && app._pads){ app._pads.forEach((p,i)=>{ p.tint = (i===activeArm && (hitDrums)) ? 0xfde68a : 0xffffff; }); }
    if (app._bow && hitViolin){ app._bow.rotation = -0.15; setTimeout(()=>{ if(app._bow) app._bow.rotation = 0.15; }, 80); }
    if (hitBass){ /* TODO: nudge bass */ }
    if (hitDrums || hitViolin || hitBass){ app._onBeat && app._onBeat(); }
  }, [activeArm, hitDrums, hitViolin, hitBass]);

  return <div ref={containerRef} className="w-full h-[360px]"/>;
}

export default function AnimalBand(){
  // Debug toggle
  const [debug, setDebug] = useState(true);
  // ====== Player & Audio ======
  const [audioFile, setAudioFile] = useState(null);
  const [audioUrl, setAudioUrl] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);

  // ====== Tempo ======
  const [bpm, setBpm] = useState(null);
  const [manualBpm, setManualBpm] = useState(120);
  const [offsetMs, setOffsetMs] = useState(0);
  const [quantize, setQuantize] = useState("1/1"); // "1/1" | "1/2" | "1/4"
  const [swing, setSwing] = useState(0); // %

  // ====== Band ======
  const band = useMemo(() => ([
    { id: "octo", name: "Octopus – Drums", instrument: "drums", subdivision: 1 },
    { id: "seahorse", name: "Seahorse – Violin", instrument: "violin", subdivision: 1 },
    { id: "seal", name: "Seal – Bass", instrument: "bass", subdivision: 2 },
  ]), []);

  // ====== Beat state ======
  const [beatCount, setBeatCount] = useState(0);
  const [hitPulse, setHitPulse] = useState(false);
  const [activeArm, setActiveArm] = useState(0);

  // Visual realism controls
  const [realism, setRealism] = useState(1); // 0..2

  // Web Audio
  const audioCtxRef = useRef(null);
  const audioBufferRef = useRef(null);
  const sourceRef = useRef(null);
  const nextBeatTimeRef = useRef(0);
  const schedulerTimerRef = useRef(null);
  const beatIndexRef = useRef(0);

  // File selection (no Pixi touch here)
  const onAudioPick = async (file) => {
    if (!file) return;
    setAudioFile(file);
    const url = URL.createObjectURL(file);
    setAudioUrl(url);

    const ctx = audioCtxRef.current ?? new (window.AudioContext || window.webkitAudioContext)();
    audioCtxRef.current = ctx;
    const arrayBuffer = await file.arrayBuffer();
    const buffer = await ctx.decodeAudioData(arrayBuffer);
    audioBufferRef.current = buffer;
  };

  // Play/Stop
  const play = (buffer) => {
    const buf = buffer ?? audioBufferRef.current; if (!buf) return;
    stop();
    const ctx = audioCtxRef.current ?? new (window.AudioContext || window.webkitAudioContext)();
    audioCtxRef.current = ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf; src.connect(ctx.destination); src.start();
    sourceRef.current = src; setIsPlaying(true);
    scheduleBeats(bpm ?? manualBpm);
    src.onended = () => { setIsPlaying(false); clearScheduler(); };
  };
  const stop = () => { if (sourceRef.current) { try{sourceRef.current.stop();}catch{} sourceRef.current.disconnect(); sourceRef.current=null; } setIsPlaying(false); clearScheduler(); };
  const clearScheduler = () => { if (schedulerTimerRef.current){ window.clearInterval(schedulerTimerRef.current); schedulerTimerRef.current=null; }};

  // Scheduler
  const scheduleBeats = (tempo) => {
    const beatMs = 60000 / clamp(tempo, 40, 240);
    const q = quantize === "1/1" ? 1 : quantize === "1/2" ? 0.5 : 0.25;
    const interval = beatMs * q; const swingAmt = swing / 100;
    nextBeatTimeRef.current = performance.now() + offsetMs;
    clearScheduler();
    schedulerTimerRef.current = window.setInterval(() => {
      const now = performance.now();
      if (now >= nextBeatTimeRef.current) {
        triggerBeat();
        const isOffBeat = (beatIndexRef.current % 2) === 1;
        const swingDelta = isOffBeat ? interval * swingAmt * 0.5 : 0;
        nextBeatTimeRef.current += interval + swingDelta;
      }
    }, Math.max(4, Math.min(16, interval/8)));
  };
  const triggerBeat = () => {
    beatIndexRef.current += 1;
    setBeatCount((c)=>c+1);
    setHitPulse(true); setTimeout(()=>setHitPulse(false), 100);
    setActiveArm((a)=>(a+1)%8);
  };

  // BPM detection placeholder
  const detectBpm = async () => {
    alert("Automatic BPM detection isn't available here – set BPM manually.");
  };

  useEffect(()=>{ if (!isPlaying) return; scheduleBeats(bpm ?? manualBpm); // eslint-disable-next-line
  },[bpm, manualBpm, quantize, swing, offsetMs]);

  useEffect(()=>()=>{ stop(); if (audioUrl) URL.revokeObjectURL(audioUrl); audioCtxRef.current?.close?.(); },[]);

  const tempo = bpm ?? manualBpm; const intervalMs = 60000 / clamp(tempo, 40, 240);

  // Per-member hit flags (subdivisions)
  const hitDrums = shouldHit(beatCount, band[0].subdivision) && hitPulse;
  const hitViolin = shouldHit(beatCount, band[1].subdivision) && hitPulse;
  const hitBass = shouldHit(beatCount, band[2].subdivision) && hitPulse;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6">
      <div className="max-w-6xl mx-auto grid gap-6">
        {/* Header */}
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Sparkles className="w-6 h-6"/>
            <h1 className="text-2xl font-semibold">Animal Band – BPM Sync</h1>
          </div>
          <div className="flex items-center gap-2">
            <button title="Play / Stop" className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 flex items-center gap-2"
              onClick={()=> (isPlaying? stop(): play())}>
              {isPlaying ? (<><Pause className="w-4 h-4"/> Stop</>) : (<><Play className="w-4 h-4"/> Play</>)}
            </button>
          </div>
        </header>

        {/* Load song & tempo */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60">
          <div className="p-4 border-b border-slate-800 flex items-center gap-2"><Upload className="w-4 h-4"/> <span className="text-base">Load a song</span></div>
          <div className="p-4 grid md:grid-cols-4 gap-4 items-end">
            <div className="md:col-span-2">
              <label className="block text-xs opacity-80 mb-1">Pick an audio file</label>
              <input type="file" accept="audio/*" onChange={(e)=> onAudioPick(e.target.files?.[0] ?? null)} className="w-full rounded-lg bg-slate-800 border border-slate-700 p-2"/>
              {audioFile && <p className="text-sm mt-2 opacity-80">Loaded: {audioFile.name}</p>}
            </div>
            <div className="flex gap-2 items-end md:col-span-2">
              <button className="px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 border border-indigo-400 flex items-center gap-2 disabled:opacity-50"
                onClick={detectBpm} disabled={!audioFile}><AudioLines className="w-4 h-4"/> Detect BPM</button>
              <div className="flex items-center gap-2">
                <label htmlFor="bpm" className="text-xs opacity-80">Manual BPM</label>
                <input id="bpm" type="number" className="w-24 rounded-lg bg-slate-800 border border-slate-700 p-2" value={tempo}
                  onChange={(e)=> setManualBpm(parseInt(e.target.value || "120",10))}/>
              </div>
            </div>
            <div className="md:col-span-4 grid md:grid-cols-4 gap-4">
              <div className="space-y-2">
                <label className="block">Quantize</label>
                <select className="w-full rounded-lg bg-slate-800 border border-slate-700 p-2" value={quantize} onChange={(e)=> setQuantize(e.target.value)}>
                  <option value="1/1">Quarter (1/1)</option>
                  <option value="1/2">Eighth (1/2)</option>
                  <option value="1/4">Sixteenth (1/4)</option>
                </select>
              </div>
              <div className="space-y-2">
                <label className="block">Swing: {swing}%</label>
                <input type="range" min={0} max={60} step={1} value={swing} onChange={(e)=> setSwing(parseInt(e.target.value,10))}
                  className="w-full" />
              </div>
              <div className="space-y-2">
                <label className="block">Start Offset (ms)</label>
                <input type="number" value={offsetMs} onChange={(e)=> setOffsetMs(parseInt(e.target.value || "0",10))}
                  className="w-full rounded-lg bg-slate-800 border border-slate-700 p-2" />
                <p className="text-xs opacity-70">Beat interval ≈ {formatMs(60000 / clamp(tempo,40,240))}</p>
              </div>
              <div className="space-y-2">
                <label className="block">Realism (0–2)</label>
                <input type="range" min={0} max={2} step={1} value={realism} onChange={(e)=> setRealism(parseInt(e.target.value,10))} className="w-full" />
              </div>
            </div>
          </div>
        </div>

        {/* Stage – PIXI WebGL animals */}
        <StageChrome beatPulse={hitPulse} realism={realism}>
          <div className="space-y-4">
            <div className="grid md:grid-cols-3 gap-4">
              <div className="rounded-2xl bg-black/30 backdrop-blur border border-slate-800 shadow-xl">
                <div className="py-3 px-4 border-b border-slate-800 flex items-center justify-between">
                  <div className="text-sm flex items-center gap-2"><Drum className="w-4 h-4"/> Octopus – Drums</div>
                  <MeterBars active={hitPulse}/>
                </div>
                <div className="p-4">
                  <PixiAnimals
                    width={860}
                    height={360}
                    beatPulse={hitPulse}
                    activeArm={activeArm}
                    hitDrums={hitDrums}
                    hitViolin={hitViolin}
                    hitBass={hitBass}
                    realism={realism}
                    debug={true}
                  />
                </div>
              </div>
              {/* The seahorse and seal are rendered in the same Pixi canvas above for lighting consistency */}
              <div className="rounded-2xl bg-black/30 backdrop-blur border border-slate-800 shadow-xl">
                <div className="py-3 px-4 border-b border-slate-800 flex items-center justify-between">
                  <div className="text-sm flex items-center gap-2"><Music2 className="w-4 h-4"/> Seahorse – Violin</div>
                  <MeterBars active={hitPulse}/>
                </div>
                <div className="p-4 text-xs opacity-75">Rendered in the WebGL stage above for coherent lighting & post‑fx.</div>
              </div>
              <div className="rounded-2xl bg-black/30 backdrop-blur border border-slate-800 shadow-xl">
                <div className="py-3 px-4 border-b border-slate-800 flex items-center justify-between">
                  <div className="text-sm flex items-center gap-2"><Guitar className="w-4 h-4"/> Seal – Bass</div>
                  <MeterBars active={beatCount % 2 === 0 && hitPulse}/>
                </div>
                <div className="p-4 text-xs opacity-75">Rendered in the WebGL stage above for coherent lighting & post‑fx.</div>
              </div>
            </div>
            <div className="mt-4 flex items-center justify-between text-sm opacity-90">
              <div className="flex items-center gap-2"><Clock className="w-4 h-4"/> Beats: {beatCount}</div>
              <div>Beat interval: {formatMs(intervalMs)}</div>
            </div>
          </div>
        </StageChrome>

        {/* Help */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60">
          <div className="p-4 border-b border-slate-800 flex items-center gap-2"><Settings2 className="w-4 h-4"/> <span className="text-base">How to use</span></div>
          <div className="p-4 grid md:grid-cols-3 gap-4 text-sm">
            <div>
              <p className="opacity-90">1) Load a song. 2) Set manual BPM (or add a detector). 3) Press Play. Animals perform a short action on each beat.</p>
            </div>
            <div>
              <p className="opacity-90">Quantize/Swing/Offset help lock to your BPM. Camera stays fixed — perfect for Resolume.</p>
            </div>
            <div>
              <p className="opacity-90">Swap vector shapes with layered PNGs for photo‑real. The WebGL pass handles displacement and lighting pulses.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
