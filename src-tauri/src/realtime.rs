//! WebSocket client for the realtime translation endpoints (Model Studio, OpenAI, Gemini, Volcengine).
//!
//! This lives in Rust rather than the webview for one hard reason: the endpoint authenticates
//! with an `Authorization` request header, and the browser `WebSocket` constructor cannot set
//! headers. Keeping the API key out of the webview is a welcome side effect.

use anyhow::{anyhow, Result};
use base64::prelude::{Engine, BASE64_STANDARD};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc::Receiver;
use tokio::sync::Notify;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::Message;

use crate::config::Settings;
use crate::player::Player;
use crate::resample::chunk_samples;

pub const EVENT: &str = "rt://event";
/// Every server frame, verbatim — the app's diagnostics drawer reads this. The realtime
/// protocol's exact field names for source transcripts are not fully documented, so being
/// able to see the wire traffic matters more than it usually would.
pub const RAW_EVENT: &str = "rt://raw";

/// How long a server that never announces the end (Gemini) must go without text or
/// non-silent audio, after stopping, before the session counts as done.
const QUIET_END: Duration = Duration::from_secs(4);

/// One normalised server event.
///
/// `text` is always the full confirmed text so far. Delta-based models are accumulated
/// in TextStream before emitting, so the frontend can replace rather than append.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub kind: &'static str,
    pub text: String,
    /// Unconfirmed tail — worth showing, but greyed out; it can still change.
    pub stash: String,
    /// Source language the model detected (transcript events only).
    pub lang: String,
    /// Which turn this belongs to. Translation events carry the assistant item's id;
    /// transcript events carry the input item's id, and a `link` event ties the two
    /// together. Without it, a transcript that finishes after its translation — which is
    /// the normal order — gets attached to whatever turn happens to be open.
    pub id: String,
    pub done: bool,
    /// Where this speech sits in the input audio, ms from its start, when the server says.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_ms: Option<u64>,
    /// How much audio had been sent when this arrived — the fallback timeline for servers
    /// that give no timing. Late by the model's latency, but on the audio's clock.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at_ms: Option<u64>,
}

pub fn emit(app: &AppHandle, ev: Event) {
    let _ = app.emit(EVENT, ev);
}

/// Status / error / progress notices, which carry nothing but a string.
pub fn note(app: &AppHandle, kind: &'static str, text: impl Into<String>) {
    emit(app, Event { kind, text: text.into(), ..Default::default() });
}

pub async fn run(
    app: AppHandle,
    settings: Settings,
    audio_rx: Receiver<Vec<i16>>,
    stop: Arc<AtomicBool>,
    player: Option<Player>,
) {
    note(&app, "status", "connecting");
    if let Err(e) = connect_and_pump(&app, &settings, audio_rx, &stop, player).await {
        note(&app, "error", e.to_string());
    }
    stop.store(true, Ordering::Relaxed);
    note(&app, "status", "closed");
}

async fn connect_and_pump(
    app: &AppHandle,
    settings: &Settings,
    mut audio_rx: Receiver<Vec<i16>>,
    stop: &Arc<AtomicBool>,
    mut player: Option<Player>,
) -> Result<()> {
    if settings.key().trim().is_empty() {
        return Err(anyhow!("API key is empty"));
    }

    let (ws, _) = tokio::time::timeout(Duration::from_secs(15), tokio_tungstenite::connect_async(settings.client_request()?))
        .await
        .map_err(|_| anyhow!("connection timed out after 15s"))?
        .map_err(|e| anyhow!("connect failed: {e}"))?;

    let (mut write, mut read) = ws.split();
    let mut text_stream = TextStream::default();
    // Volc names every frame with a session id of our choosing.
    let session = format!("realingo-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos());
    write.send(settings.setup_message(&session)).await?;
    note(app, "status", "connected");

    // Released at once, except for Gemini, which drops audio sent before `setupComplete`.
    let ready = Arc::new(Notify::new());
    if !settings.waits_for_setup() {
        ready.notify_one();
    }

    // Uplink: PCM chunks -> base64 -> the protocol's audio frame, until the user stops or
    // the source runs out (a file at EOF drops its sender).
    // Samples sent so far: the audio clock behind `Event::at_ms`.
    let sent = Arc::new(AtomicU64::new(0));
    let (stop_up, ready_up, wire, sent_up, sid) = (stop.clone(), ready.clone(), settings.clone(), sent.clone(), session.clone());
    let uplink = tokio::spawn(async move {
        ready_up.notified().await;
        while let Some(chunk) = audio_rx.recv().await {
            if stop_up.load(Ordering::Relaxed) {
                break;
            }
            sent_up.fetch_add(chunk.len() as u64, Ordering::Relaxed);
            let mut bytes = Vec::with_capacity(chunk.len() * 2);
            for s in &chunk {
                bytes.extend_from_slice(&s.to_le_bytes());
            }
            if write.send(wire.audio_message(&sid, bytes)).await.is_err() {
                return None;
            }
        }
        // Finishing: the reader below switches to the short wait, and capture stops.
        stop_up.store(true, Ordering::Relaxed);
        // A pause for the protocols that need one to let go of the last words, paced like
        // the file decoder rather than dumped at once.
        let chunk = chunk_samples(wire.sample_rate());
        for _ in 0..wire.flush_silence() / chunk {
            if write.send(wire.audio_message(&sid, vec![0u8; chunk * 2])).await.is_err() {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(80)).await;
        }
        let _ = write.send(wire.finish_message(&sid)).await;
        // Not closed here: a close frame makes the server hang up before the last sentence
        // is out. The reader closes it once `is_finished` says everything has arrived.
        Some(write)
    });

    // Last time the server said something worth having: text, or audio that is not silence.
    // Only consulted where the server never announces the end (see `signals_finish`).
    let mut heard = Instant::now();
    loop {
        if stop.load(Ordering::Relaxed) && !settings.signals_finish() && heard.elapsed() > QUIET_END {
            break;
        }
        // After session.finish the server still owes the last sentence, which can take a
        // few seconds of silence to produce; 15 s bounds a server that never answers.
        let idle = if stop.load(Ordering::Relaxed) {
            Duration::from_secs(15)
        } else {
            Duration::from_secs(90)
        };
        let msg = match tokio::time::timeout(idle, read.next()).await {
            Err(_) => break,
            Ok(None) => break,
            Ok(Some(m)) => m,
        };
        let mut value = match msg {
            Ok(Message::Text(text)) => match serde_json::from_str::<Value>(text.as_str()) {
                Ok(v) => v,
                Err(_) => continue,
            },
            // Gemini sends its JSON in binary frames; Volc speaks protobuf. Either way it comes
            // out as JSON, so everything below is the same for every protocol.
            Ok(Message::Binary(bytes)) => match settings.decode_binary(&bytes) {
                Some(v) => v,
                None => continue,
            },
            // Gemini reports a bad key or setup by closing with a reason, not with a frame.
            Ok(Message::Close(Some(frame))) if frame.code != CloseCode::Normal && !frame.reason.is_empty() => {
                return Err(anyhow!("closed by server: {}", frame.reason));
            }
            Ok(Message::Close(_)) => break,
            Ok(_) => continue,
            Err(e) => return Err(anyhow!("socket error: {e}")),
        };
        if settings.is_ready(&value) {
            ready.notify_one();
        }
        if let Some(audio) = take_audio(&mut value) {
            if audio.iter().any(|&b| b != 0) {
                heard = Instant::now();
            }
            if let Some(p) = player.as_mut() {
                p.push(&audio);
            }
        }
        let _ = app.emit(RAW_EVENT, &value);
        if let Some(reason) = settings.rejection(&value) {
            return Err(anyhow!(reason));
        }
        let now_ms = sent.load(Ordering::Relaxed) * 1000 / settings.sample_rate() as u64;
        for mut ev in text_stream.next(&value) {
            if !ev.text.is_empty() {
                heard = Instant::now();
            }
            if matches!(ev.kind, "source" | "target") {
                ev.at_ms = Some(now_ms);
            }
            emit(app, ev);
        }
        if settings.is_finished(&value) {
            break;
        }
    }

    stop.store(true, Ordering::Relaxed);
    // A setup that never completed would leave the uplink parked forever; let it see `stop`.
    ready.notify_one();
    if let Ok(Some(mut write)) = uplink.await {
        let _ = write.close().await;
    }
    Ok(())
}

/// Pulls the PCM out of an audio delta frame and leaves its byte count behind:
/// several KB of base64 ten times a second is no use in the diagnostics drawer.
fn take_audio(v: &mut Value) -> Option<Vec<u8>> {
    let is_delta = matches!(
        v.get("type").and_then(Value::as_str),
        Some("response.audio.delta" | "session.output_audio.delta")
    );
    // Qwen and OpenAI carry one `delta`; Gemini a list of parts, each with inline data.
    // Volc: TTSResponse audio, base64-encoded by `volc::decode` under `data`.
    let is_volc = v.get("type").and_then(Value::as_str) == Some("volc.TTSResponse");
    let slots: Vec<&mut Value> = if is_volc {
        v.get_mut("data").into_iter().collect()
    } else if is_delta {
        v.get_mut("delta").into_iter().collect()
    } else if let Some(parts) = v.pointer_mut("/serverContent/modelTurn/parts").and_then(Value::as_array_mut) {
        parts.iter_mut().filter_map(|p| p.pointer_mut("/inlineData/data")).collect()
    } else {
        return None;
    };
    let mut pcm = Vec::new();
    for slot in slots {
        let Some(bytes) = slot.as_str().and_then(|s| BASE64_STANDARD.decode(s).ok()) else { continue };
        *slot = format!("<{} bytes>", bytes.len()).into();
        pcm.extend(bytes);
    }
    (!pcm.is_empty()).then_some(pcm)
}

#[derive(Default)]
struct TextStream {
    partial: BTreeMap<(&'static str, String), String>,
    /// OpenAI and Gemini: the one open turn, see [`TextStream::continuous`].
    turn: u64,
    open: bool,
    source: String,
    target: String,
    /// OpenAI: the open turn's first and last `elapsed_ms` on the input transcript.
    span: (Option<u64>, Option<u64>),
    /// Volc: the id of the sentence open on each side, `[source, target]`. Word deltas carry no
    /// timing of their own, so they go to whichever sentence is open.
    volc_open: [String; 2],
}

/// Past this many characters a translation with no sentence end is cut anyway, so a speaker
/// who never pauses does not grow one endless row.
const MAX_TURN_CHARS: usize = 150;

impl TextStream {
    /// Volc, as seen live: per sentence, `*SubtitleStart` (with the audio span), word deltas in
    /// `*SubtitleResponse`, then `*SubtitleEnd` with the whole sentence — transcript first,
    /// then its translation. A translation's Start and End carry the same `start_time` as its
    /// transcript's, so that is the pairing key: a sentence that never gets translated leaves a
    /// row without one, instead of shifting every later translation onto the wrong row.
    fn volc(&mut self, name: &str, v: &Value) -> Vec<Event> {
        let (kind, stage) = match name {
            "SourceSubtitleStart" => ("source", 0),
            "SourceSubtitleResponse" => ("source", 1),
            "SourceSubtitleEnd" => ("source", 2),
            "TranslationSubtitleStart" => ("target", 0),
            "TranslationSubtitleResponse" => ("target", 1),
            "TranslationSubtitleEnd" => ("target", 2),
            _ => return Vec::new(),
        };
        let ms = |k: &str| v.get(k).and_then(Value::as_u64);
        let open = &mut self.volc_open[usize::from(kind == "target")];
        if stage != 1 {
            *open = format!("v{}", ms("start_time").unwrap_or_default());
        }
        let id = open.clone();
        let text = v.get("text").and_then(Value::as_str).unwrap_or_default();
        let mut out = Vec::new();
        match stage {
            0 => {
                self.partial.insert((kind, id.clone()), String::new());
                if kind == "source" {
                    // Transcript and translation share the id, so the link maps it to itself.
                    out.push(Event { kind: "link", id: id.clone(), text: id.clone(), ..Default::default() });
                }
                out.push(Event { kind, id, start_ms: ms("start_time"), end_ms: ms("end_time"), ..Default::default() });
            }
            1 => {
                let acc = self.partial.entry((kind, id.clone())).or_default();
                acc.push_str(text);
                out.push(Event { kind, id, text: acc.trim_start().to_string(), ..Default::default() });
            }
            _ => {
                self.partial.remove(&(kind, id.clone()));
                out.push(Event {
                    kind,
                    id,
                    text: text.trim().to_string(),
                    lang: v.get("detected_language").and_then(Value::as_str).unwrap_or_default().to_string(),
                    done: true,
                    start_ms: ms("start_time"),
                    end_ms: ms("end_time"),
                    ..Default::default()
                });
            }
        }
        out
    }

    fn next(&mut self, v: &Value) -> Vec<Event> {
        if let Some(name) = v.get("type").and_then(Value::as_str).and_then(|t| t.strip_prefix("volc.")) {
            return self.volc(name, v);
        }
        // Gemini: the same two append-only streams as OpenAI, untyped, and one frame may carry
        // either or both alongside the audio.
        if let Some(content) = v.get("serverContent") {
            let mut out = Vec::new();
            for (field, is_target) in [("inputTranscription", false), ("outputTranscription", true)] {
                if let Some(text) = content.pointer(&format!("/{field}/text")).and_then(Value::as_str) {
                    out.extend(self.continuous(is_target, text));
                }
            }
            return out;
        }
        match v.get("type").and_then(Value::as_str) {
            Some(ty @ ("session.input_transcript.delta" | "session.output_transcript.delta")) => {
                let delta = v.get("delta").and_then(Value::as_str).unwrap_or_default();
                if let (Some(ms), "session.input_transcript.delta") = (v.get("elapsed_ms").and_then(Value::as_u64), ty) {
                    self.span = (self.span.0.or(Some(ms)), Some(ms));
                }
                self.continuous(ty == "session.output_transcript.delta", delta)
            }
            _ => self.itemised(v).into_iter().collect(),
        }
    }

    /// OpenAI sends two bare append-only streams: no turns, no ids, no "done". The frontend's
    /// turn model needs all three, so they are made up here. Both streams share a turn id, a
    /// sentence end in the translation closes the turn, and the transcript is cut at its own
    /// last sentence end with the rest carried into the next turn.
    // ponytail: punctuation pairing, so a row's source and translation can be a clause apart;
    // `elapsed_ms` only times the rows (see `span`); pair on it too if that turns out to matter.
    fn continuous(&mut self, is_target: bool, delta: &str) -> Vec<Event> {
        let mut out = Vec::new();
        if is_target { &mut self.target } else { &mut self.source }.push_str(delta);
        if is_target {
            let cut = last_sentence_end(&self.target)
                .or((self.target.chars().count() > MAX_TURN_CHARS).then_some(self.target.len()));
            if let Some(cut) = cut {
                let target_rest = self.target.split_off(cut);
                let source_cut = last_sentence_end(&self.source).unwrap_or(self.source.len());
                let source_rest = self.source.split_off(source_cut);
                self.emit_turn(&mut out, true);
                // What is carried over started no later than where this turn stopped.
                self.span = (if source_rest.trim().is_empty() { None } else { self.span.1 }, None);
                self.target = target_rest.trim_start().to_string();
                self.source = source_rest.trim_start().to_string();
                self.turn += 1;
                self.open = false;
                if self.target.is_empty() && self.source.is_empty() {
                    return out;
                }
            }
        }
        self.emit_turn(&mut out, false);
        out
    }

    fn emit_turn(&mut self, out: &mut Vec<Event>, done: bool) {
        let id = format!("oa{}", self.turn);
        // The frontend files transcripts by link; announcing the turn first gives it a home
        // even when the transcript runs ahead of the translation, which it usually does.
        if !self.open {
            self.open = true;
            out.push(Event { kind: "link", id: id.clone(), text: id.clone(), ..Default::default() });
        }
        // Deltas carry their own leading space (" Welcome"), which is noise at a row's start.
        for (kind, text) in [("target", &self.target), ("source", &self.source)] {
            let (start_ms, end_ms) = if kind == "source" { self.span } else { (None, None) };
            out.push(Event { kind, id: id.clone(), text: text.trim_start().to_string(), done, start_ms, end_ms, ..Default::default() });
        }
    }

    fn itemised(&mut self, v: &Value) -> Option<Event> {
        let kind = match v.get("type")?.as_str()? {
            "conversation.item.input_audio_transcription.delta" => "source",
            "response.text.delta" | "response.audio_transcript.delta" => "target",
            _ => {
                let ev = classify(v)?;
                if ev.done {
                    self.partial.remove(&(ev.kind, ev.id.clone()));
                }
                return Some(ev);
            }
        };
        let id = v.get("item_id")?.as_str()?.to_string();
        let text = self.partial.entry((kind, id.clone())).or_default();
        text.push_str(v.get("delta")?.as_str()?);
        Some(Event { kind, id, text: text.clone(), ..Default::default() })
    }
}

/// Byte offset just past the last sentence end in `s`. A CJK mark ends a sentence outright; a
/// "." "!" "?" only once whitespace follows it, so "3.5" stays whole and a final "." waits
/// for the next delta to say whether it was one.
fn last_sentence_end(s: &str) -> Option<usize> {
    let mut chars = s.char_indices().peekable();
    let mut last = None;
    while let Some((i, c)) = chars.next() {
        let spaced = chars.peek().is_some_and(|&(_, n)| n.is_whitespace());
        if matches!(c, '。' | '！' | '？' | '…') || (matches!(c, '.' | '!' | '?') && spaced) {
            last = Some(i + c.len_utf8());
        }
    }
    last
}

fn classify(v: &Value) -> Option<Event> {
    let field = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
    let ty = v.get("type").and_then(Value::as_str)?;

    let ev = match ty {
        // Pairs the assistant item that will carry the translation with the input item
        // whose transcript belongs to it. Input items are announced through the same event,
        // and *their* `previous_item_id` points at the preceding assistant item — pairing
        // on that would tie every transcript to the turn before it.
        "conversation.item.created" => {
            let item = v.get("item")?;
            let is_input =
                item.pointer("/content/0/type").and_then(Value::as_str) == Some("input_audio");
            let prev = v.get("previous_item_id").and_then(Value::as_str).unwrap_or_default();
            if is_input || prev.is_empty() {
                return None;
            }
            Event {
                kind: "link",
                id: item.get("id").and_then(Value::as_str).unwrap_or_default().to_string(),
                text: prev.to_string(),
                ..Default::default()
            }
        }
        "conversation.item.input_audio_transcription.text" => Event {
            kind: "source",
            text: field("text"),
            stash: field("stash"),
            lang: field("language"),
            id: field("item_id"),
            ..Default::default()
        },
        "conversation.item.input_audio_transcription.completed" => Event {
            kind: "source",
            text: field("transcript"),
            lang: field("language"),
            id: field("item_id"),
            done: true,
            ..Default::default()
        },
        // `response.audio_transcript.*` is the same content under the audio modality.
        "response.text.text" | "response.audio_transcript.text" => Event {
            kind: "target",
            text: field("text"),
            stash: field("stash"),
            id: field("item_id"),
            ..Default::default()
        },
        // The audio-modality event names its payload `transcript`, not `text`.
        "response.text.done" | "response.audio_transcript.done" => Event {
            kind: "target",
            text: if ty == "response.text.done" { field("text") } else { field("transcript") },
            id: field("item_id"),
            done: true,
            ..Default::default()
        },
        // Carry the input item and the audio offset, so the turn gets its real place on the
        // timeline rather than when its text happened to arrive.
        "input_audio_buffer.speech_started" => Event {
            kind: "speech",
            text: "start".into(),
            id: field("item_id"),
            start_ms: v.get("audio_start_ms").and_then(Value::as_u64),
            ..Default::default()
        },
        "input_audio_buffer.speech_stopped" => Event {
            kind: "speech",
            text: "stop".into(),
            id: field("item_id"),
            end_ms: v.get("audio_end_ms").and_then(Value::as_u64),
            ..Default::default()
        },
        "session.created" | "session.updated" => Event { kind: "status", text: "connected".into(), ..Default::default() },
        "session.finished" | "session.closed" => Event { kind: "status", text: "closed".into(), ..Default::default() },
        // A server `error` frame (e.g. "previous turn is still processing") does not end
        // the session — surfacing it as a fatal error would wrongly stop the stream.
        "error" => Event {
            kind: "warn",
            text: v
                .pointer("/error/message")
                .and_then(Value::as_str)
                .or_else(|| v.get("message").and_then(Value::as_str))
                .unwrap_or("unknown error")
                .to_string(),
            ..Default::default()
        },
        _ => return None,
    };
    Some(ev)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn qwen3_8_deltas_accumulate_per_item_and_finish_without_duplicates() {
        let mut stream = TextStream::default();
        for (kind, item, delta, expected) in [
            ("response.text.delta", "target1", "早上", "早上"),
            ("conversation.item.input_audio_transcription.delta", "source1", "Good ", "Good "),
            ("response.audio_transcript.delta", "target2", "你好", "你好"),
            ("response.text.delta", "target1", "好。", "早上好。"),
            ("conversation.item.input_audio_transcription.delta", "source1", "morning.", "Good morning."),
        ] {
            let ev = stream.next(&json!({ "type": kind, "item_id": item, "delta": delta })).pop().unwrap();
            assert_eq!(ev.text, expected);
            assert_eq!(ev.id, item);
            assert!(!ev.done);
        }
        let done = stream.next(&json!({ "type": "response.text.done", "item_id": "target1", "text": "早上好。" })).pop().unwrap();
        assert_eq!(done.text, "早上好。");
        assert!(done.done);
        assert!(!stream.partial.contains_key(&("target", "target1".into())));
        assert!(stream.partial.contains_key(&("source", "source1".into())));
    }

    /// Frames captured from the live endpoint (see `examples/probe.rs`).
    #[test]
    fn translation_text_is_cumulative_plus_a_tentative_stash() {
        let ev = classify(&json!({
            "type": "response.text.text",
            "text": "早上好，各位。",
            "stash": "欢迎来到季度"
        }))
        .unwrap();
        assert_eq!(ev.kind, "target");
        assert_eq!(ev.text, "早上好，各位。");
        assert_eq!(ev.stash, "欢迎来到季度");
        assert!(!ev.done);
    }

    #[test]
    fn empty_confirmed_text_still_reaches_the_ui() {
        // The first frames of a turn confirm nothing yet; clearing is the correct render.
        let ev = classify(&json!({ "type": "response.text.text", "text": "", "stash": "早上好" })).unwrap();
        assert_eq!(ev.text, "");
        assert_eq!(ev.stash, "早上好");
    }

    #[test]
    fn done_carries_the_whole_sentence() {
        let ev = classify(&json!({ "type": "response.text.done", "text": "早上好，各位。" })).unwrap();
        assert!(ev.done);
        assert_eq!(ev.text, "早上好，各位。");
        assert_eq!(ev.stash, "");
    }

    #[test]
    fn transcript_completed_reads_the_transcript_field_and_language() {
        let ev = classify(&json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "transcript": "Good morning, everyone.",
            "language": "en"
        }))
        .unwrap();
        assert_eq!(ev.kind, "source");
        assert_eq!(ev.text, "Good morning, everyone.");
        assert_eq!(ev.lang, "en");
        assert!(ev.done);
    }

    #[test]
    fn assistant_item_links_to_the_input_item_it_answers() {
        let ev = classify(&json!({
            "type": "conversation.item.created",
            "item": { "id": "item_assistant", "content": [], "role": "assistant" },
            "previous_item_id": "item_input"
        }))
        .unwrap();
        assert_eq!(ev.kind, "link");
        assert_eq!(ev.id, "item_assistant");
        assert_eq!(ev.text, "item_input");
    }

    #[test]
    fn the_input_items_own_announcement_is_not_a_link() {
        // Its `previous_item_id` points at the *previous* turn's assistant item, so taking
        // it would pair every transcript with the turn before it.
        assert!(classify(&json!({
            "type": "conversation.item.created",
            "item": { "id": "item_input", "content": [{ "type": "input_audio" }] },
            "previous_item_id": "item_assistant_of_previous_turn"
        }))
        .is_none());
    }

    #[test]
    fn turn_ids_ride_along_with_transcripts_and_translations() {
        let src = classify(&json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "item_input",
            "transcript": "Good morning."
        }))
        .unwrap();
        assert_eq!(src.id, "item_input");

        let tgt = classify(&json!({
            "type": "response.text.done",
            "item_id": "item_assistant",
            "text": "早上好。"
        }))
        .unwrap();
        assert_eq!(tgt.id, "item_assistant");
    }

    #[test]
    fn audio_delta_is_decoded_and_elided_from_the_raw_log() {
        let mut v = json!({ "type": "response.audio.delta", "delta": BASE64_STANDARD.encode([1u8, 0, 255, 127]) });
        assert_eq!(take_audio(&mut v).unwrap(), vec![1, 0, 255, 127]);
        assert_eq!(v["delta"], "<4 bytes>");
        assert!(take_audio(&mut json!({ "type": "response.text.text", "delta": "AAAA" })).is_none());
        let mut oa = json!({ "type": "session.output_audio.delta", "delta": BASE64_STANDARD.encode([9u8, 9]) });
        assert_eq!(take_audio(&mut oa).unwrap(), vec![9, 9]);
    }

    fn oa(stream: &mut TextStream, ty: &str, delta: &str) -> Vec<Event> {
        stream.next(&json!({ "type": format!("session.{ty}_transcript.delta"), "delta": delta, "elapsed_ms": 200 }))
    }

    fn done_pair(evs: &[Event]) -> Option<(String, String, String)> {
        let t = evs.iter().find(|e| e.kind == "target" && e.done)?;
        let s = evs.iter().find(|e| e.kind == "source" && e.done)?;
        assert_eq!(t.id, s.id);
        Some((t.id.clone(), t.text.clone(), s.text.clone()))
    }

    #[test]
    fn openai_streams_are_cut_into_turns_at_sentence_ends() {
        let mut st = TextStream::default();
        // The transcript runs ahead; the turn is announced so it has somewhere to go.
        let first = oa(&mut st, "input", "Good morning.");
        assert_eq!(first[0].kind, "link");
        assert_eq!(first[0].id, "oa0");
        assert_eq!(first[0].text, "oa0");
        oa(&mut st, "input", " Welcome to");
        assert!(done_pair(&oa(&mut st, "output", "早上")).is_none());
        // A CJK full stop closes the turn at once; the transcript keeps its unfinished tail.
        let evs = oa(&mut st, "output", "好。");
        assert_eq!(done_pair(&evs).unwrap(), ("oa0".into(), "早上好。".into(), "Good morning.".into()));
        // The carried-over tail opens the next turn straight away.
        assert!(evs.iter().any(|e| e.kind == "link" && e.id == "oa1"));
        let next = oa(&mut st, "input", " the call");
        let src = next.iter().find(|e| e.kind == "source").unwrap();
        assert_eq!((src.id.as_str(), src.text.as_str()), ("oa1", "Welcome to the call"));
    }

    #[test]
    fn a_latin_full_stop_waits_for_the_space_after_it() {
        let mut st = TextStream::default();
        oa(&mut st, "output", "Version 3.");
        assert!(done_pair(&oa(&mut st, "output", "5 is out.")).is_none());
        let evs = oa(&mut st, "output", " Next");
        assert_eq!(done_pair(&evs).unwrap().1, "Version 3.5 is out.");
        // The word after the stop opens the next turn rather than vanishing.
        let carried = evs.iter().rev().find(|e| e.kind == "target").unwrap();
        assert_eq!((carried.id.as_str(), carried.text.as_str(), carried.done), ("oa1", "Next", false));
    }

    #[test]
    fn a_turn_with_no_sentence_end_is_still_cut() {
        let mut st = TextStream::default();
        let long = "啊".repeat(MAX_TURN_CHARS + 1);
        assert_eq!(done_pair(&oa(&mut st, "output", &long)).unwrap().1, long);
    }

    #[test]
    fn session_closed_ends_the_session_like_finished() {
        let ev = classify(&json!({ "type": "session.closed", "event_id": "e" })).unwrap();
        assert_eq!((ev.kind, ev.text.as_str()), ("status", "closed"));
    }

    /// Shapes from the Gemini Live translation docs' raw-WebSocket example.
    #[test]
    fn gemini_transcripts_feed_the_same_turns_and_its_audio_is_extracted() {
        let mut st = TextStream::default();
        let src = st.next(&json!({ "serverContent": { "inputTranscription": { "text": "Good morning.", "languageCode": "en" } } }));
        assert_eq!(src[0].kind, "link");
        assert!(src.iter().any(|e| e.kind == "source" && e.text == "Good morning."));
        // Transcript and translation in one frame: both land, and the stop closes the turn.
        let both = st.next(&json!({ "serverContent": {
            "inputTranscription": { "text": " Welcome" },
            "outputTranscription": { "text": "早上好。" }
        } }));
        let done = both.iter().find(|e| e.kind == "target" && e.done).unwrap();
        assert_eq!((done.id.as_str(), done.text.as_str()), ("oa0", "早上好。"));
        // A frame with neither (audio only, turnComplete) yields no text events.
        assert!(st.next(&json!({ "serverContent": { "turnComplete": true } })).is_empty());
        // A turn opened by a delta with its own leading space (seen live) shows without it.
        let mut fresh = TextStream::default();
        let evs = fresh.next(&json!({ "serverContent": { "inputTranscription": { "text": " Today we" } } }));
        assert!(evs.iter().any(|e| e.kind == "source" && e.text == "Today we"));

        let mut audio = json!({ "serverContent": { "modelTurn": { "parts": [
            { "inlineData": { "mimeType": "audio/pcm;rate=24000", "data": BASE64_STANDARD.encode([1u8, 2]) } },
            { "inlineData": { "mimeType": "audio/pcm;rate=24000", "data": BASE64_STANDARD.encode([3u8]) } }
        ] } } });
        assert_eq!(take_audio(&mut audio).unwrap(), vec![1, 2, 3]);
        assert_eq!(audio.pointer("/serverContent/modelTurn/parts/0/inlineData/data").unwrap(), "<2 bytes>");
        assert!(take_audio(&mut json!({ "setupComplete": {} })).is_none());
    }


    #[test]
    fn speech_events_carry_their_item_and_audio_offset() {
        let start = classify(&json!({ "type": "input_audio_buffer.speech_started", "item_id": "in1", "audio_start_ms": 1200 })).unwrap();
        assert_eq!((start.id.as_str(), start.start_ms, start.end_ms), ("in1", Some(1200), None));
        let stop = classify(&json!({ "type": "input_audio_buffer.speech_stopped", "item_id": "in1", "audio_end_ms": 3400 })).unwrap();
        assert_eq!((stop.text.as_str(), stop.end_ms), ("stop", Some(3400)));
    }

    #[test]
    fn openai_turns_are_timed_by_the_transcripts_elapsed_ms() {
        let mut st = TextStream::default();
        let at = |st: &mut TextStream, ty: &str, delta: &str, ms: u64| {
            st.next(&json!({ "type": format!("session.{ty}_transcript.delta"), "delta": delta, "elapsed_ms": ms }))
        };
        at(&mut st, "input", "Good morning.", 400);
        at(&mut st, "input", " Welcome", 1200);
        let evs = at(&mut st, "output", "早上好。", 1400);
        let src = evs.iter().find(|e| e.kind == "source" && e.done).unwrap();
        assert_eq!((src.start_ms, src.end_ms), (Some(400), Some(1200)));
        // The carried-over "Welcome" opens the next turn where this one stopped.
        let next = at(&mut st, "input", " to", 1600);
        let src = next.iter().find(|e| e.kind == "source").unwrap();
        assert_eq!((src.start_ms, src.end_ms), (Some(1200), Some(1600)));
    }

    /// The frame order captured live from the AST endpoint (zh → en, s2t).
    #[test]
    fn volc_sentences_pair_by_start_time_and_carry_their_audio_span() {
        let mut st = TextStream::default();
        let f = |name: &str, text: &str, start: u64, end: u64| {
            json!({ "type": format!("volc.{name}"), "text": text, "start_time": start, "end_time": end })
        };
        let open = st.next(&f("SourceSubtitleStart", "", 20, 1140));
        assert_eq!((open[0].kind, open[0].id.as_str(), open[0].text.as_str()), ("link", "v20", "v20"));
        assert_eq!((open[1].start_ms, open[1].end_ms), (Some(20), Some(1140)));
        st.next(&f("SourceSubtitleResponse", "看", 0, 0));
        let mid = st.next(&f("SourceSubtitleResponse", "外语", 0, 0));
        assert_eq!((mid[0].text.as_str(), mid[0].done), ("看外语", false));
        let end = st.next(&f("SourceSubtitleEnd", "看外语视频，", 20, 1140));
        assert_eq!((end[0].text.as_str(), end[0].done, end[0].start_ms), ("看外语视频，", true, Some(20)));

        st.next(&f("TranslationSubtitleStart", "", 20, 1140));
        let word = st.next(&f("TranslationSubtitleResponse", "When", 0, 0));
        assert_eq!((word[0].kind, word[0].id.as_str()), ("target", "v20"));
        let done = st.next(&f("TranslationSubtitleEnd", "When watching foreign language videos, ", 20, 1140));
        assert_eq!(done[0].text, "When watching foreign language videos,");
        assert!(done[0].done);

        // A sentence that is never translated (a cough, a filler) leaves its own row without a
        // translation; the next translation still lands on its own transcript.
        st.next(&f("SourceSubtitleStart", "", 1300, 1500));
        st.next(&f("SourceSubtitleEnd", "嗯", 1300, 1500));
        assert_eq!(st.next(&f("SourceSubtitleStart", "", 1600, 2580))[0].id, "v1600");
        st.next(&f("SourceSubtitleEnd", "实时出中文字幕。", 1600, 2580));
        st.next(&f("TranslationSubtitleStart", "", 1600, 2580));
        let late = st.next(&f("TranslationSubtitleResponse", "Chinese", 0, 0));
        assert_eq!(late[0].id, "v1600");
        assert!(st.next(&json!({ "type": "volc.UsageResponse" })).is_empty());
    }

    #[test]
    fn unknown_events_are_ignored() {
        assert!(classify(&json!({ "type": "response.output_item.added" })).is_none());
        assert!(classify(&json!({ "no_type": 1 })).is_none());
    }
}
