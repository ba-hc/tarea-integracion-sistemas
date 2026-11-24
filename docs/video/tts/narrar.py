"""Narra cada escena con Qwen3-TTS Base, clonando la voz de referencia elegida.

Uso: python narrar.py <ref.wav> <ref.txt> <carpeta narracion/> <carpeta assets/vo/> [modelo]
La referencia es la candidata elegida de disenar_voz.py (voz sintética, no de una persona real).
Cada escena se genera por oraciones y se une con una pausa corta, así la voz no se acelera ni
se desordena en textos largos.
"""
import json
import re
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel

ref_wav, ref_txt, src, dst = (Path(p) for p in sys.argv[1:5])
modelo = sys.argv[5] if len(sys.argv) > 5 else "Qwen/Qwen3-TTS-12Hz-0.6B-Base"
dst.mkdir(parents=True, exist_ok=True)
PAUSA = 0.28  # s entre oraciones

# float32: en float16 el muestreo de Base 0.6B se desborda en la RTX 2060 (CUDA device-side assert).
model = Qwen3TTSModel.from_pretrained(modelo, device_map="cuda:0", dtype=torch.float32)
solo = [Path(p).stem for p in sys.argv[6:]]  # opcional: regenerar sólo esas escenas
ref_text = ref_txt.read_text(encoding="utf-8").strip()


def oraciones(texto: str) -> list[str]:
    partes = re.split(r"(?<=[.?!])\s+", texto.strip())
    return [p for p in partes if p]


for txt in sorted(src.glob("s*.txt")):
    if solo and txt.stem not in solo:
        continue
    frases = oraciones(txt.read_text(encoding="utf-8"))
    wavs = []
    for n, frase in enumerate(frases):
        torch.manual_seed(11 + n)
        w, sr = model.generate_voice_clone(
            text=frase, language="Spanish", ref_audio=str(ref_wav), ref_text=ref_text
        )
        wavs.append(w[0])
    silencio = np.zeros(int(sr * PAUSA), dtype=np.float32)
    piezas, tramos, t = [], [], 0.0
    for frase, w in zip(frases, wavs):
        w = np.asarray(w, dtype=np.float32)
        tramos.append({"texto": frase, "inicio": round(t, 3), "fin": round(t + len(w) / sr, 3)})
        piezas += [w, silencio]
        t += (len(w) + len(silencio)) / sr
    audio = np.concatenate(piezas[:-1])
    audio = audio / max(1e-6, float(np.abs(audio).max())) * 0.9
    sf.write(dst / f"{txt.stem}.wav", audio, sr)
    # Tiempos exactos de cada oración: build.mjs los usa para sincronizar las animaciones.
    (dst / f"{txt.stem}.json").write_text(json.dumps(tramos, ensure_ascii=False, indent=1), encoding="utf-8")
    print(txt.stem, f"{len(frases)} oraciones, {len(audio) / sr:.1f} s", flush=True)
