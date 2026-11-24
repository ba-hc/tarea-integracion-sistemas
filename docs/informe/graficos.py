"""Genera los gráficos del informe desde datos versionados del repositorio.

    python docs/informe/graficos.py

Entradas: experiments/payments/results (k6, 18 corridas) y docs/evidencia/escenario3-cascada.json
(corrida end-to-end de la CI). Salida: docs/informe/img/*.png. Requiere matplotlib.
"""

import csv
import json
import statistics
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "docs" / "informe" / "img"
OUT.mkdir(parents=True, exist_ok=True)

# Paleta de referencia validada (slots 1 y 2) y tintas de texto.
CON = "#2a78d6"   # con protecciones
SIN = "#eb6834"   # sin protecciones
INK = "#0b0b0b"
INK2 = "#52514e"
GRID = "#e4e3df"
SURFACE = "#fcfcfb"
OPEN_BAND = "#fbe3d9"

plt.rcParams.update({
    "font.family": "DejaVu Sans",
    "font.size": 9,
    "axes.edgecolor": GRID,
    "axes.labelcolor": INK2,
    "axes.titlesize": 10,
    "axes.titleweight": "bold",
    "axes.titlecolor": INK,
    "xtick.color": INK2,
    "ytick.color": INK2,
    "axes.grid": True,
    "grid.color": GRID,
    "grid.linewidth": 0.6,
    "axes.axisbelow": True,
    "figure.facecolor": SURFACE,
    "axes.facecolor": SURFACE,
    "axes.spines.top": False,
    "axes.spines.right": False,
    "legend.frameon": False,
})


def summary_rows():
    with open(ROOT / "experiments/payments/results/summary.csv", newline="") as fh:
        return list(csv.DictReader(fh))


def mean_of(rows, arm, scenario, field):
    values = [float(r[field]) for r in rows if r["arm"] == arm and r["scenario"] == scenario]
    return statistics.mean(values), min(values), max(values)


def bar_labels(ax, bars, fmt):
    for bar in bars:
        height = bar.get_height()
        ax.annotate(fmt(height), (bar.get_x() + bar.get_width() / 2, height), xytext=(0, 2),
                    textcoords="offset points", ha="center", va="bottom", fontsize=7.5, color=INK)


def fig_latencia_p95():
    rows = summary_rows()
    scenarios = [("normal", "Normal"), ("slow", "Lenta (3 s)"), ("down", "Caída")]
    fig, ax = plt.subplots(figsize=(6.2, 2.6), dpi=200)
    width = 0.36
    xs = range(len(scenarios))
    con = [mean_of(rows, "protected", s, "charge_p95_ms")[0] for s, _ in scenarios]
    sin = [mean_of(rows, "unprotected", s, "charge_p95_ms")[0] for s, _ in scenarios]
    b1 = ax.bar([x - width / 2 - 0.01 for x in xs], con, width, color=CON, label="Con protecciones")
    b2 = ax.bar([x + width / 2 + 0.01 for x in xs], sin, width, color=SIN, label="Sin protecciones")
    ax.set_yscale("log")
    ax.set_ylim(3, 40000)
    ax.set_xticks(list(xs), [label for _, label in scenarios])
    ax.set_ylabel("p95 del cobro (ms, log)")
    ax.set_title("Latencia p95 de un cobro según el estado de la pasarela")
    fmt = lambda v: f"{v:,.0f} ms".replace(",", ".") if v >= 100 else f"{v:.0f} ms"
    bar_labels(ax, b1, fmt)
    bar_labels(ax, b2, fmt)
    ax.legend(loc="upper left", ncols=2, fontsize=8)
    fig.text(0.01, 0.01, "k6, 20 cobros/s durante 30 s; media de 3 corridas por barra. Fuente: experiments/payments/results/summary.csv",
             fontsize=6.5, color=INK2)
    fig.tight_layout(rect=(0, 0.04, 1, 1))
    fig.savefig(OUT / "p2-latencia-p95.png")
    plt.close(fig)


def fig_efectos():
    rows = summary_rows()
    fig, axes = plt.subplots(1, 2, figsize=(6.2, 2.4), dpi=200)
    panels = [
        (axes[0], "slow", lambda r: float(r["pending"]) + float(r["client_timeouts"]),
         "Pasarela lenta: cobros en duda\npara quien llama (por corrida)"),
        (axes[1], "down", lambda r: float(r["gateway_calls"]),
         "Pasarela caída: llamadas que\nle llegan (por corrida)"),
    ]
    for ax, scenario, metric, title in panels:
        con = statistics.mean(metric(r) for r in rows if r["arm"] == "protected" and r["scenario"] == scenario)
        sin = statistics.mean(metric(r) for r in rows if r["arm"] == "unprotected" and r["scenario"] == scenario)
        bars = ax.bar(["Con\nprotecciones", "Sin\nprotecciones"], [con, sin], 0.55, color=[CON, SIN])
        bar_labels(ax, bars, lambda v: f"{v:.0f}")
        ax.set_ylim(0, 700)
        ax.set_title(title, fontsize=9)
    fig.text(0.01, 0.01, "≈600 cobros por corrida; media de 3 corridas. Fuente: experiments/payments/results/summary.csv",
             fontsize=6.5, color=INK2)
    fig.tight_layout(rect=(0, 0.05, 1, 1))
    fig.savefig(OUT / "p2-efectos.png")
    plt.close(fig)


def fig_timeline():
    path = ROOT / "experiments/payments/results/runs/protected_slow_r1_timeline.csv"
    with open(path, newline="") as fh:
        rows = list(csv.DictReader(fh))
    t = [int(r["elapsed_ms"]) / 1000 for r in rows]
    fig, ax = plt.subplots(figsize=(6.2, 2.4), dpi=200)
    # Bandas donde el circuito está abierto.
    start = None
    for i, r in enumerate(rows):
        is_open = r["circuit_state"] == "OPEN"
        if is_open and start is None:
            start = t[i]
        if not is_open and start is not None:
            ax.axvspan(start, t[i], color=OPEN_BAND, lw=0)
            start = None
    if start is not None:
        ax.axvspan(start, t[-1], color=OPEN_BAND, lw=0)
    ax.plot(t, [int(r["circuit_rejected"]) for r in rows], color=CON, lw=2, label="Rechazos del circuito (acum.)")
    ax.plot(t, [int(r["bulkhead_rejected"]) for r in rows], color=SIN, lw=2, label="Rechazos del bulkhead (acum.)")
    ax.set_xlabel("segundos desde que la pasarela se pone lenta")
    ax.set_ylabel("rechazos acumulados")
    ax.set_title("Pasarela lenta, con protecciones: el circuito abre a los 1,5 s")
    ax.legend(loc="upper left", fontsize=8)
    fig.text(0.01, 0.01, "Zonas sombreadas: circuito ABIERTO (una sonda cada 5 s). Fuente: experiments/payments/results/runs/protected_slow_r1_timeline.csv",
             fontsize=6.5, color=INK2)
    fig.tight_layout(rect=(0, 0.04, 1, 1))
    fig.savefig(OUT / "p2-timeline-circuito.png")
    plt.close(fig)


def fig_e2e():
    path = ROOT / "docs/evidencia/escenario3-cascada.json"
    if not path.exists():
        print("sin evidencia end-to-end; se omite fig_e2e")
        return
    data = json.loads(path.read_text(encoding="utf-8"))
    arms = [("Con protecciones", data["protected"], CON), ("Sin protecciones", data["unprotected"], SIN)]
    fig, axes = plt.subplots(1, 2, figsize=(6.2, 2.5), dpi=200)
    # Panel 1: latencia de la venta en el pico (pasarela lenta) y con la pasarela caída.
    ax = axes[0]
    groups = [("Pico, pasarela\nlenta", "slow"), ("Pasarela\ncaída", "down")]
    width = 0.36
    for offset, (label, arm, color) in zip((-width / 2 - 0.01, width / 2 + 0.01), arms):
        values = [arm["phases"][phase]["sales"]["p95"] for _, phase in groups]
        bars = ax.bar([i + offset for i in range(len(groups))], values, width, color=color, label=label)
        bar_labels(ax, bars, lambda v: f"{v:,.0f}".replace(",", "."))
    ax.set_xticks(range(len(groups)), [g for g, _ in groups])
    ax.set_ylabel("p95 de la venta (ms)")
    ax.set_title("Venta vía Gateway", fontsize=9)
    ax.legend(loc="upper right", fontsize=7)
    # Panel 2: otras operaciones durante el pico.
    ax = axes[1]
    ops = ["GET /v1/customers", "GET resumen BFF"]
    for offset, (label, arm, color) in zip((-width / 2 - 0.01, width / 2 + 0.01), arms):
        other = arm["phases"]["slow"]["otherOperations"]
        values = [other.get(op, {}).get("p95") or 0 for op in ops]
        bars = ax.bar([i + offset for i in range(len(ops))], values, width, color=color, label=label)
        bar_labels(ax, bars, lambda v: f"{v:.0f}")
    ax.set_xticks(range(len(ops)), ["Clientes\n(Ventas)", "Resumen\n(BFF)"])
    ax.set_ylabel("p95 (ms)")
    ax.set_title("Otras operaciones durante el pico", fontsize=9)
    fig.text(0.01, 0.01, "Corrida end-to-end de la CI sobre docker compose up. Fuente: docs/evidencia/escenario3-cascada.json",
             fontsize=6.5, color=INK2)
    fig.tight_layout(rect=(0, 0.05, 1, 1))
    fig.savefig(OUT / "e2e-cascada.png")
    plt.close(fig)


if __name__ == "__main__":
    fig_latencia_p95()
    fig_efectos()
    fig_timeline()
    fig_e2e()
    print(f"gráficos en {OUT}")
