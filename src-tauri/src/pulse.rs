//! System audio on Linux, without sending the user to pavucontrol.
//!
//! ALSA has no loopback flag and does not enumerate the *monitor* sources that PulseAudio
//! and PipeWire expose for exactly this purpose — which is why cpal can offer nothing here.
//! So this module steps around ALSA and talks to the sound server directly, through the
//! pactl/parec pair that ships with `pulseaudio-utils`:
//!
//!   - `pactl list sources` enumerates every source, monitors included. A monitor is the one
//!     with a "Monitor of Sink" line — precisely the "record what this output plays" device.
//!   - `parec` records one of them and writes raw PCM to stdout. Asking it for
//!     s16le/16000/mono means the sound server does the downmix and resampling, so samples
//!     arrive in exactly the shape the uplink wants and skip our own pipeline.
//!
//! These tools speak the PulseAudio protocol, which PipeWire also serves (pipewire-pulse),
//! so one path covers both sound servers. Where they are missing, [`available`] is false and
//! the app falls back to the old behaviour: no system-audio devices, and the hint about
//! routing the stream by hand.

use anyhow::{anyhow, Result};
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc::Sender;

use crate::resample::{CHUNK_SAMPLES, TARGET_RATE};

/// Whether a sound server we can talk to is actually reachable. Both halves matter: pactl
/// present but no server running (a headless box) must read as "unavailable", not as an
/// empty device list that looks like broken hardware.
pub fn available() -> bool {
    Command::new("pactl")
        .arg("info")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// A monitor source: `name` is what `parec -d` wants, `label` is what the user should see.
pub struct Monitor {
    pub name: String,
    pub label: String,
}

pub fn monitors() -> Vec<Monitor> {
    match Command::new("pactl").arg("list").arg("sources").output() {
        Ok(o) if o.status.success() => parse_sources(&String::from_utf8_lossy(&o.stdout)),
        _ => Vec::new(),
    }
}

/// The monitor of the current default sink, spelled as a real source name.
///
/// Deliberately not the `@DEFAULT_MONITOR@` alias parec also accepts: the UI selects a
/// device by id and needs that id to equal one of the entries [`monitors`] returned, which
/// an alias never does — the picker would show its placeholder over a valid selection.
pub fn default_monitor() -> Option<String> {
    let out = Command::new("pactl").arg("get-default-sink").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let sink = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!sink.is_empty()).then(|| format!("{sink}.monitor"))
}

/// Parse `pactl list sources`. A "Source #N" header starts each record; within one, "Name"
/// is the id, "Description" the human label, and "Monitor of Sink" marks it as a monitor
/// (plain inputs carry `n/a`). Localised pactl output translates the *values*, never these
/// keys, so keying off them is safe.
fn parse_sources(text: &str) -> Vec<Monitor> {
    let mut out: Vec<Monitor> = Vec::new();
    let (mut name, mut desc, mut is_monitor) = (None::<String>, None::<String>, false);

    fn flush(
        out: &mut Vec<Monitor>,
        name: &mut Option<String>,
        desc: &mut Option<String>,
        mon: &mut bool,
    ) {
        if let (Some(n), true) = (name.take(), *mon) {
            let label = desc.take().unwrap_or_else(|| n.clone());
            out.push(Monitor { name: n, label });
        }
        *name = None;
        *desc = None;
        *mon = false;
    }

    for line in text.lines() {
        let t = line.trim();
        // The next header ends the previous record; blank lines are not reliable separators
        // because some properties are themselves indented blocks.
        if t.starts_with("Source #") {
            flush(&mut out, &mut name, &mut desc, &mut is_monitor);
        } else if let Some(v) = t.strip_prefix("Name: ") {
            name = Some(v.trim().to_string());
        } else if let Some(v) = t.strip_prefix("Description: ") {
            desc = Some(v.trim().to_string());
        } else if let Some(v) = t.strip_prefix("Monitor of Sink: ") {
            is_monitor = v.trim() != "n/a";
        }
    }
    flush(&mut out, &mut name, &mut desc, &mut is_monitor);
    out
}

/// Records `source` until `stop`, feeding 100 ms chunks to `tx`. Returns once the recorder
/// has been spawned, so a missing binary surfaces as a start error rather than as silence.
pub fn start(
    source: &str,
    tx: Sender<Vec<i16>>,
    level: Arc<AtomicU32>,
    stop: Arc<AtomicBool>,
) -> Result<()> {
    let mut child = Command::new("parec")
        .args([
            "-d",
            source,
            "--format=s16le",
            &format!("--rate={TARGET_RATE}"),
            "--channels=1",
            // Without this parec buffers to its own default, adding latency we could not
            // then remove downstream.
            "--latency-msec=100",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| anyhow!("parec could not start ({e}) — install pulseaudio-utils"))?;

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("parec produced no output stream"))?;

    std::thread::spawn(move || {
        let mut raw = vec![0u8; CHUNK_SAMPLES * 2];
        while !stop.load(Ordering::Relaxed) {
            if read_exact_or_eof(&mut stdout, &mut raw).is_err() {
                break; // parec exited: the source vanished, or we are shutting down
            }
            let pcm: Vec<i16> = raw
                .chunks_exact(2)
                .map(|b| i16::from_le_bytes([b[0], b[1]]))
                .collect();

            let peak = pcm.iter().fold(0f32, |m, &s| m.max((s as f32 / 32768.0).abs()));
            level.store(peak.to_bits(), Ordering::Relaxed);

            // Never block: a backed-up uplink drops audio rather than stalling the reader.
            let _ = tx.try_send(pcm);
        }
        reap(&mut child);
        level.store(0f32.to_bits(), Ordering::Relaxed);
    });

    Ok(())
}

/// `read_exact`, but a clean EOF is an error rather than an endless loop.
fn read_exact_or_eof(r: &mut impl Read, buf: &mut [u8]) -> std::io::Result<()> {
    let mut filled = 0;
    while filled < buf.len() {
        match r.read(&mut buf[filled..])? {
            0 => return Err(std::io::ErrorKind::UnexpectedEof.into()),
            n => filled += n,
        }
    }
    Ok(())
}

fn reap(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait(); // without this the recorder lingers as a zombie
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Trimmed from real `pactl list sources` output on Ubuntu (PipeWire): two monitors and
    /// one ordinary microphone.
    const SAMPLE: &str = "Source #0
\tState: SUSPENDED
\tName: alsa_output.pci-0000_00_1f.3.analog-stereo.monitor
\tDescription: Monitor of Built-in Audio Analog Stereo
\tDriver: PipeWire
\tMonitor of Sink: alsa_output.pci-0000_00_1f.3.analog-stereo
\tProperties:
\t\tdevice.description = \"Built-in Audio\"

Source #1
\tState: RUNNING
\tName: alsa_input.pci-0000_00_1f.3.analog-stereo
\tDescription: Built-in Audio Analog Stereo
\tDriver: PipeWire
\tMonitor of Sink: n/a
\tProperties:
\t\tdevice.description = \"Built-in Audio\"

Source #2
\tState: SUSPENDED
\tName: alsa_output.usb-Generic_USB_Audio-00.analog-stereo.monitor
\tDescription: Monitor of USB Audio
\tDriver: PipeWire
\tMonitor of Sink: alsa_output.usb-Generic_USB_Audio-00.analog-stereo
";

    #[test]
    fn keeps_only_monitor_sources() {
        let found = parse_sources(SAMPLE);
        let names: Vec<_> = found.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "alsa_output.pci-0000_00_1f.3.analog-stereo.monitor",
                "alsa_output.usb-Generic_USB_Audio-00.analog-stereo.monitor"
            ],
            "the plain microphone (Monitor of Sink: n/a) must not be offered as system audio"
        );
        assert_eq!(found[0].label, "Monitor of Built-in Audio Analog Stereo");
    }

    #[test]
    fn the_last_record_is_not_dropped() {
        // The sample ends without a trailing blank line — the shape that loses a record when
        // flushing is driven by separators instead of by the next header.
        assert_eq!(parse_sources(SAMPLE).len(), 2);
    }

    #[test]
    fn survives_empty_and_garbage_input() {
        assert!(parse_sources("").is_empty());
        assert!(parse_sources("no sources here\nName: dangling\n").is_empty());
    }
}
