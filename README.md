# Counselor Conversation Study (HRI)

**Conversations with Different Kinds of Counselors** — a between-subjects human–robot
interaction experiment run on [psiTurk](https://psiturk.org) 3.3.1.
Purdue University Northwest · PI: Justin Meng (meng172@pnw.edu).

Participants watch and listen to one of three recorded counselors, chosen at random, who
lead the **same** short, branching mental-health check-in. Only the counselor's
embodiment differs. Afterwards, participants rate how much they trusted the counselor and
whether they would use one like it.

| `condition` | Key       | Counselor                                  | Clips                       |
|-------------|-----------|--------------------------------------------|-----------------------------|
| 0           | `human`   | Human therapist (filmed actor)             | `static/video/human/*.mp4`  |
| 1           | `furhat`  | Furhat social robot (Furhat SDK recording) | `static/video/furhat/*.mp4` |
| 2           | `peerbot` | Mechanical, Peerbot-style robot            | `static/video/peerbot/*.mp4`|

The counselor introduces itself as "Jackson" in every condition. Each condition has 28
speaking clips plus a silent `idle.mp4` loop (87 videos in total, about 400 MB, stored
with Git LFS).

**Primary outcomes:** trust (MDMT v2: Performance and Moral trust) and willingness to use
(UTAUT behavioural intention). Everything else is a covariate, a secondary outcome or a
data-quality check.

---

## Contents

* [Participant flow](#participant-flow)
* [Setting up on Ubuntu](#setting-up-on-ubuntu)
* [Running sessions](#running-sessions)
* [Questionnaires](#questionnaires)
* [The conversation](#the-conversation)
* [Videos and recording](#videos-and-recording)
* [Data](#data)
* [Where to edit things](#where-to-edit-things)
* [Files](#files)
* [Notes for the write-up](#notes-for-the-write-up)

---

## Participant flow

```
/consent ─Agree─▶ /pretest ─▶ /briefing ─▶ /avcheck ─▶ /exp ─▶ /posttest ─▶ /complete
   │                  │                                 │          │
   │ Decline: nothing stored                            │   POST /api/save_trial (one row per answer)
             POST /api/save_pretest                             POST /api/save_posttest
```

| # | Page | What happens |
|---|------|--------------|
| 1 | **Consent** (`/consent`) | One page, never split: purpose, what you will do, risks, confidentiality, voluntary participation, contact (in columns on a computer screen; the text shrinks to fit a small window). *I agree* unlocks only after two affirmations: 18 or older, and read and understood. *Print a copy* prints it. *I do not agree* stores nothing. |
| 2 | **About you** (`/pretest`) | Demographics first (age, gender, prior therapy), then experience with technology and robots, help-seeking attitudes, openness to an AI/robot counselor, robot anxiety (23 questions). |
| 3 | **Study briefing** (`/briefing`) | Seven topics, one per page: what the study is about, **the three counselors (with a picture of each)**, what will happen (with times; "About you" shown as done), how the conversation works, what is and is not recorded, looking after yourself, and an invitation to ask the researcher questions. Stores nothing. |
| 4 | **Video and sound check** (`/avcheck`) | Its own page. The participant plays a short test video (`static/video/avcheck.mp4`) and ticks "I can see the video" and "I can hear the sound clearly". The boxes unlock only after the video has played to the end, and *Continue* only once both are ticked; "It isn't working" shows troubleshooting tips. Stores nothing. |
| 5 | **Conversation** (`/exp`) | The counselor's videos load (a progress bar in the page, no overlay), then *Begin the conversation*, then 6 or 7 questions, each answered by clicking one of three options. |
| 6 | **Your impressions** (`/posttest`) | Trust, willingness to use, empathy, disclosure comfort (including the attention check), anthropomorphism, "which counselor did you speak with?", and a required final comment (39 questions including the comment). |
| 7 | **Debrief** (`/complete`) | Explains the study and the three conditions, says the conversation was pre-recorded and scripted, asks participants not to discuss it, and repeats the support resources. The participant is marked COMPLETED. |

* **Pages are gated on the server.** "About you" needs consent, the briefing needs the
  saved "About you" answers, the video and sound check needs the briefing, the
  conversation needs the check, and so on. A
  participant cannot skip ahead, redo the conversation, or retake a questionnaire.
* **Same framing for everyone.** The consent and "About you" say only that the study
  compares "different kinds of counselors, and some of them are robots". The briefing
  then shows all three counselors to everyone, but never which one the participant will
  meet. The hypotheses are explained only in the debrief. Questionnaire wording is
  identical across conditions; the post-test page is never told the condition.
* **Support line on every page.** The footer shows 988 (US Suicide & Crisis Lifeline)
  and the Crisis Text Line (text HOME to 741741).
* **No scrolling.** No page ever scrolls. `static/js/pager.js` splits long content into
  screen-sized pages with **Back / Next** and "Page n of N". Each questionnaire page
  must be answered before *Next* works. The page count depends on the window size, so
  run sessions in a maximised window or full screen (F11) for the fewest pages.

---

## Setting up on Ubuntu

Tested with Python 3.10, psiTurk 3.3.1, Flask 1.1.4, SQLAlchemy 1.3.24, Jinja2 2.11.3.

**1. Get the code and the videos.** The videos are stored with Git LFS. Without it you
get 3-line placeholder files instead of videos, and the conversation will not load.

```bash
sudo apt install git git-lfs ffmpeg python3-venv
git lfs install
git clone https://github.com/JM3927/HRI.git
cd HRI
git lfs pull
```

**2. Install psiTurk** in a virtual environment:

```bash
python3 -m venv ~/psiturk-env
source ~/psiturk-env/bin/activate
pip install psiturk==3.3.1
pip install -U pyopenssl
```

**3. Create `config.txt`.** It is not in the repository (it holds passwords and is in
`.gitignore`). Start from psiTurk's default, for example with `psiturk-setup-example`
in another folder, and copy its `config.txt` here. Then set:

```ini
[Database Parameters]
assignments_table_name = Therapy_Participant_Data   ; optional; the default is "assignments"

[Server Parameters]
host = 0.0.0.0
port = 22362
login_username = <choose one>
login_pw = <choose a strong password>
secret_key = <long random string>

[Task Parameters]
num_conds = 3
contact_email_on_error = meng172@pnw.edu
```

* `num_conds = 3` is **required** for the three conditions; the server logs an error at
  start-up if it is anything else.
* `login_username` / `login_pw` protect the researcher console and data exports. They
  are **required**: without them `/lab` stays closed. Never commit them.

**4. Start the server:**

```bash
psiturk server on
```

The database (`participants.db`, also git-ignored) and its tables are created on the
first start. Stop the server with `psiturk server off`. **Restart it after editing any
file**, because pages are cached while it runs.

**5. Check the videos:**

```bash
python3 tools/audio_assets.py check
```

It prints `29/29 files present (incl. idle.mp4)` for each condition when every clip is
there.

---

## Running sessions

1. Open `http://<server>:22362/lab` and log in with `login_username` / `login_pw`.
   The login is asked for on every computer, including the server itself, because a
   tunnel such as Tailscale Funnel makes internet visitors look local.
2. Enter a participant code and choose the mode:
   * **Live participant:** real data. Re-using a participant code is blocked. If the
     window is closed by mistake, opening the same link again resumes where they left off.
   * **Practice / pilot:** ids get a `debug-` prefix and are stored with `mode = debug`,
     so you can exclude them. Reusing codes is allowed, and opening a practice link
     again (or the `/ad` link from `psiturk debug`) always starts the whole study over
     from consent, as a new run: a `-r` tag is added to the ids, and the earlier
     run stays in the data under its own ids.
3. Click *Start session on this workstation* and hand the computer to the participant.
   They need headphones.
4. The console shows how many sessions have started and completed in each condition, and
   links to the data exports.

**Assignment.** psiTurk assigns each new participant at random to one of the conditions
with the fewest participants (counted separately for each mode), so the groups stay
balanced.

**Pilot without videos.** In practice mode only, if videos fail to load, *Continue with
simulated audio (debug only)* runs the flow with a drawn avatar and captions. Those
answers are flagged `audio_simulated`.

---

## Questionnaires

All items live in `instruments.py`, which drives how they are displayed, validated and
scored. Scores are computed on the server.

### About you (pre-test)

| Block | Items | Scale | Score |
|-------|-------|-------|-------|
| Demographics: age, gender, prior therapy (asked first) | 3 | choices; age 18–80 | — |
| Experience with technology | 2 | 1–7 | `tech_familiarity`, `robot_exposure` |
| Attitudes toward seeking help: MHSAS, 2026 version (Hammer et al.), with its imagined-scenario instructions | 9 | 1–6 word pairs, positive word on the right; no reverse scoring | `mhsas_mean` (1–6) |
| Openness to an AI or robotic counselor | 1 | 1–7 | `ai_counseling_openness` |
| Feelings about robots: Robot Anxiety Scale (Nomura et al.), S1 and S3 only | 3 + 4 | 1–7 | `ras_s1_mean`, `ras_s3_mean`, `ras_total_mean` (mean of the 7 items) |

### Your impressions (post-test), in this order

| Block | Items | Scale | Score |
|-------|-------|-------|-------|
| **Trust:** MDMT v2 (Malle & Ullman), two blocks: "The therapist is…" | 7 + 9 | 0 (Not at all) – 7 (Very), plus *Does not fit* | see below |
| **Willingness to use:** UTAUT behavioural intention (Venkatesh et al., 2003) | 3 | 1–7 agree | `willingness_to_use_mean` |
| Empathy: CARE measure (Mercer et al., 2004), items 1–8 | 8 | 1 (Poor) – 5 (Excellent), plus *Does not apply* | `care_total` (8–40) |
| Comfort and disclosure (study-specific) + attention check | 4 + 1 | 1–7 agree; `dc_4` reversed | `disclosure_comfort_mean`, `attention_check_passed` |
| Godspeed Anthropomorphism (Bartneck et al., 2009) | 5 | 1–5 semantic differential | `godspeed_anthropomorphism_mean` |
| Which counselor did you speak with? (manipulation check) | 1 | human / social robot / mechanical robot / unsure | `mc_correct` |
| Comment: "Is there anything else you would like to tell us about the conversation?" | 1, required | free text, up to 2000 characters | — |

**MDMT words used (16 of the original 20):**

| Dimension | Words | Factor |
|-----------|-------|--------|
| Reliable | reliable, predictable, dependable, consistent | Performance trust |
| Competent | competent, skilled, capable, meticulous | Performance trust |
| Ethical | ethical, moral, integrous | Moral trust |
| Sincere | sincere, truthful, genuine | Moral trust |
| Benevolent | kind, considerate | Moral trust |

* `mdmt_<dimension>_mean` is the mean of that dimension's words (*Does not fit* is left out).
* `mdmt_performance_trust` is the mean of Reliable and Competent; both are required.
* `mdmt_moral_trust` is the mean of Ethical, Sincere and Benevolent; at least two are required.
* `mdmt_total_trust` is the mean of the two factors, and `mdmt_na_count` counts the *Does not fit* answers.

**Scoring rules**
* **CARE:** up to 2 *Does not apply* answers are replaced by the mean of the other items.
  With more than 2, `care_total` is left empty.
* **Attention check:** "please select *Somewhat disagree*" (value 3).
* **Manipulation check:** correct answers are human → `human`, Furhat → `social_robot`,
  Peerbot → `mechanical_robot`.

---

## The conversation

A scripted, branching check-in in six stages, shown in a progress bar above the counselor:

| Stage | Node | Question shown on screen | Next |
|-------|------|--------------------------|------|
| 1 Check-in | `n1_opening` | How have you been feeling over the past couple of weeks? | `n2_stressor` |
| 2 What's on your mind | `n2_stressor` | What has been weighing on you most lately? | `n3_coping` |
| 3 Coping | `n3_coping` | When stress shows up, what do you tend to do? | `n4_support` |
| 4 Support | `n4_support` | When things get difficult, how supported do you feel? | `n5_goals`, or `n4b_connection` after "I often feel like i don't have anyone to talk to" |
| 4 Support | `n4b_connection` | What makes it hardest to connect with other people? | `n5_goals` |
| 5 Goals | `n5_goals` | What would you most want to get out of future conversations? | `n6_wrapup` |
| 6 Wrap-up | `n6_wrapup` | Does that feel like a fair summary of our conversation? | end |

The counselor's spoken line for each node (`prompt` in the dialogue tree) is longer than
the on-screen question and is what the clip must contain.

Every question has three answers, and every answer has its own short spoken reply, so
there are 7 question clips + 21 reply clips = 28 clips per counselor. Participants answer
6 questions, or 7 if they get the follow-up.

**How a question plays:**
1. The question video plays over the silent idle loop.
2. When it ends, the answer buttons appear.
3. The participant clicks one, and the answer is saved immediately.
4. The reply video for that answer plays.
5. The next question starts.

Clips cannot be paused or replayed.

**Reaction time.** All videos are downloaded into memory before the conversation starts,
so playback never waits on the network. The answer buttons are enabled only once they
have actually been drawn on screen; `choice_latency_ms` runs from that moment to the
click (`pointerdown_latency_ms` measures to the press). These are saved as quality flags:
- `tab_hidden_during_choice`;
- `input_modality` (mouse, touch, pen or keyboard);
- `audio_watchdog_fired` (a clip never reported that it ended);
- `audio_simulated`.

---

## Videos and recording

```
static/video/<human|furhat|peerbot>/<clip_id>.mp4   28 clips, picture and sound in one file
static/video/<human|furhat|peerbot>/idle.mp4        10–20 s silent "listening" loop
```

* **Clip names** follow the dialogue node ids: `n1_opening.mp4` is the question, and
  `n1_opening_r0.mp4` … `_r2.mp4` are the replies to answers A–C.
  `python3 tools/audio_assets.py script` writes `audio_script.csv` with every clip id, its
  exact words and its file path for each condition. Use it as the recording script.
* **Each clip carries its own sound.** There are no separate audio files. `idle.mp4`
  always plays muted.
* **Framing.** The counselor is shown in a square, and 16:9 footage is cropped to its
  centre, so keep the face centred.
* **Consistency.** Use the same framing, background and lead-in/tail for every clip and
  every condition. Start and end `idle.mp4` in the same pose so the loop doesn't jump.

**`tools/record_takes.py`** records one condition at a time through OBS Studio, then
converts each take to web-ready MP4 (H.264/AAC, loudness normalised to −16 LUFS) under
the right name. Raw takes are kept in `recordings/<condition>/`.

```bash
pip install obsws-python furhat-remote-api
python3 tools/record_takes.py --condition furhat --backend furhat --dry-run   # show the plan
python3 tools/record_takes.py --condition furhat --backend furhat             # drives the Furhat virtual robot
python3 tools/record_takes.py --condition human --backend manual              # teleprompter for the actor
python3 tools/record_takes.py --condition peerbot --backend manual
python3 tools/record_takes.py --condition furhat --backend furhat --only n2_stressor,idle   # redo some
```

* **OBS:** enable *Tools → WebSocket Server Settings → Enable WebSocket server*, and pass
  `--obs-password` or set `OBS_WS_PASSWORD`.
* **Furhat:** run the Furhat SDK virtual robot with its Remote API skill (port 54321).
  The script points its gaze at the camera, nods at the start of each reply and speaks
  each line with Furhat's voice.
* **After each take:** *Enter* keeps it, *p* plays it back, *r* redoes, *s* skips, *q*
  quits. `--skip-existing` resumes an earlier session.

After changing any spoken line in `static/js/task.js`, re-record that clip in all three
conditions and regenerate `audio_script.csv`.

---

## Data

The researcher console's export links, or `/lab/export/<name>.csv`, download three
tables. Each row joins to psiTurk's participant table (`Therapy_Participant_Data`) on
`uniqueid` (`workerId:assignmentId`).

**`pretest.csv` (pretest_survey)**
- Background: `age`, `gender` (+ `gender_self_describe`), `prior_therapy`,
  `tech_familiarity`, `robot_exposure`. Race/ethnicity is not asked.
- Help-seeking: `mhsas_1…9` (raw 1–6) and `mhsas_mean`.
- Openness: `ai_counseling_openness`.
- Robot anxiety: `ras_s1_1…3`, `ras_s3_1…4`, `ras_s1_mean`, `ras_s3_mean`, `ras_total_mean`.
- Session: `consent_version`, `mode`, `submitted_at`.

**`trials.csv` (branching_trial_log)**, one row per answered question:
- Position: `run_id`, `condition`, `condition_label`, `trial_index`, `stage`, `node_id`,
  `question_text`.
- The answer: `selected_choice_index`, `choice_code`, `choice_text`, `next_node_id`,
  `is_terminal`, `path_so_far`.
- Timing: `choice_latency_ms`, `pointerdown_latency_ms`, `options_shown_epoch_ms`,
  `prompt_audio_duration_ms`, `prompt_audio_onset_ms`.
- The quality flags listed above, plus `client_timestamp` and `timestamp` (server, UTC).

The condition saved is the one the server assigned, never what the browser reports.

**`posttest.csv` (posttest_survey)**
- Trust: the MDMT words `mdmt_<word>` (0–7, empty = *Does not fit*), the dimension means
  and the trust factors.
- `bi_1…3` and `willingness_to_use_mean`.
- `care_1…8`, `care_total` and `care_na_count`.
- `dc_1…4` and `disclosure_comfort_mean`.
- `gs_anthro_1…5` and `godspeed_anthropomorphism_mean`.
- `attention_check` / `attention_check_passed`, `mc_embodiment` / `mc_correct`, `comments`.

**Leftover empty columns.** Some columns belong to items that were removed from the
questionnaires and always stay empty: `ras_s2_*`, `mdmt_benevolent`, `mdmt_principled`,
`mdmt_frank`, `mdmt_goodwill`, `care_9` and `care_10`. Ignore them.

psiTurk's own data for each participant also records `condition_label`, `media_mode`, the
answer path, start/finish times and the browser.

**Suggested exclusions** (decide and pre-register them before collecting data):
- `mode = debug`;
- failed attention check;
- failed manipulation check;
- `audio_simulated` or `audio_watchdog_fired` trials.

---

## Where to edit things

After any edit, restart the server (`psiturk server off`, then `psiturk server on`).

| To change… | Edit |
|------------|------|
| Study title, institution, PI, contact email, duration, crisis lines | `STUDY_INFO` at the top of `custom.py` |
| Consent wording | `templates/consent.html` (change `CONSENT_VERSION` in `custom.py` when you do) |
| Study briefing | `templates/briefing.html`: one `<section>` per page; keep it the same for every condition |
| Counselor pictures on the briefing | put `human.jpg`, `furhat.jpg` and `peerbot.jpg` in `static/images/counselors/` (square, about 600 × 600 px); a missing file shows a grey placeholder naming it |
| Questionnaire wording, items, scales | `instruments.py` (renaming an item id needs a new database) |
| What the counselor says, the questions, the answer buttons | the dialogue tree in `static/js/task.js`, between `BEGIN_DIALOGUE_TREE` and `END_DIALOGUE_TREE` (strict JSON), then re-record |
| Video and sound check page | `templates/avcheck.html`; the test clip is `static/video/avcheck.mp4` (replace it with your own short H.264/AAC clip if you like; keep it neutral, the same for every condition) |
| The conversation page (loading panel, Begin button, stage bar) | `templates/exp.html` |
| Debrief | `templates/complete.html` |
| Colours, fonts, spacing | `static/css/style.css` |

**If you add or rename a questionnaire item**, the server stops at start-up with a
message, because the existing database lacks the new column. Move `participants.db`
aside (`mv participants.db participants_old.db`) and start again; a new one is created.

---

## Files

```
custom.py               Page routes, page order checks, saving endpoints, researcher console, CSV export
instruments.py          Every questionnaire item; display, validation and scoring
models.py               Database tables: pretest_survey, branching_trial_log, posttest_survey
templates/
  layout.html           Shared page frame: header, progress steps, support footer
  macros.html           Rating-grid and multiple-choice question templates
  consent.html          Informed consent
  briefing.html         Study briefing
  avcheck.html          Video and sound check (test video + two confirmations)
  pretest.html          "About you" questionnaire
  exp.html              Conversation page
  posttest.html         "Your impressions" questionnaire
  complete.html         Debrief
  message.html          Notices (incomplete link, already taken part, session not found)
  lab.html              Researcher console (/lab)
  ad.html, error.html, … psiTurk's own pages (from the psiTurk project template; leave them)
static/js/task.js       Conversation: dialogue tree, video loading, playback, timing, saving
static/js/survey.js     Questionnaire pages: validation and submission
static/js/pager.js      Splits pages into screen-sized steps (no scrolling)
static/css/style.css    Styles
static/lib/             jQuery, Underscore, Backbone (needed by psiTurk's psiturk.js)
static/images/counselors/  human.jpg, furhat.jpg, peerbot.jpg for the briefing (you add these)
static/video/           The 87 counselor videos (Git LFS), plus avcheck.mp4 (the 8-second test clip)
tools/audio_assets.py   Writes audio_script.csv; checks that every video exists
tools/record_takes.py   Records the clips through OBS (Furhat robot or teleprompter mode)
audio_script.csv        Recording script generated from the dialogue tree
```

Not in the repository (see `.gitignore`): `config.txt`, `participants.db`, `server.log`.

---

## Notes for the write-up

Several validated scales were adapted for this study. Report them as adapted:

* **RAS:** subscales S1 (communication capability) and S3 (discourse with robots) only.
  S2 (behavioural characteristics: how the robot moves, how strong it is) was left out,
  because participants only watch a video and never share a space with a physical robot.
  It uses 7 points instead of the original 6. `ras_total_mean` averages 7 items, so it is
  not comparable to an 11-item RAS total; compare the subscale scores instead.
* **MDMT v2:**
  * 16 of the 20 words are used; benevolent, principled, frank and has goodwill were
    removed for readability.
  * "Has integrity" is presented as "integrous" to fit "The therapist is…".
  * Benevolence is scored from 2 words, so it is less reliable than the other dimensions.
  * The authors ask users to email scsrc@brown.edu.
* **UTAUT behavioural intention:** "the system" is replaced by "a counselor like this one",
  with "If a counselor like this were available," added before each item and a 6-month
  horizon.
* **CARE:** items 1–8 of 10; "helping you to take control" and "making a plan of action"
  were removed. The total runs from 8 to 40 rather than 10 to 50. © SW Mercer 2004: free
  for non-commercial research, but check its terms.
* **MHSAS** (Mental Help Seeking Attitudes Scale): the recommended 2026 version, word
  for word, from the official page
  (https://drjosephhammer.com/research/mental-help-seeking-attitudes-scale/). Cite
  Hammer, Parent & Spiker (2018), *Journal of Counseling Psychology, 65*, 74–85, and
  Hammer, Dueber, Toland & Weng (2026), *Current Psychology, 45*, 553. Use needs the
  author's permission (Hammer Instrument Permission Form, linked on that page). It
  replaces the ATSPPH-SF used in earlier versions of this study. The nine word pairs
  are shown as one block under the shared sentence, rather than as nine separate
  questions as the author suggests for online surveys; mention this in the write-up.
  The instructions ask participants to imagine a serious mental health concern (feeling
  nervous, hopeless, isolated); make sure your IRB protocol covers this.
* **Disclosure comfort** (`dc_1…4`) is study-specific and not validated; report it as
  exploratory.
* **Godspeed Anthropomorphism** is asked last, as a graded check of how human-like each
  counselor seemed, so it cannot prime the trust ratings.

**Ethics**
* The study is presented as a research simulation, not therapy, in the briefing and the
  debrief.
* No audio, video or image of the participant is recorded. OBS is used only to record
  the counselor clips.
* The briefing shows all three counselors, but which one a participant meets and the
  hypotheses are withheld until the debrief. That is a form of incomplete disclosure,
  and the debrief explains it.
* Participants may withdraw at any time by closing the window; per the consent form,
  their data is then not used.
