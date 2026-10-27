"""Soft looping ringtones for VoDog. One loop cycle per file (AVAudioPlayer loops it); preview = 2 cycles.

Shipped ring.mp3 = ring-lullaby.wav: ffmpeg -i ring-lullaby.wav -c:a libmp3lame -b:a 192k Resources/Sounds/ring.mp3
"""
import sys
import numpy as np
from chime import SR, note, write

def pad(freqs, dur, amp):
    """Warm sustained bed: detuned sines, slow swell in and out."""
    t = np.arange(int(SR * dur)) / SR
    env = np.sin(np.pi * t / dur) ** 2
    x = sum(np.sin(2 * np.pi * f * t) + np.sin(2 * np.pi * f * 1.003 * t) for f in freqs)
    return amp * env * x / (2 * len(freqs))

def cycle(melody, beat, chords, length, peak_db=-3):
    """melody: (beat_index, freq, amp, pan); chords: (beat_index, beats, [freqs])."""
    out = np.zeros((int(SR * length), 2))
    def mix(sig, start, pan=0.5):
        i = int(SR * start)
        sig = sig[: len(out) - i]
        out[i:i + len(sig), 0] += sig * (1 - pan) ** 0.5
        out[i:i + len(sig), 1] += sig * pan ** 0.5
    for b, f, a, p in melody:
        mix(note(f, min(1.6, length - b * beat), a), b * beat, p)
    for b, n, fs in chords:
        mix(pad(fs, n * beat, 0.35), b * beat)
    for delay, gain in ((0.083, 0.18), (0.131, 0.12)):  # same little room as dewdrop
        d = int(SR * delay)
        out[d:, 0] += gain * out[:-d, 1]
        out[d:, 1] += gain * out[:-d, 0]
    fade = int(SR * 0.3)
    out[-fade:] *= np.linspace(1, 0, fade)[:, None] ** 2  # tail is silent -> seamless loop
    return out / np.abs(out).max() * 10 ** (peak_db / 20)

hz = lambda midi: 440 * 2 ** ((midi - 69) / 12)
E4, A4, B4, Cs5, E5, Fs5, Gs5, A5, B5, Cs6, E6 = map(hz, (64, 69, 71, 73, 76, 78, 80, 81, 83, 85, 88))
D5, Fs4 = hz(74), hz(66)

VARIANTS = {
    # E major question/answer, dewdrop's family; ~5 s per ring
    "lullaby": ([(0, E5, 1, .45), (1, Gs5, .85, .55), (2, B5, .85, .5), (3, Gs5, .7, .45),
                 (4, Cs6, .9, .55), (5, B5, .8, .5), (6, Gs5, .75, .45), (8, E5, .7, .5),
                 (8, B5, .5, .55)],
                .24, [(0, 4, [E4, B4]), (4, 6, [A4, Cs5])], 5.0),
    # slower, lower, marimba-ish lilt in A; calm
    "harbor":  ([(0, A4, 1, .45), (1, Cs5, .8, .55), (2, E5, .85, .5), (4, D5, .8, .45),
                 (5, Fs5, .75, .55), (6, E5, .85, .5), (8, Cs5, .6, .5), (8, A5, .45, .5)],
                .30, [(0, 4, [A4, E5]), (4, 6, [Fs4, D5])], 5.6),
    # bright pentatonic bells, two quick rolls then a resolve
    "breeze":  ([(0, B5, .9, .4), (.5, Cs6, .8, .6), (1, E6, .8, .45), (2, B5, .7, .55),
                 (4, Gs5, .85, .4), (4.5, B5, .8, .6), (5, Cs6, .8, .45), (6, E6, .7, .5),
                 (7, B5, .5, .55)],
                .26, [(0, 8, [E5, B5])], 4.6),
}

if __name__ == "__main__":
    outdir = sys.argv[1]
    for name, (mel, beat, chords, length) in VARIANTS.items():
        x = cycle(mel, beat, chords, length)
        assert np.abs(x[-100:]).max() < 1e-3, "tail must be silent for a gapless loop"
        write(f"{outdir}/ring-{name}.wav", x)
        write(f"{outdir}/ring-{name}-preview.wav", np.vstack([x, x]))
        print(name, f"{length:.1f}s/ring")
