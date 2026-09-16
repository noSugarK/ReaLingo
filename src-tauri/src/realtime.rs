//! WebSocket client for the Model Studio realtime translation endpoint.
//!
//! This lives in Rust rather than the webview for one hard reason: the endpoint authenticates
//! with an `Authorization` request header, and the browser `WebSocket` constructor cannot set
//! headers. Keeping the API key out of the webview is a welcome side effect.

use anyhow::{anyhow, Result};
use base64::prelude::{Engine, BASE64_STANDARD};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc::Receiver;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

use crate::config::Settings;

pub const EVENT: &str = "rt://event";
/// Every server frame, verbatim — the app's diagnostics drawer reads this. The realtime
/// protocol's exact field names for source transcripts are not fully documented, so being
/// able to see the wire traffic matters more than it usually would.
pub const RAW_EVENT: &str = "rt://raw";

/// One normalised server event.
///
/// The wire protocol is *not* delta-based, which is the thing worth knowing here:
/// `text` is the full confirmed text so far and `stash` is the model's tentative
/// continuation, both re-sent in every frame. Appending them would duplicate; replace.
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
) {
    note(&app, "status", "connecting");
    if let Err(e) = connect_and_pump(&app, &settings, audio_rx, &stop).await {
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
) -> Result<()> {
    if settings.api_key.trim().is_empty() {
        return Err(anyhow!("API key is empty"));
    }

    let mut request = settings.ws_url().into_client_request()?;
    request.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {}", settings.api_key.trim()))?,
    );

    let (ws, _) = tokio::time::timeout(Duration::from_secs(15), tokio_tungstenite::connect_async(request))
        .await
        .map_err(|_| anyhow!("connection timed out after 15s"))?
        .map_err(|e| anyhow!("connect failed: {e}"))?;

    let (mut write, mut read) = ws.split();
    write.send(Message::Text(settings.session_update().to_string().into())).await?;
    note(app, "status", "connected");

    // Uplink: PCM chunks -> base64 -> input_audio_buffer.append.
    let stop_up = stop.clone();
    let uplink = tokio::spawn(async move {
        while let Some(chunk) = audio_rx.recv().await {
            if stop_up.load(Ordering::Relaxed) {
                break;
            }
            let mut bytes = Vec::with_capacity(chunk.len() * 2);
            for s in &chunk {
                bytes.extend_from_slice(&s.to_le_bytes());
            }
            let frame = json!({
                "type": "input_audio_buffer.append",
                "audio": BASE64_STANDARD.encode(&bytes),
            });
            if write.send(Message::Text(frame.to_string().into())).await.is_err() {
                return;
            }
        }
        let _ = write.send(Message::Text(json!({ "type": "session.finish" }).to_string().into())).await;
        let _ = write.close().await;
    });

    loop {
        // Once the user stops we still want the tail of the translation, but not forever:
        // the uplink closes the write half, the server answers, and this drains it.
        let idle = if stop.load(Ordering::Relaxed) {
            Duration::from_secs(5)
        } else {
            Duration::from_secs(90)
        };
        let msg = match tokio::time::timeout(idle, read.next()).await {
            Err(_) => break,
            Ok(None) => break,
            Ok(Some(m)) => m,
        };
        match msg {
            Ok(Message::Text(text)) => {
                if let Ok(value) = serde_json::from_str::<Value>(&text) {
                    let _ = app.emit(RAW_EVENT, &value);
                    dispatch(app, &value);
                }
            }
            Ok(Message::Close(_)) => break,
            Ok(_) => {}
            Err(e) => return Err(anyhow!("socket error: {e}")),
        }
    }

    stop.store(true, Ordering::Relaxed);
    let _ = uplink.await;
    Ok(())
}

fn dispatch(app: &AppHandle, v: &Value) {
    if let Some(ev) = classify(v) {
        emit(app, ev);
    }
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
            done: false,
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
        "input_audio_buffer.speech_started" => Event { kind: "speech", text: "start".into(), ..Default::default() },
        "input_audio_buffer.speech_stopped" => Event { kind: "speech", text: "stop".into(), ..Default::default() },
        "session.created" | "session.updated" => Event { kind: "status", text: "connected".into(), ..Default::default() },
        "session.finished" => Event { kind: "status", text: "closed".into(), ..Default::default() },
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
    fn unknown_events_are_ignored() {
        assert!(classify(&json!({ "type": "response.output_item.added" })).is_none());
        assert!(classify(&json!({ "no_type": 1 })).is_none());
    }
}
