//! Translation history: one JSONL file per session under `app-data/history`.
//!
//! Append-only text rather than a database. The write path here is "one more sentence, right
//! now", which is exactly what an append is; a crash costs the last line instead of the file;
//! exporting is handing over the file; deleting is deleting. sqlite would buy cross-session
//! search and statistics, and neither exists yet.
//!
//! Nothing is written unless the user turns history on — the setting defaults to off, and
//! the frontend simply never calls [`history_open`] while it is.

use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// The file's first line: what the session was translating, and with what.
#[derive(Serialize, Deserialize)]
pub struct Meta {
    /// File format version, so a later reader can tell old lines from new ones.
    v: u32,
    at: i64,
    source: String,
    target: String,
    model: String,
    /// Where the audio came from: `device` or `file`.
    kind: String,
}

/// One finished sentence: its transcript and its translation.
#[derive(Serialize, Deserialize)]
pub struct Entry {
    at: i64,
    source: String,
    target: String,
}

/// What the history panel lists: the session's own meta line plus what it costs.
#[derive(Serialize)]
pub struct Session {
    /// File stem, and the handle every other command takes.
    id: String,
    /// `None` when the first line is missing or unreadable. The session is still listed —
    /// the panel just falls back to showing the id.
    meta: Option<Meta>,
    /// Sentences, i.e. lines after the meta one.
    count: usize,
    bytes: u64,
}

fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("history");
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

/// Ids come from the frontend and become a file name, so a bad one is refused outright
/// rather than scrubbed — there is no `..` left to sneak past a `join` this way.
fn slug_ok(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    if !slug_ok(id) {
        return Err(format!("bad history id: {id}"));
    }
    Ok(dir(app)?.join(format!("{id}.jsonl")))
}

/// Appends one record as one line. Serialising here rather than taking JSON text is what
/// keeps a record a record: `serde_json` escapes newlines, so a line cannot split in two.
fn append(app: &AppHandle, id: &str, record: &impl Serialize) -> Result<(), String> {
    let line = serde_json::to_string(record).map_err(|e| e.to_string())?;
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path(app, id)?)
        .map_err(|e| e.to_string())?;
    writeln!(f, "{line}").map_err(|e| e.to_string())
}

/// Opens the file with its meta line. Called once, when a run starts.
#[tauri::command]
pub fn history_open(app: AppHandle, id: String, meta: Meta) -> Result<(), String> {
    append(&app, &id, &meta)
}

#[tauri::command]
pub fn history_append(app: AppHandle, id: String, entry: Entry) -> Result<(), String> {
    append(&app, &id, &entry)
}

/// Newest first. Reads every file to count its sentences — fine for the few hundred small
/// files this produces; give it an index if that ever stops being true.
#[tauri::command]
pub fn history_list(app: AppHandle) -> Result<Vec<Session>, String> {
    let mut out = Vec::new();
    for entry in fs::read_dir(dir(&app)?).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        // A file that cannot be read is skipped, not fatal: one damaged session must not
        // take the whole panel down with it.
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let mut lines = text.lines().filter(|l| !l.trim().is_empty());
        let Some(first) = lines.next() else { continue };
        out.push(Session {
            id: id.to_string(),
            meta: serde_json::from_str(first).ok(),
            count: lines.count(),
            bytes: entry.metadata().map(|m| m.len()).unwrap_or(0),
        });
    }
    // The id is an ISO timestamp, so lexical order is chronological order.
    out.sort_by(|a, b| b.id.cmp(&a.id));
    Ok(out)
}

/// The session's sentences; the meta line is dropped. So is a half-written last line, which
/// is what a kill mid-session leaves behind — the point of one line per sentence is that the
/// damage stays local.
#[tauri::command]
pub fn history_read(app: AppHandle, id: String) -> Result<Vec<Entry>, String> {
    let text = fs::read_to_string(path(&app, &id)?).map_err(|e| e.to_string())?;
    Ok(text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .skip(1)
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect())
}

#[tauri::command]
pub fn history_delete(app: AppHandle, id: String) -> Result<(), String> {
    fs::remove_file(path(&app, &id)?).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn history_clear(app: AppHandle) -> Result<(), String> {
    let d = dir(&app)?;
    fs::remove_dir_all(&d).map_err(|e| e.to_string())?;
    fs::create_dir_all(&d).map_err(|e| e.to_string())
}

/// For the "open folder" button — the frontend hands it to the opener plugin.
#[tauri::command]
pub fn history_dir(app: AppHandle) -> Result<String, String> {
    Ok(dir(&app)?.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_that_could_escape_the_history_folder_are_refused() {
        assert!(slug_ok("2026-09-16T14-03-22-123Z"));
        assert!(!slug_ok(""));
        assert!(!slug_ok(".."));
        assert!(!slug_ok("../../settings"));
        assert!(!slug_ok("a/b"));
        assert!(!slug_ok("a\\b"));
        assert!(!slug_ok("a.jsonl"));
        assert!(!slug_ok(&"x".repeat(65)));
    }

    /// Files written before these payloads were typed must keep opening, and new lines must
    /// keep looking like the old ones — same keys, same order, one format either way.
    #[test]
    fn lines_survive_the_round_trip_in_the_shape_already_on_disk() {
        let meta = r#"{"v":1,"at":1758153802123,"source":"auto","target":"en","model":"qwen3-livetranslate-flash-realtime","kind":"device"}"#;
        let m: Meta = serde_json::from_str(meta).unwrap();
        assert_eq!(m.target, "en");
        assert_eq!(serde_json::to_string(&m).unwrap(), meta);

        let entry = r#"{"at":1758153806000,"source":"你好","target":"Hello"}"#;
        let e: Entry = serde_json::from_str(entry).unwrap();
        assert_eq!(e.source, "你好");
        assert_eq!(serde_json::to_string(&e).unwrap(), entry);
    }
}
