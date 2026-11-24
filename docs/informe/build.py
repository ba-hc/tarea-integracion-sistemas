"""Arma el informe desde la evidencia versionada y lo imprime a PDF.

    python docs/informe/graficos.py      # gráficos (requiere matplotlib)
    python docs/informe/build.py         # informe.html + INFORME-T2.pdf

Todas las cifras del informe salen de docs/evidencia/*.json (corrida de CI) y de
experiments/payments/results/summary.csv. Para imprimir usa Microsoft Edge o
Chrome en modo headless (variable BROWSER para indicar otro ejecutable).
"""

import csv
import html
import re
import json
import os
import shutil
import statistics
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = ROOT / "docs" / "informe"
EVID = ROOT / "docs" / "evidencia"


def load(name):
    return json.loads((EVID / f"{name}.json").read_text(encoding="utf-8"))


def esc(value):
    return html.escape(str(value))


def ms(value):
    if value is None:
        return "–"
    return f"{value:,.0f} ms".replace(",", ".") if value >= 100 else f"{value:.0f} ms" if value >= 10 else f"{value:.1f} ms".replace(".", ",")


def statuses(counts):
    return ", ".join(f"{n}× {esc(k)}" for k, n in sorted(counts.items(), key=lambda kv: -kv[1]))


def main():
    meta = json.loads((EVID / "run.json").read_text(encoding="utf-8"))
    expo, e1, e2, e3 = load("exposicion"), load("escenario1-exito"), load("escenario2-compensacion"), load("escenario3-cascada")
    v = {"fecha": meta["date"], "run_id": meta["run_id"], "commit": meta["commit"][:7]}

    rl = expo["rateLimit"]
    v["expo_frase"] = (
        f"sólo <code>api-gateway</code> publica un puerto; sin token la respuesta es <code>{expo['auth']['anonymous']}</code>, un token "
        f"<code>reader</code> que intenta escribir recibe <code>{expo['auth']['readerPost']}</code>, y de {rl['requests']} peticiones seguidas "
        f"de un mismo cliente la #{rl['firstLimitedAt']} ya recibe <code>429</code> (Retry-After {rl['retryAfterSeconds']} s) mientras otro "
        f"cliente sigue atendido (<code>{rl['otherClientStatus']}</code>)."
    )

    events1 = " → ".join(f"{e['step']}:{e['outcome']}" for e in e1["saga"]["events"])
    v["e1_frase"] = (
        f"La venta respondió <code>{e1['sale']['status']} {e1['sale']['orderStatus']}</code> en {ms(e1['sale']['ms'])}. El reintento con la misma "
        f"<code>Idempotency-Key</code> devolvió la misma orden y la misma key con otra cantidad, <code>{e1['conflict']['status']} {esc(e1['conflict']['code'])}</code>. "
        f"El stock pasó de {e1['stock']['before']} a {e1['stock']['after']} y la pasarela registró {e1['pasarela']['chargesApprovedDelta']} cobro: "
        f"sin doble reserva ni doble cobro. El resumen del BFF mostró el pago <code>{esc(e1['summary']['payment']['data']['status'])}</code> y el despacho "
        f"<code>{esc(e1['summary']['dispatch']['data']['status'])}</code> en una sola respuesta."
    )
    v["e1_log"] = esc(f"saga {e1['orderId'][:8]}… {e1['saga']['status']}: {events1}\n"
                      f"steps: stock={e1['saga']['steps']['stock']} payment={e1['saga']['steps']['payment']} dispatch={e1['saga']['steps']['dispatch']}\n"
                      f"GET /web/v1/orders/{{id}}/summary → partial={str(e1['summary']['partial']).lower()}, "
                      f"payment={e1['summary']['payment']['data']['status']}, dispatch={e1['summary']['dispatch']['data']['status']}")

    s2 = e2["saga"]
    v["e2_frase"] = (
        f"Con Despacho rechazando toda creación, la venta respondió <code>{e2['sale']['status']} {esc(e2['sale']['code'])}</code> en {ms(e2['sale']['ms'])} "
        f"y el reintento con la misma key devolvió lo mismo (<code>{e2['replay']['status']} {esc(e2['replay']['code'])}</code>) sin efectos nuevos. "
        f"La bitácora de la Saga, leída de la base de Ventas, muestra los pasos confirmados y luego las compensaciones en orden inverso: "
        f"primero el reembolso y después la liberación del stock. La Saga terminó <code>{s2['status']}</code>."
    )
    rows = []
    for e in s2["events"]:
        rows.append(f"<tr><td class='mono'>{esc(e['at'])}</td><td>{esc(e['step'])}</td><td>{esc(e['action'])}</td><td>{esc(e['outcome'])}</td><td>{esc(e.get('code') or '')}</td></tr>")
    v["e2_tabla"] = "\n".join(rows)
    v["e2_antes_despues"] = "\n".join([
        f"<tr><td>Stock de la pieza</td><td class='n'>{e2['stock']['before']}</td><td class='n'>{e2['stock']['after']}</td><td>reserva liberada</td></tr>",
        f"<tr><td>Cobros / reembolsos nuevos en la pasarela</td><td class='n'>–</td><td class='n'>{e2['pasarela']['chargesApprovedDelta']} / {e2['pasarela']['refundsDelta']}</td><td>ningún cobro sin venta</td></tr>",
        f"<tr><td>Pago según el BFF</td><td class='n'>–</td><td class='n'>{esc(e2['summary']['payment']['data']['status'])}</td><td>Pagos registra el reembolso</td></tr>",
        f"<tr><td>Orden pública (<code>GET /v1/orders/{{id}}</code>)</td><td class='n'>–</td><td class='n'>{e2['publicOrderStatus']}</td><td>no se expone una venta a medias</td></tr>",
    ])

    pa, ua = e3["protected"], e3["unprotected"]
    v["peak"], v["down_n"] = e3["config"]["peakSales"], e3["config"]["downSales"]

    def other(arm, op):
        o = arm["phases"]["slow"]["otherOperations"].get(op)
        return f"{ms(o['p95'])} ({statuses(o['statuses'])})" if o else "–"

    def cb(arm, phase):
        r = arm["phases"][phase]["resilience"]
        c, b = r["circuitBreaker"], r["bulkhead"]
        if not c["enabled"] and not b["enabled"]:
            return "desactivados"
        return f"circuito {c['state']}, {c['openedCount']} aperturas, {c['rejectedCalls']} rechazos; bulkhead pico {b['peakInFlight']}, {b['rejectedCalls']} rechazos"

    rec_p, rec_u = pa["phases"]["recovery"]["attempts"][-1], ua["phases"]["recovery"]["attempts"][-1]
    table = [
        ("<b>3a · Pasarela lenta + pico</b>", "", ""),
        ("Respuestas a las ventas", statuses(pa["phases"]["slow"]["sales"]["statuses"]), statuses(ua["phases"]["slow"]["sales"]["statuses"])),
        ("Venta p50 / p95", f"{ms(pa['phases']['slow']['sales']['p50'])} / {ms(pa['phases']['slow']['sales']['p95'])}", f"{ms(ua['phases']['slow']['sales']['p50'])} / {ms(ua['phases']['slow']['sales']['p95'])}"),
        ("Duración del pico completo", ms(pa["phases"]["slow"]["sales"]["wallMs"]), ms(ua["phases"]["slow"]["sales"]["wallMs"])),
        ("Protecciones al final de la fase", cb(pa, "slow"), cb(ua, "slow")),
        ("GET /v1/customers p95 durante el pico", other(pa, "GET /v1/customers"), other(ua, "GET /v1/customers")),
        ("Resumen BFF p95 durante el pico", other(pa, "GET resumen BFF"), other(ua, "GET resumen BFF")),
        ("<b>3b · Pasarela caída</b>", "", ""),
        ("Respuestas a las ventas", statuses(pa["phases"]["down"]["sales"]["statuses"]), statuses(ua["phases"]["down"]["sales"]["statuses"])),
        ("Venta p50 / p95", f"{ms(pa['phases']['down']['sales']['p50'])} / {ms(pa['phases']['down']['sales']['p95'])}", f"{ms(ua['phases']['down']['sales']['p50'])} / {ms(ua['phases']['down']['sales']['p95'])}"),
        (f"Llamadas que llegan a la pasarela ({e3['config']['downSales']} ventas)", str(pa["phases"]["down"]["pasarelaCalls"]), str(ua["phases"]["down"]["pasarelaCalls"])),
        ("Estado del circuito", cb(pa, "down"), cb(ua, "down")),
        ("<b>Recuperación y consistencia</b>", "", ""),
        ("Primera venta aceptada tras restaurar", f"{rec_p['atMs']/1000:.1f} s".replace(".", ","), f"{rec_u['atMs']/1000:.1f} s".replace(".", ",")),
        ("Sagas al final", statuses(pa["consistency"]["sagas"]), statuses(ua["consistency"]["sagas"])),
        ("Unidades descontadas = ventas confirmadas", f"{pa['consistency']['stock']['before'] - pa['consistency']['stock']['after']} = {pa['consistency']['confirmedSales']}", f"{ua['consistency']['stock']['before'] - ua['consistency']['stock']['after']} = {ua['consistency']['confirmedSales']}"),
        ("Cobros netos en la pasarela = ventas confirmadas", f"{pa['consistency']['pasarela']['netCharges']} = {pa['consistency']['confirmedSales']}", f"{ua['consistency']['pasarela']['netCharges']} = {ua['consistency']['confirmedSales']}"),
        ("Cobros que la pasarela aplicó / reembolsó", f"{pa['consistency']['pasarela']['chargesApproved']} / {pa['consistency']['pasarela']['refunds']}", f"{ua['consistency']['pasarela']['chargesApproved']} / {ua['consistency']['pasarela']['refunds']}"),
    ]
    v["e3_tabla"] = "\n".join(
        f"<tr><td colspan='3'>{a}</td></tr>" if not b and not c else f"<tr><td>{a}</td><td class='n'>{b}</td><td class='n'>{c}</td></tr>"
        for a, b, c in table
    )
    def clean(line):
        line = re.sub(r"\x1b\[[0-9;]*m", "", line).split("|", 1)[-1]
        line = re.sub(r"\[Nest\] \d+\s+-\s+", "", line).strip()
        line = re.sub(r"orderId: '([0-9a-f]{8})[^']*'", r"orderId: '\1…'", line)
        return re.sub(r", traceId: '[^']+'", "", line)
    log_lines = [clean(line) for line in (pa.get("logs") or [])]
    transitions = [line for line in log_lines if "state changed" in line]
    rejected = [line for line in log_lines if "CIRCUIT_OPEN" in line]
    shown = transitions[:1] + rejected[:3]
    if len(rejected) > 3:
        shown.append(f"… {len(rejected) - 3} rechazos más con reason CIRCUIT_OPEN …")
    shown += transitions[1:]
    v["e3_log"] = esc("\n".join(shown) or "(sin transiciones registradas)")

    rows_csv = list(csv.DictReader(open(ROOT / "experiments/payments/results/summary.csv", newline="")))
    def m(arm, sc, f):
        return statistics.mean(float(r[f]) for r in rows_csv if r["arm"] == arm and r["scenario"] == sc)
    slow_p, slow_u = pa["phases"]["slow"]["sales"], ua["phases"]["slow"]["sales"]
    v["interpretacion"] = f"""
<div class="callout"><b>Lentitud.</b> Sin protecciones, cada venta del pico esperó el plazo completo de Ventas hacia Pagos (p50 {ms(slow_u['p50'])}) y el
pico tardó {ms(slow_u['wallMs'])} en drenar. Pagos, con 30 s de plazo, siguió esperando a la pasarela, que <i>aplicó</i> los
{ua['consistency']['pasarela']['chargesApproved'] - ua['consistency']['confirmedSales']} cobros rechazados: la Saga tuvo que reembolsarlos todos
(con protecciones fueron {pa['consistency']['pasarela']['chargesApproved'] - pa['consistency']['confirmedSales']}, sólo las llamadas que el bulkhead dejó pasar). En k6, los ≈600 cobros por corrida agotaron los 2 s del cliente y la pasarela <i>aplicó</i> todos:
dinero cobrado que quien llama no sabe si se cobró,. Con protecciones, el bulkhead dejó pasar sólo 8 llamadas,
el circuito abrió y el resto se rechazó sin esperar a la pasarela (p50 de la venta {ms(slow_p['p50'])} frente a {ms(slow_u['p50'])}; {m('protected','slow','pending'):.0f} cobros en duda por corrida en k6
frente a {m('unprotected','slow','client_timeouts'):.0f}). El rechazo rápido es seguro: garantiza que no hubo cobro, así que Ventas libera la unidad al instante.</div>
<div class="callout"><b>Caída.</b> Ambos brazos rechazan las ventas (no hay a quién cobrar), pero sin circuito cada venta golpea a la pasarela caída
({ua['phases']['down']['pasarelaCalls']} de {e3['config']['downSales']} en la corrida end-to-end; ≈{m('unprotected','down','gateway_calls'):.0f} por corrida en k6) y espera su
respuesta; con el circuito abierto llegan {pa['phases']['down']['pasarelaCalls']} (k6: ≈{m('protected','down','gateway_calls'):.0f}, las que lo abren más una sonda cada 5 s) y la
respuesta no espera a la pasarela. Eso le da aire a una dependencia que se está cayendo en vez de rematarla con reintentos de cada venta.</div>
<div class="callout"><b>Resto del sistema.</b> Durante el pico, consultar clientes en Ventas y el resumen del BFF siguió respondiendo en ambos brazos
(tabla 5.4). Lo explica el diseño: esas operaciones no pasan por la pasarela y Pagos atiende lecturas desde su base. A esta carga, el aporte
medible del bulkhead no es proteger esas lecturas sino acotar a 8 los sockets y cobros en vuelo contra una dependencia lenta; con más carga, esas
esperas acumuladas son las que agotarían memoria y conexiones. Lo decimos así porque es lo que muestran los datos.</div>
<div class="callout"><b>Costo de las protecciones.</b> Con la pasarela sana los brazos son indistinguibles (p95 del cobro ≈{m('protected','normal','charge_p95_ms'):.0f} ms en
ambos). El costo está en la recuperación: tras volver la pasarela, la primera venta aceptada tardó {str(round(rec_p['atMs']/1000, 1)).replace('.', ',')} s con el circuito
(espera la sonda) frente a {str(round(rec_u['atMs']/1000, 1)).replace('.', ',')} s sin él.</div>
"""

    page = (HERE / "informe.template.html").read_text(encoding="utf-8")
    for key, value in v.items():
        page = page.replace("{{" + key + "}}", str(value))
    missing = [part.split("}}")[0] for part in page.split("{{")[1:]]
    if missing:
        sys.exit(f"faltan valores: {missing}")
    out_html = HERE / "informe.html"
    out_html.write_text(page, encoding="utf-8")

    browser = os.environ.get("BROWSER") or next((p for p in [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        shutil.which("chromium"), shutil.which("google-chrome"), shutil.which("microsoft-edge"),
    ] if p and Path(p).exists()), None)
    if not browser:
        sys.exit("no se encontró Edge/Chrome para imprimir el PDF")
    pdf = HERE / "INFORME-T2.pdf"
    subprocess.run([browser, "--headless=new", "--disable-gpu", "--no-pdf-header-footer", "--virtual-time-budget=20000",
                    "--run-all-compositor-stages-before-draw", f"--print-to-pdf={pdf}", out_html.as_uri()], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print(f"informe: {pdf}")


if __name__ == "__main__":
    main()
