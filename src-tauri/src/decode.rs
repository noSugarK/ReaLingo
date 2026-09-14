//! Decode a local audio file into the same 16 kHz mono PCM stream the microphone produces,
//! then feed it to the socket at roughly real time (the endpoint is a live translator, not a
//! batch API — firing a whole file at it in one go just overruns its buffer).

use anyhow::{anyhow, Result};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use tokio::sync::mpsc::Sender;

use crate::resample::{downmix, Resampler, CHUNK_SAMPLES, TARGET_RATE};

/// Slightly faster than real time: enough headroom to finish a file sooner without
/// outrunning the server's input buffer.
const CHUNK_PACE: Duration = Duration::from_millis(80);

/// Blocking — call from `spawn_blocking`. `progress` gets (seconds_sent, total_seconds_or_none).
pub fn stream_file(
    path: &Path,
    tx: Sender<Vec<i16>>,
    stop: Arc<AtomicBool>,
    mut progress: impl FnMut(f64, Option<f64>),
) -> Result<()> {
    let file = std::fs::File::open(path)?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let mut format = symphonia::default::get_probe()
        .probe(&hint, mss, FormatOptions::default(), MetadataOptions::default())
        .map_err(|e| anyhow!("unsupported or corrupt audio file: {e}"))?;

    let track = format
        .default_track(TrackType::Audio)
        .ok_or_else(|| anyhow!("no audio track in this file"))?;
    let track_id = track.id;
    let params = track
        .codec_params
        .as_ref()
        .and_then(|p| p.audio())
        .ok_or_else(|| anyhow!("missing codec parameters"))?
        .clone();
    let total_secs = track
        .num_frames
        .zip(params.sample_rate)
        .map(|(n, r)| n as f64 / r as f64);

    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(&params, &AudioDecoderOptions::default())
        .map_err(|e| anyhow!("unsupported codec: {e}"))?;

    let mut resampler: Option<Resampler> = None;
    let mut interleaved: Vec<f32> = Vec::new();
    let mut mono: Vec<f32> = Vec::new();
    let mut pcm: Vec<i16> = Vec::new();
    let mut sent_samples: u64 = 0;

    loop {
        if stop.load(Ordering::Relaxed) {
            return Ok(());
        }
        let packet = match format.next_packet() {
            Ok(Some(p)) => p,
            Ok(None) => break,
            Err(SymError::IoError(_)) => break,
            Err(e) => return Err(anyhow!("read error: {e}")),
        };
        if packet.track_id != track_id {
            continue;
        }

        let buf = match decoder.decode(&packet) {
            Ok(b) => b,
            // Individual bad packets are survivable; keep going.
            Err(SymError::IoError(_)) | Err(SymError::DecodeError(_)) => continue,
            Err(e) => return Err(anyhow!("decode error: {e}")),
        };

        let spec = buf.spec();
        let channels = spec.channels().count().max(1);
        let resampler = resampler.get_or_insert_with(|| Resampler::new(spec.rate(), TARGET_RATE));

        interleaved.resize(buf.samples_interleaved(), 0.0);
        buf.copy_to_slice_interleaved(&mut interleaved[..]);

        mono.clear();
        downmix(&interleaved, channels, &mut mono);
        resampler.push(&mono, &mut pcm);

        while pcm.len() >= CHUNK_SAMPLES {
            if stop.load(Ordering::Relaxed) {
                return Ok(());
            }
            let chunk: Vec<i16> = pcm.drain(..CHUNK_SAMPLES).collect();
            if tx.blocking_send(chunk).is_err() {
                return Ok(()); // socket closed
            }
            sent_samples += CHUNK_SAMPLES as u64;
            progress(sent_samples as f64 / TARGET_RATE as f64, total_secs);
            std::thread::sleep(CHUNK_PACE);
        }
    }

    // Flush the tail so the last partial chunk isn't silently dropped.
    if !pcm.is_empty() {
        let _ = tx.blocking_send(std::mem::take(&mut pcm));
    }
    Ok(())
}
