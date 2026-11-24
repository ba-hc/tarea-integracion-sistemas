# Video de la demo (fuente)

El video (≈4 min 23 s, 1920×1080, narrado) muestra el camino feliz, la inducción de cada falla y la
lectura de la evidencia. **Es una reconstrucción narrada de la corrida de CI
[45446846259](https://github.com/ba-hc/tarea-integracion-sistemas/actions/runs/45446846259)**, no una
grabación de pantalla: cada línea de consola y cada cifra que aparece la lee `build.mjs` desde
[`docs/evidencia/`](../evidencia/README.md) (incluida `consola.txt`, la salida real del script) y desde
`experiments/payments/results/summary.csv`. El MP4 no se versiona (pesa más de lo razonable para git); se
entrega aparte.

## Escenas

| # | Contenido | Fuente |
|---|---|---|
| 1 | Problema y aviso de reconstrucción | `run.json` |
| 2 | Un solo puerto, 401 / 403 / 429 por cliente | `exposicion.json`, `consola.txt` |
| 3 | Escenario 1: Saga completa, idempotencia, stock y cobro, resumen BFF | `escenario1-exito.json` |
| 4 | Escenario 2: falla de Despacho, bitácora, compensación inversa, antes/después | `escenario2-compensacion.json` |
| 5 | Escenario 3a: pasarela lenta + 24 ventas, con y sin protecciones | `escenario3-cascada.json` |
| 6 | Escenario 3b: pasarela caída, recuperación, consistencia, k6 | `escenario3-cascada.json`, `summary.csv` |
| 7 | Decisiones: Saga vs 2PC, orquestación, idempotencia | ADR-005/006/007 |
| 8 | Resumen y cómo reproducir | — |

## Regenerarlo

Requiere [HyperFrames](https://hyperframes.heygen.com) 0.9.91, ffmpeg y Python con `kokoro-onnx` para la voz.

> Estos pasos resumen cómo se generó el video, pero no se probaron tal cual desde un clon limpio. El
> MP4 entregado se hizo con el lanzador local de HyperFrames, con `ffmpeg`/`ffprobe` y Python indicados
> por variables de entorno (`HYPERFRAMES_FFMPEG_PATH`, `HYPERFRAMES_FFPROBE_PATH`, `HYPERFRAMES_PYTHON`).
> Si un comando falla, revisa `npx hyperframes@0.9.91 <comando> --help`.

```bash
npx hyperframes@0.9.91 init demo && cd demo
cp ../docs/video/build.mjs ../docs/video/SPEC.md . && cp -r ../docs/video/narracion .
for f in narracion/*.txt; do
  npx hyperframes@0.9.91 tts --text-file "$f" --voice em_alex --lang es --speed 0.92 -o "assets/vo/$(basename "$f" .txt).wav"
done
node build.mjs ..            # lee ../docs/evidencia y escribe index.html + compositions/
npx hyperframes@0.9.91 check
npx hyperframes@0.9.91 render -o demo-t2.mp4 --quality delivery
```

`build.mjs` falla si una línea citada no está en `consola.txt` o si el total supera 8 minutos. La
narración escribe algunos términos en inglés de forma fonética (por ejemplo «dóquer compóus ap») para
que la voz sintética los pronuncie bien.
