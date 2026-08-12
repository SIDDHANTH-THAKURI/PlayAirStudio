# Air Guitar

A playable air guitar in the browser. Your webcam watches both hands: one
**points** at a wall of chords, the other either holds a **sign** to run a strum
pattern in tempo or picks **one string at a time** by how many fingers you open.
Both hands can switch modes mid-song with a hold-and-tilt dial, and both the
chord wall and the strum patterns are things you author yourself.

Designed for ordinary laptop webcams: no fast motions anywhere, every gesture is
a calm, deliberate hand shape. Six Karplus-Strong string voices, real guitar
voicings, vibrato/bends/dead-notes for expression.

Entirely client-side. No backend, no uploads, no recording — the video never
leaves the tab.

## Run it

Browsers only hand out cameras on `https://` or `localhost`, and ES modules
need a real origin, so open it through a local server rather than `file://`:

```bash
cd "air guitar"
npm start                     # or: node test/serve.mjs, or: python -m http.server 8000
```

Then open <http://localhost:8000> — that's **Air Studio**, the landing page and
app shelf. Three instruments are playable: Air Guitar at `/play.html`, Air Piano
at `/piano.html`, and Air Drums at `/drums.html`.

First load pulls Tone.js, the MediaPipe WASM runtime and the hand-landmark
model from CDNs; after that it's cached. Chrome or Edge give the best tracking
latency (GPU delegate).

## How to play

### Fretting hand — two modes

**Chord grid** (default). Twelve chords fill the left half of the frame. Your
**index fingertip** is the cursor, and a cell only takes over while you are
actually *pointing* (☝️ index out, other fingers in) — so drifting across the
wall with a relaxed hand changes nothing. That gate is the whole reason the wall
can be this big.

**Sign chords.** Five chords bound to ✋ ✌️ 🤘 👌 🤙. Where your hand *is* stops
mattering entirely; only its shape does.

| Gesture | Grid mode | Sign mode |
| --- | --- | --- |
| Pick a chord | Point ☝️ at a cell | Make its sign |
| Deaden (percussive *chk*) | ✌️ index + middle | ✊ fist |
| Vibrato | 🤘 index + little, then shake | shake — nothing else reads position |
| Bend (≤ whole step) | pinch thumb + index, middle finger out | — (the pinch is 👌, a chord) |

### Plucking hand — two modes

**Fingerstyle.** The number of open digits picks one string, one at a time:

| Open digits | String |
| --- | --- |
| 1 | 1st — high e |
| 2 | 2nd — B |
| 3 | 3rd — G |
| 4 | 4th — D |
| 5 (including thumb) | 5th — A |
| little finger alone | 6th — low E |

Each shape sounds **once** on arrival. Go back toward a fist, or move to a
different count, to fire again — a held shape never machine-guns.

**Strumming.** Hold ✊ ✌️ 🤘 🤙 👌 for about half a second and that sign's
pattern runs for as long as you hold it. **✋ open palm stops.** Patterns follow
the tempo slider and pick up chord changes live, so hold a fist and just play
chords with the other hand.

Either mode: moving toward the frame edge brightens the tone (bridge pickup),
toward the middle warms it.

### Switching modes — the dial

Same ritual on both hands, and deliberately slow so it can never fire mid-song:

1. Hold **👍 thumbs-up for one second** — a two-option dial opens around the hand.
2. **Tilt the hand left or right** to move the highlight.
3. **Open your palm** to accept. Drop the shape and it closes, changing nothing.

The left hand's dial switches *chord grid ⇄ sign chords*; the right hand's
switches *fingerstyle ⇄ strumming*. Both are plain buttons in the panel too.

### Making it yours

**Chord bank…** — edit all twelve grid cells and all five sign chords: pick any
root and quality per slot, leave slots empty, or refill the whole bank from the
current key and voicing set.

**Strum maker…** — an 8- or 16-step editor for one bar. Each step is a rest, a
down/up brush, a treble-only up, a muted chunk, the bass or alternating bass, or
any single string, at one of three dynamics. **Preview** loops it against your
selected chord so you hear it before you commit. Save it, then bind it to any of
the five hand signs; unbound signs keep their factory pattern, so a mix of your
own and the defaults is the normal case. The five built-ins are read-only —
opening one hands you a copy — which is why "switch back to the defaults" is
always one click.

### Strum speed

Two controls, because "faster" means two different things:

- **Tempo** (panel slider, 40–240 BPM, or <kbd>[</kbd> / <kbd>]</kbd> to nudge by 4)
  moves the whole song — metronome and every pattern together. Drag it while a
  pattern is running and the groove speeds up under your hand: running players
  are re-anchored, not restarted, so it never stutters back to beat one.
- **Feel** (½× · 1× · 1½× · 2× in the strum maker) speeds up *one pattern* against
  that tempo — half-time or double-time — and is saved with the pattern. This is
  usually what you want: the song stays where it is and just this strum gets
  busier.

Both compose. A 16-step bar at 2× is four times as many strums as an 8-step bar
at 1×, at the same BPM. The panel shows the resulting strums/sec live, and the
editor shows it for whatever you're drafting.

Everything you author, plus your settings, is saved in the browser and reloads
with the page.

### Phones and tablets

**Play in landscape.** Both hands have to fit in the frame with room between
them, and a portrait phone gives you a tall slot instead of a wide one. Open it
in portrait and the page says so, with a fullscreen button that also asks for an
orientation lock where the browser allows one. Rotating dismisses the prompt by
itself — its visibility is pure CSS, no JS and no resize listener — and you can
decline and carry on if your device is rotation-locked.

The layout reflows to a single column, the editors become full-height sheets,
and hit targets grow on touch devices. Nothing about the desktop layout changes:
every rule is behind a width or `pointer: coarse` query.

A phone has no keyboard, so everything the keyboard fallback offers has a
tappable twin — and these work on desktop too, because clicking the thing you
are looking at is not a worse way to pick a chord:

| Tap | Does |
| --- | --- |
| a cell in the chord strip | selects that chord |
| a pattern chip | starts/stops that pattern |
| the ✋ chip | stops whatever is playing |
| a string chip (fingerstyle) | plucks that string |
| ↓ / ↑ strum, ✋ mute | the manual strokes, shown only on touch or narrow screens |

The chord strip is laid out in four columns so it is a true mini-map of the 4×3
wall on screen — cell 5 is row 2, column 1 in both places.

One thing that is *not* adjustable: the stage keeps whatever aspect ratio the
camera reports. The video is `object-fit: cover` and the overlay maps landmarks
onto the displayed box, so the two only line up while the box and the frame are
the same shape. Force a different ratio and `cover` starts cropping — the feed
appears to zoom and every drawn hand slides toward the centre, away from the
real one.

That shape can change *while you play*: a throughput renegotiation picking a
mode the camera likes better, a phone rotating, a different device being
selected. The stage is bound to the video's `resize` event rather than measured
once at boot — but that event is still just an event, not a guarantee, and a
missed one used to leave the mismatch sitting there indefinitely (reported as
the feed "zooming" and both hands displaced after a few seconds of play). A
periodic check in the existing perf tick now self-heals independently of
whether anything fired: it costs one ratio comparison roughly three times a
second and needs no event at all, which a smoke test proves directly by
skewing the box and confirming it recovers with every resize listener removed.

### Keyboard fallback

Works with no camera at all:

| Keys | Action |
| --- | --- |
| <kbd>1</kbd>–<kbd>=</kbd> | pick a chord cell (12 of them) |
| <kbd>,</kbd> <kbd>.</kbd> | step through the cells |
| <kbd>Q</kbd><kbd>W</kbd><kbd>E</kbd><kbd>R</kbd><kbd>T</kbd><kbd>Y</kbd> | pluck strings 1 → 6 |
| <kbd>Z</kbd><kbd>X</kbd><kbd>C</kbd><kbd>V</kbd><kbd>B</kbd> | toggle the five sign patterns |
| <kbd>↓</kbd>/<kbd>Space</kbd>, <kbd>↑</kbd> | down / up strum (<kbd>Shift</kbd> accents) |
| <kbd>[</kbd> <kbd>]</kbd> | tempo down / up by 4 BPM |
| <kbd>G</kbd> / <kbd>F</kbd> | flip the fretting / plucking hand's mode |
| <kbd>M</kbd> / <kbd>N</kbd> | palm mute / dead notes |

On a touch device these hints are hidden rather than left lying about.

## Design notes

**One shape vocabulary, two hands.** Both hands run the same front end: per-digit
curl → hysteresis → a single discrete shape id (`point`, `peace`, `horns`,
`fist`, `palm`, `thumbup`, …). Everything above that reads shapes, never raw
landmarks, which is what keeps the two hands' vocabularies from bleeding into
each other and makes "✌️ means deaden here but a chord there" a one-line
difference rather than two detectors. Curl comes from knuckle angles on
MediaPipe's 3D world landmarks — angles survive hand rotation where fingertip
distances collapse.

**Nothing fires from a guess.** A digit sitting in the hysteresis dead zone reads
`mid`, genuinely undecided, and a shape that depends on it matches nothing at
all. Without that, a hand resting half-open reads as five extended fingers and
plays a note you never asked for. Grid cells need a Schmitt boundary *plus* a
160 ms steady point; signs need a 250 ms settle; patterns need a 420 ms dwell,
drawn as a filling ring so you can see it coming. The mode dial needs a full
second of 👍, a deliberate tilt, and a separate accept gesture — three
independent things that don't co-occur by accident.

**Orthogonality, on purpose.** In grid mode the hand's Y position *means*
something (it picks the row), so vibrato — which is Y wobble — is gated behind a
dedicated 🤘 shape rather than left listening. In sign mode position means
nothing, so the gate lifts and any shake is vibrato. The plucking hand's two
modes are exclusive for the same reason: finger counting consumes every shape
the pattern signs would need.

**Latency.** Detection runs on `requestVideoFrameCallback` — one inference per
camera frame, not per repaint — and rendering on rAF. Four things keep the gap
between moving your hand and hearing a note small:

- *The gesture engine runs once per detection, not once per frame.* The camera
  delivers 15–30 fps and rAF fires at 60, so the engine used to receive the same
  landmarks two or three times in a row. That was not merely wasted work
  competing with MediaPipe for the main thread — it was wrong. Curl velocity is
  (now − previous)/dt, so a repeated sample reads as *zero motion* and quietly
  flattened the dynamics of every pluck. A smoke test asserts the engine ticks
  well below the frame rate.
- *The camera is asked for less on small devices.* Inference cost tracks the
  source frame, and a phone is both the slowest device and the one most likely
  to hand back 1080p if asked vaguely. Touch devices get 640×480, which is ample
  at arm's length and roughly halves the per-frame upload.
- *There is a floor below the CPU delegate.* If inference is still over ~55 ms a
  frame after the GPU→CPU downgrade, the stream is renegotiated down to 480×360.
  Once — `applyConstraints` stutters the feed, which is worth paying a single
  time and never in a loop.
- *A single pluck is scheduled 10 ms out, not 22.* The 22 ms is headroom for a
  strum's string-to-string spread; one plucked string has no spread to lay out,
  and that is the path a gesture triggers. Tone's own lookahead is dropped to
  10 ms on top.

What is *not* latency you can remove: the dwell times. A grid cell needs 160 ms
of steady pointing and a pattern sign 420 ms, on purpose — that is the price of
not firing chords at somebody who was only scratching their nose.

**Why an AudioWorklet for the strings.** Web Audio clamps `delayTime` to one
render quantum (128 samples ≈ 2.7 ms) for any delay inside a feedback loop,
which caps a comb-filter string at ~375 Hz — most of the fretted range would
play flat. `src/karplus-worklet.js` runs the delay lines by hand: correct
tuning everywhere, fractional-sample reads so bends and vibrato glide, and
sample-accurate strum spread. Falls back to `Tone.PluckSynth` if
`AudioWorklet` is missing.

**Musical detail.** Chords come from real fretboard shapes (open cowboy chords
where they exist, E/A-shape barres otherwise), so string assignment and octave
doubling match what a player's hand would actually produce. Pattern steps are
*abstract* — "down brush", "the bass note", "string 3" — and resolve against the
chord held at the moment each step is scheduled, so changing chords mid-pattern
behaves like a real strummer following your other hand. A step aimed at a string
this voicing mutes walks to the nearest sounding one. Downstroke brushes run
low→high; upstrokes catch the treble strings and land softer. Muted strings
still get a quiet pick click.

**The landing page has music; the instrument does not.** Interface sound inside
Air Guitar would fight the thing you are actually playing, so `play.html` loads
none of it — a smoke test asserts the instrument page opens exactly one audio
context, its own, for the strings.

Out front, the first attempt was a Karplus-Strong pluck tied to the strings:
a noise burst into a feedback delay. That is the right model for a *string* and
completely wrong for interface sound — it rang metallic and had to be torn out.
What replaced it is the other classic approach: a few sine partials with a soft
attack and a long exponential tail, through a real convolution reverb, with no
noise anywhere in the signal path except the impulse response, where it belongs.
Everything is pinned to a D-major pentatonic, so any two notes that can overlap
are consonant by construction and a hurried visitor mashing four cards still
gets a chord rather than a cluster. Music starts when you press Enter — never
before, since a mousemove is not user activation — and there is a mute toggle
that is remembered.

The six lines behind the wordmark still pluck when you drag through them, using
crossing detection rather than proximity so a fast sweep fires all six instead of
dropping the ones you jumped over. They are silent: sound hanging off a mousemove
is how a page ends up making noise before you asked it for anything.

**Hand roles** are identified with MediaPipe handedness and *locked* on first
sighting, so crossing your hands mid-song never swaps duties.

## Air Piano (prototype)

`piano.html`. Mark out a keyboard-sized rectangle — **in the air in front of
you, or on your desk** — and play it.

Air is the default, and it turned out to be the better first experience.
Pointing the camera down at a desk means tilting the lid until you can no
longer see the screen, which is a real cost for a marginal gain; marking a
plane in mid-air needs no rearrangement at all. A desk still wins once you are
used to it, because a surface you can feel is steadier than one you cannot, so
both are offered. The geometry and the detector are identical either way — the
only real difference is that wood stops a finger in a millisecond or two while
braking yourself in mid-air takes tens of them, so air mode widens the window
that still counts as an abrupt stop. That is three numbers, not a second
detector.

The layout is **one row by default, and wide**. Two rows asks you to reach to a
second depth you cannot feel, which is much harder than simply having more keys
side by side; three is unplayable. So the range comes from width — up to
fifteen keys — and from the register split, which puts the left hand two
octaves down over the same surface.

**Calibration.** Four corners mark the patch you want to play on, which pins
down a planar homography. That is the right model rather than a convenient one:
any two images of the same plane are related by one, so it generalises across
desks, camera heights and tilts with no per-setup fudge factor. Everything
downstream works in table coordinates — u across, v away from you — and the
overlay runs the mapping backwards, so the grid is painted *on* the desk in the
camera's own perspective instead of floating over it.

The corners are marked by **tapping** them, and that is a correctness decision.
A homography maps exactly one plane; clicking marks the desk, but every point
the instrument is later asked about is a *fingertip landmark*, which sits a
centimetre or two above the desk even when the pad is touching. Those are two
different planes, and the gap is parallax that grows the lower the camera sits
and the further you reach — a laptop lid being both the worst case and the
common one. Modelled with a pinhole camera in `test/piano.mjs`, a clicked
calibration puts taps out by up to a fifth of the surface, which is two whole
keys; tapping fits the homography to the plane the fingertips are actually on,
and the error cancels to machine precision on every rig tested.

**Onset detection** is the part that decides whether this is an instrument or a
toy, and it went through three designs — see the header of `src/piano/onset.js`
for the full reasoning. Proximity thresholds fail because MediaPipe's world
landmarks are hand-relative, so there is no scene-anchored height to threshold,
and because a slow hover fires identically to a strike. A plain velocity
threshold fires *during* the approach, so the harder you play the earlier the
note — backwards. What works is the strike signature: speed climbing along the
approach and then a discontinuity, because a desk stops a finger inside a frame
or two while a hand merely being put down eases off over a fifth of a second.
The note fires on the stop, which is also the instant a real key would sound,
and the peak speed just before it is exactly what a hammer converts to loudness
— so velocity falls out of the detection rather than being bolted on.

Thresholds are in palm spans rather than pixels, so one set covers a hand near
the camera and the same hand far away. The approach axis is *learned* from
confirmed strikes, which is how one detector covers a laptop lid at 30° and a
phone propped nearly overhead.

**Which finger actually hit.** Tap one finger and the others come along for the
ride: the hand dips and is then arrested by the finger that landed, so *every*
finger shows the same accelerate-then-stop and a per-finger detector plays a
five-note cluster. No threshold fixes it, because the passengers' motion really
is a strike shape — the stop is shared. What separates them is the reaching, not
the stopping: the finger that hit travelled further than its own palm did, while
a passenger merely rode along. Fingertip travel minus palm travel isolates that
for free, since both are already tracked. A strike needs articulation of its
own, and one arriving alongside a stronger one must be a decent fraction of it
to count as a deliberate chord rather than a passenger. The leader always fires
immediately — arbitration never delays a note, because this is an instrument.

**Layout.** The surface is scale-locked: each column is the next degree of a
scale, not the next semitone, so an aim that is one column out is a neighbouring
scale tone rather than a wrong note. Rows run away from you, each an octave up.
With the register split on, the left hand sounds two octaves down, so both hands
get the whole desk rather than half of it each — the division of labour a
pianist already has.

**Sound** is modal synthesis (`src/piano/piano-worklet.js`): each note is an
explicit sum of decaying partials, placed where string stiffness actually puts
them. That inharmonicity is not a defect to correct — it is most of why a piano
sounds like a piano — and it buys per-partial decay and velocity-as-brightness,
neither of which a delay-line model gives up easily. On top of that:

- **Every partial is voiced twice.** A real string vibrates in two planes: the
  vertical couples hard into the bridge so it is loud and dies fast, the
  horizontal barely couples so it is quiet and rings on. Their sum is the
  piano's two-stage decay, which one exponential cannot make — a single
  decaying sinusoid is a straight line in dB. Measured, the tail slows from
  ~11 dB/s to ~7 dB/s. The pair is left half a cent apart: enough to stay
  alive, far too little to beat, because 1.5 cents put an audible null right in
  the middle of a held C4 and the note appeared to die and come back.
- **The hammer's strike point.** A real hammer hits about an eighth along the
  string and therefore cannot excite the 8th partial at all. One multiply, and
  a large part of the characteristic hollowness.
- **Stereo by pitch**, bass left and treble right, as it sits under your hands.

**Latency** is where this instrument lives or dies, so the piano spends
everything on detection rate. A note cannot be detected before the frame that
shows the finger stopping, so *one look at your hands is the floor* — at 10
looks a second that is 100 ms of dead feel before any audio is involved. So:
no duty-cycle throttle at all (the guitar needs one to protect its pattern
scheduler; the piano schedules each note the instant it detects it, so a
briefly starved rAF costs only a stuttery overlay), a deliberately modest
640×480 camera request because inference cost tracks the source frame, light
velocity smoothing because it sits directly in that budget, and 4 ms of audio
runway — arriving a hair late is harmless, since the worklet just starts the
note at the top of the current block and a struck string begins from silence
either way. The panel reports the resulting figure honestly, split into
tracking and audio.

**Known limits.** Tap detection can only see what the tracker delivers. Below
roughly 20 detections a second a tap can begin and end between two looks at your
hands, and no threshold recovers it; short, hard taps are the first thing lost,
and velocity discrimination degrades before hit rate does. The header pill shows
the live rate and turns red when it drops.

Hardware acceleration therefore matters more here than anywhere else in this
project: if the header reads `cpu`, inference is typically five to ten times
slower than it needs to be, and no amount of tuning compensates. That is worth
checking before concluding the instrument feels sluggish.

## Air Drums (prototype)

`drums.html`. **Point your index finger and you are holding a drumstick** —
one in each hand. Swing at a drum and stop; the stop is the hit, and how fast
you were moving when you got there is how hard it lands.

### The stick is the idea, not the decoration

A drum stroke is a wrist flick. The wrist itself barely travels — rotate your
hand thirty degrees and your knuckles move almost nowhere — so watching a
fingertip means watching the *smallest* part of the gesture. A stick is a
lever: its tip sits a couple of palm-spans out along the hand's axis, so the
same flick swings it several times as far and several times as fast. In
`test/drums.mjs` a half-radian rotation moves the knuckles 0.49 spans and the
tip 1.48. The motion the detector has to recognise is three times the motion
the player actually makes, which is the right way round, and it is why a small
comfortable stroke reads clearly instead of needing to be flailed.

It is also the aiming device. A fingertip is a point you have to imagine; a
stick is drawn on screen, rooted in your hand, and moves exactly as a real one
would. Pointing is what arms it — extend your index finger and you have picked
it up, relax and you have put it down — so resting, gesturing and scratching
your nose are all silent with no special case for any of them.

**The stick lies along the index finger**, passing through the knuckle and the
fingertip and carrying on past. A fist was tried first and was worse in both
ways that matter. Visually, you are aiming an invisible object attached to a
featureless blob rather than aiming the finger you can already see. And a
closed hand held naturally in front of a webcam points its knuckles *at the
camera*, so the palm axis is foreshortened to nearly nothing and its direction
degenerates into noise — the stick flails, or the grip never registers and
nothing works at all.

Sticks are told apart by **grip tape** in each hand's colour, wrapped over the
butt end. A coloured dot does not survive motion blur; a band along a quarter
of the shaft does.

### The lever amplifies the noise too

This was the trap, and it is worth stating plainly because it is not obvious
until the thresholds are loosened enough for the instrument to feel good.
Putting the tip two spans out multiplies the gesture by two — and multiplies
the tracker's jitter by two as well. Three hundredths of a span of wobble at
the knuckle is nothing; the same wobble rocking the finger's *direction* throws
the tip a tenth of a span, which at sixty frames a second is six spans per
second of apparent speed. That is comfortably fast enough to look like somebody
hitting a drum. A hand held perfectly still would play.

So the direction is low-passed, and only the direction, because the knuckle's
own jitter is not multiplied by anything. The detector and the drawn stick use
*different* time constants rather than a compromise: the detector wants quiet
and can afford two frames of lag, the drawn stick wants to stay glued to the
finger and can afford some shimmer.

`test/drums.mjs` prints the resulting margin as a pair, because either number
alone is meaningless — it is easy to catch a gentle flick, and easy to reject
noise, and the whole problem is doing both:

```
a still hand, per tracker jitter - 2%:0  3%:0  4%:0  6%:9 spurious
smallest flick still caught      - 0.5rad:8/8  0.35rad:8/8  0.25rad:8/8  0.18rad:8/8
```

An eleven-degree wrist flick plays; realistic tracker jitter does not.

### No calibration, deliberately

The piano needs a homography because a key is two centimetres wide and hitting
the wrong one is a wrong note. A drum is the size of a dinner plate and there
are seven of them, so screen-space ellipses are plenty. Dropping calibration
removes the single largest piece of setup friction in the project: you open the
page, press start, and play.

### Where the kit goes is not where a kit looks right

The first layout spread the drums corner to corner, the way a photograph of a
kit does, and several of them turned out to be **physically unreachable**.

The stick tip hangs a couple of spans out along a hand that points down and
forward, so the region the tip can occupy is offset well *below* wherever your
hands are comfortable — roughly the lower two-thirds of the frame. Putting the
cymbals near the top edge meant reaching them required holding your hands above
the frame entirely. It read as the instrument being broken, and it was.

So the kit sits lower and narrower than a photograph would: cymbals at the top
of the reachable band, snare and floor at the bottom of it, kick below them.
The catch margin around each pad is generous enough that the pads' areas meet,
because a stroke landing in the gap between two drums is not a mistake worth
punishing — it is a stroke aimed at one of them, and swallowing it teaches
nothing except that the instrument is unreliable.

### Say what you are about to hit

The drum under each raised stick is **ringed in that hand's colour**, before any
stroke. Without it, aiming is guesswork you only get feedback on after
committing: you swing, something else sounds, and there is no way to learn where
the edges are. With it the kit answers continuously to where the tip is, and
hitting the drum you meant becomes something you can see rather than something
you find out afterwards.

### Detection

The same principle as the piano's tap detector — accelerate, then stop
abruptly, and the hit belongs on the stop — with three differences that all
follow from playing with a stick:

- **One point per hand, not five.** A stick has one tip, so all the machinery
  for deciding which of five fingers actually struck is simply not needed.
- **No articulation test.** The piano rejects strokes where the fingertip moved
  no more than its palm, because a hand being put down is not a note. Drumming
  is the opposite — the whole hand *should* move. Pointing takes over that job.
- **Bigger numbers**, scaled to the tip's leverage.

The learned approach axis is also much weaker here than in the piano, and that
is deliberate. The piano's taps all go the same way — down onto one plane — so
learning that direction is free accuracy. Drum strokes go to seven different
places, and an axis fitted to the last one *penalises* the next: reach left for
the hi-hat and a stroke down onto the floor tom projects short, reading as
softer than it was or missing entirely. The only thing worth learning is the
small standing tilt of a camera that is not level.

One thing worth calling out because it was a bug: requiring the stick to be
seen *lifting* before it can hit again is correct drumming, but on its own it
means a single unseen recovery — an occluded hand, a dropped frame, a player
who drifts back up too gently to measure — takes that stick out of service
permanently. A dead hand is a far worse failure than an extra hit, so the
re-arm also times out (`REARM_MAX`).

### The kit

Seven voices, all synthesised, nothing sampled. A sampled kit plays the same
snare at seven volumes; since this instrument's whole proposition is that your
arm is the controller, a kit that ignored *how* you moved it would undo the
point. It also keeps the download at zero bytes.

Percussion is not one model but three, and each drum uses whichever physics
calls for:

- **A swept sine** for the kick and toms. The reason a kick has a pitch at all
  is that the beater stretches the head and it relaxes: the note starts high
  and falls within about forty milliseconds. That fall *is* the drum — the
  measured sweep is 106 Hz to 47 Hz. Take it away and you have a low beep.
- **Resonant modes** for anything that rings, placed *inharmonically*: a
  circular membrane's modes fall at 1, 1.59, 2.14, 2.30 times its fundamental,
  and a cymbal's are more scattered still. That is why a drum reads as a drum
  rather than as a pitched note played badly.
- **Filtered noise** for the snare wires, the beater click and the cymbal wash,
  with the filter *sweeping closed* as it decays — a struck cymbal loses its
  top end long before it goes quiet, and a static filter sounds like a hiss
  with a volume envelope.

Velocity changes the sound and not merely the level: a hard stroke drives the
modes further up the bank, opens the noise filter and lengthens the tail.
`test/drums-dsp.mjs` measures it — a snare goes from 40% to 63% of its energy
above 1.2 kHz between a ghost note and a full hit.

Two pads answer to *where* you strike them, which is the only expression a kit
gets from position and is worth having: the **top of the hi-hat is open and the
bottom is closed** (hitting closed chokes the open one, exactly as the pedal
does), and the **middle of the ride is the bell**, the outside the bow.

> A resonator sharp enough to ring for two seconds has a Q in the thousands, so
> feeding it un-normalised put the first build three orders of magnitude over
> full scale, and every drum was slamming the clipper. Input is scaled by
> `sin(w)`, which makes each mode's `gain` mean its actual peak amplitude
> whatever its frequency or decay.

## Access gate (temporary)

The whole site currently sits behind `src/gate.js`, which asks for a key before
showing anything.

**It is not security and must not be treated as such.** The site is static:
every file is served to anyone who asks, and the check runs on their machine.
The key is in the file, the overlay is a DOM node anyone can delete, and the
pages work perfectly well if the script never runs. It keeps a casual visitor
from wandering in mid-build. It stops nothing else. Real protection has to
happen before the bytes leave the server — Vercel's own deployment protection,
or an auth layer in front of the origin.

Removing it is one file and three `<script>` tags, which is the shape something
temporary should have.

## Files

```
index.html              Air Studio: animated landing page + app shelf
intro.css               landing-page theme
src/intro.js            pluckable string field, scene transitions
src/audio-intro.js      landing-page music and touch sounds (never loaded by the app)
play.html               Air Guitar: markup, control panel, three modals
piano.html / piano.css  Air Piano: markup and its few theme additions
src/piano/geometry.js   calibration homography, desk ⇄ image mapping
src/piano/onset.js      tap detection — the strike-signature state machine
src/piano/scales.js     scale-locked note layout across the surface
src/piano/piano-worklet.js  modal struck-string synthesis
src/piano/audio.js      Tone chain for the piano
src/piano/render.js     overlay drawn onto the calibrated desk
src/piano/main.js       piano wiring, calibration UI, settings
drums.html / drums.css  Air Drums: markup and its few theme additions
src/drums/stick.js      stick geometry from a hand, and the grip trigger
src/drums/kit.js        where the drums are, and which one a stroke landed on
src/drums/onset.js      stroke detection — the strike-signature state machine
src/drums/drum-worklet.js  swept sines, inharmonic modes, swept-filter noise
src/drums/audio.js      Tone chain for the drums
src/drums/render.js     the kit, the sticks, and the feedback on a hit
src/drums/main.js       drums wiring and settings
src/gate.js             temporary access screen (not security — see above)
styles.css              light, warm theme
src/main.js             wiring, UI state, error/permission states, keyboard fallback
src/store.js            localStorage persistence for banks, bindings and custom patterns
src/ui.js               the chord-bank and strum-maker popups
src/tracking.js         getUserMedia + MediaPipe HandLandmarker → mirrored landmarks + handedness
src/gestures.js         shape matcher, both hands' mode machines, the tilt dial, role lock
src/patterns.js         built-in + user patterns, editor step format, lookahead scheduler
src/audio.js            Tone.js signal chain, strums + single-string plucks
src/karplus-worklet.js  six plucked-string DSP voices
src/chords.js           fretboard shapes, voicing selection, chord banks, chord diagram
src/render.js           canvas overlay: chord wall, sign badges, strings, hands, dial
```

## Tests

All headless, no dependencies beyond Node ≥ 21 (smoke needs Chrome or Edge):

```bash
# guitar, and the landing page + shelf
node test/sim.mjs         # shape matcher, both hands' mode machines, chords, scheduler
node test/dsp.mjs         # renders the worklet offline: tuning (±1¢), decay, bends, stability
node test/perf.mjs        # inference duty-cycle, delegate choice, scheduling under stalls
node test/smoke.mjs       # real Chromium + fake webcam over CDP: shelf, tutorial, boot, editors, audio

# piano
node test/piano.mjs       # homography, tap detection at controlled sample rates, scales
node test/piano-dsp.mjs   # inharmonicity, per-partial decay, two-stage decay, velocity as brightness
node test/piano-smoke.mjs # boot, tap-calibration, then the whole path with a scripted hand

# drums
node test/drums.mjs       # stick geometry and leverage, kit hit-testing, stroke detection
node test/drums-dsp.mjs   # register, kick sweep, decay envelopes, velocity as brightness, load
node test/drums-smoke.mjs # boot, settings, then the whole path with a scripted pair of fists

# handy while working on the drawn hand or any single page
node test/shot.mjs test/poses.html poses.png    # every tutorial pose on one sheet
node test/shot.mjs play.html shot.png           # screenshot the instrument
```

## Performance on phones

Hand tracking is a neural net, and `detectForVideo` is *synchronous*: on a
mid-range phone one inference blocks the main thread for 80–250 ms, far longer
than the 33 ms between camera frames. Running it per frame — which is what
`requestVideoFrameCallback` invites — leaves the thread essentially never
outside MediaPipe, so the canvas looks frozen and pattern notes land late. Four
things keep it playable:

- **A duty-cycle throttle** (`Tracker.due`): inference gets at most 50% of wall
  time on mobile, 80% on desktop, and idles the rest. Slower hands, but 60 fps
  paint and in-time audio — the trade every player actually wants. Desktop
  inference is ~5 ms, so nothing is throttled there.
- **A verified delegate choice.** A mobile GPU at 120 ms is fine and is left
  alone (the old fixed 80 ms bar wrongly demoted it); a single frame past a
  second is software GL and bails out immediately. After switching, both
  delegates are compared and the faster one is kept and pinned — the previous
  one-way swap could strand a device on the *worse* option forever.
- **Adaptive audio lookahead.** The pattern scheduler plans further ahead than
  the tracker's stall, so a 200 ms inference can't swallow a note. Measured:
  30 of 37 steps survived with the old fixed window; all 37 do now.
- **Less pixels**: 480×360 capture on mobile, and the overlay canvas is capped
  at 1.5× device pixel ratio instead of 3×.

The header pill reports all of it live — `60 fps · track 8/s · 62 ms gpu`.

## Troubleshooting

- **"Camera permission was blocked"** — click the camera icon in the address
  bar, allow this origin, reload.
- **"Needs a secure page"** — you opened the file directly; serve it over
  `localhost` (see above).
- **Pointing doesn't select** — the cursor is your *index fingertip*, and the
  cell only commits while the other fingers are curled. If cells feel too small,
  stand further back so your hand travels more pixels per cell.
- **👍 vs ✊ confusion** — the thumb is the weakest signal on a webcam. Spread
  the thumb clearly away from the palm; if the dial still won't open, use the
  Left hand / Right hand buttons in the panel, or <kbd>G</kbd> / <kbd>F</kbd>.
- **A finger count picks the wrong string** — 4 fingers and 5 fingers differ only
  by the thumb. Tuck it firmly against the palm for four, and stick it right out
  for five. Thresholds live at the top of `src/gestures.js` (`EXT_AT`,
  `CURL_AT`, `SHAPE_DWELL`, `POSE_DWELL`).
- **Notes feel late** — check the fps/ms pill in the header. Below ~24 fps,
  close other GPU-heavy tabs or drop the camera resolution in
  `src/tracking.js`.
- **Pill says `cpu`** — the GPU delegate was rejected or ran on emulated GL
  (remote desktop, old iGPU), so tracking auto-switched to CPU inference.
  Playable, just a bit more latency.
- **Start over** — `localStorage.removeItem('air-guitar.v2')` in the console
  wipes every bank, binding and custom pattern back to factory.