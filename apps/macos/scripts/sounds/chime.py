"""Synthesize soft notification chimes for VoDog (48 kHz / 24-bit stereo WAV, like bleeps.wav).

Shipped bleeps.wav = dewdrop.wav (byte-identical). Usage: python3 chime.py <outdir>
"""
import sys, wave
import numpy as np

SR = 48000

def note(freq, dur, amp=1.0, bright=1.0):
    """Soft mallet/kalimba tone: sine body + quickly fading inharmonic partials."""
    t = np.arange(int(SR * dur)) / SR
    attack = np.minimum(t / 0.006, 1.0)            # 6 ms attack, no click
    body = np.sin(2 * np.pi * freq * t) * np.exp(-t * 3.2)
    tine = 0.22 * bright * np.sin(2 * np.pi * freq * 2.0 * t) * np.exp(-t * 7)
    ping = 0.07 * bright * np.sin(2 * np.pi * freq * 3.01 * t) * np.exp(-t * 18)
    return amp * attack * (body + tine + ping)

def render(seq, total):
    """seq: (start_s, freq, amp, pan) tuples -> stereo buffer."""
    out = np.zeros((int(SR * total), 2))
    for start, freq, amp, pan in seq:
        n = note(freq, total - start, amp)
        i = int(SR * start)
        out[i:i + len(n), 0] += n * (1 - pan) ** 0.5
        out[i:i + len(n), 1] += n * pan ** 0.5
    # small stereo room: two quiet taps, crossed channels
    for delay, gain in ((0.083, 0.18), (0.131, 0.12)):
        d = int(SR * delay)
        out[d:, 0] += gain * out[:-d, 1]
        out[d:, 1] += gain * out[:-d, 0]
    fade = int(SR * 0.25)
    out[-fade:] *= np.linspace(1, 0, fade)[:, None] ** 2
    return out / np.abs(out).max() * 10 ** (-4 / 20)  # peak -4 dBFS: soft but audible

def write(path, x):
    pcm = (np.clip(x, -1, 1) * (2 ** 23 - 1)).astype("<i4")
    raw = np.frombuffer(pcm.tobytes(), np.uint8).reshape(-1, 4)[:, :3].tobytes()
    with wave.open(path, "wb") as w:
        w.setnchannels(2); w.setsampwidth(3); w.setframerate(SR); w.writeframes(raw)

E5, Gs5, B5, Cs6, E6 = 659.25, 830.61, 987.77, 1108.73, 1318.51
VARIANTS = {
    # rising E-major arpeggio, ends on a gentle high E
    "dewdrop": ([(0.00, E5, 1.0, 0.45), (0.11, Gs5, 0.85, 0.55), (0.22, B5, 0.8, 0.5), (0.36, E6, 0.55, 0.5)], 1.4),
    # two-note "ding-dong" up a sixth, very calm
    "pebble":  ([(0.00, Gs5, 1.0, 0.45), (0.16, E6, 0.7, 0.55)], 1.2),
    # pentatonic sparkle, slightly brighter
    "sprout":  ([(0.00, B5, 0.9, 0.4), (0.09, Cs6, 0.8, 0.6), (0.18, E6, 0.75, 0.45), (0.30, Gs5, 0.5, 0.55)], 1.3),
}

if __name__ == "__main__":
    outdir = sys.argv[1]
    for name, (seq, total) in VARIANTS.items():
        x = render(seq, total)
        assert x.shape[1] == 2 and abs(np.abs(x).max() - 10 ** (-4 / 20)) < 1e-6
        write(f"{outdir}/{name}.wav", x)
        print(name, f"{total:.2f}s")
