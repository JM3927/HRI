# Therapist Embodiment Study — psiTurk experiment

Between-subjects psiTurk 3 experiment comparing comfort, trust and willingness to
consult three therapist embodiments that deliver the **same** branching
clinical-intake script:

| psiTurk `condition` | Key       | Embodiment                                   | Media files                          |
|---------------------|-----------|----------------------------------------------|--------------------------------------|
| 0                   | `human`   | Human therapist (filmed actor)               | `static/video/human/*.mp4`           |
| 1                   | `furhat`  | Furhat social robot (Furhat SDK, recorded)   | `static/video/furhat/*.mp4`          |
| 2                   | `peerbot` | Mechanical, Peerbot-style robot (robotic TTS)| `static/audio/peerbot/*.mp3` for now |

Peerbot's format is not decided yet. It plays `.mp3` audio with the drawn robot
until its footage exists; then set its `media` to `'video'` in `CONDITIONS` in
`static/js/task.js` and put the `.mp4` files in `static/video/peerbot/`
(see [Video mode](#video-mode-recorded-robots-and-actor)).

Built and smoke-tested against **psiTurk 3.3.1** (Flask 1.1, SQLAlchemy 1.3).

---

## Participant flow

```
/consent ─Agree─▶ /briefing ─▶ /pretest ─▶ /exp ─▶ /posttest ─▶ /complete
   │ Decline: nothing stored                   │
   │                              POST /api/save_trial  (one row per answered node)
                         POST /api/save_pretest                POST /api/save_posttest
```

1. **Consent** — IRB-style form; *Agree* unlocks only after three affirmations.
2. **Study briefing** (`templates/briefing.html`). This is the usual HRI briefing between
   consent and the first questionnaire, with one topic per page:
   * what the study is about (same cover framing for everyone);
   * the three parts and how long each takes;
   * how the conversation works;
   * what is and is not recorded;
   * how to stop or get support;
   * a prompt to ask the researcher questions before starting.

   It is identical in every condition, does not name the conditions or the hypotheses,
   and stores nothing. The pre-test cannot be opened without passing through it.
3. **Pre-test** — age, gender, race/ethnicity, therapy history, tech familiarity,
   robot exposure, help-seeking attitudes (ATSPPH-SF), openness to AI counseling,
   Robot Anxiety Scale (11 items, 3 subscales; introduced with the same cover line
   for everyone: the study compares different kinds of counselors, some of them robots).
4. **Conversation** — audio preloaded into memory → sound check → 6 or 7 questions.
   Each node: therapist prompt plays → options appear on `ended` → click → latency
   saved → condition-specific acknowledgment plays → next node.
5. **Post-test** — primary outcomes first: trust (MDMT v2 → Performance & Moral
   trust) and willingness to use (UTAUT behavioural intention); then perceived
   empathy (CARE), disclosure comfort (with the attention check), Godspeed
   Anthropomorphism, the manipulation check and an optional comment.
6. **Complete** — psiTurk participant marked COMPLETED; debrief with completion code
   and support resources.

Pages are gated server-side, so a participant cannot skip ahead, redo the conversation
after finishing it, or re-take the pre-test.

## Screen layout: no scrolling

No page ever shows a scroll bar. The window is a fixed column (header, content, crisis
footer), and `static/js/pager.js` splits long content into screen-sized pages with
**Back / Next** and a "Page n of N" counter:

* **Consent, debrief, lab console, notices:** sections are packed into pages. A section
  that continues onto the next page repeats its heading, and the consent affirmations
  always sit on the last page next to *I agree*, *I do not agree* and *Print a copy*.
  Printing still prints the whole consent form.
* **Study briefing:** each topic starts on its own page (`data-pager-break` on its
  `<section>`); a topic too tall for the screen continues on the next page. Add
  `data-pager-break` to any unit or section, on any paged page, to force a page break there.
* **Questionnaires:** each question (or Likert row) is placed whole. A Likert block that
  continues repeats its title, instructions and column headings. *Next* only advances
  once every question on the page is answered (unanswered ones are highlighted).
* **Conversation:** the session fills the window. The avatar is the largest square that
  fits, at least 140 px on phones, and the options always stay on screen. On short
  screens the sound-check dialog becomes two steps.

Pages are rebuilt for the actual window size (and again if it is resized), so the page
count depends on the screen. At 1366×657 (a 768-px laptop with browser bars), the
pre-test is about 11 pages and the post-test about 14; at 1920×969 they are about 5 and
7. If a single question is taller than the screen, the font is reduced (down to 12 px)
and, as a last resort, that question is zoomed out. It is never cut off. For the fewest
pages, run sessions in a maximised browser window or full screen (F11).

## Files

```
custom.py               Blueprint: page routes, protocol gates, REST API, researcher console, CSV export
models.py               PreTestSurvey, BranchingTrialLog, PostTestSurvey (on psiTurk's Base)
instruments.py          All questionnaire items: drives rendering, validation and scoring
templates/
  layout.html           Shared shell (header, crisis-line footer)
  macros.html           Likert-matrix and choice-question macros
  consent.html          Informed consent
  briefing.html         Study briefing (after consent, before the pre-test)
  pretest.html          Pre-test survey
  exp.html              Trial layout: preloader modal, avatar, visualiser, question card
  posttest.html         Post-test survey
  complete.html         Debrief + completion code
  message.html          Generic notices (bad link, already participated, …)
  lab.html              Researcher console (/lab)
static/js/task.js       Preloader, BranchingEngine, AudioPlayer, AvatarRenderer, Visualizer, DataCollector, Session
static/js/survey.js     Shared survey form logic (per-page validation)
static/js/pager.js      Splits long pages into screen-sized pages (no scrolling anywhere)
static/css/style.css    Styles
tools/audio_assets.py   Exports the recording script; verifies audio/video files
tools/record_takes.py   Records the video clips through OBS (drives the Furhat virtual robot, or teleprompter mode)
```

## Installation

Copy these files into your existing psiTurk project (the one that already has your
`config.txt`). They replace the scaffold's `custom.py`, `templates/consent.html`,
`templates/exp.html`, `templates/complete.html` and `static/js/task.js`. **Keep** the
scaffold's `templates/error.html`, `closepopup.html`, `thanks-mturksubmit.html` and
`static/lib/` — psiTurk requires them, and `exp.html` loads jQuery, Underscore and
Backbone from `static/lib/` for `psiturk.js` (which psiTurk serves itself).

`config.txt` is not modified by this code, but it **must** contain:

```ini
[Task Parameters]
num_conds = 3
num_counters = 1
```

At start-up `custom.py` logs an error if `num_conds` is not 3. If you want remote
researcher access to `/lab`, also set `login_username` / `login_pw` under
`[Server Parameters]`; otherwise `/lab` answers only to requests from localhost.

Edit `STUDY_INFO` at the top of `custom.py` (PI, IRB protocol, contact, compensation,
crisis lines) before collecting data.

The custom tables are created automatically on first start (psiTurk's `init_db()`).

## Media assets

The dialogue tree lives in `static/js/task.js` between `/* BEGIN_DIALOGUE_TREE */`
and `/* END_DIALOGUE_TREE */` (strict JSON). It has 28 clips per condition (7
prompts + 21 acknowledgments), about 680 words, ≈ 4.5 min of speech per voice.
Each clip id is one file, in the format that condition's `media` setting asks for:

```
static/video/human/<clip_id>.mp4      + static/video/human/idle.mp4
static/video/furhat/<clip_id>.mp4     + static/video/furhat/idle.mp4
static/audio/peerbot/<clip_id>.mp3    (until Peerbot is switched to video)
```

```bash
python tools/audio_assets.py script
```

writes `audio_script.csv` with every clip id, its transcript and the exact file
path for each condition (`.mp4` for Human and Furhat, `.mp3` for Peerbot, and the
`idle.mp4` row for the video conditions). It is the actor's script and the text
for the Peerbot TTS; the Furhat takes read the same tree automatically (see
[Recording the clips](#recording-the-clips)). Then:

```bash
python tools/audio_assets.py check
```

checks each condition in its own format and exits non-zero if any file is missing
or empty. Normalise loudness across conditions (e.g. −16 LUFS) and trim leading
silence so prompt onsets are comparable. For the video clips `record_takes.py`
normalises loudness itself and gives every take the same `--preroll`; for the
actor, start each line right after the recording starts so the lead-in matches.

If a clip is missing at run time, the preloader lists every failed file and will
not start. In **debug** mode only, a *Continue with simulated audio* button lets
you pilot the flow without recordings: speech timing is simulated from the
transcript length, captions are shown, and trials are flagged `audio_simulated`.

To show a photograph or video still instead of a drawn avatar, set `portrait` for
that condition in `CONDITIONS` in `task.js`; it is preloaded with the audio.

## Video mode (recorded robots and actor)

Each condition in `CONDITIONS` in `static/js/task.js` has `media: 'audio'` or
`media: 'video'`. Human and Furhat are set to `'video'`; Peerbot is `'audio'`
until you decide. In video mode the participant sees recorded footage instead of
the drawn avatar:

```
static/video/<condition>/idle.mp4          silent "listening" loop, plays (muted, looping) the whole time
static/video/<condition>/<clip_id>.mp4     the same 28 clip ids as the audio, picture and sound in one file
```

Each clip `.mp4` carries its own soundtrack: there is no separate `.mp3` for a
video condition, and nothing under `static/audio/human/` or `static/audio/furhat/`
is used. The sound is played from the video file itself (and drives the
visualiser), so keep picture and sound in sync in the export. Only `idle.mp4`
is silent; any sound in it is ignored.

When a clip plays it is layered over the idle loop and appears on its first
`playing` event; when it ends, the idle loop is visible again. Everything is
preloaded into memory exactly like the audio (allow ~1 minute for large files),
and the timing rules are unchanged: options appear on the clip's `ended` event.
`prompt_audio_onset_ms` then measures video start-up (about 50 ms in testing,
versus a few ms for audio); it does not affect `choice_latency_ms`, which is
timed from when the options are painted. psiTurk's question data records
`media_mode` for each participant.

The stage is square and uses `object-fit: cover`, so 16:9 footage shows its
centre square: keep the face centred. **Decide Peerbot before collecting real
data.** While Human and Furhat are footage and Peerbot is a drawn robot, any
Peerbot difference could come from the presentation format rather than the
embodiment. Switching it is one word (`media: 'video'`) plus its files. In debug mode a missing video offers the
same *simulated* fallback as audio, with the drawn avatar.

### Recording the clips

`tools/record_takes.py` records one condition at a time. It starts and stops
OBS Studio for each take, then converts the take to web-ready H.264/AAC MP4
(loudness normalised to −16 LUFS, the idle loop without sound) under the right
name. Raw takes are kept in `recordings/<condition>/`.

```bash
pip install obsws-python furhat-remote-api
sudo apt install ffmpeg
python tools/record_takes.py --condition furhat --backend furhat --dry-run   # see the plan first
python tools/record_takes.py --condition furhat --backend furhat
python tools/record_takes.py --condition peerbot --backend manual
python tools/record_takes.py --condition human --backend manual
python tools/record_takes.py --condition furhat --backend furhat --only n2_stressor,idle   # redo some
python tools/audio_assets.py check            # each condition in its own format
```

* **OBS:** enable *Tools → WebSocket Server Settings → Enable WebSocket server*
  (pass `--obs-password`, or set `OBS_WS_PASSWORD`). Use a Window Capture of just
  the robot, plus desktop audio, on a canvas with the subject centred.
* **`--backend furhat`:** start the virtual robot from the Furhat SDK with its
  Remote API skill running (port 54321). For every take the script makes Furhat
  look into the camera (`--gaze`), nods at the start of each reply
  (`--response-gesture`, empty for none; `--prompt-gesture` for questions) and
  speaks the line with its TTS (`--voice` to choose the voice). Unknown gesture
  names are reported and skipped. The idle take is 15 s (`--idle-seconds`) of
  the robot's own idle behaviour.
* **`--backend manual`:** teleprompter mode for anything the script cannot drive.
  Press Enter to start recording, perform the line (or trigger the Peerbot from
  its own SDK), then press Enter to stop. For the human condition, film the actor
  against the same neutral background, with the same framing, lead-in and tail.
* After each take: *Enter* keeps it, *p* plays it, *r* redoes, *s* skips,
  *q* quits. `--auto` keeps every take; `--skip-existing` resumes a session.
* `--preroll` / `--postroll` (0.5 s / 0.6 s) add still frames around each line.
  Keep them the same for every condition, because the tail delays when the
  options appear.
* If the Peerbot SDK turns out to be scriptable, add a backend class with
  `setup()` and `perform(take)` next to `FurhatBackend` and register it in `BACKENDS`.

## Running sessions in the lab (no AMT / Prolific)

1. Start the server: `psiturk server on` (Linux/macOS). psiTurk's gunicorn launcher
   does not run on Windows; there, start Flask directly from the project folder:
   `python -c "from psiturk.experiment import app; app.run(host='127.0.0.1', port=22362, threaded=True)"`.
2. Open `http://localhost:22362/lab`, enter a participant code, choose **Live** or
   **Practice/pilot**, click *Start*, and hand over the workstation.
3. `/lab` shows started / completed counts per condition and links to CSV exports
   of the three custom tables (`/lab/export/pretest.csv`, `trials.csv`,
   `posttest.csv`).

Practice runs get a `debug-` prefix on their ids. psiTurk treats those as debug
sessions (restartable, never flagged as quitters), and they are stored with
`mode = debug` so you can exclude them. In live mode psiTurk marks the participant
STARTED when the conversation begins, so a reload of `/exp` is refused, and
re-using a participant code under a new session id is blocked.

## Reaction-time methodology

* **Preloading.** Each clip is downloaded to a `Blob`, wrapped in an object URL and
  played by an `HTMLAudioElement` awaited to `canplaythrough`. Playback never touches
  the network. `prompt_audio_onset_ms` (from `play()` to the `playing` event) is
  logged per trial so you can confirm this; expect a few ms.
* **Options shown.** Buttons are inserted disabled; `t_options_shown` is taken in the
  second `requestAnimationFrame` after insertion (after the frame containing them
  has painted), and only then are they enabled. Latency can't be negative and isn't
  inflated by layout time. If the tab is not being painted (hidden, minimised), the
  options stay locked until it is.
* **Click.** `choice_latency_ms = click.timeStamp − t_options_shown`, both on the
  `performance.now()` clock. `pointerdown_latency_ms` (press rather than release) is
  stored too. Browser timer resolution is about 0.1 ms in Chrome and 1 ms in Firefox.
* **Quality flags.** `tab_hidden_during_choice`, `input_modality`,
  `audio_watchdog_fired` (the `ended` event never arrived), `audio_simulated`.

## Data dictionary (custom tables)

All tables join to psiTurk's `assignments` table on `uniqueid` (`workerId:assignmentId`).

**pretest_survey** — `age`, `gender` (+`_self_describe`), `ethnicity` (comma-separated
codes, +`_self_describe`), `prior_therapy` (yes/no/prefer_not), `tech_familiarity`,
`robot_exposure`, `ras_s1_1…ras_s3_4`, `ras_s1_mean`, `ras_s2_mean`, `ras_s3_mean`,
`ras_total_mean` (baseline robot anxiety), `atspph_1…atspph_10` (raw 0–3) →
`atspph_total` (0–30, items 2/4/8/9/10 reversed), `ai_counseling_openness` (1–7),
`consent_version`, `mode`, `submitted_at`.

**branching_trial_log** — `run_id` (one per page load), `condition`, `condition_label`,
`trial_index`, `stage` (1–6), `node_id`, `question_text`, `selected_choice_index`,
`choice_code`, `choice_text`, `next_node_id` (NULL at the end), `is_terminal`,
`path_so_far`, `choice_latency_ms`, `pointerdown_latency_ms`, `options_shown_epoch_ms`,
`prompt_audio_duration_ms`, `prompt_audio_onset_ms`, the quality flags above,
`client_timestamp`, `timestamp` (server UTC). The condition stored is the server's
assignment, never the browser's.

**posttest_survey**
* **Trust (primary)** — 20 MDMT v2 items `mdmt_<word>` (0–7, NULL = “Does not fit”) →
  subscales `mdmt_reliable_mean`, `mdmt_competent_mean`, `mdmt_ethical_mean`,
  `mdmt_sincere_mean`, `mdmt_benevolent_mean` → **`mdmt_performance_trust`** (Reliable +
  Competent, both required), **`mdmt_moral_trust`** (Ethical + Sincere + Benevolent, at
  least two required), `mdmt_total_trust` (both factors required), `mdmt_na_count`.
  Factors are means of subscale scores, as the scale sheet specifies.
* **Willingness to use (primary)** — `bi_1…bi_3` (1–7) → **`willingness_to_use_mean`**.
* **Perceived empathy** — `care_1…care_10` (1–5, NULL = “Does not apply”) →
  `care_total` (10–50; NULL when more than two items are N/A), `care_na_count`.
* **Disclosure comfort (exploratory)** — `dc_1…dc_4` (`dc_4` reversed) →
  `disclosure_comfort_mean`.
* **Godspeed Anthropomorphism** — `gs_anthro_1…5` (1–5) → `godspeed_anthropomorphism_mean`.
* **Checks** — `attention_check` / `attention_check_passed`, `mc_embodiment` /
  `mc_correct`; `comments`.

All scores are computed on the server from the raw items. Because the columns changed,
a `participants.db` created by an earlier version is refused at start-up with
instructions to move it aside.

## Instrument notes

* **RAS** (Nomura, Kanda, Suzuki & Kato, 2006/2008): the original uses a 6-point
  format; this study uses 7 points as specified. The item wording is an English
  rendering, so check it against the version approved by your IRB.
* **ATSPPH-SF** (Fischer & Farina, 1995): 10 items, 0–3, summed. Check the wording
  against the 1995 article.
* **MDMT v2** (Malle & Ullman, 2021, 2023; scale sheet 2025-09-01 at
  research.clps.brown.edu/SocCogSci/Measures): 0–7 plus “Does not fit”, presented in
  the authors’ two balanced 10-item blocks. The authors ask users to email
  scsrc@brown.edu.
* **Behavioural intention** (Venkatesh et al., 2003, UTAUT): the three BI items with
  “a counselor like this one” and a 6-month horizon.
* **CARE** (Mercer et al., 2004): © SW Mercer; free for non-commercial use, but check
  its terms. Descriptions adapted for a counselor (no doctor-specific wording).
* **Godspeed Anthropomorphism** (Bartneck et al., 2009): used as a graded
  manipulation check, asked last so it cannot prime the trust ratings.
* Disclosure comfort (`dc_*`) is study-specific and not validated: report it as exploratory.
* Post-test wording is identical across conditions; the template never receives
  the condition.

## Ethics notes

* The crisis line (988, US) appears in the footer of every page, the same for all conditions.
* The debrief explains that the conversation was pre-recorded and scripted, with no
  live listener. Review it against your protocol if your design uses deception
  about the human condition.
* No audio or video of the participant is recorded (OBS is used only to record the
  stimuli, never during sessions).
