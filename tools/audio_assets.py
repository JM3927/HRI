#!/usr/bin/env python3
"""
audio_assets.py — Recording script export and media verification.

The dialogue tree lives in static/js/task.js between the markers
/* BEGIN_DIALOGUE_TREE */ and /* END_DIALOGUE_TREE */ as strict JSON. This tool
reads it from there, so the recording script and the experiment can never
disagree.

Usage (from the project root):

    python tools/audio_assets.py script            # writes audio_script.csv
    python tools/audio_assets.py script -o out.csv
    python tools/audio_assets.py check             # verifies all 3 conditions
    python tools/audio_assets.py check --condition furhat
    python tools/audio_assets.py check --media video   # ignore task.js, check videos

Each condition is checked for the media type set in CONDITIONS in task.js:
'audio' → static/audio/<condition>/<clip>.mp3, 'video' →
static/video/<condition>/<clip>.mp4 plus the idle loop idle.mp4.

`check` exits with status 1 if any file is missing or empty, so it can gate a
deployment.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TASK_JS = ROOT / "static" / "js" / "task.js"
AUDIO_DIR = ROOT / "static" / "audio"
VIDEO_DIR = ROOT / "static" / "video"
CONDITION_KEYS = ("human", "furhat", "peerbot")   # must match CONDITIONS in task.js / custom.py
AUDIO_EXT = ".mp3"                                # must match CONFIG.audioExt in task.js
VIDEO_EXT = ".mp4"                                # must match CONFIG.videoExt in task.js
IDLE_CLIP_ID = "idle"                             # must match CONFIG.idleClipId in task.js
IDLE_DIRECTION = ("(no speech) 10-20 s of attentive, neutral listening; "
                  "start and end in the same pose so it loops without a jump")

_TREE_RE = re.compile(r"/\*\s*BEGIN_DIALOGUE_TREE\s*\*/(.*?)/\*\s*END_DIALOGUE_TREE\s*\*/", re.S)
_COND_RE = re.compile(r"key:\s*'(\w+)'[^}]*?media:\s*'(\w+)'")


def load_tree(path: Path = TASK_JS) -> list:
    match = _TREE_RE.search(path.read_text(encoding="utf-8"))
    if not match:
        sys.exit(f"Dialogue tree markers not found in {path}")
    try:
        return json.loads(match.group(1))
    except json.JSONDecodeError as exc:
        sys.exit(f"Dialogue tree in {path} is not valid JSON: {exc}")


def media_modes(path: Path = TASK_JS) -> dict[str, str]:
    """Condition key → 'audio' | 'video', read from CONDITIONS in task.js (default 'audio')."""
    found = dict(_COND_RE.findall(path.read_text(encoding="utf-8")))
    return {c: found.get(c, "audio") for c in CONDITION_KEYS}


def media_path(cond: str, clip_id: str, media: str) -> Path:
    if media == "video":
        return VIDEO_DIR / cond / f"{clip_id}{VIDEO_EXT}"
    return AUDIO_DIR / cond / f"{clip_id}{AUDIO_EXT}"


def clips(tree: list) -> list[dict]:
    """One row per spoken clip, in script order."""
    rows = []
    for node in tree:
        rows.append({
            "clip_id": node["audio"], "kind": "prompt", "node_id": node["id"],
            "stage": node["stage"], "option_index": "", "option_text": "",
            "transcript": node["prompt"],
        })
        for i, opt in enumerate(node["options"]):
            rows.append({
                "clip_id": opt["responseAudio"], "kind": "response", "node_id": node["id"],
                "stage": node["stage"], "option_index": i, "option_text": opt["text"],
                "transcript": opt["responseTranscript"],
            })
    return rows


def idle_row() -> dict:
    """The silent listening loop needed by conditions in video mode."""
    return {"clip_id": IDLE_CLIP_ID, "kind": "idle_loop", "node_id": "", "stage": "",
            "option_index": "", "option_text": "", "transcript": IDLE_DIRECTION}


def cmd_script(args) -> int:
    rows = clips(load_tree())
    modes = media_modes()
    out = Path(args.output)
    with out.open("w", newline="", encoding="utf-8-sig") as fh:
        fields = ["clip_id", "kind", "node_id", "stage", "option_index", "option_text", "transcript"] + \
                 [f"file_{c}" for c in CONDITION_KEYS]
        writer = csv.DictWriter(fh, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            for c in CONDITION_KEYS:
                row[f"file_{c}"] = media_path(c, row["clip_id"], modes[c]).relative_to(ROOT).as_posix()
            writer.writerow(row)
        if "video" in modes.values():
            row = idle_row()
            for c in CONDITION_KEYS:
                row[f"file_{c}"] = (media_path(c, IDLE_CLIP_ID, "video").relative_to(ROOT).as_posix()
                                    if modes[c] == "video" else "")
            writer.writerow(row)
    words = sum(len(r["transcript"].split()) for r in rows)
    print(f"Wrote {len(rows)} clips ({words} words, ~{words / 150:.1f} min of speech per voice) to {out}")
    return 0


def cmd_check(args) -> int:
    rows = clips(load_tree())
    modes = media_modes()
    conditions = [args.condition] if args.condition else list(CONDITION_KEYS)
    problems = 0
    for cond in conditions:
        media = args.media or modes[cond]
        clip_ids = [r["clip_id"] for r in rows] + ([IDLE_CLIP_ID] if media == "video" else [])
        missing, empty = [], []
        for clip_id in clip_ids:
            path = media_path(cond, clip_id, media)
            if not path.is_file():
                missing.append(path)
            elif path.stat().st_size == 0:
                empty.append(path)
        status = "OK" if not (missing or empty) else "INCOMPLETE"
        idle_note = f" (incl. {IDLE_CLIP_ID}{VIDEO_EXT})" if media == "video" else ""
        print(f"[{status}] {cond} ({media}): {len(clip_ids) - len(missing) - len(empty)}/{len(clip_ids)} "
              f"files present{idle_note}")
        issues = [("missing", p) for p in missing] + [("empty  ", p) for p in empty]
        for label, p in issues[:args.limit]:
            print(f"    {label}  {p.relative_to(ROOT)}")
        if len(issues) > args.limit:
            print(f"    … and {len(issues) - args.limit} more (use --limit to show more)")
        problems += len(missing) + len(empty)
    return 1 if problems else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    p_script = sub.add_parser("script", help="export the recording script as CSV")
    p_script.add_argument("-o", "--output", default=str(ROOT / "audio_script.csv"))
    p_script.set_defaults(func=cmd_script)
    p_check = sub.add_parser("check", help="verify that every clip exists for each condition")
    p_check.add_argument("--condition", choices=CONDITION_KEYS)
    p_check.add_argument("--media", choices=("audio", "video"),
                         help="check this media type instead of the one set in task.js")
    p_check.add_argument("--limit", type=int, default=8, help="max problems listed per condition")
    p_check.set_defaults(func=cmd_check)
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
