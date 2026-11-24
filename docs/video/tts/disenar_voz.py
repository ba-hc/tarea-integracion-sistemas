"""Diseña candidatas de voz con Qwen3-TTS VoiceDesign y deja un WAV por candidata.

Uso: python disenar_voz.py <carpeta_salida>
Cada candidata dice la misma frase, para compararlas de oído. La elegida se usa después
como referencia en narrar.py (Qwen3-TTS Base), que mantiene esa voz en las 8 escenas.
"""
import sys
from pathlib import Path

import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel

OUT = Path(sys.argv[1])
OUT.mkdir(parents=True, exist_ok=True)

TEXTO = (
    "Escenario uno, el camino feliz. Ventas orquesta la saga: reserva el stock en Inventario, "
    "cobra en Pagos y crea el despacho. La venta responde doscientos uno, confirmada, "
    "en doscientos veintiocho milisegundos."
)

# La primera tanda (descripciones en inglés) salió con acento estadounidense: las descripciones
# van en español y piden explícitamente una hablante nativa latinoamericana.
TONO = ("Tono tranquilo, claro y cercano, como una ingeniera que presenta una demo técnica. "
        "Ritmo natural, sin exagerar.")
CANDIDATAS = {
    "d-doblaje-neutro": "Mujer adulta, hablante nativa de español latinoamericano, con el español neutro del "
    "doblaje latino. Pronunciación latina, sin ningún acento extranjero ni anglosajón. " + TONO,
    "e-mexicana": "Mujer adulta mexicana de Ciudad de México, hablante nativa de español, acento mexicano suave. "
    "Sin acento extranjero. " + TONO,
    "f-colombiana": "Mujer adulta colombiana de Bogotá, hablante nativa de español, acento rolo suave y muy claro. "
    "Sin acento extranjero. " + TONO,
    "g-en-ingles": "Adult woman, native Mexican Spanish speaker born and raised in Mexico City, who does NOT speak "
    "English. Authentic Latin American Spanish pronunciation, no American accent. Calm, clear, friendly tech demo.",
}

# Turing (RTX 20xx) no tiene bfloat16 nativo: float16.
model = Qwen3TTSModel.from_pretrained(
    "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign", device_map="cuda:0", dtype=torch.float16
)
print("idiomas:", model.get_supported_languages())

for nombre, instruct in CANDIDATAS.items():
    torch.manual_seed(7)
    wavs, sr = model.generate_voice_design(text=TEXTO, language="Spanish", instruct=instruct)
    sf.write(OUT / f"{nombre}.wav", wavs[0], sr)
    print(nombre, f"{len(wavs[0]) / sr:.1f} s", flush=True)

(OUT / "texto.txt").write_text(TEXTO, encoding="utf-8")
