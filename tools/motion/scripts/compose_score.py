"""Original 72-second synth score. Oscillators and seeded noise only; no samples or ML."""

import math, wave
from pathlib import Path
import numpy as np

RATE = 48000
SECONDS = 72
BEAT = 0.5
rng = np.random.default_rng(614)
mix = np.zeros((RATE * SECONDS, 2), dtype=np.float64)


def frequency(note):
    return 440 * 2 ** ((note - 69) / 12)


def add(at, signal, gain=0.1, pan=0):
    start = round(at * RATE)
    end = min(len(mix), start + len(signal))
    n = end - start
    if n <= 0:
        return
    mix[start:end, 0] += signal[:n] * gain * math.sqrt((1 - pan) / 2)
    mix[start:end, 1] += signal[:n] * gain * math.sqrt((1 + pan) / 2)


def envelope(t, duration, attack=0.01, release=0.12):
    return np.minimum(t / attack, 1) * np.minimum(
        np.maximum(duration - t, 0) / release, 1
    )


def synth(note, duration, bright=8, detune=0):
    t = np.arange(round(duration * RATE)) / RATE
    f = frequency(note) * (1 + detune)
    wave = sum(np.sin(2 * np.pi * f * k * t) / (k**1.4) for k in range(1, bright + 1))
    return wave * envelope(t, duration)


roots = [38, 34, 41, 36]
for bar in range(36):
    at = bar * 2
    root = roots[(bar // 4) % 4]
    intro = bar < 4
    outro = bar >= 32
    breakdown = 16 <= bar < 18
    # Wide, slowly swelling chords with a brighter harmonic above the bass.
    for offset in [12, 15 if (bar // 4) % 4 == 0 else 16, 19, 26]:
        for detune, pan in [(-0.0015, -0.65), (0.0015, 0.65)]:
            duration = 2.7
            t = np.arange(round(duration * RATE)) / RATE
            pad = (
                synth(root + offset, duration, bright=3, detune=detune)
                * np.minimum(t / 0.7, 1)
                * np.exp(-t * 0.28)
            )
            add(at, pad, 0.045 if intro or outro else 0.029, pan)
    if not intro and not outro and not breakdown:
        # Syncopated bass, fundamental plus a restrained saw harmonic spectrum.
        for step, noteOffset in [
            (0, 0),
            (3, 0),
            (4, 12),
            (6, 0),
            (8, 0),
            (11, 7),
            (12, 0),
            (14, 12),
        ]:
            duration = 0.21
            t = np.arange(round(duration * RATE)) / RATE
            bass = synth(root + noteOffset, duration, bright=12) * np.exp(-t * 7)
            bass += (
                np.sin(2 * np.pi * frequency(root + noteOffset) * t)
                * envelope(t, duration, 0.003, 0.06)
                * 0.55
            )
            add(at + step * 0.125, np.tanh(bass * 1.6), 0.16)
    # Original repeating arp phrase, with alternating octaves and panning.
    if bar >= 2 and bar < 34:
        pattern = [12, 19, 24, 15, 26, 24, 19, 27]
        for step, interval in enumerate(pattern):
            duration = 0.29
            t = np.arange(round(duration * RATE)) / RATE
            note = synth(root + interval, duration, bright=4) * np.exp(-t * 12)
            gain = 0.047 if not breakdown else 0.025
            pan = math.sin(step * 1.7) * 0.55
            add(at + step * 0.25, note, gain, pan)
            add(at + step * 0.25 + 0.375, note, gain * 0.26, -pan)
    if intro or outro or breakdown:
        continue
    for beat in range(4):
        t = np.arange(round(0.36 * RATE)) / RATE
        phase = 2 * np.pi * (49 * t + (135 - 49) * 0.027 * (1 - np.exp(-t / 0.027)))
        kick = (
            np.sin(phase) * np.exp(-t * 15)
            + rng.normal(0, 1, len(t)) * np.exp(-t * 250) * 0.12
        )
        add(at + beat * BEAT, kick, 0.42)
        if beat in [1, 3]:
            t = np.arange(round(0.22 * RATE)) / RATE
            noise = rng.normal(0, 1, len(t))
            high = np.concatenate([[0], np.diff(noise)])
            snare = (
                high * np.exp(-t * 24) * 0.35
                + np.sin(2 * np.pi * 185 * t) * np.exp(-t * 35) * 0.4
            )
            add(at + beat * BEAT, snare, 0.17)
    for step in range(8):
        duration = 0.11 if step % 2 else 0.045
        t = np.arange(round(duration * RATE)) / RATE
        noise = rng.normal(0, 1, len(t))
        high = np.concatenate([[0], np.diff(noise)])
        hat = high * np.exp(-t * (45 if step % 2 else 95))
        add(
            at + step * 0.25,
            hat,
            0.026 if step % 2 else 0.017,
            0.28 if step % 2 else -0.28,
        )
# A rising, filtered noise transition into the full groove and midpoint return.
for end in [8, 36, 64]:
    duration = 1.5
    t = np.arange(round(duration * RATE)) / RATE
    noise = rng.normal(0, 1, len(t))
    noise = np.convolve(noise, np.ones(9) / 9, mode="same")
    add(end - duration, noise * (t / duration) ** 2, 0.065)
# Soft saturation, headroom, and a deliberate final fade rather than a hard cut.
t = np.arange(len(mix)) / RATE
fade = np.minimum(t / 1.2, 1) * np.minimum(np.maximum(SECONDS - t, 0) / 3, 1)
mix = np.tanh(mix * 1.15) * fade[:, None]
peak = np.max(np.abs(mix))
mix *= 0.84 / max(peak, 0.001)
out = (
    Path(__file__).resolve().parents[3]
    / "apps/marketing/public/media/solla-code-score.wav"
)
out.parent.mkdir(parents=True, exist_ok=True)
with wave.open(str(out), "wb") as wav:
    wav.setnchannels(2)
    wav.setsampwidth(2)
    wav.setframerate(RATE)
    wav.writeframes((mix * 32767).astype("<i2").tobytes())
print(
    f"{out}: {SECONDS}s, 120 BPM, 48 kHz stereo, peak {20*np.log10(np.max(abs(mix))):.2f} dBFS"
)
