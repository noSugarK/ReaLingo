//! Streaming sample-rate conversion to 16 kHz mono i16 (what the model wants).
//!
//! Direct windowed-sinc resampler: for each output sample we evaluate a Blackman-windowed
//! sinc centred on the fractional input position, with the cutoff pinned to the *lower* of
//! the two Nyquist frequencies. That gives real anti-aliasing for arbitrary ratios
//! (48000/16000 = 3, but 44100/16000 = 2.75625), which naive decimation does not.

pub const TARGET_RATE: u32 = 16_000;
/// 100 ms at 16 kHz — the chunk size the realtime API examples use.
pub const CHUNK_SAMPLES: usize = 1600;

const HALF: usize = 16; // 32 taps; plenty for speech

pub struct Resampler {
    step: f64, // input samples consumed per output sample
    pos: f64,  // fractional read position inside `buf`
    buf: Vec<f32>,
    cutoff: f64, // normalised to the input rate, 0..0.5
    passthrough: bool,
}

impl Resampler {
    pub fn new(in_rate: u32, out_rate: u32) -> Self {
        let step = in_rate as f64 / out_rate as f64;
        // 0.92 leaves a transition band so the stopband actually attenuates.
        let cutoff = 0.5 * (out_rate as f64 / in_rate as f64).min(1.0) * 0.92;
        Self {
            step,
            pos: HALF as f64,
            buf: vec![0.0; HALF], // left context
            cutoff,
            passthrough: in_rate == out_rate,
        }
    }

    /// Feed interleaved-then-downmixed mono samples; appends converted i16 to `out`.
    pub fn push(&mut self, input: &[f32], out: &mut Vec<i16>) {
        if self.passthrough {
            out.extend(input.iter().map(|&s| to_i16(s)));
            return;
        }
        self.buf.extend_from_slice(input);

        while (self.pos.floor() as usize) + HALF < self.buf.len() {
            let center = self.pos;
            let first = center.floor() as isize - HALF as isize + 1;
            let mut acc = 0.0f64;
            let mut wsum = 0.0f64;
            for k in 0..2 * HALF {
                let idx = first + k as isize;
                if idx < 0 {
                    continue;
                }
                let dx = center - idx as f64;
                let w = sinc(2.0 * self.cutoff * dx) * blackman(dx / HALF as f64);
                acc += self.buf[idx as usize] as f64 * w;
                wsum += w;
            }
            // Normalising by the window sum keeps DC gain at 1 for every phase.
            out.push(to_i16((acc / wsum.max(1e-9)) as f32));
            self.pos += self.step;
        }

        // Retire input we will never look at again, keeping HALF samples of left context.
        let keep_from = (self.pos.floor() as usize).saturating_sub(HALF);
        if keep_from > 0 {
            self.buf.drain(..keep_from);
            self.pos -= keep_from as f64;
        }
    }
}

fn sinc(x: f64) -> f64 {
    if x.abs() < 1e-9 {
        1.0
    } else {
        let p = std::f64::consts::PI * x;
        p.sin() / p
    }
}

/// Blackman window over t in [-1, 1]; zero outside.
fn blackman(t: f64) -> f64 {
    if t.abs() >= 1.0 {
        return 0.0;
    }
    let p = std::f64::consts::PI * t;
    0.42 + 0.5 * p.cos() + 0.08 * (2.0 * p).cos()
}

fn to_i16(s: f32) -> i16 {
    (s.clamp(-1.0, 1.0) * 32767.0) as i16
}

/// Average all channels of an interleaved frame down to mono.
pub fn downmix(interleaved: &[f32], channels: usize, out: &mut Vec<f32>) {
    if channels <= 1 {
        out.extend_from_slice(interleaved);
        return;
    }
    for frame in interleaved.chunks_exact(channels) {
        out.push(frame.iter().sum::<f32>() / channels as f32);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rms(v: &[i16]) -> f64 {
        (v.iter().map(|&s| (s as f64 / 32767.0).powi(2)).sum::<f64>() / v.len() as f64).sqrt()
    }

    fn run(in_rate: u32, freq: f64) -> Vec<i16> {
        let mut r = Resampler::new(in_rate, TARGET_RATE);
        let input: Vec<f32> = (0..in_rate)
            .map(|n| (2.0 * std::f64::consts::PI * freq * n as f64 / in_rate as f64).sin() as f32)
            .collect();
        let mut out = Vec::new();
        // Feed in realistic chunks, not one big slab — this is the streaming path.
        for c in input.chunks(512) {
            r.push(c, &mut out);
        }
        out
    }

    #[test]
    fn integer_ratio_48k() {
        let out = run(48_000, 1000.0);
        let n = out.len() as i64;
        assert!((n - 16_000).abs() < 64, "expected ~16000 samples, got {n}");
        // A unit sine has RMS 1/sqrt(2); the resampler must not eat the signal.
        assert!((rms(&out) - 0.707).abs() < 0.05, "rms drifted: {}", rms(&out));
    }

    #[test]
    fn fractional_ratio_44k1() {
        let out = run(44_100, 1000.0);
        let expect = (44_100.0 * 16_000.0 / 44_100.0) as i64; // = 16000
        let n = out.len() as i64;
        assert!((n - expect).abs() < 64, "expected ~{expect} samples, got {n}");
        assert!((rms(&out) - 0.707).abs() < 0.05, "rms drifted: {}", rms(&out));
    }

    #[test]
    fn passthrough_is_exact() {
        let mut r = Resampler::new(TARGET_RATE, TARGET_RATE);
        let mut out = Vec::new();
        r.push(&[1.0, -1.0, 0.0], &mut out);
        assert_eq!(out, vec![32767, -32767, 0]);
    }

    #[test]
    fn downmix_averages_channels() {
        let mut out = Vec::new();
        downmix(&[1.0, 0.0, 0.5, 0.5], 2, &mut out);
        assert_eq!(out, vec![0.5, 0.5]);
    }
}
