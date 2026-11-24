# SPEC · Demo T2 RepuestosSur

GOAL:    the evaluator sees the happy path, each induced failure and how the evidence is read, and believes the
         numbers because every one is a real line of the CI run 45446846259 (commit e4c7f90).
OUTPUT:  HyperFrames, 1920 x 1080, 30 fps, MP4. Narrated with Qwen3-TTS (voice designed with 1.7B-VoiceDesign, Bogotá-accented female; cloned per sentence with 0.6B-Base, see tts/). No music.
TIME:    8 scenes; each scene = 0.5 s lead + its narration + 1.2 s tail. Total must stay < 480 s (target ~4.5 min).
LOOK:    engineering notebook + terminal. Ground #f2f1ed flat. Ink #16161a, secondary #55534e, rules #d6d4cd.
         Accent "con protecciones" #2a78d6, "sin protecciones" #eb6834, ok #0b7a3e, fail #b3261e.
         Terminal panels #15171c, text #e4e4e0, 26 px JetBrains Mono, [ok] in #4cc38a.
         Display Inter 900 at 64 px (scene titles), 150 px on the intro; body Inter 400/700 at 30-36 px.
OBJECTS: services as labelled boxes with their real names; the Saga as a left-to-right pipeline of three steps;
         the pasarela as the one box outside the system; requests as small squares (one per real request).
MOTION:  terminal lines print left to right (clip-path, linear, 0.25-0.8 s); boxes enter with a 0.35 s power3.out
         scale 0.94 -> 1 + opacity; stamps (DONE, COMPENSATED, 429) snap in 0.15 s. Every reveal is cued to the
         word that names it (character offset in the narration x narration length).
SHOTS:   s1 intro + honesty note · s2 single entry point, 401/403/429 · s3 happy path · s4 last step fails,
         reverse compensation · s5 slow pasarela + peak, with vs without · s6 pasarela down + recovery +
         consistency · s7 decisions (Saga vs 2PC, orchestration, idempotency) · s8 summary + how to reproduce.
BANNED:  dark void ground, glow, gradients, glass cards, bullet slides, three cards in a row, KPI grids,
         numbers typed by hand (all come from build.mjs reading docs/evidencia), claims the evidence does not make
         (the bulkhead did not "save the reads"), presenting this as a live screen recording.
QA:      one frame per scene after its last reveal: every number matches docs/evidencia; nothing clipped;
         footer note visible.
