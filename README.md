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

Out front there are three screens: a **threshold** overlay, the landing, and the
shelf. The threshold exists for one reason, and it is not decoration. A browser
will not start audio without a genuine gesture, and a page whose first act is to
ask permission to make noise has already lost the moment — so the overlay asks
for exactly one click, and *that click is what builds the audio graph*. Nothing
before it makes a sound. The smoke test drags across the strings and then
requires that zero AudioContexts exist, because a mousemove is not user
activation and a graph built there would sit suspended forever.

**The score.** The first attempt was a Karplus-Strong pluck tied to the strings:
a noise burst into a feedback delay. That is the right model for a *string* and
completely wrong for interface sound — it rang metallic and had to be torn out.
Its replacement was bells over a triangle pad, which was pleasant and thin: four
chords, one voice of movement, and an obvious loop point at eight seconds.

What is there now is generative cinematic ambient in A minor — sub bass, a
breathing pad, and a bell arpeggio through a dotted-eighth ping-pong delay into a
convolution hall — and it is built around the two things that make a score read
as *scored* rather than as a widget making notes:

- **Everything moves at a different rate.** The pad's filter breathes on a
  0.07 Hz LFO, an air layer sweeps on another, and the delay repeats land
  *between* the arpeggio's own notes, which is most of why eight notes a bar
  sound like sixteen. Nothing lines up, so nothing ticks.
- **The loop is longer than the memory of it.** Eight bars at 68 BPM is ~28 s,
  the arpeggio shape alternates by bar, and a high theme note appears in only
  four of the eight. Two passes are never identical.

Still no noise anywhere in the signal path except the reverb's impulse response,
the air layer and the entry impact — the three places noise belongs. Chords are
voiced so any two notes that can overlap are consonant, so a hurried visitor
mashing four cards gets a chord rather than a cluster. The mute toggle is
remembered, and it only appears once there is something to mute.

**The visuals are one canvas.** Nebula, stars, a planet's limb, a scrim, the
dial, the strings, dust, shockwaves and the cursor light are all drawn in a
single rAF, back to front. Four of those are worth naming:

- *The nebula is noise, not gradients.* The first build was five big radial
  gradients drifting on Lissajous paths. It was cheap and smooth and it looked
  like every other dark landing page, because a radial gradient can only make a
  blob and a nebula is not blobs — it is filaments, bright threads with dark
  dust lanes between them. That comes from **domain warping**: sampling the
  noise at coordinates that have themselves been displaced by noise. There is no
  way to fake it with gradients.

  It costs ~0.1 s per tile, which is far too long to spend inside a frame, so
  three tiles are built one per rAF and faded in as they arrive. The page is
  interactive throughout and the sky assembles behind it. Each tile is then
  blitted twice at different scales and rotations — one copy of a cloud is a
  shape you recognise, two overlapping is a cloud.

  Getting the density curve wrong is the easy failure and it is invisible in
  code review: summed octaves of value noise cluster around 0.5, with a real
  range of roughly 0.3–0.7 rather than 0–1. Thresholding *that* and then raising
  it to a power left every pixel at about 3% alpha, and the first sky was
  blank. Stretch the contrast about the midpoint first and the threshold means
  what it looks like it means.
- *The horizon is a silhouette with a lit edge.* A planet's limb, low in the
  frame, is the single element that stops the page reading as content floating
  in the middle of nothing — once there is a horizon, everything above it is
  somewhere. It is one radial gradient inside an elliptical transform. Six
  stacked wide strokes were the obvious way to do it and they banded, because a
  260 px stroke is a band with two hard edges.
- *The scrim is the price of the sky.* A dark pool through the middle, under the
  type. Without it the lede is unreadable over the bright half of the nebula and
  no amount of `text-shadow` fixes that.
- *The dial is the music.* A ring of ticks whose lengths are the score's own
  spectrum off an `AnalyserNode`, log-spaced into 40 bands, mirrored so there is
  no seam, and coloured bass→treble around the circle so the shape you see is
  the shape of the chord. Ninety-six ticks cost three strokes a frame, because
  they are bucketed by colour into three paths. It stands down below ~840 px:
  a ring only works if it can get *outside* the words, and a narrow screen has
  it cutting through the copy instead of framing it.

The six lines behind everything still pluck when you drag through them, using
crossing detection rather than proximity so a fast sweep fires all six instead of
dropping the ones you jumped over. They are silent to the pointer — sound hanging
off a mousemove is how a page ends up making noise before you asked it for
anything — but they are *not* silent to the score: every note the music plays
rings the string nearest its pitch, so what you hear and what you see are one
event rather than two that happen to coincide.

**Frames before particles.** The stage keeps a rolling average of frame time and
spends the budget in a fixed order: drop motes first, then the string glow, and
never the frame rate. Dropping a hundred motes is invisible; dropping to 40 fps
is the only thing anybody would actually notice.

**Type is Fraunces + Inter**, the same pair the instruments use, so the front
door and the rooms behind it are one typeface at two temperatures. The page's
own chrome is a viewfinder — four corner brackets and two rails — rather than a
border, which on a product that is a camera watching your hands is the right
kind of cheap.

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

The corners are placed **with the cursor** — four clicks. They were originally
marked by *tapping* them, which is, on paper, the more correct thing to do. A
homography maps exactly one plane; clicking marks the desk, but every point the
instrument is later asked about is a *fingertip landmark*, which sits a
centimetre or two above the desk even when the pad is touching. Those are two
different planes, and the gap is parallax that grows the lower the camera sits
and the further you reach — a laptop lid being both the worst case and the
common one. Modelled with a pinhole camera in `test/piano.mjs`, a clicked
calibration puts taps out by up to a fifth of the surface; tapping fits the
homography to the plane the fingertips are actually on, and the error cancels
to machine precision.

It was still the wrong trade, and it is worth being precise about why, because
the geometry above is not wrong — it just isn't the binding constraint. Placing
a corner by tap requires the tap detector to be working *before* there is any
calibration to tell you whether it is. A marginal corner and a marginal
detector look identical from the outside, so the one step nobody can skip
became the least reliable thing in the instrument, and a first run could fail
in a way that gave the player nothing to act on. A cursor puts the corner
exactly where it was meant, every time. The parallax is real but bounded, it
only bites in Desk mode at all (Air, the default, has no surface under the
fingertips), and the cure is one sentence of instruction: click where your
*fingertips* will be, not where the desk's corner is. The pinhole test stays,
because it is what would price a future tap-assisted refinement.

**The walkthrough.** Two things here are not guessable by poking at it: that a
note fires when the fingertip is *stopped*, so you strike rather than press,
and that you must mark out where the keyboard is before anything sounds. Both
are one sentence each, so the first run spends five cards saying them —
spotlighting the real controls rather than describing them, since every step
is something you can try while it is on screen. It hands over to calibration
when it ends, is remembered so it greets nobody twice, and **Show me around**
replays it.

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

**Or don't ask the question.** Arbitration gets this right most of the time,
and "most" is the reason **Play with → Index only** exists: a stray note is far
worse than a missing one, and restricting each hand to one finger removes the
question rather than answering it better. It is also the pose people adopt
anyway when picking out a melody rather than playing chords, and the fingers
that are off are drawn as faint outlines so the mode never reads as the tracker
having lost them.

It is a *detector* setting rather than a filter over its output, which is the
part worth getting right: a finger that is not playing must not enter the
strike machine at all, or it still joins arbitration clusters and can talk a
real strike out of sounding — so the option that exists to stop wrong notes
would quietly start swallowing right ones. `test/piano.mjs` pins that down by
tapping the index alongside a much stronger middle finger and requiring the
index to sound.

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

`drums.html`. **Point one index finger in each hand** — or switch to a pair of
drumsticks — and bring the tip down through a drum. It sounds right as the tip
goes through the head, and how fast you were moving is how hard it lands.

### The sticks are bolted to the fist

The first version drew each stick **along the index finger**, through the
knuckle and the fingertip and carrying on past, and on paper that is the better
idea: you aim the finger you can already see, rather than an invisible object
attached to a featureless blob.

In practice a drum stroke *bends that finger*. The index curls as the wrist
flicks, straightens on the recovery, and drifts wherever the hand is relaxed —
so the one line the whole geometry was built from was the line that changed
most during the gesture, and the tip swung to places nobody aimed at. Arming
made it worse: it required a clean point, index out and the others in, which a
drummer's grip is not, so the common failure was no stick at all.

Nothing in `src/drums/stick.js` now reads a single finger joint. Everything
comes from the palm — wrist and the four knuckles — which is rigid: curl your
fingers, make a fist, splay them, and those five points keep the same shape.
`test/drums.mjs` asserts it directly, by throwing the index fingertip to the
far corner of the frame and checking the stick does not move by so much as a
float.

**The direction went wrong twice more before it went right,** and the two dead
ends are worth keeping because both looked correct on paper.

A stick points where the fingers would if you opened them, so the quantity
wanted is the hand's forward axis — wrist to knuckles. Measuring it *directly*
fails in exactly the pose the instrument is played in: a fist held out in front
of a camera points its knuckles at the lens, so the axis collapses to almost
nothing in the image and its angle becomes noise. That is why a fist was
rejected in the first place.

**The line across the knuckles** has the opposite property — widest part of the
hand, seen broadside, long and well defined however the wrist is turned — and
its perpendicular is that same forward axis. So take the angle from there. But
a perpendicular has *two ends*, and deciding which one is the tip needs the
very measurement that just collapsed. Both attempts foundered on that one bit.
Forcing it always downward (mapping the lean through `sin 2θ` so it faded out
at the ambiguous angle) could not flip, and hung the stick vertically past a
hand held at an angle — visibly not in the hand, which on an air instrument is
not a cosmetic complaint. Taking the sign from the collapsed axis and smoothing
it hard could flip, and did: a threshold between "trust the evidence" and "fall
back to downward" is a discontinuity sitting exactly where the evidence is
weakest. That is what "the sticks keep changing direction" was.

**What works is the forward axis, straight, with no cleverness at all** — and
being honest about the foreshortening instead of papering over it. It is a
vector, not a line, so there is no end to choose and nothing to flip. When it
shortens, the stick is drawn *shorter by exactly that much*, right down to
nothing. Reliable angle, full-length stick pointing where the hand points; angle
turning to noise, and the stick is a stub with almost nothing to swing.

The zero matters. A floor under the length looks kinder and reinstates the bug:
pitch a hand from pointing slightly down-and-away to slightly up-and-away and
the axis passes through the camera line, where the direction genuinely
reverses — so a stick with a minimum length snaps end for end there. Let it go
to zero and the reversal is a stick shrinking to a point and growing back the
other way, which is what a real one does. `test/drums.mjs` sweeps a hand
through that pose and requires the tip to move no more than 0.016 spans between
one step and the next; before, it jumped 1.6.

It also makes the aiming rule something you can see: tip your hand further down
at the kit and the stick gets longer.

### And an instrument with no stick at all

All of the above is inference. The tip of a drumstick is a point on an object
that is not there, worked out from the shape of a hand — and every scheme for
working it out degrades as the hand turns toward the camera, because that is
where the information goes.

A fingertip does not have that problem. It is a landmark the tracker reports
directly, with no geometry in between. So **Fingertip** is the other way to
play, and it is the default: point one index finger with the others tucked in,
and the tip of it strikes exactly as it does in Air Piano. Relax the hand and
it stops — the other fingers cannot set anything off, because the pose itself
is the switch.

Everything downstream is shared. Both modes hand the detector the same shape of
thing, differing in the ruler they measure in (a stick's reach, or a palm span)
and a short table of thresholds, because a tap is a smaller and quicker gesture
than a swing. `test/drums.mjs` runs the entire stroke suite twice, once per
mode, and the browser test plays takes in both: neither gets to be the one that
only works in principle.

### A stick is as long as the screen says, not as long as your hand

Measuring the stick in palm spans is the right instinct and the wrong law. It
keeps the stick in proportion to the hand, which is most of what makes it look
held — and a hand's size on screen is a fact about how close somebody is
sitting, not about how far they need to reach. Sit close enough and 1.9 hands
is half the height of the frame: a caber, sweeping every drum at once. Sit far
back and it is a stub that cannot reach the kit at all.

The kit is drawn at fixed places on screen, so the reach that matters is
measured in screen too. Inside the normal range the clamp changes nothing —
a 0.12-span hand still gets exactly 1.9 spans of stick — and outside it, it is
the difference between an instrument and a joke. Every threshold in the
detector is then expressed in *stick reaches* rather than palm spans, for the
same reason: a threshold in spans quietly means something different for every
player and every seating position.

**Holding is a closed hand** — curl your fingers and you have picked the sticks
up, spread them flat and you have put them down. It is measured off all four
fingers at once, in metric 3D when the tracker offers world landmarks, so no
single finger can decide it and turning your hand cannot fake it. The
thresholds sit low enough that a loose, comfortable grip counts; this gesture
exists to put the sticks down, not to make you clench.

Sticks are told apart by **grip tape** in each hand's colour, wrapped from the
butt to a little past the fist. A coloured dot does not survive motion blur; a
band along a third of the shaft does — and putting it where the hand closes is
what makes the stick read as gripped rather than as glued to a wrist.

### One ruler that does not shrink

Every threshold here is measured in *palm spans*, so the span itself has to
mean something. Naively it is one distance across the palm, and naively that is
wrong: turn the hand and whichever distance you picked foreshortens, the ruler
shrinks, and every threshold silently moves with it.

World landmarks make this recoverable without assuming anything about pose.
Each pair of palm points has a known real length, so each gives an estimate of
the image scale — and a foreshortened pair can only ever read *short*. The
largest estimate is therefore the one from whichever pair happens to be side-on
to the camera, which is the true scale. Squashing a synthetic hand to 35% of
its width in `test/drums.mjs` moves the measured span by under 1%.

### No calibration, deliberately

The piano needs a homography because a key is two centimetres wide and hitting
the wrong one is a wrong note. A drum is the size of a dinner plate and there
are seven of them, so screen-space ellipses are plenty. Dropping calibration
removes the single largest piece of setup friction in the project: you open the
page, press start, and play.

### Where the kit goes is not where a kit looks right

The first layout spread the drums corner to corner, the way a photograph of a
kit does, and several of them turned out to be **physically unreachable**.

The stick tip hangs a couple of spans below the fist, so the region the tip can
occupy is offset well *below* wherever your hands are comfortable — roughly the
lower two-thirds of the frame. Putting the cymbals near the top edge meant
reaching them required holding your hands above the frame entirely. It read as
the instrument being broken, and it was.

So the kit sits lower and narrower than a photograph would: cymbals at the top
of the reachable band, snare and floor at the bottom of it, kick below them.

Each pad then carries two geometries. The **head** is what is drawn. The
**zone** is a larger and especially a *taller* ellipse around it, and zones
decide only which drum you are aiming at, never whether you hit anything. They
are stretched vertically rather than evenly because a kit is a couple of rows of
drums with a lot of air between them, so the gaps that swallow strokes are the
vertical ones. `test/drums.mjs` walks the line joining every adjacent pair of
pads — 246 sample points — and requires that not one of them belongs to no
drum.

### Say what you are about to hit, and whether you could

The drum under each raised stick is **ringed in that hand's colour**, before any
stroke. Without it, aiming is guesswork you only get feedback on after
committing: you swing, something else sounds, and there is no way to learn where
the edges are.

The ring says two things, because a stroke needs two. Solid, with the drum's
surface drawn as a bright line across it, means the tip is above that line and a
stroke will land. Faint and dashed means the tip is already *below* it and has
to come back up first — which is the one state that would otherwise be a silent
mystery, since everything looks right and nothing sounds.

### Detection: contact, not braking

The first detector borrowed the piano's tap logic — accelerate, then stop
abruptly, and the hit belongs on the stop — and it was the wrong question twice
over.

**It was late by construction.** A stop can only be recognised after it has
happened: the detector had to watch the speed fall to roughly half its peak, and
in mid-air a hand takes something like a tenth of a second to brake. That is a
tenth of a second of latency no tuning could remove, on the one instrument where
timing is the entire performance. **And it was fragile** — a stroke had to clear
an approach speed, then a peak, then a travel distance, then decelerate by the
right ratio inside a window, all before a timeout. Five gates in series, each
with its own way of quietly dropping a stroke you definitely played.

The question is now simply **did the tip come down through a drum?** Each pad
has a surface just above its centre, and a hit is the tip crossing that surface
downward with some speed behind it. It fires on the frame the crossing happens
rather than a tenth of a second after the fact, and there is one gate left, on a
quantity the player can see.

Because the crossing sits *between* two samples, the exact moment is
interpolated and the hit is placed there rather than at whenever the tracker
happened to look. That matters more than it sounds: at twenty-five looks a
second the difference is up to forty milliseconds, applied at random, which is
precisely what makes a steady roll sound drunk. The same stroke sampled at 20 fps
and at 120 fps lands 2.2 ms apart in `test/drums.mjs`, on samples 50 ms apart.
`main.js` then holds a 22 ms budget so each hit can be scheduled at its true
moment — constant latency is something a player adapts to in seconds, jitter is
something nobody ever adapts to.

What is lost is worth naming. A stroke swung at a gap between two drums used to
be caught by a nearest-pad search and played anyway; now it plays nothing. The
zones above are sized so those gaps barely exist inside the kit, and the ring
makes a miss something you can see coming rather than discover afterwards.

**Rearming is a lift, and it is measured as travel.** Coming back up is what
reloads the stroke, which is how drumming works anyway. The subtle part is that
it cannot be "above the surface": the kit is a staircase of surfaces at
different heights, so rearming against whichever drum the tip currently happens
to be over lets one long swing down the frame sound every drum it passes — it
goes through the hi-hat and is immediately "above" the snare's lower surface,
and fires again. Measuring upward travel from the lowest the tip has been fixes
it, and `test/drums.mjs` sweeps a stick down the whole frame to prove one swing
sounds one drum.

The timeout matters too, and it was a bug once: requiring the lift and nothing
else means a single unseen recovery — an occluded hand, a dropped frame, a
player who drifts back up too gently to measure — takes that stick out of
service permanently. A dead hand is a far worse failure than an extra hit, so
the rearm also times out (`SLACK`).

`test/drums.mjs` prints the resulting margin as a pair, because either number
alone is meaningless — it is easy to catch a gentle stroke, and easy to reject
noise, and the whole problem is doing both:

```
a hand resting on a drum, per tracker jitter - 2%:0  3%:0  4%:0  6%:0 spurious
slowest stroke still caught                  - 0.2s:8/8  0.35s:8/8  0.5s:8/8  0.8s:5/8
caught per tracking rate — 60fps:4/4  45fps:4/4  30fps:4/4  20fps:4/4  15fps:4/4
```

An unhurried half-second stroke plays; a hand resting *on* a drum with 6% jitter
does not; and because contact is caught on the frame it happens rather than
after the stroke finishes braking, a slow tracker now costs timing rather than
whole strokes.

### Smooth at sixty, tracked at twenty

Landmarks arrive whenever inference finishes — on a laptop twenty-something
times a second, and never evenly. The canvas paints sixty times a second.
Drawing the latest sample means the stick stands still and then jumps, and the
eye reads that as the *instrument* being slow even when the detection underneath
is fine.

So the drawn stick follows the tracked one through a critically damped spring,
evaluated every frame. It costs a few milliseconds of visual lag and buys none
of it back in timing: contact is measured off the raw tip, and flashes are
scheduled against the audio clock, so neither goes anywhere near it. The tracker
also gives up the last tenth of its duty cycle, because at a duty of 1 the main
thread never leaves MediaPipe and there is nothing left to paint with.

One rule holds the whole thing together: the stick that is drawn is built from
the *detector's own* filtered pose, not recomputed alongside it. Two filters on
the same landmarks drift apart, and when they do the stick you aim with is not
the stick that hits — unplayable, and very hard to diagnose from outside.

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
index.html              Air Studio: threshold → landing → app shelf
intro.css               landing-page theme (dark; the instruments are still light)
src/intro.js            the canvas: nebula, stars, horizon, dial, strings, dust — and the scenes
src/audio-intro.js      landing-page score and touch sounds (never loaded by the app)
play.html               Air Guitar: markup, control panel, three modals
piano.html / piano.css  Air Piano: markup and its few theme additions
src/piano/geometry.js   calibration homography, desk ⇄ image mapping
src/piano/onset.js      tap detection — the strike-signature state machine
src/piano/scales.js     scale-locked note layout across the surface
src/piano/piano-worklet.js  modal struck-string synthesis
src/piano/audio.js      Tone chain for the piano
src/piano/tour.js       the first-run walkthrough, and where it points
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
node test/smoke.mjs       # real Chromium + fake webcam over CDP: threshold, shelf, tutorial, boot, editors, audio

# piano
node test/piano.mjs       # homography, tap detection at controlled sample rates, scales
node test/piano-dsp.mjs   # inharmonicity, per-partial decay, two-stage decay, velocity as brightness
node test/piano-smoke.mjs # boot, walkthrough, calibration, then the whole path with a scripted hand

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