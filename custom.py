"""
custom.py — psiTurk custom code for the Therapist Embodiment Study.

psiTurk imports `custom_code` from this file and registers it as a Flask
Blueprint. Everything study-specific lives here; config.txt is not modified.

Participant flow
----------------
    /consent ─Agree─▶ /pretest ──▶ /briefing ─▶ /avcheck ─▶ /exp ──▶ /posttest ──▶ /complete
       │                │                                   │          │             │
       │      POST /api/save_pretest                        │  POST /api/save_posttest
       │                                                    │
       │                                  POST /api/save_trial (one per dialogue node)
       ▼
    Decline → nothing is stored

/pretest ("About you": demographics first, then the baseline scales) comes
straight after consent. /briefing is the study information (what the study is
about, the counselors, what will happen, what is recorded, how to stop); it
stores nothing and opens only once the pre-test is saved. /avcheck is the video
and sound check (a test clip the participant must play and confirm). /exp
opens only with briefed=1&avchecked=1 in the link, so neither can be skipped.

How the built-in psiTurk routes are handled
-------------------------------------------
psiTurk already defines `/consent`, `/exp` and `/complete` on the app. Flask
will not let a Blueprint replace an app route with the same URL, and the
order in which psiTurk registers routes vs. this Blueprint differs between
releases. To stay version-independent, those three URLs are handled by a
`before_app_request` hook (`protocol_router`), which runs before *any* view:

  /consent   fully handled here (renders templates/consent.html).
  /exp       gated here (pre-test must exist and the briefing and the video
             and sound check must have been passed; finished sessions are
             forwarded), then handed to
             psiTurk's own view so that psiTurk
             still creates the Participant row and assigns the condition
             (counterbalanced across `num_conds`).
  /complete  fully handled here: requires the post-test, marks the psiTurk
             Participant COMPLETED, renders templates/complete.html.

`/briefing`, `/avcheck`, `/pretest`, `/posttest`, the `/api/*` endpoints and
the researcher-only `/lab` pages are ordinary Blueprint routes.

Required config.txt values (read, never written)
------------------------------------------------
[Task Parameters]   num_conds = 3     (0 = human, 1 = furhat, 2 = peerbot)
                    num_counters = 1
"""

from __future__ import annotations

import csv
import hashlib
import hmac
import io
import logging
import re
import secrets
from datetime import datetime, timezone
from functools import wraps
from typing import Callable, Dict, Optional
from urllib.parse import urlencode

from flask import (Blueprint, Response, jsonify, make_response, redirect,
                   render_template, request)
from sqlalchemy import inspect as sa_inspect
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from psiturk.db import db_session, engine, init_db
from psiturk.models import Participant
from psiturk.psiturk_config import PsiturkConfig

try:  # psiTurk ships a no-cache decorator; fall back to an equivalent one.
    from psiturk.user_utils import nocache
except ImportError:  # pragma: no cover - depends on psiTurk version
    def nocache(view):
        @wraps(view)
        def _wrapped(*args, **kwargs):
            return _no_store(make_response(view(*args, **kwargs)))
        return _wrapped

import instruments as inst
from models import BranchingTrialLog, PostTestSurvey, PreTestSurvey

logger = logging.getLogger("therapist_embodiment")

# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #

config = PsiturkConfig()
config.load_config()

#: Shown on the consent form, debrief and page headers. Edit for your IRB.
STUDY_INFO = {
    "title": "Conversations with Different Kinds of Counselors",
    "short_title": "Counselor Conversation Study",
    "institution": "Purdue University Northwest",
    "pi_name": "Principal Investigator Justin Meng",
    "contact_email": "meng172@pnw.edu",
    "duration_minutes": 20,
    "crisis_line": "988",               # US Suicide & Crisis Lifeline (call or text)
    "crisis_text": "Text HOME to 741741",  # Crisis Text Line (US)
}

CONSENT_VERSION = "v1.0"

#: psiTurk condition index → stable label used in the database and front end.
CONDITIONS: Dict[int, str] = {0: "human", 1: "furhat", 2: "peerbot"}

#: psiTurk participant status codes (psiturk/experiment.py).
STATUS_STARTED = 2
STATUS_COMPLETED = 3
#: Statuses that must not be overwritten when the participant finishes
#: (COMPLETED, SUBMITTED, CREDITED, BONUSED). QUITEARLY (6) *is* overwritten:
#: psiTurk sets it on any beforeunload, even one the participant cancelled.
STATUS_FINAL = {3, 4, 5, 7}

ALLOWED_MODES = {"debug", "sandbox", "live"}
_ID_RE = re.compile(r"^[A-Za-z0-9_.\-]{1,64}$")

#: Upper bound on a single choice latency we accept (1 hour, in ms).
MAX_LATENCY_MS = 3_600_000
MAX_TRIALS_PER_RUN = 20


def _config_value(section: str, option: str, getter: str = "get", fallback=None):
    """Read config.txt defensively (psiTurk versions differ in defaults)."""
    try:
        return getattr(config, getter)(section, option, fallback=fallback)
    except Exception:  # noqa: BLE001 - any parse error → fallback
        return fallback


def _startup_checks() -> None:
    """Fail loudly on configuration that would silently corrupt the design."""
    num_conds = _config_value("Task Parameters", "num_conds", "getint")
    if num_conds != len(CONDITIONS):
        logger.error(
            "config.txt [Task Parameters] num_conds = %s, but this study has %d "
            "conditions (human, furhat, peerbot). Set num_conds = 3 or the "
            "between-subjects assignment will be wrong.", num_conds, len(CONDITIONS))

    # Every questionnaire item must have a matching database column.
    ids = inst.all_item_ids()
    for model, key in ((PreTestSurvey, "pretest"), (PostTestSurvey, "posttest")):
        missing = [c for c in ids[key] if c not in model.__table__.columns]
        if missing:
            raise RuntimeError(f"{model.__name__} is missing columns for items: {missing}")

    # create_all() never alters an existing table, so a database made by an
    # earlier version of the questionnaires would reject every save. Stop now
    # with instructions instead.
    db_columns = sa_inspect(engine)
    move_aside = ("Stop the server, move participants.db aside (e.g. mv participants.db "
                  "participants_old.db) so a fresh one is created, and start again.")
    for model in (PreTestSurvey, BranchingTrialLog, PostTestSurvey):
        table = model.__tablename__
        db_cols = db_columns.get_columns(table)
        existing = {c["name"] for c in db_cols}
        stale = sorted(set(model.__table__.columns.keys()) - existing)
        if stale:
            raise RuntimeError(
                f"The database table '{table}' was created by an older version of this study and lacks "
                f"{len(stale)} column(s) (e.g. {', '.join(stale[:5])}). " + move_aside)
        # A required column that the study no longer fills (e.g. a removed
        # question) would make every save fail, so stop now instead.
        removed = sorted(c["name"] for c in db_cols
                         if c["name"] not in model.__table__.columns
                         and not c.get("nullable", True) and c.get("default") is None)
        if removed:
            raise RuntimeError(
                f"The database table '{table}' was created by an older version of this study and has "
                f"required column(s) for questions that were removed ({', '.join(removed)}). " + move_aside)


# Create the custom tables (psiTurk's init_db() calls Base.metadata.create_all,
# which now includes the models imported above).
init_db()
_startup_checks()

ALLOW_REPEATS = bool(_config_value("Task Parameters", "allow_repeats", "getboolean", False))

custom_code = Blueprint("custom_code", __name__,
                        template_folder="templates", static_folder="static")


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def _no_store(resp: Response) -> Response:
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    resp.headers["Pragma"] = "no-cache"
    resp.headers["Expires"] = "0"
    return resp


def _url(path: str, **params) -> str:
    return f"{path}?{urlencode(params)}" if params else path


def _parse_ids(source) -> Optional[Dict[str, str]]:
    """Extract and validate psiTurk's hitId / assignmentId / workerId / mode."""
    ids = {k: str(source.get(k, "")).strip()
           for k in ("hitId", "assignmentId", "workerId", "mode")}
    if ids["mode"] not in ALLOWED_MODES:
        return None
    if not all(_ID_RE.match(ids[k]) for k in ("hitId", "assignmentId", "workerId")):
        return None
    return ids


def _uid(ids: Dict[str, str]) -> str:
    """psiTurk's uniqueId convention."""
    return f"{ids['workerId']}:{ids['assignmentId']}"


def _participant(uniqueid: Optional[str]) -> Optional[Participant]:
    if not uniqueid:
        return None
    return Participant.query.filter(Participant.uniqueid == uniqueid).first()


def _has_pretest(uid: str) -> bool:
    return db_session.query(PreTestSurvey.id).filter_by(uniqueid=uid).first() is not None


def _has_posttest(uid: str) -> bool:
    return db_session.query(PostTestSurvey.id).filter_by(uniqueid=uid).first() is not None


def _has_finished_dialogue(uid: str) -> bool:
    return (db_session.query(BranchingTrialLog.id)
            .filter_by(uniqueid=uid, is_terminal=True).first() is not None)


def _prior_participation(worker_id: str, assignment_id: str) -> bool:
    """True if this worker already took part under a different assignment."""
    if ALLOW_REPEATS:
        return False
    other_participant = (Participant.query
                         .filter(Participant.workerid == worker_id,
                                 Participant.assignmentid != assignment_id,
                                 Participant.mode != "debug")
                         .first())
    other_pretest = (PreTestSurvey.query
                     .filter(PreTestSurvey.workerid == worker_id,
                             PreTestSurvey.assignmentid != assignment_id,
                             PreTestSurvey.mode != "debug")
                     .first())
    return other_participant is not None or other_pretest is not None


def _fresh_practice_ids(ids: Dict[str, str]) -> Dict[str, str]:
    """New ids for a practice (debug) run whose link was already used.

    The same tag is appended to workerId and assignmentId (replacing an earlier
    tag), so psiTurk sees a brand-new participant and the earlier run's data is
    kept separately under its own uniqueid.
    """
    tag = "-r" + secrets.token_hex(3)

    def retag(value: str) -> str:
        return re.sub(r"-r[0-9a-f]{6}$", "", value)[:64 - len(tag)] + tag

    return dict(ids, workerId=retag(ids["workerId"]), assignmentId=retag(ids["assignmentId"]))


def _message(title: str, body: str, status: int = 200) -> Response:
    """Render the generic participant-facing message page."""
    return _no_store(make_response(render_template("message.html", title=title, body=body), status))


def _json_body() -> dict:
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def _api_error(message: str, status: int, **extra):
    return jsonify(status="error", message=message, **extra), status


def _commit_or_rollback() -> Optional[str]:
    """Commit the session; return an error string instead of raising."""
    try:
        db_session.commit()
        return None
    except IntegrityError:
        db_session.rollback()
        return "duplicate"
    except SQLAlchemyError as exc:
        db_session.rollback()
        logger.exception("Database commit failed")
        return f"database error: {exc.__class__.__name__}"


def _completion_code(uid: str) -> str:
    """Short, deterministic code the participant can show the researcher."""
    return hashlib.sha256(f"therapist-embodiment:{uid}".encode()).hexdigest()[:8].upper()


@custom_code.app_context_processor
def inject_study_info():
    """Expose STUDY_INFO to every template, including psiTurk-rendered exp.html."""
    return {"study": STUDY_INFO, "conditions": CONDITIONS}


# --------------------------------------------------------------------------- #
# Protocol gates for psiTurk's built-in /consent, /exp, /complete
# --------------------------------------------------------------------------- #

def consent_gate():
    """GET /consent — IRB consent form."""
    ids = _parse_ids(request.args)
    if ids is None:
        return _message("This study link is incomplete",
                        "Please ask the researcher for a new link to the study.", 400)
    uid = _uid(ids)

    if ids["mode"] == "debug" and (_has_pretest(uid) or _participant(uid) is not None):
        # Practice / pilot: opening the study link again starts the whole study
        # again from consent, as a new run with new ids (the earlier run's data
        # stays in the database under its own uniqueid).
        return redirect(_url("/consent", **_fresh_practice_ids(ids)))
    if _has_posttest(uid):
        return redirect(_url("/complete", uniqueId=uid, mode=ids["mode"]))
    if _has_pretest(uid):
        # Live participant: consent was already given; resume where they left off.
        return redirect(_url("/briefing", **ids))
    if ids["mode"] != "debug" and _prior_participation(ids["workerId"], ids["assignmentId"]):
        return _message("You have already taken part",
                        "Our records show you have already participated in this study. "
                        "Because each person may take part only once, you cannot continue. "
                        "Thank you for your interest.", 403)

    return _no_store(make_response(render_template(
        "consent.html", ids=ids, consent_version=CONSENT_VERSION)))


def exp_gate():
    """GET /exp — enforce ordering, then defer to psiTurk's start_exp view."""
    ids = _parse_ids(request.args)
    if ids is None:
        return None  # psiTurk raises its standard "improper inputs" error.
    uid = _uid(ids)

    if _has_posttest(uid):
        return redirect(_url("/complete", uniqueId=uid, mode=ids["mode"]))
    if _has_finished_dialogue(uid):
        return redirect(_url("/posttest", uniqueId=uid, mode=ids["mode"]))
    if not _has_pretest(uid):
        return redirect(_url("/consent", **ids))
    if request.args.get("briefed") != "1":
        return redirect(_url("/briefing", **ids))
    if request.args.get("avchecked") != "1":
        return redirect(_url("/avcheck", briefed="1", **ids))
    return None  # Fall through: psiTurk creates the Participant and renders exp.html.


def complete_gate():
    """GET /complete — mark the participant COMPLETED and show the debrief."""
    uid = request.args.get("uniqueId", "")
    mode = request.args.get("mode", "")
    part = _participant(uid)
    if part is None:
        return _message("Session not found",
                        "We could not find this session. Please contact the researcher.", 404)
    if not _has_posttest(uid):
        return redirect(_url("/posttest", uniqueId=uid, mode=mode or part.mode or "debug"))

    if part.status not in STATUS_FINAL:
        part.status = STATUS_COMPLETED
        part.endhit = datetime.now(timezone.utc)  # same convention as psiTurk's own /complete
        db_session.add(part)
        err = _commit_or_rollback()
        if err:
            logger.error("Could not mark %s complete: %s", uid, err)

    return _no_store(make_response(render_template(
        "complete.html", completion_code=_completion_code(uid), mode=mode)))


_PROTOCOL_GATES: Dict[str, Callable] = {
    "/consent": consent_gate,
    "/exp": exp_gate,
    "/complete": complete_gate,
}


@custom_code.before_app_request
def protocol_router():
    """Intercept psiTurk's built-in pages (see module docstring)."""
    if request.method != "GET":
        return None
    gate = _PROTOCOL_GATES.get(request.path)
    return gate() if gate else None


# --------------------------------------------------------------------------- #
# Participant pages
# --------------------------------------------------------------------------- #

@custom_code.route("/briefing", methods=["GET"])
@nocache
def briefing():
    """Study briefing: shown once the pre-test is saved, before the conversation."""
    ids = _parse_ids(request.args)
    if ids is None:
        return _message("This study link is incomplete",
                        "Please ask the researcher for a new link to the study.", 400)
    uid = _uid(ids)
    if _has_posttest(uid):
        return redirect(_url("/complete", uniqueId=uid, mode=ids["mode"]))
    if _has_finished_dialogue(uid):
        return redirect(_url("/posttest", uniqueId=uid, mode=ids["mode"]))
    if not _has_pretest(uid):
        return redirect(_url("/consent", **ids))
    return render_template("briefing.html", ids=ids)


@custom_code.route("/avcheck", methods=["GET"])
@nocache
def avcheck():
    """Video and sound check: a test clip to play and confirm, before the conversation."""
    ids = _parse_ids(request.args)
    if ids is None:
        return _message("This study link is incomplete",
                        "Please ask the researcher for a new link to the study.", 400)
    uid = _uid(ids)
    if _has_posttest(uid):
        return redirect(_url("/complete", uniqueId=uid, mode=ids["mode"]))
    if _has_finished_dialogue(uid):
        return redirect(_url("/posttest", uniqueId=uid, mode=ids["mode"]))
    if not _has_pretest(uid):
        return redirect(_url("/consent", **ids))
    if request.args.get("briefed") != "1":
        return redirect(_url("/briefing", **ids))
    return render_template("avcheck.html", ids=ids)


@custom_code.route("/pretest", methods=["GET"])
@nocache
def pretest():
    """Demographics, prior experience, Robot Anxiety Scale, therapy baseline."""
    ids = _parse_ids(request.args)
    if ids is None:
        return _message("This study link is incomplete",
                        "Please ask the researcher for a new link to the study.", 400)
    uid = _uid(ids)
    if _has_pretest(uid):
        return redirect(_url("/briefing", **ids))
    if request.args.get("consent") != "agree":
        return redirect(_url("/consent", **ids))

    return render_template(
        "pretest.html", ids=ids,
        choices=inst.PRETEST_CHOICES, blocks=inst.PRETEST_BLOCKS,
        age_min=inst.AGE_MIN, age_max=inst.AGE_MAX)


@custom_code.route("/posttest", methods=["GET"])
@nocache
def posttest():
    """Trust, disclosure, willingness to use, manipulation check."""
    uid = request.args.get("uniqueId", "")
    part = _participant(uid)
    if part is None:
        return _message("Session not found",
                        "We could not find this session. Please contact the researcher.", 404)
    mode = part.mode or request.args.get("mode", "debug")
    if _has_posttest(uid):
        return redirect(_url("/complete", uniqueId=uid, mode=mode))
    if not _has_finished_dialogue(uid):
        return redirect(_url("/exp", hitId=part.hitid, assignmentId=part.assignmentid,
                             workerId=part.workerid, mode=mode))

    # The condition is intentionally NOT passed to the template: wording is
    # identical across conditions so the survey cannot cue the manipulation.
    return render_template(
        "posttest.html", unique_id=uid, mode=mode,
        blocks=inst.POSTTEST_BLOCKS, manipulation_check=inst.MANIPULATION_CHECK,
        attention_check_id=inst.ATTENTION_CHECK_ID,
        comments_max=inst.COMMENTS_MAX_CHARS)


# --------------------------------------------------------------------------- #
# REST endpoints
# --------------------------------------------------------------------------- #

@custom_code.route("/api/save_pretest", methods=["POST"])
def api_save_pretest():
    """Body: {hitId, assignmentId, workerId, mode, responses: {...}}"""
    data = _json_body()
    ids = _parse_ids(data)
    if ids is None:
        return _api_error("Missing or invalid hitId / assignmentId / workerId / mode.", 400)
    uid = _uid(ids)
    next_url = _url("/briefing", **ids)

    if _has_pretest(uid):
        return jsonify(status="exists", next_url=next_url)

    row_fields, errors = inst.score_pretest(data.get("responses"))
    if errors:
        return _api_error("Some answers are missing or invalid.", 422, errors=errors)

    db_session.add(PreTestSurvey(
        uniqueid=uid, workerid=ids["workerId"], assignmentid=ids["assignmentId"],
        hitid=ids["hitId"], mode=ids["mode"], consent_version=CONSENT_VERSION,
        user_agent=request.user_agent.string[:512], **row_fields))
    err = _commit_or_rollback()
    if err == "duplicate":
        return jsonify(status="exists", next_url=next_url)
    if err:
        return _api_error(err, 500)
    logger.info("Pre-test saved for %s", uid)
    return jsonify(status="saved", next_url=next_url)


def _num(value, lo: float, hi: float, required: bool = True) -> Optional[float]:
    """Validate a finite number in [lo, hi]; raises ValueError when invalid."""
    if value is None:
        if required:
            raise ValueError("missing")
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("not a number")
    if not (lo <= float(value) <= hi):
        raise ValueError(f"outside [{lo}, {hi}]")
    return float(value)


def _short_str(value, max_len: int, required: bool = True) -> Optional[str]:
    if value is None or value == "":
        if required:
            raise ValueError("missing")
        return None
    return str(value)[:max_len]


@custom_code.route("/api/save_trial", methods=["POST"])
def api_save_trial():
    """Body: one answered dialogue node (see DataCollector in static/js/task.js)."""
    data = _json_body()
    uid = data.get("unique_id", "")
    part = _participant(uid)
    if part is None:
        return _api_error("Unknown participant.", 404)
    if part.cond not in CONDITIONS:
        return _api_error(f"Participant has condition {part.cond}; expected 0–2. Check num_conds.", 409)

    try:
        fields = dict(
            run_id=_short_str(data.get("run_id"), 64),
            trial_index=int(_num(data.get("trial_index"), 0, MAX_TRIALS_PER_RUN)),
            stage=int(_num(data.get("stage"), 1, 6)),
            node_id=_short_str(data.get("node_id"), 64),
            question_text=_short_str(data.get("question_text"), 2000),
            selected_choice_index=int(_num(data.get("selected_choice_index"), 0, 9)),
            choice_code=_short_str(data.get("choice_code"), 64),
            choice_text=_short_str(data.get("choice_text"), 2000),
            next_node_id=_short_str(data.get("next_node_id"), 64, required=False),
            path_so_far=_short_str(data.get("path_so_far"), 2000),
            choice_latency_ms=_num(data.get("choice_latency_ms"), 0, MAX_LATENCY_MS),
            pointerdown_latency_ms=_num(data.get("pointerdown_latency_ms"), 0, MAX_LATENCY_MS, required=False),
            options_shown_epoch_ms=_num(data.get("options_shown_epoch_ms"), 0, 1e14),
            prompt_audio_duration_ms=_num(data.get("prompt_audio_duration_ms"), 0, MAX_LATENCY_MS, required=False),
            prompt_audio_onset_ms=_num(data.get("prompt_audio_onset_ms"), 0, MAX_LATENCY_MS, required=False),
            input_modality=_short_str(data.get("input_modality"), 16, required=False),
            client_timestamp=_short_str(data.get("client_timestamp"), 40, required=False),
        )
    except (ValueError, TypeError) as exc:
        return _api_error(f"Invalid trial payload: {exc}", 422)

    client_cond = data.get("condition")
    if client_cond != part.cond:
        # The server's assignment is authoritative; log the discrepancy.
        logger.warning("Condition mismatch for %s: client=%r server=%r", uid, client_cond, part.cond)

    existing = (BranchingTrialLog.query
                .filter_by(uniqueid=uid, run_id=fields["run_id"], trial_index=fields["trial_index"])
                .first())
    if existing:
        return jsonify(status="duplicate", id=existing.id)

    row = BranchingTrialLog(
        uniqueid=uid, condition=part.cond, condition_label=CONDITIONS[part.cond],
        is_terminal=fields["next_node_id"] is None,
        tab_hidden_during_choice=bool(data.get("tab_hidden_during_choice")),
        audio_simulated=bool(data.get("audio_simulated")) and part.mode == "debug",
        audio_watchdog_fired=bool(data.get("audio_watchdog_fired")),
        **fields)
    db_session.add(row)
    err = _commit_or_rollback()
    if err == "duplicate":
        return jsonify(status="duplicate")
    if err:
        return _api_error(err, 500)
    return jsonify(status="saved", id=row.id)


@custom_code.route("/api/save_posttest", methods=["POST"])
def api_save_posttest():
    """Body: {uniqueId, responses: {...}}"""
    data = _json_body()
    uid = data.get("uniqueId", "")
    part = _participant(uid)
    if part is None:
        return _api_error("Unknown participant.", 404)
    mode = part.mode or "debug"
    next_url = _url("/complete", uniqueId=uid, mode=mode)

    if _has_posttest(uid):
        return jsonify(status="exists", next_url=next_url)
    if not _has_finished_dialogue(uid):
        return _api_error("The conversation has not been completed yet.", 409)

    row_fields, errors = inst.score_posttest(data.get("responses"), part.cond)
    if errors:
        return _api_error("Some answers are missing or invalid.", 422, errors=errors)

    db_session.add(PostTestSurvey(
        uniqueid=uid, condition=part.cond, condition_label=CONDITIONS.get(part.cond, "unknown"),
        mode=mode, user_agent=request.user_agent.string[:512], **row_fields))
    err = _commit_or_rollback()
    if err == "duplicate":
        return jsonify(status="exists", next_url=next_url)
    if err:
        return _api_error(err, 500)
    logger.info("Post-test saved for %s (condition %s)", uid, part.cond)
    return jsonify(status="saved", next_url=next_url)


# --------------------------------------------------------------------------- #
# Researcher-only pages: session launcher, enrolment counts, CSV export
# --------------------------------------------------------------------------- #

def researcher_only(view):
    """Require HTTP Basic auth with config.txt's login_username / login_pw on every request.

    There is deliberately no exemption for requests from this computer: a tunnel
    (Tailscale Funnel, cloudflared, ngrok) or reverse proxy hands every internet
    visitor to the server as 127.0.0.1, so "local" cannot be trusted. If no login
    is configured, the researcher pages stay closed.
    """
    @wraps(view)
    def _wrapped(*args, **kwargs):
        user = _config_value("Server Parameters", "login_username") or ""
        pw = _config_value("Server Parameters", "login_pw") or ""
        if not (user and pw):
            logger.warning("Researcher console refused: login_username / login_pw are not set.")
            return Response("The researcher console is disabled. Set login_username and login_pw "
                            "under [Server Parameters] in config.txt, then restart the server.",
                            503, {"Content-Type": "text/plain; charset=utf-8"})
        try:
            auth = request.authorization
        except (UnicodeDecodeError, ValueError):
            auth = None   # malformed or non-UTF-8 header: ask for the login again
        if (auth and auth.username is not None and auth.password is not None
                and hmac.compare_digest(auth.username.encode("utf-8"), user.encode("utf-8"))
                and hmac.compare_digest(auth.password.encode("utf-8"), pw.encode("utf-8"))):
            return view(*args, **kwargs)
        return Response("Researcher login required.", 401,
                        {"WWW-Authenticate": 'Basic realm="Study administration", charset="UTF-8"'})
    return _wrapped


_EXPORTS = {
    "pretest": PreTestSurvey,
    "trials": BranchingTrialLog,
    "posttest": PostTestSurvey,
}


@custom_code.route("/lab", methods=["GET"])
@researcher_only
@nocache
def lab_dashboard():
    """Start sessions on a lab workstation and monitor enrolment per condition."""
    counts = []
    for cond, label in CONDITIONS.items():
        row = {"cond": cond, "label": label}
        for mode in ("live", "debug"):
            row[f"started_{mode}"] = (Participant.query
                                      .filter(Participant.cond == cond, Participant.mode == mode,
                                              Participant.status >= STATUS_STARTED).count())
            row[f"completed_{mode}"] = (PostTestSurvey.query
                                        .filter_by(condition=cond, mode=mode).count())
        counts.append(row)
    return render_template("lab.html", counts=counts, exports=list(_EXPORTS),
                           default_session=datetime.now().strftime("S%Y%m%d-%H%M%S"))


@custom_code.route("/lab/export/<name>.csv", methods=["GET"])
@researcher_only
def lab_export(name: str):
    """Download one custom table as CSV (UTF-8 with BOM for Excel)."""
    model = _EXPORTS.get(name)
    if model is None:
        return Response("Unknown table.", 404)
    columns = [c.name for c in model.__table__.columns]

    def generate():
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=columns)
        buf.write("﻿")
        writer.writeheader()
        yield buf.getvalue()
        for row in model.query.order_by(model.id).yield_per(500):
            buf.seek(0)
            buf.truncate(0)
            writer.writerow(row.to_dict())
            yield buf.getvalue()

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return Response(generate(), mimetype="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="{name}-{stamp}.csv"',
                             "Cache-Control": "no-store"})
