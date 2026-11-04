#!/usr/bin/env python3
"""
record_takes.py — Record the video clips for one condition, one take at a time.

It walks through every clip in the dialogue tree (plus the silent idle loop),
starts and stops OBS Studio for each take, and files the result as
static/video/<condition>/<clip_id>.mp4, the names task.js expects in video mode.

Two ways to perform a take:

  --backend furhat   The script drives the Furhat SDK's virtual robot through
                     the Remote API: it faces the camera, makes a gesture and
                     speaks the line with Furhat's TTS. Fully hands-off.
  --backend manual   For anything the script cannot drive (the Peerbot, the
                     human actor): it shows each line like a teleprompter and
                     you press Enter when the take is done.

Usage (from the project root):

    python tools/record_takes.py --condition furhat --backend furhat
    python tools/record_takes.py --condition peerbot --backend manual
    python tools/record_takes.py --condition furhat --backend furhat --only n1_opening,idle
    python tools/record_takes.py --condition furhat --backend furhat --dry-run

Requirements:
    pip install obsws-python furhat-remote-api
    OBS Studio 28+ with Tools → WebSocket Server Settings → Enable WebSocket server
    ffmpeg on PATH (converts OBS output to web-ready MP4 and evens out loudness)
    Furhat backend: the virtual robot running with its Remote API skill (port 54321)

Every raw recording is kept under recordings/<condition>/ (one file per take,
timestamped), so nothing is lost if you redo a take or want to re-edit later.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import audio_assets as assets  # noqa: E402  (shares the dialogue-tree parser and file layout)

ROOT = assets.ROOT
RAW_DIR = ROOT / "recordings"


@dataclass
class Take:
    clip_id: str
    kind: str          # 'prompt' | 'response' | 'idle_loop'
    transcript: str

    @property
    def is_idle(self) -> bool:
        return self.kind == "idle_loop"


# ----------------------------------------------------------------------------- recorders

class ObsRecorder:
    """Starts/stops OBS recording over obs-websocket v5 (built into OBS 28+)."""

    def __init__(self, host: str, port: int, password: str):
        try:
            import obsws_python as obs
        except ImportError:
            sys.exit("obsws-python is not installed: pip install obsws-python")
        try:
            self.client = obs.ReqClient(host=host, port=port, password=password, timeout=5)
        except Exception as exc:  # connection refused, auth failure, ...
            sys.exit(f"Could not connect to OBS at {host}:{port} ({exc}).\n"
                     "In OBS: Tools → WebSocket Server Settings → Enable WebSocket server, "
                     "then pass --obs-password if authentication is on.")
        if self.client.get_record_status().output_active:
            sys.exit("OBS is already recording. Stop that recording first.")

    def start(self) -> None:
        self.client.start_record()
        deadline = time.monotonic() + 5
        while not self.client.get_record_status().output_active:
            if time.monotonic() > deadline:
                raise RuntimeError("OBS did not start recording within 5 s")
            time.sleep(0.05)

    def stop(self) -> Path:
        return Path(self.client.stop_record().output_path)

    def abort(self) -> None:
        try:
            if self.client.get_record_status().output_active:
                self.client.stop_record()
        except Exception:
            pass


class DryRunRecorder:
    """Prints what would happen; touches no files."""

    def start(self) -> None:
        print("    [dry run] OBS: start recording")

    def stop(self) -> None:
        print("    [dry run] OBS: stop recording")
        return None

    def abort(self) -> None:
        pass


# ----------------------------------------------------------------------------- performers

class FurhatBackend:
    """Drives the Furhat (virtual) robot through the Remote API."""

    def __init__(self, args):
        self.args = args
        self.gestures = {"prompt": args.prompt_gesture or None, "response": args.response_gesture or None}
        if args.dry_run:
            self.robot = None
            return
        try:
            from furhat_remote_api import FurhatRemoteAPI
        except ImportError:
            sys.exit("furhat-remote-api is not installed: pip install furhat-remote-api")
        self.robot = FurhatRemoteAPI(args.furhat_host)

    def setup(self) -> None:
        if self.robot is None:
            print(f"[dry run] Furhat at {self.args.furhat_host}: voice={self.args.voice or '(current)'}, "
                  f"gaze={self.args.gaze}, gestures={self.gestures}")
            return
        try:
            available = {g.name for g in self.robot.get_gestures()}
        except Exception as exc:
            sys.exit(f"Could not reach the Furhat Remote API at {self.args.furhat_host}:54321 ({exc}).\n"
                     "Start the virtual robot from the Furhat SDK and launch its Remote API skill.")
        for kind, name in list(self.gestures.items()):
            if name and name not in available:
                print(f"Warning: Furhat has no gesture '{name}' (for {kind}s); it will be skipped.\n"
                      f"  Available: {', '.join(sorted(available))}")
                self.gestures[kind] = None
        if self.args.voice:
            self.robot.set_voice(name=self.args.voice)
        self.robot.attend(location=self.args.gaze)

    def perform(self, take: Take) -> None:
        if self.robot is None:
            print(f"    [dry run] Furhat: {'hold idle' if take.is_idle else 'say the line'}")
            return
        self.robot.attend(location=self.args.gaze)   # look into the camera on every take
        if take.is_idle:
            countdown(self.args.idle_seconds, "idle")
            return
        gesture = self.gestures.get(take.kind)
        if gesture:
            self.robot.gesture(name=gesture)          # non-blocking: overlaps the start of speech
        self.robot.say(text=take.transcript, blocking=True)


class ManualBackend:
    """Teleprompter mode: a person performs or triggers each take."""

    def __init__(self, args):
        self.args = args

    def setup(self) -> None:
        print("Manual mode: for each take, wait for ● REC, perform the line (or trigger the robot),\n"
              "hold still for a moment, then press Enter.\n")

    def perform(self, take: Take) -> None:
        if take.is_idle:
            print("    Hold a calm, attentive, neutral pose. Recording stops by itself.")
            countdown(self.args.idle_seconds, "idle")
            return
        print("\n" + wrap(take.transcript) + "\n")
        if not self.args.dry_run:
            input("    Press Enter when the take is finished… ")


BACKENDS = {"furhat": FurhatBackend, "manual": ManualBackend}


# ----------------------------------------------------------------------------- helpers

def wrap(text: str, width: int = 72, indent: str = "    │ ") -> str:
    words, lines, line = text.split(), [], ""
    for w in words:
        if len(line) + len(w) + 1 > width:
            lines.append(line)
            line = w
        else:
            line = f"{line} {w}".strip()
    lines.append(line)
    return "\n".join(indent + ln for ln in lines)


def countdown(seconds: float, label: str) -> None:
    end = time.monotonic() + seconds
    while (left := end - time.monotonic()) > 0:
        print(f"\r    {label}: {left:4.1f} s ", end="", flush=True)
        time.sleep(min(0.1, left))
    print(f"\r    {label}: done      ")


def wait_until_stable(path: Path, timeout: float = 15.0) -> None:
    """OBS finalises the file just after StopRecord returns; wait until its size settles."""
    deadline = time.monotonic() + timeout
    last = -1
    while time.monotonic() < deadline:
        size = path.stat().st_size if path.exists() else -1
        if size > 0 and size == last:
            return
        last = size
        time.sleep(0.5)
    if not path.exists():
        raise RuntimeError(f"OBS reported {path}, but the file does not exist "
                           "(is OBS running on another computer?)")


def open_file(path: Path) -> None:
    """Open a recording in the system's default player for review."""
    if sys.platform.startswith("win"):
        os.startfile(path)  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def export(raw: Path, dst: Path, take: Take, args) -> None:
    """Convert a raw OBS file to the web-ready MP4 the experiment loads."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg = args.ffmpeg or shutil.which("ffmpeg")
    if not ffmpeg:
        if raw.suffix.lower() != ".mp4":
            raise RuntimeError("ffmpeg not found and OBS did not record MP4. Install ffmpeg "
                               "(sudo apt install ffmpeg) or set OBS → Settings → Output → "
                               "Recording Format to MP4.")
        shutil.copy2(raw, dst)
        return
    cmd = [ffmpeg, "-y", "-loglevel", "error", "-i", str(raw),
           "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p"]
    if take.is_idle:
        cmd += ["-an"]                                   # the idle loop always plays muted
    else:
        cmd += ["-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2"]
        if not args.no_normalize:
            # Same target loudness for every clip and condition (EBU R128, -16 LUFS).
            cmd += ["-af", "loudnorm=I=-16:TP=-1.5:LRA=11"]
    cmd += ["-movflags", "+faststart", str(dst)]
    subprocess.run(cmd, check=True)


def plan(args) -> list[Take]:
    rows = assets.clips(assets.load_tree())
    takes = [Take("idle", "idle_loop", assets.IDLE_DIRECTION)] if not args.no_idle else []
    takes += [Take(r["clip_id"], r["kind"], r["transcript"]) for r in rows]
    if args.only:
        wanted = {s.strip() for s in args.only.split(",") if s.strip()}
        unknown = wanted - {t.clip_id for t in takes}
        if unknown:
            sys.exit(f"Unknown clip id(s): {', '.join(sorted(unknown))}")
        takes = [t for t in takes if t.clip_id in wanted]
    if args.skip_existing:
        takes = [t for t in takes if not assets.media_path(args.condition, t.clip_id, "video").is_file()]
    return takes


# ----------------------------------------------------------------------------- main loop

def record_all(args, recorder, backend) -> int:
    takes = plan(args)
    if not takes:
        print("Nothing to record.")
        return 0
    print(f"{len(takes)} take(s) for '{args.condition}' → static/video/{args.condition}/\n")
    backend.setup()
    raw_dir = RAW_DIR / args.condition
    kept = 0

    for n, take in enumerate(takes, 1):
        dst = assets.media_path(args.condition, take.clip_id, "video")
        attempt = 0
        while True:
            attempt += 1
            label = "idle loop" if take.is_idle else take.kind
            print(f"── [{n}/{len(takes)}] {take.clip_id} ({label}), take {attempt}")
            if args.backend == "manual" and not args.dry_run:
                input("    Press Enter to start recording… ")

            recorder.start()
            print("    ● REC")
            try:
                time.sleep(args.preroll)
                backend.perform(take)
                time.sleep(args.postroll)
            finally:
                raw = recorder.stop()

            if raw is None:            # dry run
                break
            wait_until_stable(raw)
            raw_dir.mkdir(parents=True, exist_ok=True)
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            kept_raw = raw_dir / f"{take.clip_id}__{stamp}_take{attempt}{raw.suffix}"
            shutil.move(str(raw), kept_raw)

            if args.auto:
                choice = ""
            else:
                choice = review(kept_raw)
            if choice == "r":
                continue
            if choice == "s":
                print("    skipped")
                break
            if choice == "q":
                print(f"Stopped. {kept} clip(s) exported.")
                return 0
            export(kept_raw, dst, take, args)
            kept += 1
            print(f"    saved {dst.relative_to(ROOT)}")
            break

    print(f"\nDone: {kept} clip(s) exported to static/video/{args.condition}/.")
    print(f"Check completeness with: python tools/audio_assets.py check --condition {args.condition} --media video")
    return 0


def review(raw: Path) -> str:
    while True:
        ans = input("    [Enter] keep · [p] play · [r] redo · [s] skip · [q] quit: ").strip().lower()
        if ans == "p":
            open_file(raw)
        elif ans in ("", "r", "s", "q"):
            return ans


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--condition", required=True, choices=assets.CONDITION_KEYS)
    parser.add_argument("--backend", required=True, choices=sorted(BACKENDS))
    parser.add_argument("--only", help="comma-separated clip ids to (re)record, e.g. n1_opening,idle")
    parser.add_argument("--skip-existing", action="store_true", help="skip clips that already have a video")
    parser.add_argument("--no-idle", action="store_true", help="do not record the idle loop")
    parser.add_argument("--auto", action="store_true", help="keep every take without asking")
    parser.add_argument("--dry-run", action="store_true", help="print the plan; no OBS, robot or files")
    parser.add_argument("--preroll", type=float, default=0.5, help="seconds recorded before the line (default 0.5)")
    parser.add_argument("--postroll", type=float, default=0.6, help="seconds recorded after the line (default 0.6)")
    parser.add_argument("--idle-seconds", type=float, default=15.0, help="length of the idle loop (default 15)")
    parser.add_argument("--obs-host", default="localhost")
    parser.add_argument("--obs-port", type=int, default=4455)
    parser.add_argument("--obs-password", default=os.environ.get("OBS_WS_PASSWORD", ""),
                        help="obs-websocket password (or set OBS_WS_PASSWORD)")
    parser.add_argument("--ffmpeg", help="path to ffmpeg if it is not on PATH")
    parser.add_argument("--no-normalize", action="store_true", help="skip loudness normalisation")
    furhat = parser.add_argument_group("furhat backend")
    furhat.add_argument("--furhat-host", default="localhost", help="where the Remote API runs (port 54321)")
    furhat.add_argument("--voice", help="Furhat voice name; default keeps the robot's current voice")
    furhat.add_argument("--gaze", default="0.0,0.0,1.0",
                        help="x,y,z point (metres) Furhat looks at; default is straight ahead into the camera")
    furhat.add_argument("--prompt-gesture", default="", help="gesture at the start of each question (default none)")
    furhat.add_argument("--response-gesture", default="Nod", help="gesture at the start of each reply (default Nod)")
    args = parser.parse_args()
    # Box-drawing characters and arrows must not crash a non-UTF-8 console (e.g. Windows cp1252).
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")

    recorder = DryRunRecorder() if args.dry_run else ObsRecorder(args.obs_host, args.obs_port, args.obs_password)
    backend = BACKENDS[args.backend](args)
    try:
        return record_all(args, recorder, backend)
    except KeyboardInterrupt:
        recorder.abort()
        print("\nInterrupted; OBS recording stopped. Exported clips are kept.")
        return 130


if __name__ == "__main__":
    sys.exit(main())
