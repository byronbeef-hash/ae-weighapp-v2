# How to Build an Interactive Demo Tour Page

This guide documents how the AgriEID demo pages (`demo.html`, `scales-demo.html`, `reader-demo.html`) were built. Use this as a blueprint to build a demo for the main webapp or any other product.

---

## Architecture

### Single-File Approach
Each demo is a **single self-contained HTML file** with inline `<style>` and `<script>` blocks. No build step, no frameworks, no external dependencies beyond Google Fonts.

```
demo.html          ← Full product tour (8 steps)
scales-demo.html   ← Scales-only demo (5 steps)
reader-demo.html   ← EID reader demo (5 steps)
```

### Why Single File?
- Deploys alongside the main app with zero config
- No risk of breaking production code
- No build process — just push and it's live
- Easy to duplicate and customise for different products

---

## Core Structure

Every demo follows the same pattern:

```html
<!DOCTYPE html>
<html>
<head>
    <!-- Google Fonts (same as main app) -->
    <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">

    <style>
        /* 1. CSS Variables (copy from main app) */
        /* 2. Layout components (progress bar, nav, steps) */
        /* 3. UI components (cards, badges, tooltips) */
        /* 4. Step-specific styles (weight display, charts, etc.) */
    </style>
</head>
<body>
    <!-- Progress bar (fixed top) -->
    <!-- Step label pill (fixed top centre) -->
    <!-- Toast notification (fixed top centre) -->

    <!-- Step 1 HTML -->
    <!-- Step 2 HTML -->
    <!-- Step N HTML -->

    <!-- Bottom navigation (fixed bottom) -->

    <script>
        /* 1. Mock data */
        /* 2. Tour controller (goToStep, nextStep, prevStep) */
        /* 3. Animation helpers (typeText, countUp, showToast) */
        /* 4. Step init functions (one per animated step) */
        /* 5. Init on page load */
    </script>
</body>
</html>
```

---

## Step 1: Copy CSS Variables from Main App

Open the main app's `styles.css` and copy the entire `:root` block. This guarantees your demo uses identical colours, spacing, and border radius.

```css
:root {
    --bg-primary: #0d1117;
    --bg-secondary: #161b22;
    --bg-card: #161b22;
    --text-primary: #ffffff;
    --text-secondary: rgba(255, 255, 255, 0.55);
    --text-dim: rgba(255, 255, 255, 0.25);
    --green: #3fb950;
    --green-dim: rgba(63, 185, 80, 0.15);
    --orange: #f0883e;
    --blue: #58a6ff;
    --border: rgba(255, 255, 255, 0.15);
    --glass-bg: #161b22;
    --glass-border: rgba(255, 255, 255, 0.18);
    --glass-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    --radius: 12px;
    --radius-sm: 8px;
}
```

---

## Step 2: Build the Tour Controller (JavaScript)

This is the engine that drives the entire demo. ~30 lines of code.

### State
```javascript
const STEP_NAMES = ['Setup', 'Connected', 'Live Weighing', 'Records', 'Shop'];
const TOTAL_STEPS = 5;
let currentStep = 1;
let stepTimers = [];        // All setTimeout/setInterval IDs for cleanup
let autoAdvanceTimer = null; // The 10-second auto-advance timer
```

### Core Function: `goToStep(n)`
This is the most important function. It:
1. Clears all running timers (prevents animation overlap)
2. Hides all steps, shows the target step
3. Updates progress bar width
4. Updates step label text
5. Updates nav dots (active/visited/future)
6. Updates Next/Back button text and visibility
7. Removes flash animation from Next button
8. Scrolls to top
9. Calls the step's init function to trigger animations
10. Schedules auto-advance (10 seconds)

```javascript
function goToStep(n) {
    if (n < 1 || n > TOTAL_STEPS) return;
    clearTimers();

    // Hide all, show target
    document.querySelectorAll('.demo-step').forEach(s => s.classList.remove('active'));
    document.getElementById('step-' + n).classList.add('active');
    currentStep = n;

    // Progress bar
    document.getElementById('progress-bar').style.width = ((n / TOTAL_STEPS) * 100) + '%';

    // Step label
    document.getElementById('step-label').textContent =
        'Step ' + n + ' of ' + TOTAL_STEPS + ' — ' + STEP_NAMES[n - 1];

    // Nav buttons
    document.getElementById('btn-back').classList.toggle('hidden', n === 1);
    const nextBtn = document.getElementById('btn-next');
    nextBtn.classList.remove('flash');
    if (n === TOTAL_STEPS) {
        nextBtn.textContent = 'Shop Now';
        nextBtn.onclick = () => window.open('https://your-shop-url.com', '_blank');
    } else {
        nextBtn.textContent = 'Next';
        nextBtn.onclick = nextStep;
    }

    // Dots
    document.querySelectorAll('.demo-nav-dot').forEach((d, i) => {
        d.className = 'demo-nav-dot';
        if (i + 1 === n) d.classList.add('active');
        else if (i + 1 < n) d.classList.add('visited');
    });

    window.scrollTo(0, 0);

    // Trigger step animations
    if (n === 1) initStep1();
    if (n === 2) initStep2();
    // etc.

    // Auto-advance after 10 seconds (flash button at 5s)
    if (n < TOTAL_STEPS) {
        scheduleAutoAdvance(10);
    } else {
        // Flash the CTA button on the last step
        stepTimers.push(setTimeout(flashNextBtn, 3000));
    }
}
```

### Timer Management
Critical for preventing animation overlap when users click quickly:

```javascript
function clearTimers() {
    stepTimers.forEach(t => clearTimeout(t));
    stepTimers = [];
    if (autoAdvanceTimer) { clearTimeout(autoAdvanceTimer); autoAdvanceTimer = null; }
}
```

### Auto-Advance + Flashing Button
```javascript
function flashNextBtn() {
    document.getElementById('btn-next').classList.add('flash');
}

function scheduleAutoAdvance(seconds) {
    if (autoAdvanceTimer) clearTimeout(autoAdvanceTimer);
    // Flash at halfway point
    stepTimers.push(setTimeout(flashNextBtn, seconds * 500));
    // Auto-advance at full duration
    autoAdvanceTimer = setTimeout(() => {
        if (currentStep < TOTAL_STEPS) nextStep();
    }, seconds * 1000);
}
```

### Keyboard Navigation
```javascript
document.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight') nextStep();
    if (e.key === 'ArrowLeft') prevStep();
});
```

---

## Step 3: Build the Persistent UI

### Progress Bar (fixed top)
```html
<div class="demo-progress" id="progress-bar" style="width:0%"></div>
```
```css
.demo-progress {
    position: fixed; top: 0; left: 0; height: 3px; z-index: 100;
    background: var(--green);
    transition: width 0.4s ease;
}
```

### Step Label (fixed top centre)
```html
<div class="demo-step-label" id="step-label"></div>
```

### Toast Notification
```html
<div class="demo-toast" id="toast"></div>
```
```javascript
function showToast(msg, duration) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), duration || 2000);
}
```

### Bottom Navigation
```html
<div class="demo-nav">
    <button class="demo-btn" id="btn-back" onclick="prevStep()">Back</button>
    <div class="demo-nav-dots" id="nav-dots"></div>
    <button class="demo-btn primary" id="btn-next" onclick="nextStep()">Next</button>
</div>
```

Dots are generated dynamically on init:
```javascript
const dots = document.getElementById('nav-dots');
for (let i = 1; i <= TOTAL_STEPS; i++) {
    const dot = document.createElement('div');
    dot.className = 'demo-nav-dot' + (i === 1 ? ' active' : '');
    dot.onclick = () => goToStep(i);
    dots.appendChild(dot);
}
```

### Flashing Button CSS
```css
.demo-btn.flash {
    animation: btnFlash 1s ease infinite;
}
@keyframes btnFlash {
    0%, 100% { box-shadow: 0 0 0 0 rgba(63,185,80,0.4); }
    50% { box-shadow: 0 0 16px 4px rgba(63,185,80,0.6); }
}
```

---

## Step 4: Build Each Demo Step

### Step Container Pattern
Each step is a `<div>` with class `demo-step`. Only one has `active` at a time.

```html
<div class="demo-step" id="step-3">
    <!-- Step content -->
    <div class="demo-tooltip">
        <strong>Feature name</strong> — Description of what's happening.
    </div>
</div>
```

```css
.demo-step {
    display: none;
    min-height: calc(100vh - 70px);
    padding: 60px 20px 90px;
    max-width: 1000px;
    margin: 0 auto;
    animation: fadeIn 0.4s ease;
}
.demo-step.active { display: block; }

@keyframes fadeIn {
    from { opacity: 0; transform: translateY(12px); }
    to { opacity: 1; transform: translateY(0); }
}
```

### Starting with the Real App Screen
Both product demos (scales, reader) start with a replica of the actual app setup screen. This grounds the user in the real product immediately rather than a marketing splash page.

Replicate:
- The 4-button grid (+ New Session, Historic Sessions, Cloud Data, Cloud Login)
- The Bluetooth device cards (Weigh Scales, EID Reader) with Connect buttons
- Display Mode and Data Mode selectors
- The pairing hint ("First time? Enter 0000 or ignore")

Then animate the relevant device connecting (dot turns green, button text changes, toast fires).

---

## Step 5: Animation Helpers

### Typewriter Effect
Auto-types text into an element character by character:
```javascript
function typeText(element, text, speed) {
    speed = speed || 50;
    return new Promise(resolve => {
        let i = 0;
        element.textContent = '';
        const interval = setInterval(() => {
            element.textContent += text[i++];
            if (i >= text.length) { clearInterval(interval); resolve(); }
        }, speed);
    });
}
```

Usage (chain multiple fields):
```javascript
let chain = Promise.resolve();
chain = chain.then(() => typeText(sessionNameEl, 'Morning Weigh'));
chain = chain.then(() => delay(200));
chain = chain.then(() => typeText(mobEl, 'Mob 47'));
```

### Animated Counter
Counts up from 0 to a target number with easing:
```javascript
function countUp(element, target, duration, decimals) {
    decimals = decimals || 0;
    duration = duration || 1000;
    const start = performance.now();
    const tick = () => {
        const progress = Math.min((performance.now() - start) / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
        element.textContent = (target * eased).toFixed(decimals);
        if (progress < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
}
```

### Bluetooth Connect Animation
```javascript
function initSetup() {
    const dot = document.getElementById('scales-dot');
    const btn = document.getElementById('scales-btn');

    // Reset
    dot.className = 'status-dot';
    btn.textContent = 'Connect Scales';

    // Searching... (orange) after 1.5s
    stepTimers.push(setTimeout(() => {
        btn.textContent = 'Searching...';
        btn.style.color = 'var(--orange)';
    }, 1500));

    // Connected (green) after 3.5s
    stepTimers.push(setTimeout(() => {
        dot.classList.add('connected');
        btn.textContent = 'AGU9i Connected';
        btn.style.color = 'var(--green)';
        showToast('Scales connected via Bluetooth');
    }, 3500));
}
```

---

## Step 6: The Weight Simulation (Money Shot)

This is the centrepiece animation. Three phases:

### Phase 1: Fluctuate (orange, MOVING)
Weight numbers flicker randomly around the target. Display is orange.

### Phase 2: Stabilise (green, STEADY)
Weight settles to exact value. Display turns green. Border glows.

### Phase 3: Lock + Save
Lock button fills green. Locked weight section appears. Toast fires. Record count increments. New record slides into the list.

```javascript
function initWeighing() {
    const weightNum = document.getElementById('weight-num');
    const weightDisplay = document.getElementById('weight-display');
    const weightBox = document.getElementById('weight-box');
    const target = 483.0;

    // Reset
    weightNum.textContent = '---';
    weightDisplay.className = 'weight-value';
    weightBox.className = 'weight-indicator';

    // Phase 1: Fluctuate after 600ms
    stepTimers.push(setTimeout(() => {
        weightDisplay.classList.add('dynamic');  // orange
        weightBox.classList.add('dynamic');

        let interval = setInterval(() => {
            const fluctuation = (Math.random() - 0.5) * 4;
            weightNum.textContent = (target + fluctuation).toFixed(1);
        }, 150);

        // Phase 2: Stabilise after 3s
        stepTimers.push(setTimeout(() => {
            clearInterval(interval);
            weightNum.textContent = target.toFixed(1);
            weightDisplay.className = 'weight-value';     // green
            weightBox.className = 'weight-indicator steady';

            // Phase 3: Lock after 1.2s
            stepTimers.push(setTimeout(() => {
                lockBtn.classList.add('locked');
                lockedSection.classList.add('visible');
                showToast('Record saved — ' + target.toFixed(1) + ' kg');
                recCount.textContent = '15';
            }, 1200));
        }, 3000));
    }, 600));
}
```

### Key CSS for Weight Display
```css
.weight-indicator {
    background: #0d1117;
    border: 2px solid var(--glass-border);
    border-radius: 20px;
    padding: 32px 20px;
    transition: border-color 0.3s, box-shadow 0.3s;
}
.weight-indicator.steady {
    border-color: rgba(63,185,80,0.5);
    box-shadow: 0 0 20px rgba(63,185,80,0.15);
}
.weight-indicator.dynamic {
    border-color: rgba(240,136,62,0.5);
    box-shadow: 0 0 20px rgba(240,136,62,0.15);
}

.weight-value {
    font-family: 'Orbitron', monospace;
    font-size: 72px;    /* scales up at breakpoints */
    font-weight: 900;
    color: var(--green);
    transition: color 0.3s;
}
.weight-value.dynamic { color: var(--orange); }
```

---

## Step 7: SVG Charts (No Libraries)

Draw weight history charts using inline SVG. No Chart.js needed.

```javascript
function drawChart() {
    const svg = document.getElementById('chart');
    svg.innerHTML = '';

    const W = 600, H = 220;
    const PAD = { top: 20, right: 20, bottom: 30, left: 50 };
    const data = WEIGHT_HISTORY; // [{date, weight}, ...]

    const minW = Math.min(...data.map(d => d.weight)) - 5;
    const maxW = Math.max(...data.map(d => d.weight)) + 5;

    const xScale = i => PAD.left + (i / (data.length - 1)) * (W - PAD.left - PAD.right);
    const yScale = v => PAD.top + (1 - (v - minW) / (maxW - minW)) * (H - PAD.top - PAD.bottom);

    // Grid lines + labels (SVG line + text elements)
    // Area fill (SVG polygon)
    // Line (SVG polyline with stroke-dasharray animation)
    // Dots (SVG circles, fade in with delay)
}
```

### Draw Animation
The line "draws itself" using CSS stroke-dasharray:
```javascript
const line = createSVG('polyline');
line.setAttribute('points', pointsString);
line.style.strokeDasharray = 1000;
line.style.strokeDashoffset = 1000;
line.style.transition = 'stroke-dashoffset 1.5s ease';
svg.appendChild(line);

// Trigger
requestAnimationFrame(() => {
    line.style.strokeDashoffset = '0';
});
```

---

## Step 8: Mock Data

Define all mock data at the top of the script:

```javascript
const ANIMALS = [
    { eid: '982000364718293', vid: 'Y247', weight: 483.0, adg: 0.82, date: '25 Mar' },
    { eid: '982000364718294', vid: 'Y102', weight: 521.5, adg: 0.95, date: '25 Mar' },
    // ...
];

const WEIGHT_HISTORY = [
    { date: '18 Jan', weight: 444.5 },
    { date: '01 Feb', weight: 447.0 },
    // ...
];

const SESSION_WEIGHTS = [
    { vid: 'Y247', weight: 483.0, time: '10:32' },
    // ...
];
```

Use realistic values — real EID number formats (982...), real-sounding visual tags (Y247, R089, B156), realistic weight ranges (440-540kg for cattle).

---

## Step 9: Responsive Design

Match the main app's breakpoints:

```css
/* Mobile (default) */
.demo-step { padding: 50px 16px 90px; }
.weight-value { font-size: 72px; }
.demo-grid-2, .demo-grid-3 { grid-template-columns: 1fr 1fr; }

/* Tablet (600px+) */
@media (min-width: 600px) {
    .weight-value { font-size: 96px; }
}

/* Desktop (1024px+) */
@media (min-width: 1024px) {
    .weight-value { font-size: 110px; }
}
```

---

## Step 10: Deploy

Since the demo is a static HTML file in the same directory as the main app:

```bash
cd /path/to/webapp
npx vercel --prod --yes
```

It deploys to `your-app.vercel.app/demo.html` automatically. No routing config needed.

---

## Customisation Checklist

When creating a new demo:

1. **Choose your steps** — What's the story? Setup → Action → Results → CTA
2. **Pick your accent colour** — Green for scales, blue for readers, green for full product
3. **Write mock data** — Realistic animal records, weights, dates
4. **Replicate real app screens** — Start with the actual setup screen for authenticity
5. **Add one "hero" animation** — The weight simulation, tag scanning sequence, or chart drawing
6. **End with a shop CTA** — Link to product page, pricing, and free app trial
7. **Set auto-advance timing** — 10 seconds per step works well, flash button at 5s
8. **Test mobile** — Resize to 375px width, check all steps look good
9. **Remove product specs** — No IP ratings, technical jargon. Keep it simple.

---

## File Sizes

| File | Lines | Size |
|------|-------|------|
| demo.html (full tour, 8 steps) | ~780 | ~28 KB |
| scales-demo.html (5 steps) | ~520 | ~20 KB |
| reader-demo.html (5 steps) | ~500 | ~19 KB |

All well under Vercel's limits. No performance concerns.

---

## Live URLs

| Demo | URL |
|------|-----|
| Full Product Tour | https://ae-weighapp.vercel.app/demo.html |
| Scales Demo | https://ae-weighapp.vercel.app/scales-demo.html |
| Reader Demo | https://ae-weighapp.vercel.app/reader-demo.html |
| Main App | https://ae-weighapp.vercel.app/ |
