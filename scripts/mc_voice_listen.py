#!/usr/bin/env python3
"""Microphone listener with faster-whisper. VAD or push-to-talk (default: hold V)."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import time
from pathlib import Path

import numpy as np
import sounddevice as sd
import soundfile as sf

_model = None
_paused = threading.Event()
_shutdown = threading.Event()
_input_lock = threading.Lock()


def _emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _ptt_mode() -> bool:
    return (os.environ.get("MC_STT_MODE") or "ptt").strip().lower() != "vad"


def _ptt_key() -> str:
    return (os.environ.get("MC_STT_PTT_KEY") or "v").strip().lower() or "v"


def _resolve_device() -> str:
    explicit = (os.environ.get("MC_STT_DEVICE") or "").strip()
    if explicit:
        return explicit
    try:
        import ctranslate2

        if ctranslate2.get_cuda_device_count() > 0:
            return "cuda"
    except Exception:
        pass
    return "cpu"


def _resolve_compute(device: str) -> str:
    explicit = (os.environ.get("MC_STT_COMPUTE") or "").strip()
    if explicit:
        return explicit
    return "float16" if device == "cuda" else "int8"


def _model_name() -> str:
    return (os.environ.get("MC_STT_MODEL") or "tiny").strip() or "tiny"


def _language() -> str | None:
    raw = (os.environ.get("MC_STT_LANGUAGE") or "en").strip().lower()
    if raw in ("", "auto", "detect"):
        return None
    return raw


def _ensure_model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel

        device = _resolve_device()
        cpu_threads = int((os.environ.get("MC_STT_CPU_THREADS") or "4").strip() or "4")
        kwargs = {
            "device": device,
            "compute_type": _resolve_compute(device),
        }
        if device == "cpu":
            kwargs["cpu_threads"] = max(1, cpu_threads)
        _model = WhisperModel(_model_name(), **kwargs)
    return _model


def _transcribe_audio(audio: np.ndarray, sample_rate: int = 16000) -> str:
    model = _ensure_model()
    beam = max(1, int((os.environ.get("MC_STT_BEAM_SIZE") or "1").strip() or "1"))
    use_vad = (os.environ.get("MC_STT_VAD_FILTER") or "").strip().lower() == "true"
    if not os.environ.get("MC_STT_VAD_FILTER") and _ptt_mode():
        use_vad = False
    data = audio.astype(np.float32)
    if data.ndim > 1:
        data = data.mean(axis=1)
    segments, _ = model.transcribe(
        data,
        vad_filter=use_vad,
        language=_language(),
        beam_size=beam,
        condition_on_previous_text=False,
        temperature=0.0,
        best_of=1,
    )
    parts = [s.text.strip() for s in segments if s.text and s.text.strip()]
    return " ".join(parts).strip()


def _transcribe_wav(path: Path) -> str:
    data, sr = sf.read(str(path), dtype="float32", always_2d=False)
    if isinstance(data, np.ndarray) and sr != 16000:
        ratio = 16000 / float(sr)
        idx = (np.arange(int(len(data) * ratio)) / ratio).astype(np.int64)
        idx = np.clip(idx, 0, len(data) - 1)
        data = data[idx]
    return _transcribe_audio(np.asarray(data, dtype=np.float32))


def _stdin_thread() -> None:
    for line in sys.stdin:
        if _shutdown.is_set():
            break
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        cmd = str(msg.get("cmd") or "").strip().lower()
        if cmd == "pause":
            _paused.set()
        elif cmd == "resume":
            _paused.clear()
        elif cmd == "shutdown":
            _shutdown.set()
            break


def _emit_transcript_from_buffer(buf: list[np.ndarray], sample_rate: int, min_ms: int) -> None:
    if not buf:
        return
    audio = np.concatenate(buf)
    if audio.size < sample_rate * (min_ms / 1000.0):
        return
    try:
        text = _transcribe_audio(audio, sample_rate)
        if text:
            _emit({"type": "transcript", "text": text})
    except Exception as exc:
        _emit({"type": "error", "message": str(exc)})


def _ptt_loop() -> None:
    import keyboard

    sample_rate = 16000
    block = int(os.environ.get("MC_STT_BLOCK_MS", "100") or "100")
    block_samples = max(256, int(sample_rate * block / 1000))
    min_ms = max(150, int(os.environ.get("MC_STT_MIN_SPEECH_MS", "200") or 200))
    device = (os.environ.get("MC_STT_INPUT_DEVICE") or "").strip()
    device_arg: int | str | None = int(device) if device.isdigit() else (device or None)
    key = _ptt_key()

    recording: list[np.ndarray] = []
    ptt_active = threading.Event()

    def on_press(_event) -> None:
        if _paused.is_set() or _shutdown.is_set():
            return
        # Windows key-repeat fires many press events while V is held — ignore repeats.
        if ptt_active.is_set():
            return
        with _input_lock:
            recording.clear()
        ptt_active.set()
        _emit({"type": "ptt", "state": "down"})

    def on_release(_event) -> None:
        if not ptt_active.is_set():
            return
        ptt_active.clear()
        _emit({"type": "ptt", "state": "up"})
        with _input_lock:
            buf = recording.copy()
            recording.clear()

        def transcribe_async() -> None:
            try:
                _emit_transcript_from_buffer(buf, sample_rate, min_ms)
            except Exception as exc:
                _emit({"type": "error", "message": str(exc)})

        threading.Thread(target=transcribe_async, daemon=True).start()

    keyboard.on_press_key(key, on_press, suppress=False)
    keyboard.on_release_key(key, on_release, suppress=False)

    def callback(indata, _frames, _time_info, status) -> None:
        if status:
            _emit({"type": "warn", "message": str(status)})
        if not ptt_active.is_set() or _paused.is_set() or _shutdown.is_set():
            return
        mono = indata[:, 0].copy() if indata.ndim > 1 else indata.copy()
        with _input_lock:
            recording.append(mono)

    try:
        _ensure_model()
    except Exception as exc:
        _emit({"type": "error", "message": f"Whisper load failed: {exc}"})
        _shutdown.set()
        return

    _emit(
        {
            "type": "ready",
            "model": _model_name(),
            "device": _resolve_device(),
            "mode": "ptt",
            "ptt_key": key,
        }
    )

    with sd.InputStream(
        samplerate=sample_rate,
        channels=1,
        dtype="float32",
        blocksize=block_samples,
        device=device_arg,
        callback=callback,
    ):
        while not _shutdown.is_set():
            time.sleep(0.05)


def _vad_loop() -> None:
    sample_rate = 16000
    block = int(os.environ.get("MC_STT_BLOCK_MS", "100") or "100")
    block_samples = max(256, int(sample_rate * block / 1000))
    silence_ms = max(400, int(os.environ.get("MC_STT_SILENCE_MS", "1500") or 1500))
    threshold = float(os.environ.get("MC_STT_SPEECH_THRESHOLD", "0.012") or 0.012)
    min_speech_ms = max(200, int(os.environ.get("MC_STT_MIN_SPEECH_MS", "300") or 300))
    device = (os.environ.get("MC_STT_INPUT_DEVICE") or "").strip()
    device_arg: int | str | None = int(device) if device.isdigit() else (device or None)

    recording: list[np.ndarray] = []
    had_speech = False
    last_sound = 0.0
    speech_started = 0.0

    def callback(indata, _frames, _time_info, status) -> None:
        nonlocal had_speech, last_sound, speech_started, recording
        if status:
            _emit({"type": "warn", "message": str(status)})
        if _paused.is_set() or _shutdown.is_set():
            return
        mono = indata[:, 0].copy() if indata.ndim > 1 else indata.copy()
        rms = float(np.sqrt(np.mean(mono * mono)))
        now = time.monotonic()
        with _input_lock:
            if rms >= threshold:
                if not had_speech:
                    speech_started = now
                had_speech = True
                last_sound = now
                recording.append(mono)
            elif had_speech:
                recording.append(mono)
                if (now - last_sound) * 1000 >= silence_ms:
                    _flush(recording, had_speech, speech_started, now)
                    recording = []
                    had_speech = False

    def _flush(buf: list[np.ndarray], spoke: bool, started: float, ended: float) -> None:
        if not spoke:
            return
        if (ended - started) * 1000 < min_speech_ms:
            return
        _emit_transcript_from_buffer(buf, sample_rate, int(min_speech_ms * 0.8))

    try:
        _ensure_model()
    except Exception as exc:
        _emit({"type": "error", "message": f"Whisper load failed: {exc}"})
        _shutdown.set()
        return

    _emit({"type": "ready", "model": _model_name(), "device": _resolve_device(), "mode": "vad"})

    with sd.InputStream(
        samplerate=sample_rate,
        channels=1,
        dtype="float32",
        blocksize=block_samples,
        device=device_arg,
        callback=callback,
    ):
        while not _shutdown.is_set():
            time.sleep(0.05)


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    threading.Thread(target=_stdin_thread, daemon=True).start()
    try:
        if _ptt_mode():
            _ptt_loop()
        else:
            _vad_loop()
    except KeyboardInterrupt:
        pass
    finally:
        _shutdown.set()
        _emit({"type": "stopped"})


if __name__ == "__main__":
    main()
