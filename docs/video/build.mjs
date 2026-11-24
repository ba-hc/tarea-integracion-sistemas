// Genera index.html y compositions/*.html desde la evidencia versionada del repositorio.
// Ninguna cifra se escribe a mano: todo sale de docs/evidencia (corrida de CI) y de la narración medida.
//
//   node build.mjs <ruta-al-repo>      (FFPROBE=ruta a ffprobe si no está en el PATH)

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO = resolve(process.argv[2] ?? '../../repo');
const EVID = join(REPO, 'docs/evidencia');
const FFPROBE = process.env.FFPROBE ?? 'ffprobe';
const json = (name) => JSON.parse(readFileSync(join(EVID, name), 'utf8'));
const run = json('run.json');
const expo = json('exposicion.json');
const e1 = json('escenario1-exito.json');
const e2 = json('escenario2-compensacion.json');
const e3 = json('escenario3-cascada.json');
const consola = readFileSync(join(EVID, 'consola.txt'), 'utf8').split(/\r?\n/);
const k6 = readFileSync(join(REPO, 'experiments/payments/results/summary.csv'), 'utf8').trim().split(/\r?\n/);

/** Línea real de la consola de la corrida (la n-ésima que contiene el texto). */
function L(fragment, nth = 0) {
  const hits = consola.filter((line) => line.includes(fragment));
  if (!hits[nth]) throw new Error(`línea no encontrada en consola.txt: ${fragment}`);
  return hits[nth].replace(/\s+$/, '');
}

function k6mean(arm, scenario, field) {
  const [head, ...rows] = k6.map((line) => line.split(','));
  const i = head.indexOf(field);
  const values = rows.filter((r) => r[head.indexOf('arm')] === arm && r[head.indexOf('scenario')] === scenario).map((r) => Number(r[i]));
  return values.reduce((a, b) => a + b, 0) / values.length;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const num = (n) => Number(n).toLocaleString('es-CL', { maximumFractionDigits: 1 });
const secs = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : `${num(Math.round(ms / 100) / 10)} s`);

const LEAD = 0.5;
const TAIL = 1.2;
const W = 1920;
const H = 1080;

// ---------------------------------------------------------------------------
// Escenas: id, archivo de narración, título y constructor.

const SCENES = [
  ['s1', 's1-intro'], ['s2', 's2-exposicion'], ['s3', 's3-exito'], ['s4', 's4-compensacion'],
  ['s5', 's5-lenta'], ['s6', 's6-caida'], ['s7', 's7-decisiones'], ['s8', 's8-cierre'],
].map(([id, vo]) => {
  const text = readFileSync(`narracion/${vo}.txt`, 'utf8').trim();
  const voDur = Number(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', `assets/vo/${vo}.wav`]).toString().trim());
  return { id, vo, text, voDur, dur: Math.round((LEAD + voDur + TAIL) * 100) / 100 };
});
let clock = 0;
for (const scene of SCENES) { scene.start = Math.round(clock * 100) / 100; clock += scene.dur; }
const TOTAL = Math.round(clock * 100) / 100;
if (TOTAL >= 480) throw new Error(`el video dura ${TOTAL} s: supera los 8 minutos`);

/** Momento (s, local a la escena) en que la voz dice `phrase`. */
function cueOf(scene) {
  return (phrase, offset = 0) => {
    const i = scene.text.indexOf(phrase);
    if (i < 0) throw new Error(`${scene.id}: la narración no contiene «${phrase}»`);
    return Math.round((LEAD + scene.voDur * (i / scene.text.length) + offset) * 100) / 100;
  };
}

// ---------------------------------------------------------------------------
// Piezas reutilizables (HTML + animaciones GSAP como texto).

function termLines(prefix, lines) {
  return lines.map((line, i) => {
    const cls = line.startsWith('[ok]') ? 'ok' : line.startsWith('->') ? 'step' : line.startsWith('==') ? 'head' : '';
    const body = line.startsWith('[ok]') ? `<b>[ok]</b>${esc(line.slice(4))}` : esc(line);
    return `<div class="ln ${cls}" id="${prefix}-l${i}">${body}</div>`;
  }).join('\n');
}
const print = (sel, t, len = 60) => `tl.fromTo("${sel}", { clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0% 0 0)", duration: ${Math.min(0.8, Math.max(0.25, len / 110)).toFixed(2)}, ease: "none" }, ${t});`;
const enter = (sel, t, extra = '') => `tl.fromTo("${sel}", { opacity: 0, scale: 0.94 }, { opacity: 1, scale: 1, duration: 0.35, ease: "power3.out"${extra} }, ${t});`;
const show = (sel, t, d = 0.15) => `tl.fromTo("${sel}", { opacity: 0 }, { opacity: 1, duration: ${d}, ease: "none" }, ${t});`;
const mark = (sel, t) => `tl.fromTo("${sel}", { backgroundColor: "rgba(255,214,102,0)" }, { backgroundColor: "rgba(255,214,102,0.85)", duration: 0.3, ease: "none" }, ${t});`;
const stamp = (sel, t) => `tl.fromTo("${sel}", { opacity: 0, scale: 1.4 }, { opacity: 1, scale: 1, duration: 0.15, ease: "power2.out" }, ${t});`;

function sceneFile(id, css, body, anims) {
  return `<template>
  <style>
    #root { position: absolute; inset: 0; background: var(--ground); color: var(--ink); font-family: Inter, sans-serif; }
${css}
  </style>
  <div id="root" data-composition-id="${id}" data-width="${W}" data-height="${H}">
${body}
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
${anims.map((a) => `    ${a}`).join('\n')}
    window.__timelines["${id}"] = tl;
  </script>
</template>
`;
}

const title = (id, kicker, text) => `    <div class="kicker" id="${id}-kicker">${esc(kicker)}</div>
    <h1 class="scene-title" id="${id}-title">${esc(text)}</h1>`;
const titleAnims = (id) => [show(`#${id}-kicker`, 0.05, 0.25), enter(`#${id}-title`, 0.1)];

const builders = {};

// s1 · Intro ----------------------------------------------------------------
builders.s1 = (scene) => {
  const c = cueOf(scene);
  const css = `
    #s1-name { position: absolute; left: 120px; top: 170px; font-size: 150px; font-weight: 900; letter-spacing: -0.03em; }
    #s1-sub { position: absolute; left: 124px; top: 360px; font-size: 46px; color: var(--ink2); }
    #s1-pipe { position: absolute; left: 120px; top: 500px; display: flex; align-items: center; gap: 28px; }
    .s1-step { border: 3px solid var(--ink); background: #fff; padding: 22px 30px; min-width: 360px; }
    .s1-step b { display: block; font-size: 40px; }
    .s1-step span { font-size: 30px; color: var(--ink2); }
    .s1-arrow { font-size: 54px; color: var(--ink2); }
    #s1-note { position: absolute; left: 120px; top: 760px; width: 1500px; border-left: 8px solid var(--con); background: #fff; padding: 22px 30px; font-size: 32px; line-height: 1.35; }
    #s1-note code { font-family: "JetBrains Mono", monospace; font-size: 29px; }`;
  const body = `
    <div id="s1-name">RepuestosSur</div>
    <div id="s1-sub">Vender un repuesto sin dejar nunca una venta a medias</div>
    <div id="s1-pipe">
      <div class="s1-step" id="s1-inv"><b>Inventario</b><span>reserva el stock</span></div>
      <div class="s1-arrow" id="s1-a1">→</div>
      <div class="s1-step" id="s1-pag"><b>Pagos</b><span>cobra vía la pasarela</span></div>
      <div class="s1-arrow" id="s1-a2">→</div>
      <div class="s1-step" id="s1-des"><b>Despacho</b><span>crea la entrega</span></div>
    </div>
    <div id="s1-note"><b>Reconstrucción narrada, no grabación de pantalla.</b> Cada línea de consola y cada cifra viene de la corrida de CI
      <code id="s1-run">${run.run_id}</code> (commit <code id="s1-commit">${run.commit.slice(0, 7)}</code>), guardada en <code id="s1-evid">docs/evidencia/</code>.</div>`;
  const anims = [
    enter('#s1-name', 0.1), show('#s1-sub', c('Vender'), 0.3),
    enter('#s1-inv', c('Inventario')), show('#s1-a1', c('Pagos', -0.2)), enter('#s1-pag', c('Pagos')),
    show('#s1-a2', c('Despacho', -0.2)), enter('#s1-des', c('Despacho')),
    enter('#s1-note', c('Este video')), mark('#s1-run', c('corrida real')), mark('#s1-commit', c('integración continua')),
    mark('#s1-evid', c('evidencia guardada')),
  ];
  return sceneFile('s1', css, body, anims);
};

// s2 · Exposición ----------------------------------------------------------
builders.s2 = (scene) => {
  const c = cueOf(scene);
  const rl = expo.rateLimit;
  const lines = [
    L('[ok] sólo api-gateway publica'),
    L('[ok] GET /v1/customers sin token'),
    L('[ok] POST /v1/customers con rol reader'),
    L('respuestas: {"200"'),
    L('[ok] otro cliente sigue atendido'),
  ];
  const cells = [];
  for (let i = 0; i < rl.requests; i += 1) cells.push(`<div class="s2-cell ${i + 1 >= rl.firstLimitedAt ? 'lim' : ''}" id="s2-c${i}"></div>`);
  const node = (id, label, sub, x, y, w, extra = '') => `<div class="s2-node ${extra}" id="${id}" style="left:${x}px;top:${y}px;width:${w}px"><b>${label}</b>${sub ? `<span>${sub}</span>` : ''}</div>`;
  const css = `
    .kicker { position: absolute; left: 96px; top: 64px; font-size: 28px; font-weight: 700; color: var(--con); letter-spacing: 0.02em; }
    .scene-title { position: absolute; left: 96px; top: 100px; margin: 0; font-size: 60px; font-weight: 900; letter-spacing: -0.02em; }
    #s2-diagram { position: absolute; left: 96px; top: 210px; width: 860px; height: 740px; }
    .s2-node { position: absolute; border: 3px solid var(--ink); background: #fff; padding: 12px 16px; text-align: center; }
    .s2-node b { display: block; font-size: 30px; }
    .s2-node span { display: block; font-size: 28px; color: var(--ink2); }
    .s2-node span i { font-style: normal; padding: 0 3px; }
    .s2-node.gw { border-color: var(--con); border-width: 4px; }
    .s2-node.ext { border-style: dashed; }
    #s2-net { position: absolute; left: 0; top: 168px; width: 860px; height: 490px; border: 2px dashed var(--rule); }
    #s2-netlabel { position: absolute; left: 14px; top: 612px; font-size: 28px; color: var(--ink2); }
    #s2-port { position: absolute; left: 600px; top: 40px; font-family: "JetBrains Mono", monospace; font-size: 28px; background: var(--con); color: #fff; padding: 6px 12px; }
    #s2-svg { position: absolute; left: 0; top: 0; }
    #s2-term { position: absolute; left: 990px; top: 210px; width: 834px; }
    #s2-grid { position: absolute; left: 990px; top: 770px; display: grid; grid-template-columns: repeat(14, 34px); gap: 6px; }
    .s2-cell { width: 34px; height: 34px; background: var(--ok); }
    #s2-cmd { position: absolute; left: 1100px; top: 112px; font-family: "JetBrains Mono", monospace; font-size: 30px; background: #15171c; color: #e4e4e0; padding: 8px 16px; }
    #s2-nobiz { position: absolute; left: 686px; top: 128px; font-size: 28px; font-weight: 700; color: var(--fail); }
    .s2-cell.lim { background: var(--sin); }
    #s2-gridlabel { position: absolute; left: 990px; top: 978px; font-size: 28px; color: var(--ink2); }`;
  const body = `
${title('s2', 'Exposición', 'Una sola puerta: el API Gateway')}
    <div id="s2-cmd">$ docker compose up</div>
    <div id="s2-diagram">
      <div id="s2-net"></div><div id="s2-netlabel">red interna de docker compose</div>
      <svg id="s2-svg" width="860" height="740" viewBox="0 0 860 740">
        <g stroke="#16161a" stroke-width="3" fill="none">
          <path id="s2-e1" d="M430 96 V120" /><path id="s2-e2" d="M430 222 L230 330" /><path id="s2-e3" d="M430 222 L630 330" />
          <path id="s2-e4" d="M230 412 L120 520" /><path id="s2-e5" d="M230 412 L430 520" /><path id="s2-e6" d="M230 412 L740 520" />
          <path id="s2-e7" d="M430 586 V680" /><path id="s2-e8" d="M630 412 L430 520" stroke-dasharray="8 6" /><path id="s2-e9" d="M630 412 L740 520" stroke-dasharray="8 6" />
        </g>
      </svg>
      ${node('s2-cli', 'Cliente', 'token JWT', 330, 0, 200)}
      ${node('s2-gw', 'API Gateway', '<i id="s2-g1">token</i>·<i id="s2-g2">rol</i>·<i id="s2-g3">rate limit</i>·<i id="s2-g4">timeout</i>', 190, 120, 480, 'gw')}
      <div id="s2-nobiz">sin lógica<br>de negocio</div>
      ${node('s2-ven', 'Ventas', 'orquesta la Saga', 80, 330, 300)}
      ${node('s2-bff', 'BFF web', 'pago + despacho', 480, 330, 300)}
      ${node('s2-inv', 'Inventario', '', 20, 520, 200)}
      ${node('s2-pag', 'Pagos', '', 330, 520, 200)}
      ${node('s2-des', 'Despacho', '', 640, 520, 200)}
      ${node('s2-pas', 'Pasarela', 'externa, simulada', 270, 680, 320, 'ext')}
      <div id="s2-port">127.0.0.1:8080</div>
    </div>
    <div class="term" id="s2-term">
${termLines('s2', lines)}
    </div>
    <div id="s2-grid">${cells.join('')}</div>
    <div id="s2-gridlabel">${rl.requests} GET del mismo token: ${rl.counts['200']} × 200 y ${rl.counts['429 RATE_LIMIT_EXCEEDED']} × 429 (Retry-After ${rl.retryAfterSeconds} s)</div>`;
  const tAll = c('siete servicios');
  const anims = [
    ...titleAnims('s2'), enter('#s2-cmd', c('dóquer')),
    show('#s2-net', tAll, 0.3), show('#s2-netlabel', tAll, 0.3),
    ...['#s2-ven', '#s2-bff', '#s2-inv', '#s2-pag', '#s2-des', '#s2-pas'].map((sel, i) => enter(sel, tAll + i * 0.12)),
    ...['#s2-e2', '#s2-e3', '#s2-e4', '#s2-e5', '#s2-e6', '#s2-e7', '#s2-e8', '#s2-e9'].map((sel, i) => show(sel, tAll + 0.2 + i * 0.1)),
    enter('#s2-gw', c('Sólo la puerta')), show('#s2-cli', c('Sólo la puerta')), show('#s2-e1', c('Sólo la puerta', 0.2)),
    stamp('#s2-port', c('publica un puerto')), print('#s2-l0', c('publica un puerto', 0.5), lines[0].length),
    mark('#s2-g1', c('Valida el token')), mark('#s2-g2', c('decide por rol')), mark('#s2-g3', c('limita a cada')), mark('#s2-g4', c('tiempo máximo')),
    show('#s2-nobiz', c('sin lógica'), 0.3),
    print('#s2-l1', c('sin token'), lines[1].length),
    print('#s2-l2', c('Un lector'), lines[2].length),
    ...cells.map((_, i) => show(`#s2-c${i}`, c('setenta peticiones') + i * 0.035, 0.05)),
    print('#s2-l3', c('la número sesenta'), lines[3].length),
    show('#s2-gridlabel', c('la número sesenta'), 0.3),
    print('#s2-l4', c('otro cliente'), lines[4].length),
  ];
  return sceneFile('s2', css, body, anims);
};

// Saga pipeline compartido por s3 y s4.
function pipeline(prefix, labels) {
  return `<div class="pipe" id="${prefix}-pipe">${labels.map(([k, a, b], i) => `${i ? `<div class="pipe-arrow" id="${prefix}-ar${i}">→</div>` : ''}
      <div class="pipe-step" id="${prefix}-${k}"><b>${a}</b><span>${b}</span><em class="pipe-stamp" id="${prefix}-${k}-st"></em><em class="pipe-stamp2" id="${prefix}-${k}-st2"></em></div>`).join('')}</div>`;
}
const pipeCss = `
    .kicker { position: absolute; left: 96px; top: 64px; font-size: 28px; font-weight: 700; color: var(--con); letter-spacing: 0.02em; }
    .scene-title { position: absolute; left: 96px; top: 100px; margin: 0; font-size: 60px; font-weight: 900; letter-spacing: -0.02em; }
    .pipe { position: absolute; left: 96px; top: 220px; display: flex; align-items: center; gap: 22px; }
    .pipe-step { position: relative; border: 3px solid var(--ink); background: #fff; padding: 18px 24px 58px; width: 390px; white-space: nowrap; }
    .pipe-step b { display: block; font-size: 34px; }
    .pipe-step span { display: block; font-size: 28px; color: var(--ink2); }
    .pipe-arrow { font-size: 48px; color: var(--ink2); }
    .pipe-stamp, .pipe-stamp2 { position: absolute; left: 24px; bottom: 12px; font-style: normal; font-family: "JetBrains Mono", monospace; font-size: 28px; font-weight: 700; padding: 2px 10px; color: #fff; opacity: 0; }
    .pipe-stamp2 { left: auto; right: 16px; }
    .done { background: var(--ok); } .rej { background: var(--fail); } .comp { background: var(--sin); }`;

// s3 · Éxito ---------------------------------------------------------------
builders.s3 = (scene) => {
  const c = cueOf(scene);
  const lines = [
    L('[ok] venta -> 201 CONFIRMED'),
    L('[ok] reintento -> 201, misma orden'),
    L('[ok] misma key con otra cantidad'),
    L('bitácora de la Saga: stock:EXECUTE'),
    L('[ok] stock 200 -> 199'),
    L('[ok] la pasarela registró un solo cobro'),
    L('[ok] resumen 200: pago CHARGED'),
  ];
  const summary = e1.summary;
  const css = `${pipeCss}
    #s3-sale { position: absolute; left: 1560px; top: 236px; width: 264px; border: 3px solid var(--ok); background: #fff; padding: 16px; text-align: center; font-size: 28px; font-weight: 700; opacity: 0; }
    #s3-term { position: absolute; left: 96px; top: 470px; width: 1100px; }
    #s3-read { position: absolute; left: 1250px; top: 470px; width: 574px; }
    .read { border-top: 3px solid var(--ink); padding: 12px 0 18px; }
    .read small { display: block; font-size: 28px; color: var(--ink2); }
    .read big { display: block; font-size: 64px; font-weight: 900; letter-spacing: -0.02em; }
    #s3-bff { border: 3px solid var(--con); background: #fff; padding: 14px 18px; font-size: 28px; }
    #s3-bff code { font-family: "JetBrains Mono", monospace; font-size: 28px; }`;
  const body = `
${title('s3', 'Escenario 1 · camino feliz', 'Reservar → cobrar → despachar')}
    ${pipeline('s3', [['stock', '1 · Reservar stock', 'Inventario (gRPC)'], ['pay', '2 · Cobrar', 'Pagos → pasarela'], ['dis', '3 · Crear despacho', 'Despacho']])}
    <div id="s3-sale">${e1.sale.status}<br>${esc(e1.sale.orderStatus)}</div>
    <div class="term" id="s3-term">
${termLines('s3', lines)}
    </div>
    <div id="s3-read">
      <div class="read" id="s3-r1"><small>Stock de la pieza</small><big>${e1.stock.before} → ${e1.stock.after}</big></div>
      <div class="read" id="s3-r2"><small>Cobros nuevos en la pasarela</small><big>${e1.pasarela.chargesApprovedDelta}</big></div>
      <div id="s3-bff"><b>BFF web · una respuesta</b><br>pago <code>${esc(summary.payment.data.status)}</code> · despacho <code>${esc(summary.dispatch.data.status)}</code></div>
    </div>`;
  const anims = [
    ...titleAnims('s3'),
    enter('#s3-stock', 0.4), show('#s3-ar1', 0.5), enter('#s3-pay', 0.6), show('#s3-ar2', 0.7), enter('#s3-dis', 0.8),
    `document.querySelector("#s3-stock-st").textContent = "DONE"; document.querySelector("#s3-stock-st").classList.add("done");`,
    `document.querySelector("#s3-pay-st").textContent = "DONE"; document.querySelector("#s3-pay-st").classList.add("done");`,
    `document.querySelector("#s3-dis-st").textContent = "DONE"; document.querySelector("#s3-dis-st").classList.add("done");`,
    stamp('#s3-stock-st', c('reserva el stock')), stamp('#s3-pay-st', c('cobra en Pagos')), stamp('#s3-dis-st', c('crea el despacho')),
    enter('#s3-sale', c('La venta responde')), mark('#s3-sale', c('confirmada')),
    print('#s3-l0', c('La venta responde'), lines[0].length),
    print('#s3-l1', c('El cliente reintenta'), lines[1].length),
    print('#s3-l2', c('otra cantidad'), lines[2].length),
    print('#s3-l3', c('Leemos la evidencia'), lines[3].length),
    print('#s3-l4', c('el stock bajó'), lines[4].length), enter('#s3-r1', c('el stock bajó')),
    print('#s3-l5', c('un solo cobro'), lines[5].length), enter('#s3-r2', c('un solo cobro')),
    print('#s3-l6', c('be efe efe'), lines[6].length), enter('#s3-bff', c('be efe efe')),
  ];
  return sceneFile('s3', css, body, anims);
};

// s4 · Compensación --------------------------------------------------------
builders.s4 = (scene) => {
  const c = cueOf(scene);
  const ev = e2.saga.events;
  const induce = [L('-> Se provoca la falla'), L('[ok] dispatch-api recreado'), L('[ok] venta -> 503 DISPATCH_UNAVAILABLE')];
  const rows = ev.map((e, i) => `<tr id="s4-row${i}" class="${e.action === 'COMPENSATE' ? 'comp-row' : e.outcome === 'REJECTED' ? 'rej-row' : ''}"><td class="mono">${esc(e.at)}</td><td>${esc(e.step)}</td><td>${esc(e.action)}</td><td>${esc(e.outcome)}</td></tr>`).join('\n');
  const ba = [
    ['Stock de la pieza', e2.stock.before, e2.stock.after],
    ['Cobros / reembolsos nuevos', '–', `${e2.pasarela.chargesApprovedDelta} / ${e2.pasarela.refundsDelta}`],
    ['Pago según el BFF', '–', e2.summary.payment.data.status],
    ['GET /v1/orders/{id}', '–', e2.publicOrderStatus],
  ];
  const css = `${pipeCss}
    .pipe { top: 380px; }
    #s4-term { position: absolute; left: 96px; top: 200px; width: 1728px; }
    #s4-log { position: absolute; left: 96px; top: 600px; width: 1010px; border-collapse: collapse; font-size: 28px; }
    #s4-log td, #s4-log th { border-bottom: 2px solid var(--rule); padding: 7px 12px; text-align: left; }
    #s4-log th { font-size: 28px; color: var(--ink2); }
    .mono { font-family: "JetBrains Mono", monospace; font-size: 28px; }
    .comp-row td { color: var(--sin); font-weight: 700; }
    .rej-row td { color: var(--fail); font-weight: 700; }
    #s4-ba { position: absolute; left: 1150px; top: 600px; width: 674px; border-collapse: collapse; font-size: 28px; }
    #s4-ba td, #s4-ba th { border-bottom: 2px solid var(--rule); padding: 7px 10px; text-align: left; }
    #s4-ba th { font-size: 28px; color: var(--ink2); }
    #s4-ba td.n { text-align: right; font-weight: 700; }
    #s4-rev { position: absolute; left: 470px; top: 540px; font-size: 30px; font-weight: 700; color: var(--sin-ink); }
    .comp-row td { color: var(--sin-ink) !important; }`;
  const body = `
${title('s4', 'Escenario 2 · falla del último paso', 'Compensar en orden inverso')}
    <div class="term" id="s4-term">
${termLines('s4', induce)}
    </div>
    ${pipeline('s4', [['stock', '1 · Reservar stock', 'Inventario'], ['pay', '2 · Cobrar', 'Pagos'], ['dis', '3 · Crear despacho', 'Despacho']])}
    <div id="s4-rev">← compensación: primero reembolsar, después liberar</div>
    <table id="s4-log"><tr id="s4-loghead"><th>hora UTC</th><th>paso</th><th>acción</th><th>resultado</th></tr>
${rows}
    </table>
    <table id="s4-ba"><tr id="s4-bahead"><th></th><th>antes</th><th>después</th></tr>
${ba.map(([a, b, d], i) => `<tr id="s4-ba${i}"><td>${esc(a)}</td><td class="n">${esc(b)}</td><td class="n">${esc(d)}</td></tr>`).join('\n')}
    </table>`;
  const tOk = c('Stock y pago confirmados');
  const tRej = c('despacho rechazado');
  const tRef = c('primero el reembolso');
  const tRel = c('después la liberación');
  const set = (sel, text, cls) => `document.querySelector("${sel}").textContent = "${text}"; document.querySelector("${sel}").classList.add("${cls}");`;
  const anims = [
    ...titleAnims('s4'),
    print('#s4-l0', c('Inducimos'), induce[0].length), print('#s4-l1', c('recreamos Despacho', 0.6), induce[1].length),
    print('#s4-l2', c('La venta responde'), induce[2].length),
    enter('#s4-stock', 0.5), show('#s4-ar1', 0.6), enter('#s4-pay', 0.7), show('#s4-ar2', 0.8), enter('#s4-dis', 0.9),
    set('#s4-stock-st', 'DONE', 'done'), set('#s4-pay-st', 'DONE', 'done'), set('#s4-dis-st', 'REJECTED', 'rej'),
    set('#s4-pay-st2', 'COMPENSATED', 'comp'), set('#s4-stock-st2', 'COMPENSATED', 'comp'),
    show('#s4-loghead', c('La bitácora'), 0.3),
    stamp('#s4-stock-st', tOk), stamp('#s4-pay-st', tOk + 0.4), show('#s4-row0', tOk, 0.2), show('#s4-row1', tOk + 0.4, 0.2),
    stamp('#s4-dis-st', tRej), show('#s4-row2', tRej, 0.2),
    show('#s4-rev', c('compensaciones en orden inverso'), 0.3),
    stamp('#s4-pay-st2', tRef), show('#s4-row3', tRef, 0.2),
    stamp('#s4-stock-st2', tRel), show('#s4-row4', tRel, 0.2), show('#s4-row5', tRel + 0.6, 0.2),
    show('#s4-bahead', c('Antes y después'), 0.3),
    show('#s4-ba0', c('el stock sigue'), 0.25), show('#s4-ba1', c('hubo un cobro'), 0.25),
    show('#s4-ba2', c('Pagos marca'), 0.25), show('#s4-ba3', c('no existe orden'), 0.25),
  ];
  return sceneFile('s4', css, body, anims);
};

// Columnas con / sin protecciones para s5 y s6.
const armCss = `
    .kicker { position: absolute; left: 96px; top: 64px; font-size: 28px; font-weight: 700; color: var(--con); letter-spacing: 0.02em; }
    .scene-title { position: absolute; left: 96px; top: 100px; margin: 0; font-size: 60px; font-weight: 900; letter-spacing: -0.02em; }
    .arm { position: absolute; top: 210px; width: 840px; }
    .arm h2 { margin: 0 0 14px; font-size: 36px; font-weight: 900; padding-bottom: 8px; border-bottom: 5px solid; }
    .arm.con h2 { color: var(--con); border-color: var(--con); }
    .arm.sin h2 { color: var(--sin-ink); border-color: var(--sin); }
    .arm .sub { font-size: 28px; color: var(--ink2); margin-bottom: 14px; }
    .sq { display: grid; grid-template-columns: repeat(12, 62px); gap: 6px; margin-bottom: 10px; }
    .cell { width: 62px; height: 62px; border: 3px solid var(--ink); background: #fff; font-family: "JetBrains Mono", monospace; font-size: 28px; letter-spacing: -2px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
    .legend { font-size: 28px; margin: 4px 0; }
    .sw { display: inline-block; width: 26px; height: 26px; vertical-align: -4px; margin-right: 8px; border: 3px solid var(--ink); }
    .metric { border-top: 2px solid var(--rule); padding: 10px 0; font-size: 28px; display: flex; justify-content: space-between; }
    .metric b { font-size: 34px; }
    .state { display: inline-block; font-family: "JetBrains Mono", monospace; font-size: 26px; font-weight: 700; padding: 4px 12px; color: #fff; }`;

// s5 · Pasarela lenta + pico ----------------------------------------------
builders.s5 = (scene) => {
  const c = cueOf(scene);
  const P = e3.protected.phases.slow;
  const U = e3.unprotected.phases.slow;
  const n = e3.config.peakSales;
  const pTimeout = P.sales.statuses['504 PAYMENT_TIMEOUT'] ?? 0;
  const pReject = P.sales.statuses['503 PAYMENT_UNAVAILABLE'] ?? 0;
  const uTimeout = U.sales.statuses['504 PAYMENT_TIMEOUT'] ?? 0;
  const pCharges = e3.protected.consistency.pasarela.chargesApproved - e3.protected.consistency.confirmedSales;
  const uCharges = e3.unprotected.consistency.pasarela.chargesApproved - e3.unprotected.consistency.confirmedSales;
  const reads = (arm) => Object.entries(arm.otherOperations).map(([op, s]) => `${Object.values(s.statuses).reduce((a, b) => a + b, 0)}/${s.statuses['200'] ?? 0}`);
  const allOk = (arm) => Object.values(arm.otherOperations).every((s) => Object.keys(s.statuses).every((k) => k === '200'));
  if (!allOk(P) || !allOk(U)) throw new Error('s5: las lecturas no fueron todas 200; revisar la narración');
  const grid = (prefix, codeOf) => Array.from({ length: n }, (_, i) => `<div class="cell" id="${prefix}${i}"><span id="${prefix}${i}t">${codeOf(i)}</span></div>`).join('');
  const css = `${armCss}
    #s5-con { left: 96px; } #s5-sin { left: 984px; }
    .cell span { opacity: 0; }
    #s5-slow { position: absolute; left: 1250px; top: 112px; font-family: "JetBrains Mono", monospace; font-size: 30px; background: #15171c; color: #f0c27a; padding: 8px 16px; }`;
  const body = `
${title('s5', 'Escenario 3a · pasarela lenta (3 s)', `${n} ventas simultáneas de ${e3.config.peakClients} clientes`)}
    <div id="s5-slow">pasarela: mode=slow, ${e3.config.slowDelayMs} ms</div>
    <div class="arm con" id="s5-con">
      <h2>Con protecciones</h2>
      <div class="sub">timeout 1,2 s · Circuit Breaker · Bulkhead ≤ ${P.resilience.bulkhead.maxConcurrent}</div>
      <div class="sq">${grid('s5-p', (i) => (i < pTimeout ? '504' : '503'))}</div>
      <div class="legend" id="s5-pl1"><span class="sw" style="background:#f4c7b4"></span>${pTimeout} × 504: pasaron el bulkhead y agotaron el timeout</div>
      <div class="legend" id="s5-pl2"><span class="sw" style="background:#cfe0f5"></span>${pReject} × 503 al instante, sin tocar la pasarela</div>
      <div class="metric" id="s5-pm0"><span>Circuito</span><span class="state" style="background:var(--sin-ink)" id="s5-pstate">${esc(P.resilience.circuitBreaker.state)}</span></div>
      <div class="metric" id="s5-pm1"><span>Venta p50</span><b>${num(Math.round(P.sales.p50))} ms</b></div>
      <div class="metric" id="s5-pm2"><span>Cobros aplicados que hubo que reembolsar</span><b>${pCharges}</b></div>
      <div class="metric" id="s5-pm3"><span>Lecturas durante el pico (total/200)</span><b>${reads(P).join(' · ')}</b></div>
    </div>
    <div class="arm sin" id="s5-sin">
      <h2>Sin protecciones</h2>
      <div class="sub">sin circuito ni bulkhead · Pagos espera hasta 30 s</div>
      <div class="sq">${grid('s5-u', () => '504')}</div>
      <div class="legend" id="s5-ul1"><span class="sw" style="background:#f4c7b4"></span>${uTimeout} × 504: Ventas se rinde a los 2 s</div>
      <div class="legend" style="visibility:hidden"><span class="sw"></span>.</div>
      <div class="metric" id="s5-um0"><span>Circuito</span><span class="state" style="background:var(--ink2)">desactivado</span></div>
      <div class="metric" id="s5-um1"><span>Venta p50</span><b>${num(Math.round(U.sales.p50))} ms</b></div>
      <div class="metric" id="s5-um2"><span>Cobros aplicados que hubo que reembolsar</span><b>${uCharges}</b></div>
      <div class="metric" id="s5-um3"><span>Lecturas durante el pico (total/200)</span><b>${reads(U).join(' · ')}</b></div>
    </div>`;
  const tLenta = c('lenta, tres segundos');
  const tPeak = c('lanzamos veinticuatro');
  const tOcho = c('deja pasar sólo ocho');
  const tOpen = c('el circuito se abre');
  const t16 = c('Las otras dieciséis');
  const tSin = c('Repetimos sin protecciones');
  const tFinal = c('Con protecciones, fueron sólo ocho');
  const tReads = c('Mientras tanto');
  const fill = (sel, color, t) => [
    `tl.fromTo("${sel}", { backgroundColor: "#ffffff" }, { backgroundColor: "${color}", duration: 0.12, ease: "none" }, ${t.toFixed(2)});`,
    `tl.fromTo("${sel}t", { opacity: 0 }, { opacity: 1, duration: 0.12, ease: "none" }, ${t.toFixed(2)});`,
  ];
  const anims = [...titleAnims('s5'), stamp('#s5-slow', tLenta), enter('#s5-con', tPeak), enter('#s5-sin', tPeak + 0.2)];
  for (let i = 0; i < n; i += 1) {
    const isTimeout = i < pTimeout;
    anims.push(...fill(`#s5-p${i}`, isTimeout ? '#f4c7b4' : '#cfe0f5', isTimeout ? tOcho + i * 0.06 : t16 + (i - pTimeout) * 0.04));
    anims.push(...fill(`#s5-u${i}`, '#f4c7b4', c('Ventas se rinde') + i * 0.04));
  }
  anims.push(show('#s5-pl1', tOcho + 0.6, 0.3), show('#s5-pm0', tOpen - 0.2, 0.2), stamp('#s5-pstate', tOpen), show('#s5-pl2', t16 + 0.6, 0.3), show('#s5-pm1', t16 + 1.2, 0.3));
  anims.push(mark('#s5-sin h2', tSin), show('#s5-ul1', c('Ventas se rinde'), 0.3), show('#s5-um0', c('Ventas se rinde'), 0.3), show('#s5-um1', c('a los dos segundos'), 0.3));
  anims.push(show('#s5-um2', c('veinticuatro cobros'), 0.3), show('#s5-pm2', tFinal, 0.3));
  anims.push(show('#s5-pm3', tReads, 0.3), show('#s5-um3', tReads + 0.3, 0.3), mark('#s5-pm3 b', c('esas lecturas')), mark('#s5-um3 b', c('no pasan por la pasarela')));
  return sceneFile('s5', css, body, anims);
};

// s6 · Pasarela caída + recuperación + consistencia ------------------------
builders.s6 = (scene) => {
  const c = cueOf(scene);
  const P = e3.protected.phases;
  const U = e3.unprotected.phases;
  const n = e3.config.downSales;
  const recP = P.recovery.attempts.at(-1).atMs;
  const recU = U.recovery.attempts.at(-1).atMs;
  const okLines = [L('ventas confirmadas 1; stock', 0), L('ventas confirmadas 1; stock', 1), L('[ok] cada unidad descontada'), L('[ok] cada cobro neto')];
  const k6p = Math.round(k6mean('protected', 'slow', 'pending'));
  const k6u = Math.round(k6mean('unprotected', 'slow', 'client_timeouts'));
  const k6n = Math.round(k6mean('unprotected', 'slow', 'charge_requests'));
  const lane = (prefix, reached) => `<div class="lane" id="${prefix}-lane">
        <div class="lnode">Ventas</div><div class="lnode">Pagos</div><div class="lnode down">Pasarela ✕</div>
        ${Array.from({ length: n }, (_, i) => `<div class="dot" id="${prefix}-d${i}"></div>`).join('')}
        <div class="lcount" id="${prefix}-count">${reached} de ${n} llegan a la pasarela</div></div>`;
  const css = `${armCss}
    #s6-con { left: 96px; } #s6-sin { left: 984px; }
    .lane { position: relative; height: 210px; }
    .lnode { position: absolute; top: 20px; width: 190px; border: 3px solid var(--ink); background: #fff; text-align: center; font-size: 28px; font-weight: 700; padding: 18px 0; }
    .lnode:nth-child(1) { left: 0; } .lnode:nth-child(2) { left: 320px; } .lnode:nth-child(3) { left: 640px; }
    .lnode.down { border-style: dashed; color: var(--fail); border-color: var(--fail); }
    .dot { position: absolute; left: 200px; top: 52px; width: 13px; height: 13px; border-radius: 50%; background: var(--ink); opacity: 0; }
    .lcount { position: absolute; left: 0; top: 130px; font-size: 32px; font-weight: 900; }
    #s6-rec { position: absolute; left: 96px; top: 590px; width: 1728px; }
    #s6-term { position: absolute; left: 96px; top: 690px; width: 1110px; }
    #s6-k6 { position: absolute; left: 1250px; top: 740px; width: 574px; font-size: 28px; }
    #s6-fast { position: absolute; left: 0; top: 330px; font-size: 28px; font-weight: 700; color: var(--con); }
    .bar { height: 40px; margin: 6px 0 12px; display: flex; align-items: center; }
    .bar i { display: block; height: 40px; }
    .bar b { margin-left: 12px; font-size: 30px; }`;
  const body = `
${title('s6', 'Escenario 3b · pasarela caída', `${n} ventas seguidas, y la vuelta`)}
    <div class="arm con" id="s6-con"><h2>Con protecciones · circuito ${esc(P.down.resilience.circuitBreaker.state)}</h2>${lane('s6-p', P.down.pasarelaCalls)}<div id="s6-fast">503 en ${Math.round(P.down.sales.p50)} ms (p50) · Ventas libera el stock</div></div>
    <div class="arm sin" id="s6-sin"><h2>Sin protecciones</h2>${lane('s6-u', U.down.pasarelaCalls)}</div>
    <div id="s6-rec">
      <div class="metric" id="s6-r1"><span>Primera venta aceptada tras volver la pasarela</span><b><span style="color:var(--con)" id="s6-recp">${secs(recP)}</span> con circuito (espera la sonda) · <span style="color:var(--sin-ink)" id="s6-recu">${secs(recU)}</span> sin él</b></div>
    </div>
    <div class="term" id="s6-term">
${termLines('s6', okLines)}
    </div>
    <div id="s6-k6"><div id="s6-k6t"><b>Experimento k6</b> · ${k6n} cobros por corrida, pasarela lenta: cobros en duda</div>
      <div class="bar" id="s6-k6a"><i style="width:${Math.max(6, Math.round(420 * k6p / k6u))}px;background:var(--con)"></i><b>${k6p}</b></div>
      <div class="bar" id="s6-k6b"><i style="width:420px;background:var(--sin)"></i><b>${k6u}</b></div></div>`;
  const tDown = c('llegan diez ventas');
  const tCon = c('Con el circuito abierto');
  const tSin = c('Sin circuito');
  const anims = [...titleAnims('s6'), enter('#s6-con', tDown - 0.6), enter('#s6-sin', tDown - 0.4)];
  for (let i = 0; i < n; i += 1) {
    // Con circuito: el punto sale de Ventas y se detiene en Pagos. Sin circuito: llega a la pasarela.
    const col = Math.floor(i / 5) * 20;
    const row = (i % 5) * 15 - 30;
    const stopP = (i < P.down.pasarelaCalls ? 575 : 255) + col - 200;
    const stopU = (i < U.down.pasarelaCalls ? 575 : 255) + col - 200;
    anims.push(`tl.fromTo("#s6-p-d${i}", { x: 0, y: ${row}, opacity: 0 }, { x: ${stopP}, opacity: 1, duration: 0.45, ease: "power2.out" }, ${(tCon + i * 0.2).toFixed(2)});`);
    anims.push(`tl.fromTo("#s6-u-d${i}", { x: 0, y: ${row}, opacity: 0 }, { x: ${stopU}, opacity: 1, duration: 0.45, ease: "power2.out" }, ${(tSin + i * 0.16).toFixed(2)});`);
  }
  anims.push(show('#s6-p-count', tCon + 2.4, 0.3), show('#s6-u-count', tSin + 2.2, 0.3));
  anims.push(enter('#s6-r1', c('Cuando la pasarela vuelve')));
  anims.push(print('#s6-l0', c('la consistencia se mantiene'), okLines[0].length), print('#s6-l1', c('la consistencia se mantiene', 0.8), okLines[1].length));
  anims.push(print('#s6-l2', c('cada unidad descontada'), okLines[2].length), print('#s6-l3', c('cada cobro neto'), okLines[3].length));
  anims.push(show('#s6-fast', c('Pagos responde de inmediato'), 0.3), mark('#s6-recp', c('tres coma dos')), mark('#s6-recu', c('Ese es el costo')));
  anims.push(show('#s6-k6t', c('en el experimento de carga'), 0.3), show('#s6-k6b', c('todos quedaron en duda'), 0.3), show('#s6-k6a', c('con ellas, catorce'), 0.3));
  return sceneFile('s6', css, body, anims);
};

// s7 · Decisiones ------------------------------------------------------------
builders.s7 = (scene) => {
  const c = cueOf(scene);
  const css = `
    .kicker { position: absolute; left: 96px; top: 64px; font-size: 28px; font-weight: 700; color: var(--con); letter-spacing: 0.02em; }
    .scene-title { position: absolute; left: 96px; top: 100px; margin: 0; font-size: 60px; font-weight: 900; letter-spacing: -0.02em; }
    #s7-left { position: absolute; left: 96px; top: 230px; width: 820px; }
    .dec { border-left: 8px solid var(--ink); padding: 6px 0 6px 24px; margin-bottom: 34px; }
    .dec b { display: block; font-size: 40px; font-weight: 900; }
    .dec span { display: block; font-size: 30px; color: var(--ink2); line-height: 1.35; }
    .strike { text-decoration: line-through; text-decoration-thickness: 4px; color: var(--fail); }
    #s7-dia { position: absolute; left: 1000px; top: 230px; width: 824px; height: 760px; }
    .dnode { position: absolute; border: 3px solid var(--ink); background: #fff; text-align: center; font-size: 30px; font-weight: 700; padding: 16px 0; width: 250px; }
    .dnode.orq { border-color: var(--con); border-width: 5px; }
    .key { position: absolute; white-space: nowrap; font-family: "JetBrains Mono", monospace; font-size: 28px; background: var(--ink); color: #fff; padding: 4px 10px; }`;
  const body = `
${title('s7', 'Decisiones', 'Saga orquestada e idempotente')}
    <div id="s7-left">
      <div class="dec" id="s7-d1"><b><span class="strike" style="display:inline;font-size:40px;color:var(--fail)">Commit en dos fases</span> → Saga</b>
        <span id="s7-d1a">La pasarela es un tercero: no vota ni retiene fondos.</span><span id="s7-d1b">Bloquear Inventario y Despacho al ritmo del más lento es la cascada que evitamos.</span></div>
      <div class="dec" id="s7-d2"><b>Orquestación en Ventas</b>
        <span>Un solo componente impone <em id="s7-inv2" style="font-style:normal">el orden inverso</em> y deja <em id="s7-bit" style="font-style:normal">una bitácora legible</em> (sale_saga_events).</span></div>
      <div class="dec" id="s7-d3"><b>Idempotencia por orderId</b>
        <span>Reintentar o compensar nunca duplica una reserva, un cobro ni un despacho.</span></div>
    </div>
    <div id="s7-dia">
      <svg width="824" height="760" viewBox="0 0 824 760" style="position:absolute;left:0;top:0">
        <g stroke="#16161a" stroke-width="3" fill="none"><path id="s7-e0" d="M412 90 V170"/><path id="s7-e1" d="M412 250 L130 470"/><path id="s7-e2" d="M412 250 V470"/><path id="s7-e3" d="M412 250 L694 470"/></g>
      </svg>
      <div class="dnode" id="s7-cli" style="left:287px;top:20px">Cliente</div>
      <div class="dnode orq" id="s7-ven" style="left:287px;top:170px">Ventas</div>
      <div class="dnode" id="s7-inv" style="left:5px;top:470px">Inventario</div>
      <div class="dnode" id="s7-pag" style="left:287px;top:470px">Pagos</div>
      <div class="dnode" id="s7-des" style="left:569px;top:470px">Despacho</div>
      <div class="key" id="s7-k0" style="left:430px;top:110px">Idempotency-Key</div>
      <div class="key" id="s7-k1" style="left:5px;top:570px">ReserveStock(order_id)</div>
      <div class="key" id="s7-k2" style="left:287px;top:625px">charge-{orderId}</div>
      <div class="key" id="s7-k3" style="left:395px;top:680px">PUT /dispatches/{orderId}</div>
    </div>`;
  const tOrq = c('Elegimos orquestación');
  const tIdem = c('idempotente');
  const anims = [
    ...titleAnims('s7'),
    enter('#s7-d1', c('¿Por qué')), show('#s7-d1a', c('La pasarela es un tercero'), 0.3), show('#s7-d1b', c('Y bloquear'), 0.3),
    mark('#s7-inv2', c('impone el orden inverso')), mark('#s7-bit', c('deja una bitácora')),
    enter('#s7-d2', tOrq), enter('#s7-ven', tOrq), show('#s7-cli', tOrq + 0.2), show('#s7-e0', tOrq + 0.2),
    ...['#s7-inv', '#s7-pag', '#s7-des'].map((s, i) => enter(s, tOrq + 0.5 + i * 0.15)),
    ...['#s7-e1', '#s7-e2', '#s7-e3'].map((s, i) => show(s, tOrq + 0.6 + i * 0.15)),
    enter('#s7-d3', tIdem),
    stamp('#s7-k0', tIdem + 0.3), stamp('#s7-k1', c('una reserva')), stamp('#s7-k2', c('un cobro')), stamp('#s7-k3', c('un despacho')),
  ];
  return sceneFile('s7', css, body, anims);
};

// s8 · Cierre ---------------------------------------------------------------
builders.s8 = (scene) => {
  const c = cueOf(scene);
  const css = `
    #s8-list { position: absolute; left: 120px; top: 190px; width: 1680px; }
    .res { font-size: 42px; font-weight: 700; margin-bottom: 30px; white-space: nowrap; }
    .res i { font-style: normal; color: var(--ok); margin-right: 18px; }
    #s8-term { position: absolute; left: 120px; top: 510px; width: 1680px; }
    #s8-files { position: absolute; left: 120px; top: 720px; font-size: 32px; line-height: 1.6; color: var(--ink2); }
    #s8-files code { font-family: "JetBrains Mono", monospace; color: var(--ink); }`;
  const cmd = ['$ docker compose up --build -d --wait', `$ ${consola[0].trim()}`];
  const body = `
    <div id="s8-list">
      <div class="res" id="s8-r1"><i>✓</i>Camino feliz: tres pasos confirmados, sin doble reserva ni doble cobro</div>
      <div class="res" id="s8-r2"><i>✓</i>Último paso falla: se compensa en orden inverso, sin estado inconsistente</div>
      <div class="res" id="s8-r3"><i>✓</i>Pasarela lenta o caída: contenida en Pagos (timeout, circuito, bulkhead)</div>
    </div>
    <div class="term" id="s8-term">
${termLines('s8', cmd)}
    </div>
    <div id="s8-files">Informe <code>docs/informe/INFORME-T2.pdf</code> · evidencia <code>docs/evidencia/</code><br>Repositorio <code>github.com/ba-hc/tarea-integracion-sistemas</code></div>`;
  const anims = [
    enter('#s8-r1', c('el camino feliz')), enter('#s8-r2', c('la falla del último paso')), enter('#s8-r3', c('la falla de la pasarela')),
    print('#s8-l0', c('Todo se reproduce'), cmd[0].length), print('#s8-l1', c('y un script'), cmd[1].length),
    show('#s8-files', c('Todo se reproduce', 1), 0.4),
  ];
  return sceneFile('s8', css, body, anims);
};

// ---------------------------------------------------------------------------
mkdirSync('compositions', { recursive: true });
for (const scene of SCENES) writeFileSync(`compositions/${scene.id}.html`, builders[scene.id](scene));

const hosts = SCENES.map((s) => `      <div id="${s.id}" data-composition-id="${s.id}" data-composition-src="compositions/${s.id}.html" data-start="${s.start}" data-duration="${s.dur}" data-track-index="1" data-track-kind="graphics" data-width="${W}" data-height="${H}"></div>`).join('\n');
const voices = SCENES.map((s) => `      <audio id="vo-${s.id}" class="clip" src="assets/vo/${s.vo}.wav" data-start="${Math.round((s.start + LEAD) * 100) / 100}" data-duration="${Math.round(s.voDur * 100) / 100}" data-track-index="3" data-volume="1"></audio>`).join('\n');

const index = `<!doctype html>
<html lang="es" data-resolution="landscape">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${W}, height=${H}" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js"></script>
    <style>
      :root { --ground: #f2f1ed; --ink: #16161a; --ink2: #55534e; --rule: #d6d4cd; --con: #2a78d6; --sin: #eb6834; --ok: #0b7a3e; --fail: #b3261e; --sin-ink: #b8481a; }
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; background: var(--ground); }
      #root { position: relative; width: 100%; height: 100%; font-family: Inter, sans-serif; color: var(--ink); }
      #bg { position: absolute; inset: 0; background: var(--ground); }
      .term { background: #15171c; color: #e4e4e0; font-family: "JetBrains Mono", monospace; font-size: 28px; line-height: 1.45; padding: 18px 22px; }
      .term .ln { white-space: pre-wrap; overflow-wrap: anywhere; clip-path: inset(0 100% 0 0); }
      .term .ln.ok b { color: #4cc38a; font-weight: 700; }
      .term .ln.step { color: #8fb8ee; }
      .term .ln.head { color: #f0c27a; font-weight: 700; }
      #footer { position: absolute; left: 96px; bottom: 22px; font-size: 28px; color: var(--ink2); z-index: 10; }
      #footer code { font-family: "JetBrains Mono", monospace; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${TOTAL}" data-width="${W}" data-height="${H}">
      <div id="bg"></div>
${hosts}
      <div id="footer" class="clip" data-start="0" data-duration="${TOTAL}" data-track-index="2">Reconstrucción narrada de la corrida de CI <code>${run.run_id}</code> · commit <code>${run.commit.slice(0, 7)}</code> · fuente: <code>docs/evidencia/</code></div>
${voices}
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      window.__timelines["main"] = gsap.timeline({ paused: true });
    </script>
  </body>
</html>
`;
writeFileSync('index.html', index);
console.log(`escenas: ${SCENES.map((s) => `${s.id}@${s.start}+${s.dur}`).join(' ')}; total ${TOTAL} s (${Math.floor(TOTAL / 60)} min ${Math.round(TOTAL % 60)} s)`);
