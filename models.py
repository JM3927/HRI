"""
models.py — Custom SQLAlchemy tables layered on psiTurk's database.

These models subclass psiTurk's declarative `Base` (psiturk.models), so they live in the same
SQLite (or other) database configured by `database_url` in config.txt and are
created by psiTurk's `init_db()` (called from custom.py once these classes are
imported). psiTurk's own `participants` table is left untouched; every row
here is joined to it through `uniqueid` ("<workerId>:<assignmentId>").

Tables
------
pretest_survey        one row per participant  (before condition assignment)
branching_trial_log   one row per answered dialogue node
posttest_survey       one row per participant  (after the session)

Column names for questionnaire items match the item ids in instruments.py.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import (Boolean, Column, DateTime, Float, Integer, String, Text,
                        UniqueConstraint)

from psiturk.models import Base   # psiTurk's declarative base (psiTurk 3.x)


def _utcnow() -> datetime:
    """Naive UTC timestamp (SQLite has no timezone type)."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _likert(doc: str) -> Column:
    """Nullable small-integer column for one Likert item (range given in `doc`)."""
    return Column(Integer, nullable=True, doc=doc)


class _SerializableMixin:
    """Gives every model a flat dict view for JSON / CSV export."""

    def to_dict(self) -> dict:
        out = {}
        for col in self.__table__.columns:
            value = getattr(self, col.name)
            out[col.name] = value.isoformat() if isinstance(value, datetime) else value
        return out


# --------------------------------------------------------------------------- #
# Pre-test
# --------------------------------------------------------------------------- #

class PreTestSurvey(_SerializableMixin, Base):
    """Demographics, prior experience, help-seeking attitudes (ATSPPH-SF), Robot Anxiety Scale."""

    __tablename__ = "pretest_survey"

    id = Column(Integer, primary_key=True, autoincrement=True)
    uniqueid = Column(String(128), nullable=False, unique=True, index=True,
                      doc="psiTurk uniqueId: '<workerId>:<assignmentId>'")
    workerid = Column(String(128), nullable=False, index=True)
    assignmentid = Column(String(128), nullable=False)
    hitid = Column(String(128), nullable=False)
    mode = Column(String(16), nullable=False, doc="psiTurk mode: debug | sandbox | live")
    consent_version = Column(String(32), nullable=False)

    # Demographics
    age = Column(Integer, nullable=False)
    gender = Column(String(32), nullable=False)
    gender_self_describe = Column(String(100), nullable=True)
    ethnicity = Column(String(256), nullable=False, doc="Comma-separated choice codes")
    ethnicity_self_describe = Column(String(100), nullable=True)

    # Prior experience
    prior_therapy = Column(String(16), nullable=False, doc="yes | no | prefer_not")
    tech_familiarity = _likert("1–7 familiarity with everyday technology")
    robot_exposure = _likert("1–7 experience with robots / voice assistants")

    # Robot Anxiety Scale (Nomura et al.) — 7-point
    ras_s1_1 = _likert("RAS S1 communication capability")
    ras_s1_2 = _likert("RAS S1 communication capability")
    ras_s1_3 = _likert("RAS S1 communication capability")
    ras_s2_1 = _likert("RAS S2 behavioral characteristics")
    ras_s2_2 = _likert("RAS S2 behavioral characteristics")
    ras_s2_3 = _likert("RAS S2 behavioral characteristics")
    ras_s2_4 = _likert("RAS S2 behavioral characteristics")
    ras_s3_1 = _likert("RAS S3 discourse with robots")
    ras_s3_2 = _likert("RAS S3 discourse with robots")
    ras_s3_3 = _likert("RAS S3 discourse with robots")
    ras_s3_4 = _likert("RAS S3 discourse with robots")
    ras_s1_mean = Column(Float, nullable=True)
    ras_s2_mean = Column(Float, nullable=True)
    ras_s3_mean = Column(Float, nullable=True)
    ras_total_mean = Column(Float, nullable=True, doc="Baseline robot anxiety score (mean of 11 items)")

    # Attitudes Toward Seeking Professional Psychological Help, short form
    # (Fischer & Farina, 1995). Raw answers 0–3; items 2, 4, 8, 9, 10 are
    # reverse-scored in atspph_total only.
    atspph_1 = _likert("ATSPPH-SF 0–3")
    atspph_2 = _likert("ATSPPH-SF 0–3 (reverse-scored in total)")
    atspph_3 = _likert("ATSPPH-SF 0–3")
    atspph_4 = _likert("ATSPPH-SF 0–3 (reverse-scored in total)")
    atspph_5 = _likert("ATSPPH-SF 0–3")
    atspph_6 = _likert("ATSPPH-SF 0–3")
    atspph_7 = _likert("ATSPPH-SF 0–3")
    atspph_8 = _likert("ATSPPH-SF 0–3 (reverse-scored in total)")
    atspph_9 = _likert("ATSPPH-SF 0–3 (reverse-scored in total)")
    atspph_10 = _likert("ATSPPH-SF 0–3 (reverse-scored in total)")
    atspph_total = Column(Integer, nullable=True, doc="ATSPPH-SF sum 0–30 (higher = more positive)")
    ai_counseling_openness = _likert("1–7 openness to AI / robotic counseling (single item)")

    # Provenance
    user_agent = Column(String(512), nullable=True)
    submitted_at = Column(DateTime, nullable=False, default=_utcnow, doc="Server UTC time")


# --------------------------------------------------------------------------- #
# Trial-by-trial branching log
# --------------------------------------------------------------------------- #

class BranchingTrialLog(_SerializableMixin, Base):
    """One answered node of the dialogue tree, with millisecond timing."""

    __tablename__ = "branching_trial_log"
    __table_args__ = (
        # Makes client retries idempotent; run_id separates page reloads.
        UniqueConstraint("uniqueid", "run_id", "trial_index", name="uq_trial_per_run"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    uniqueid = Column(String(128), nullable=False, index=True)
    run_id = Column(String(64), nullable=False,
                    doc="Random id per page load of /exp (distinguishes debug restarts)")
    condition = Column(Integer, nullable=False, doc="Server-side psiTurk condition: 0 human, 1 furhat, 2 peerbot")
    condition_label = Column(String(16), nullable=False)

    # Dialogue position
    trial_index = Column(Integer, nullable=False, doc="0-based order of this answer within the run")
    stage = Column(Integer, nullable=False, doc="Clinical-intake stage 1–6")
    node_id = Column(String(64), nullable=False)
    question_text = Column(Text, nullable=False)

    # Response
    selected_choice_index = Column(Integer, nullable=False)
    choice_code = Column(String(64), nullable=False, doc="Analysis code, e.g. coping_avoidant")
    choice_text = Column(Text, nullable=False)
    next_node_id = Column(String(64), nullable=True, doc="NULL when the session ended")
    is_terminal = Column(Boolean, nullable=False, default=False)
    path_so_far = Column(Text, nullable=False, doc="'>'-joined node ids visited up to this node")

    # Timing (ms). Latency = t_click − t_options_shown (performance.now clock).
    choice_latency_ms = Column(Float, nullable=False)
    pointerdown_latency_ms = Column(Float, nullable=True, doc="Press (not release) latency, if a pointer was used")
    options_shown_epoch_ms = Column(Float, nullable=False, doc="performance.timeOrigin + t_options_shown")
    prompt_audio_duration_ms = Column(Float, nullable=True, doc="Measured play→ended time of the node prompt")
    prompt_audio_onset_ms = Column(Float, nullable=True, doc="play() call → 'playing' event; ~0 when preloaded")
    input_modality = Column(String(16), nullable=True, doc="mouse | touch | pen | keyboard")
    tab_hidden_during_choice = Column(Boolean, nullable=False, default=False)
    audio_simulated = Column(Boolean, nullable=False, default=False,
                             doc="True only for debug runs without audio files")
    audio_watchdog_fired = Column(Boolean, nullable=False, default=False,
                                  doc="True if 'ended' never fired and the watchdog advanced the trial")

    client_timestamp = Column(String(40), nullable=True, doc="Client ISO-8601 time of the click")
    timestamp = Column(DateTime, nullable=False, default=_utcnow, doc="Server UTC receive time")


# --------------------------------------------------------------------------- #
# Post-test
# --------------------------------------------------------------------------- #

class PostTestSurvey(_SerializableMixin, Base):
    """MDMT v2 trust, willingness to use, CARE empathy, disclosure comfort, Godspeed, checks."""

    __tablename__ = "posttest_survey"

    id = Column(Integer, primary_key=True, autoincrement=True)
    uniqueid = Column(String(128), nullable=False, unique=True, index=True)
    condition = Column(Integer, nullable=False)
    condition_label = Column(String(16), nullable=False)
    mode = Column(String(16), nullable=False)

    # MDMT v2 items (0–7; NULL = "Does not fit")
    mdmt_reliable = _likert("MDMT Reliable")
    mdmt_predictable = _likert("MDMT Reliable")
    mdmt_dependable = _likert("MDMT Reliable")
    mdmt_consistent = _likert("MDMT Reliable")
    mdmt_competent = _likert("MDMT Competent")
    mdmt_skilled = _likert("MDMT Competent")
    mdmt_capable = _likert("MDMT Competent")
    mdmt_meticulous = _likert("MDMT Competent")
    mdmt_ethical = _likert("MDMT Ethical")
    mdmt_principled = _likert("MDMT Ethical")
    mdmt_moral = _likert("MDMT Ethical")
    mdmt_integrity = _likert("MDMT Ethical ('has integrity')")
    mdmt_truthful = _likert("MDMT Sincere")
    mdmt_genuine = _likert("MDMT Sincere")
    mdmt_sincere = _likert("MDMT Sincere")
    mdmt_frank = _likert("MDMT Sincere")
    mdmt_benevolent = _likert("MDMT Benevolent")
    mdmt_kind = _likert("MDMT Benevolent")
    mdmt_considerate = _likert("MDMT Benevolent")
    mdmt_goodwill = _likert("MDMT Benevolent ('has goodwill')")
    mdmt_reliable_mean = Column(Float, nullable=True)
    mdmt_competent_mean = Column(Float, nullable=True)
    mdmt_ethical_mean = Column(Float, nullable=True)
    mdmt_sincere_mean = Column(Float, nullable=True)
    mdmt_benevolent_mean = Column(Float, nullable=True)
    mdmt_performance_trust = Column(Float, nullable=True,
                                    doc="PRIMARY. Mean of Reliable and Competent subscale scores (both required)")
    mdmt_moral_trust = Column(Float, nullable=True,
                              doc="PRIMARY. Mean of Ethical, Sincere, Benevolent subscale scores (≥2 required)")
    mdmt_total_trust = Column(Float, nullable=True, doc="Mean of Performance and Moral trust (both required)")
    mdmt_na_count = Column(Integer, nullable=True, doc="Number of 'Does not fit' answers (0–20)")

    # Willingness to use: UTAUT behavioural intention (Venkatesh et al., 2003), 1–7
    bi_1 = _likert("1–7 intend to use in the next 6 months")
    bi_2 = _likert("1–7 predict I would use in the next 6 months")
    bi_3 = _likert("1–7 plan to use in the next 6 months")
    willingness_to_use_mean = Column(Float, nullable=True, doc="PRIMARY. Mean of bi_1–bi_3")

    # CARE measure (Mercer et al., 2004), 1–5; NULL = "Does not apply"
    care_1 = _likert("CARE making you feel at ease")
    care_2 = _likert("CARE letting you tell your story")
    care_3 = _likert("CARE really listening")
    care_4 = _likert("CARE interested in you as a whole person")
    care_5 = _likert("CARE fully understanding your concerns")
    care_6 = _likert("CARE showing care and compassion")
    care_7 = _likert("CARE being positive")
    care_8 = _likert("CARE explaining things clearly")
    care_9 = _likert("CARE helping you take control")
    care_10 = _likert("CARE making a plan of action with you")
    care_total = Column(Float, nullable=True,
                        doc="10–50; ≤2 N/A replaced by the item mean; NULL if more than 2 N/A")
    care_na_count = Column(Integer, nullable=True)

    # Disclosure comfort (study-specific, exploratory), 1–7
    dc_1 = _likert("Comfortable sharing")
    dc_2 = _likert("Honest answers")
    dc_3 = _likert("Future disclosure willingness")
    dc_4 = _likert("Held back information (reverse-coded in mean)")
    disclosure_comfort_mean = Column(Float, nullable=True)

    # Godspeed Anthropomorphism (Bartneck et al., 2009), 1–5 semantic differential
    gs_anthro_1 = _likert("Fake (1) – Natural (5)")
    gs_anthro_2 = _likert("Machinelike (1) – Humanlike (5)")
    gs_anthro_3 = _likert("Unconscious (1) – Conscious (5)")
    gs_anthro_4 = _likert("Artificial (1) – Lifelike (5)")
    gs_anthro_5 = _likert("Moving rigidly (1) – Moving elegantly (5)")
    godspeed_anthropomorphism_mean = Column(Float, nullable=True,
                                            doc="Graded manipulation check of perceived human-likeness")

    # Data-quality checks
    attention_check = _likert("Instructed-response item (target = 3)")
    attention_check_passed = Column(Boolean, nullable=True)
    mc_embodiment = Column(String(32), nullable=True, doc="Manipulation check answer")
    mc_correct = Column(Boolean, nullable=True)

    comments = Column(Text, nullable=True)
    user_agent = Column(String(512), nullable=True)
    submitted_at = Column(DateTime, nullable=False, default=_utcnow)
