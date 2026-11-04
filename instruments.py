"""
instruments.py — Single source of truth for every questionnaire in the study.

The same definitions drive three things, so they can never drift apart:
  1. Rendering   — templates/pretest.html and templates/posttest.html loop over
                   these blocks to build the Likert matrices.
  2. Validation  — score_pretest() / score_posttest() reject malformed or
                   out-of-range payloads sent to the /api/save_* endpoints.
  3. Scoring     — subscale scores (with reverse-coding) are computed on the
                   server, never trusted from the browser.

Every item `id` below is also a column name in models.py; custom.py asserts
this at start-up so a renamed item fails loudly instead of silently dropping
data.

Primary outcomes: trust (MDMT v2) and willingness to use (UTAUT behavioural
intention). Everything else is a covariate, a secondary outcome or a check.

Instrument notes (cite these; verify wording against your IRB-approved copy)
----------------------------------------------------------------------------
Pre-test
* Robot Anxiety Scale (RAS): Nomura, Kanda, Suzuki & Kato (2006/2008).
  11 items, 3 subscales. The original uses a 6-point format; this study uses
  7 points. Item wording is an English rendering.
* ATSPPH-SF, Attitudes Toward Seeking Professional Psychological Help — Short
  Form: Fischer & Farina (1995). 10 items, 0–3 (Disagree … Agree); items 2, 4,
  8, 9, 10 are reverse-scored; total = sum, 0–30 (higher = more positive).
Post-test
* MDMT v2, Multi-Dimensional Measure of Trust: Malle & Ullman (2021, 2023),
  scale sheet 2025-09-01 (research.clps.brown.edu/SocCogSci/Measures). 20
  items, 0 (Not at all) – 7 (Very) plus "Does not fit" (stored as NULL), in
  the authors' two balanced 10-item blocks. Subscales Reliable, Competent
  (→ Performance trust) and Ethical, Sincere, Benevolent (→ Moral trust).
* Behavioural intention (willingness to use): the three BI items of UTAUT,
  Venkatesh, Morris, Davis & Davis (2003), with "the system" replaced by
  "a counselor like this one" and <n> = 6 months; 7-point agreement.
* CARE measure, Consultation and Relational Empathy: Mercer, Maxwell, Heaney &
  Watt (2004), © SW Mercer 2004 — free for non-commercial research, but check
  its terms of use. 10 items, Poor (1) – Excellent (5) plus "Does not apply";
  total 10–50, with up to two N/A replaced by the mean of the other items and
  the score left NULL when more than two are N/A.
* Godspeed questionnaire: Bartneck, Kulić, Croft & Zoghbi (2009). Only the
  Anthropomorphism subscale (5 semantic-differential items, 1–5) is used, as a
  graded manipulation check of how human-like each embodiment seemed.
* Disclosure comfort (dc_1–dc_4): study-specific, not a validated scale; treat
  it as exploratory.
"""

from __future__ import annotations

from dataclasses import dataclass
from statistics import mean
from typing import Dict, List, Optional, Sequence, Tuple


# --------------------------------------------------------------------------- #
# Building blocks
# --------------------------------------------------------------------------- #

@dataclass(frozen=True)
class Item:
    """A single Likert item. Semantic-differential items set `left`/`right` instead of `text`."""
    id: str
    text: str = ""
    subscale: Optional[str] = None
    reverse: bool = False
    help: str = ""                   # smaller explanatory line under the item (CARE descriptions)
    left: str = ""                   # semantic differential: low-end anchor
    right: str = ""                  # semantic differential: high-end anchor


@dataclass(frozen=True)
class LikertBlock:
    """A matrix of Likert items sharing one response scale."""
    id: str
    title: str
    instructions: str
    labels: Sequence[str]            # one label per scale point, low → high
    items: Sequence[Item]
    scale_min: int = 1
    allow_na: bool = False           # adds an N/A column ("Does not fit" for the MDMT)
    na_label: str = "Does not fit"
    semantic: bool = False           # rows are bipolar word pairs (Godspeed)
    stem: str = ""                   # shown above the item column, e.g. "The therapist …"

    @property
    def scale_max(self) -> int:
        return self.scale_min + len(self.labels) - 1

    @property
    def points(self) -> List[int]:
        return list(range(self.scale_min, self.scale_max + 1))


@dataclass(frozen=True)
class Choice:
    """An option of a categorical (radio / checkbox / select) question."""
    value: str
    label: str


@dataclass(frozen=True)
class ChoiceQuestion:
    id: str
    text: str
    choices: Sequence[Choice]
    multiple: bool = False
    self_describe_value: Optional[str] = None   # choice that reveals a text box
    self_describe_field: Optional[str] = None   # name of that text box
    help: str = ""


AGREE_7 = (
    "Strongly disagree", "Disagree", "Somewhat disagree",
    "Neither agree nor disagree",
    "Somewhat agree", "Agree", "Strongly agree",
)

ANXIETY_7 = (
    "Not at all anxious", "Very slightly anxious", "Slightly anxious",
    "Moderately anxious",
    "Quite anxious", "Very anxious", "Extremely anxious",
)

AGREE_4 = ("Disagree", "Partly disagree", "Partly agree", "Agree")          # ATSPPH-SF, 0–3

MDMT_8 = ("Not at all", "", "", "", "", "", "", "Very")                      # MDMT v2, 0–7

CARE_5 = ("Poor", "Fair", "Good", "Very good", "Excellent")                  # CARE, 1–5


# --------------------------------------------------------------------------- #
# PRE-TEST
# --------------------------------------------------------------------------- #

AGE_MIN, AGE_MAX = 18, 80

GENDER = ChoiceQuestion(
    id="gender",
    text="What is your gender?",
    choices=(
        Choice("woman", "Woman"),
        Choice("man", "Man"),
        Choice("non_binary", "Non-binary"),
        Choice("self_describe", "Prefer to self-describe"),
        Choice("prefer_not", "Prefer not to say"),
    ),
    self_describe_value="self_describe",
    self_describe_field="gender_self_describe",
)

ETHNICITY = ChoiceQuestion(
    id="ethnicity",
    text="Which of the following best describe your race and/or ethnicity?",
    help="Select all that apply.",
    multiple=True,
    choices=(
        Choice("american_indian_alaska_native", "American Indian or Alaska Native"),
        Choice("asian", "Asian"),
        Choice("black_african_american", "Black or African American"),
        Choice("hispanic_latino", "Hispanic or Latino/a/x"),
        Choice("middle_eastern_north_african", "Middle Eastern or North African"),
        Choice("native_hawaiian_pacific_islander", "Native Hawaiian or Other Pacific Islander"),
        Choice("white", "White"),
        Choice("self_describe", "Prefer to self-describe"),
        Choice("prefer_not", "Prefer not to say"),
    ),
    self_describe_value="self_describe",
    self_describe_field="ethnicity_self_describe",
)

PRIOR_THERAPY = ChoiceQuestion(
    id="prior_therapy",
    text="Have you ever spoken with a therapist, counselor, or other mental health professional?",
    choices=(
        Choice("yes", "Yes"),
        Choice("no", "No"),
        Choice("prefer_not", "Prefer not to say"),
    ),
)

TECH_BLOCK = LikertBlock(
    id="tech",
    title="Experience with technology",
    instructions="Please choose the number that best describes you.",
    labels=("Not at all", "", "", "Moderately", "", "", "Extremely"),
    items=(
        Item("tech_familiarity",
             "How familiar are you with everyday technology (computers, smartphones, apps)?"),
        Item("robot_exposure",
             "How much experience do you have with robots or voice assistants "
             "(e.g., Siri, Alexa, social robots)?"),
    ),
)

ATSPPH_BLOCK = LikertBlock(
    id="atspph",
    title="Attitudes toward counseling",
    instructions="Please indicate how much you agree or disagree with each statement.",
    labels=AGREE_4,
    scale_min=0,
    items=(
        Item("atspph_1", "If I thought I was having a mental breakdown, my first thought would be "
                         "to get professional attention.", "atspph"),
        Item("atspph_2", "The idea of talking about problems with a psychologist strikes me as a poor way "
                         "to get rid of emotional conflicts.", "atspph", reverse=True),
        Item("atspph_3", "If I were experiencing a serious emotional crisis at this point in my life, I "
                         "would be confident that psychological therapy would help.", "atspph"),
        Item("atspph_4", "There is something admirable in the attitude of a person who is willing to deal "
                         "with his or her conflicts and fears without going to professional help.",
             "atspph", reverse=True),
        Item("atspph_5", "I would want to get psychological help if I were worried or upset for a long "
                         "period of time.", "atspph"),
        Item("atspph_6", "I might want to have psychological counseling in the future.", "atspph"),
        Item("atspph_7", "A person with an emotional problem is not likely to solve it alone. They are more "
                         "likely to solve it with professional help.", "atspph"),
        Item("atspph_8", "Considering the time and expense involved in psychological therapy, it would be wasted "
                         "value for a person like me.", "atspph", reverse=True),
        Item("atspph_9", "A person should work out his or her own problems, and getting psychological "
                         "counseling should be a last resort.", "atspph", reverse=True),
        Item("atspph_10", "Personal and emotional troubles, like many things, tend to work out by "
                          "themselves.", "atspph", reverse=True),
    ),
)

AI_OPENNESS_BLOCK = LikertBlock(
    id="ai_openness",
    title="Different kinds of counselors",
    instructions="Please indicate how much you agree or disagree with this statement.",
    labels=AGREE_7,
    items=(
        Item("ai_counseling_openness",
             "I would be open to discussing personal concerns with an AI or robotic counselor."),
    ),
)

RAS_BLOCK = LikertBlock(
    id="ras",
    title="Feelings about robots",
    # Same framing for every participant: the study compares different kinds of
    # counselors, some of which are robots (so this block does not reveal the condition).
    instructions=("This study compares different kinds of counselors, and some of them are robots. "
                  "Imagine you were going to interact with a robot. "
                  "How anxious would you feel about each of the following?"),
    labels=ANXIETY_7,
    items=(
        # S1 — Anxiety toward communication capability of robots
        Item("ras_s1_1", "The robot talking about irrelevant details in conversation.", "s1"),
        Item("ras_s1_2", "The robot would be inflexible in conversation.", "s1"),
        Item("ras_s1_3", "The ability of the robot to understand complex stories.", "s1"),
        # S2 — Anxiety toward discourse with robots
        Item("ras_s3_1", "How I should talk with the robot.", "s3"),
        Item("ras_s3_2", "How I should respond when the robot talks to me.", "s3"),
        Item("ras_s3_3", "Whether the robot understands what I am talking about.", "s3"),
        Item("ras_s3_4", "Whether I understand what the robot is talking about.", "s3"),
    ),
)

PRETEST_CHOICES = (GENDER, ETHNICITY, PRIOR_THERAPY)
# Counseling attitudes come before the robot items so the general measures are
# answered before robots are mentioned.
PRETEST_BLOCKS = (TECH_BLOCK, ATSPPH_BLOCK, AI_OPENNESS_BLOCK, RAS_BLOCK)


# --------------------------------------------------------------------------- #
# POST-TEST
# --------------------------------------------------------------------------- #

# MDMT v2, in the authors' order: two balanced blocks of 10 (Form A, Form B),
# each with two items from every dimension.
_MDMT_INSTRUCTIONS = ("How much does the therapist you just spoke with have each of these qualities? "
                      "Choose from 0 (Not at all) to 7 (Very). If a word does not fit the therapist at all, "
                      "choose “Does not fit”.")

MDMT_BLOCK_A = LikertBlock(
    id="mdmt_a",
    title="Your impressions of the therapist (1 of 2)",
    instructions=_MDMT_INSTRUCTIONS,
    stem="The therapist is…",
    labels=MDMT_8,
    scale_min=0,
    allow_na=True,
    items=(
        Item("mdmt_reliable", "reliable", "reliable"),
        Item("mdmt_competent", "competent", "competent"),
        Item("mdmt_ethical", "ethical", "ethical"),
        Item("mdmt_sincere", "sincere", "sincere"),
        Item("mdmt_predictable", "predictable", "reliable"),
        Item("mdmt_skilled", "skilled", "competent"),
        Item("mdmt_kind", "kind", "benevolent"),
    ),
)

MDMT_BLOCK_B = LikertBlock(
    id="mdmt_b",
    title="Your impressions of the therapist (2 of 2)",
    instructions=_MDMT_INSTRUCTIONS,
    stem="The therapist is…",
    labels=MDMT_8,
    scale_min=0,
    allow_na=True,
    items=(
        Item("mdmt_dependable", "dependable", "reliable"),
        Item("mdmt_capable", "capable", "competent"),
        Item("mdmt_moral", "moral", "ethical"),
        Item("mdmt_truthful", "truthful", "sincere"),
        Item("mdmt_considerate", "considerate", "benevolent"),
        Item("mdmt_consistent", "consistent", "reliable"),
        Item("mdmt_meticulous", "meticulous", "competent"),
        Item("mdmt_honorable", "honorable",  "ethical"), 
        Item("mdmt_genuine", "genuine", "sincere"),
    ),
)

MDMT_BLOCKS = (MDMT_BLOCK_A, MDMT_BLOCK_B)
MDMT_PERFORMANCE = ("reliable", "competent")
MDMT_MORAL = ("ethical", "sincere", "benevolent")

BI_BLOCK = LikertBlock(
    id="bi",
    title="Using this kind of counselor",
    instructions=("Imagine that a counselor like the one you just spoke with were available to you. "
                  "Please indicate how much you agree or disagree with each statement."),
    labels=AGREE_7,
    items=(
        Item("bi_1", "If a counselor like this were available, I intend to use a counselor like this one in the next 6 months.", "bi"),
        Item("bi_2", "If a counselor like this were available, I predict I would use a counselor like this one in the next 6 months.", "bi"),
        Item("bi_3", "If a counselor like this were available, I plan to use a counselor like this one in the next 6 months.", "bi"),
    ),
)

CARE_BLOCK = LikertBlock(
    id="care",
    title="How the therapist treated you",
    instructions=("Please rate the following statements about the conversation you just had. "
                  "If a statement does not apply to this conversation, choose “Does not apply”."),
    stem="How good was the therapist at …",
    labels=CARE_5,
    allow_na=True,
    na_label="Does not apply",
    items=(
        Item("care_1", "Making you feel at ease", "care",
             help="being friendly and warm towards you, treating you with respect; not cold or abrupt"),
        Item("care_2", "Letting you tell your “story”", "care",
             help="giving you time to fully describe your situation in your own words; "
                  "not interrupting, rushing or diverting you"),
        Item("care_3", "Really listening", "care",
             help="paying close attention to what you were saying"),
        Item("care_4", "Being interested in you as a whole person", "care",
             help="asking about relevant details of your life and your situation; "
                  "not treating you as “just a number”"),
        Item("care_5", "Fully understanding your concerns", "care",
             help="communicating that they had accurately understood your concerns; "
                  "not overlooking or dismissing anything"),
        Item("care_6", "Showing care and compassion", "care",
             help="seeming genuinely concerned, connecting with you on a human level; "
                  "not being indifferent or “detached”"),
        Item("care_7", "Being positive", "care",
             help="having a positive approach and a positive attitude; "
                  "being honest but not negative about your problems"),
        Item("care_8", "Explaining things clearly", "care",
             help="explaining clearly, giving you adequate information; not being vague"),
    ),
)
CARE_MAX_NA = 2   # more N/A / missing than this → no CARE score (scoring rule of the measure)

ATTENTION_CHECK_ID = "attention_check"
ATTENTION_CHECK_TARGET = 3          # "Somewhat disagree"

DISCLOSURE_BLOCK = LikertBlock(
    id="disclosure",
    title="Comfort and disclosure",
    instructions="Please indicate how much you agree or disagree with each statement about the conversation.",
    labels=AGREE_7,
    items=(
        Item("dc_1", "I felt comfortable sharing personal information during the conversation.", "disclosure"),
        Item("dc_2", "I gave honest answers about my thoughts and feelings.", "disclosure"),
        Item(ATTENTION_CHECK_ID, "To show that you are reading carefully, please select “Somewhat disagree” "
                                 "for this statement."),
        Item("dc_3", "I would be willing to share more sensitive information in a future conversation.",
             "disclosure"),
        Item("dc_4", "I held back information I would normally share with a counselor.", "disclosure",
             reverse=True),
    ),
)

GODSPEED_ANTHRO_BLOCK = LikertBlock(
    id="godspeed",
    title="Your overall impression",
    instructions="Please rate your impression of the therapist on these scales.",
    labels=("", "", "", "", ""),
    semantic=True,
    items=(
        Item("gs_anthro_1", left="Fake", right="Natural", subscale="anthro"),
        Item("gs_anthro_2", left="Machinelike", right="Humanlike", subscale="anthro"),
        Item("gs_anthro_3", left="Unconscious", right="Conscious", subscale="anthro"),
        Item("gs_anthro_4", left="Artificial", right="Lifelike", subscale="anthro"),
        Item("gs_anthro_5", left="Moving rigidly", right="Moving elegantly", subscale="anthro"),
    ),
)

MANIPULATION_CHECK = ChoiceQuestion(
    id="mc_embodiment",
    text="Which of these best describes the therapist you spoke with?",
    choices=(
        Choice("human", "A human therapist"),
        Choice("social_robot", "A social robot with an expressive, human-like face"),
        Choice("mechanical_robot", "A mechanical robot"),
        Choice("unsure", "I'm not sure"),
    ),
)

# Expected manipulation-check answer for each psiTurk condition index.
MC_EXPECTED = {0: "human", 1: "social_robot", 2: "mechanical_robot"}

COMMENTS_MAX_CHARS = 2000

# Primary outcomes first, so they are not influenced by the later questions;
# Godspeed (which asks how machine-like the therapist was) comes last.
POSTTEST_BLOCKS = (MDMT_BLOCK_A, MDMT_BLOCK_B, BI_BLOCK, CARE_BLOCK, DISCLOSURE_BLOCK,
                   GODSPEED_ANTHRO_BLOCK)


# --------------------------------------------------------------------------- #
# Validation & scoring helpers
# --------------------------------------------------------------------------- #

def _as_int(value) -> Optional[int]:
    """Coerce JSON numbers / numeric strings to int; None if impossible."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str) and value.strip().lstrip("-").isdigit():
        return int(value.strip())
    return None


def _clean_text(value, max_len: int) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text[:max_len] if text else None


def _mean_or_none(values: List[Optional[float]]) -> Optional[float]:
    present = [v for v in values if v is not None]
    return round(mean(present), 4) if present else None


def _validate_block(block: LikertBlock, responses: dict, errors: List[str]) -> Dict[str, Optional[int]]:
    """Validate every item of a Likert block. N/A becomes None when allowed."""
    cleaned: Dict[str, Optional[int]] = {}
    for item in block.items:
        raw = responses.get(item.id)
        if block.allow_na and raw in ("na", "NA", None) and item.id in responses:
            cleaned[item.id] = None
            continue
        value = _as_int(raw)
        if value is None or not (block.scale_min <= value <= block.scale_max):
            errors.append(f"{item.id}: expected an integer {block.scale_min}–{block.scale_max}"
                          + (" or 'na'" if block.allow_na else ""))
            continue
        cleaned[item.id] = value
    return cleaned


def _scored_values(blocks: Sequence[LikertBlock], cleaned: Dict[str, Optional[int]],
                   subscale: str) -> List[Optional[int]]:
    """Item values of one subscale across blocks, reverse-coded; None for N/A."""
    values: List[Optional[int]] = []
    for block in blocks:
        for item in block.items:
            if item.subscale != subscale:
                continue
            v = cleaned.get(item.id)
            if v is not None and item.reverse:
                v = block.scale_max + block.scale_min - v
            values.append(v)
    return values


def _scored(block: LikertBlock, cleaned: Dict[str, Optional[int]], subscale: str) -> Optional[float]:
    """Mean of a subscale with reverse-coding applied; NULL items are skipped."""
    return _mean_or_none(_scored_values((block,), cleaned, subscale))


def _factor(subscale_scores: List[Optional[float]], min_valid: int) -> Optional[float]:
    """Mean of subscale scores, only if at least `min_valid` of them exist (MDMT v2 rule)."""
    present = [s for s in subscale_scores if s is not None]
    return round(mean(present), 4) if len(present) >= min_valid else None


def _care_total(cleaned: Dict[str, Optional[int]]) -> Tuple[Optional[float], int]:
    """CARE total (10–50): up to CARE_MAX_NA N/A items are replaced by the mean of the rest."""
    values = _scored_values((CARE_BLOCK,), cleaned, "care")
    present = [v for v in values if v is not None]
    n_na = len(values) - len(present)
    if n_na > CARE_MAX_NA or not present:
        return None, n_na
    return round(sum(present) + n_na * mean(present), 4), n_na


def _validate_choice(q: ChoiceQuestion, responses: dict, errors: List[str]) -> Tuple[Optional[str], Optional[str]]:
    """Return (stored value, self-describe text). Multi-select is comma-joined."""
    allowed = {c.value for c in q.choices}
    raw = responses.get(q.id)
    if q.multiple:
        values = raw if isinstance(raw, list) else ([raw] if raw else [])
        values = [str(v) for v in values]
        if not values or any(v not in allowed for v in values):
            errors.append(f"{q.id}: select at least one valid option")
            return None, None
        if "prefer_not" in values and len(values) > 1:
            errors.append(f"{q.id}: 'Prefer not to say' cannot be combined with other options")
            return None, None
        stored = ",".join(v for v in (c.value for c in q.choices) if v in values)
        selected_self = q.self_describe_value in values
    else:
        if raw not in allowed:
            errors.append(f"{q.id}: select one valid option")
            return None, None
        stored = raw
        selected_self = raw == q.self_describe_value

    describe = None
    if q.self_describe_field and selected_self:
        describe = _clean_text(responses.get(q.self_describe_field), 100)
    return stored, describe


def score_pretest(responses) -> Tuple[dict, List[str]]:
    """Validate and score the pre-test. Returns (row_fields, errors)."""
    errors: List[str] = []
    if not isinstance(responses, dict):
        return {}, ["responses: expected an object"]

    row: dict = {}

    age = _as_int(responses.get("age"))
    if age is None or not (AGE_MIN <= age <= AGE_MAX):
        errors.append(f"age: expected an integer {AGE_MIN}–{AGE_MAX}")
    row["age"] = age

    row["gender"], row["gender_self_describe"] = _validate_choice(GENDER, responses, errors)
    row["ethnicity"], row["ethnicity_self_describe"] = _validate_choice(ETHNICITY, responses, errors)
    row["prior_therapy"], _ = _validate_choice(PRIOR_THERAPY, responses, errors)

    for block in PRETEST_BLOCKS:
        row.update(_validate_block(block, responses, errors))

    if not errors:
        row["ras_s1_mean"] = _scored(RAS_BLOCK, row, "s1")
        row["ras_s2_mean"] = _scored(RAS_BLOCK, row, "s2")
        row["ras_s3_mean"] = _scored(RAS_BLOCK, row, "s3")
        # Baseline robot anxiety score = mean of all 11 RAS items.
        row["ras_total_mean"] = _mean_or_none([row[i.id] for i in RAS_BLOCK.items])
        # ATSPPH-SF is conventionally reported as a sum (0–30).
        row["atspph_total"] = sum(_scored_values((ATSPPH_BLOCK,), row, "atspph"))
    return row, errors


def score_posttest(responses, condition: int) -> Tuple[dict, List[str]]:
    """Validate and score the post-test. Returns (row_fields, errors)."""
    errors: List[str] = []
    if not isinstance(responses, dict):
        return {}, ["responses: expected an object"]

    row: dict = {}
    for block in POSTTEST_BLOCKS:
        row.update(_validate_block(block, responses, errors))

    row["mc_embodiment"], _ = _validate_choice(MANIPULATION_CHECK, responses, errors)
    row["comments"] = _clean_text(responses.get("comments"), COMMENTS_MAX_CHARS)

    if not errors:
        # MDMT v2: subscale = mean of its non-N/A items; factors = mean of
        # subscale scores, computed only when at least two subscales exist.
        subs = {s: _mean_or_none(_scored_values(MDMT_BLOCKS, row, s))
                for s in MDMT_PERFORMANCE + MDMT_MORAL}
        for s, v in subs.items():
            row[f"mdmt_{s}_mean"] = v
        row["mdmt_performance_trust"] = _factor([subs[s] for s in MDMT_PERFORMANCE], 2)
        row["mdmt_moral_trust"] = _factor([subs[s] for s in MDMT_MORAL], 2)
        both = (row["mdmt_performance_trust"], row["mdmt_moral_trust"])
        row["mdmt_total_trust"] = round(mean(both), 4) if None not in both else None
        row["mdmt_na_count"] = sum(1 for b in MDMT_BLOCKS for i in b.items if row[i.id] is None)

        row["willingness_to_use_mean"] = _scored(BI_BLOCK, row, "bi")
        row["care_total"], row["care_na_count"] = _care_total(row)
        row["disclosure_comfort_mean"] = _scored(DISCLOSURE_BLOCK, row, "disclosure")
        row["godspeed_anthropomorphism_mean"] = _scored(GODSPEED_ANTHRO_BLOCK, row, "anthro")

        row["attention_check_passed"] = row[ATTENTION_CHECK_ID] == ATTENTION_CHECK_TARGET
        row["mc_correct"] = row["mc_embodiment"] == MC_EXPECTED.get(condition)
    return row, errors


def all_item_ids() -> Dict[str, List[str]]:
    """Every stored field name per survey — used for the start-up schema check."""
    pre = ["age", "gender", "gender_self_describe", "ethnicity", "ethnicity_self_describe", "prior_therapy"]
    pre += [i.id for b in PRETEST_BLOCKS for i in b.items]
    post = [i.id for b in POSTTEST_BLOCKS for i in b.items] + ["mc_embodiment", "comments"]
    return {"pretest": pre, "posttest": post}
