#!/usr/bin/env python3
"""Luna voice window — on-screen replies + TTS for OBS window/app audio capture."""

from __future__ import annotations

import asyncio
import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import tkinter as tk
import tkinter.font as tkfont
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

try:
    import edge_tts
except ImportError:
    print("Missing edge-tts. Run: pip install edge-tts", file=sys.stderr)
    sys.exit(1)

DEFAULT_PORT = 8791
DEFAULT_VOICE = "en-US-AvaMultilingualNeural"
MAX_HISTORY = 8


def resolve_voice(raw: str) -> str:
    aliases = {
        "ava": DEFAULT_VOICE,
        "ava-multilingual": DEFAULT_VOICE,
        "ava-multolingual": DEFAULT_VOICE,
        "aria": "en-US-AriaNeural",
        "jenny": "en-US-JennyNeural",
        "sonia": "en-GB-SoniaNeural",
    }
    key = raw.strip().lower().replace(" ", "-")
    if "Neural" in raw or "-" in raw:
        return aliases.get(key, raw.strip())
    return aliases.get(key, raw.strip() or DEFAULT_VOICE)


def find_ffplay() -> str | None:
    return shutil.which("ffplay")


class VoiceWindow:
    def __init__(self) -> None:
        self.port = int(os.environ.get("MC_VOICE_WINDOW_PORT", str(DEFAULT_PORT)))
        self.voice = resolve_voice(os.environ.get("MC_TTS_VOICE", "ava-multilingual"))
        self.rate = (os.environ.get("MC_TTS_RATE") or "+0%").strip()
        self.pitch = (os.environ.get("MC_TTS_PITCH") or "+0Hz").strip()
        self.always_on_top = os.environ.get("MC_VOICE_WINDOW_TOPMOST", "true").lower() != "false"
        self.ffplay = find_ffplay()

        self.speak_queue: queue.Queue[str] = queue.Queue()
        self.history: list[str] = []
        self.speaking = False

        self.root = tk.Tk()
        self.root.title("Luna Voice")
        self.root.geometry("520x220")
        self.root.configure(bg="#1a1a2e")
        self.root.minsize(360, 160)
        if self.always_on_top:
            self.root.attributes("-topmost", True)

        self.status_var = tk.StringVar(value="Ready — capture this window in OBS")
        self.text_var = tk.StringVar(value="Waiting for Luna…")

        status_font = tkfont.Font(family="Segoe UI", size=10)
        text_font = tkfont.Font(family="Segoe UI", size=16, weight="bold")

        header = tk.Label(
            self.root,
            text="Luna",
            font=tkfont.Font(family="Segoe UI", size=11, weight="bold"),
            fg="#e94560",
            bg="#1a1a2e",
            anchor="w",
        )
        header.pack(fill="x", padx=14, pady=(12, 0))

        self.status_label = tk.Label(
            self.root,
            textvariable=self.status_var,
            font=status_font,
            fg="#a0a0b8",
            bg="#1a1a2e",
            anchor="w",
        )
        self.status_label.pack(fill="x", padx=14, pady=(2, 8))

        body = tk.Frame(self.root, bg="#16213e", highlightbackground="#0f3460", highlightthickness=1)
        body.pack(fill="both", expand=True, padx=14, pady=(0, 10))

        self.text_label = tk.Label(
            body,
            textvariable=self.text_var,
            font=text_font,
            fg="#f5f5f5",
            bg="#16213e",
            wraplength=480,
            justify="left",
            anchor="nw",
        )
        self.text_label.pack(fill="both", expand=True, padx=12, pady=12)

        footer = tk.Label(
            self.root,
            text=f"http://127.0.0.1:{self.port}/speak  |  voice: {self.voice.split('-')[-1]}",
            font=tkfont.Font(family="Consolas", size=8),
            fg="#666680",
            bg="#1a1a2e",
            anchor="w",
        )
        footer.pack(fill="x", padx=14, pady=(0, 10))

        if not self.ffplay:
            self.status_var.set("Warning: ffplay not found — text only (install ffmpeg)")

        self.root.after(100, self._poll_speak_queue)
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)
        self._shutdown = threading.Event()

    def _on_close(self) -> None:
        self._shutdown.set()
        self.root.destroy()

    def enqueue_speak(self, text: str) -> None:
        cleaned = " ".join(text.split()).strip()
        if cleaned:
            self.speak_queue.put(cleaned)

    def _poll_speak_queue(self) -> None:
        if self._shutdown.is_set():
            return
        try:
            while True:
                text = self.speak_queue.get_nowait()
                if not self.speaking:
                    threading.Thread(target=self._speak_worker, args=(text,), daemon=True).start()
        except queue.Empty:
            pass
        self.root.after(80, self._poll_speak_queue)

    def _set_ui(self, status: str, text: str | None = None) -> None:
        def apply() -> None:
            self.status_var.set(status)
            if text is not None:
                self.text_var.set(text)
                self.text_label.configure(wraplength=max(280, self.root.winfo_width() - 56))

        self.root.after(0, apply)

    def _speak_worker(self, text: str) -> None:
        if self.speaking:
            self.enqueue_speak(text)
            return
        self.speaking = True
        self._set_ui("Speaking…", text)
        try:
            asyncio.run(self._synthesize_and_play(text))
            self.history.append(text)
            if len(self.history) > MAX_HISTORY:
                self.history.pop(0)
            self._set_ui("Ready")
        except Exception as exc:  # noqa: BLE001
            self._set_ui(f"Error: {exc}")
        finally:
            self.speaking = False

    async def _synthesize_and_play(self, text: str) -> None:
        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
            path = tmp.name
        try:
            communicate = edge_tts.Communicate(text, self.voice, rate=self.rate, pitch=self.pitch)
            await communicate.save(path)
            if self.ffplay:
                proc = subprocess.Popen(
                    [self.ffplay, "-nodisp", "-autoexit", "-loglevel", "quiet", path],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                proc.wait()
            else:
                self._set_ui("Speaking (no audio player)…", text)
        finally:
            try:
                Path(path).unlink(missing_ok=True)
            except OSError:
                pass

    def start_http(self) -> None:
        window = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, fmt: str, *args: Any) -> None:  # noqa: ANN401
                return

            def _json(self, code: int, payload: dict[str, Any]) -> None:
                body = json.dumps(payload).encode("utf-8")
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self) -> None:
                path = urlparse(self.path).path
                if path in ("/health", "/"):
                    self._json(200, {"ok": True, "speaking": window.speaking})
                    return
                self._json(404, {"ok": False, "error": "not found"})

            def do_POST(self) -> None:
                path = urlparse(self.path).path
                if path != "/speak":
                    self._json(404, {"ok": False, "error": "not found"})
                    return
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length) if length else b"{}"
                try:
                    data = json.loads(raw.decode("utf-8"))
                except json.JSONDecodeError:
                    self._json(400, {"ok": False, "error": "invalid json"})
                    return
                text = str(data.get("text", "")).strip()
                if not text:
                    self._json(400, {"ok": False, "error": "missing text"})
                    return
                window.enqueue_speak(text)
                self._json(200, {"ok": True, "queued": True})

        server = ThreadingHTTPServer(("127.0.0.1", self.port), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        print(f"[luna-voice-window] listening on http://127.0.0.1:{self.port}/speak")

    def run(self) -> None:
        self.start_http()
        print("[luna-voice-window] Open OBS -> Window Capture -> 'Luna Voice'")
        print("[luna-voice-window] Audio -> Application Audio Capture -> python.exe")
        self.root.mainloop()


def main() -> None:
    # Windows console may be cp1252 — avoid UnicodeEncodeError on log lines.
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")
        except OSError:
            pass
    VoiceWindow().run()


if __name__ == "__main__":
    main()
