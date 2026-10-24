/* =====================================================================
   BirdGuessr - Daily + Archive + Free Play
   Loaded with <script src="birdguessr-daily.js"></script> at the end of <body>.
   ===================================================================== */

/* ---------- CONFIG ---------- */
const SCHEDULE_FILE = 'daily_schedule.json';   // made offline by make_daily_schedule.R
const CSV_FILE = 'birdguessr_db_6nov.csv';     // only fetched when Free Play is used
const SITE_URL = 'https://ch3rryblossom.github.io/birdguessr';   // <-- your real address
const ROUNDS_PER_SET = 5;
const MAX_ROUND_SCORE = 1000;
const EPOCH_UTC = Date.UTC(2026, 9, 24);       // Day 1 = 24 Oct 2026 (month is 0-based)

// Shared score storage (Supabase REST). Leave empty to run without global stats.
const SUPABASE_URL = 'https://auvorzvqpgvngrennedh.supabase.co';        // e.g. 'https://xxxx.supabase.co'
const SUPABASE_ANON_KEY = 'sb_publishable_IFX5i-Qvph9QMZ-TeBJ75A_0wmHd7n6';
const SCORES_TABLE = 'daily_scores';

const PROGRESS_KEY = 'birdguessr_progress_v2';
const OLD_PROGRESS_KEY = 'birdguessr_daily_v1';
const CLIENT_KEY = 'birdguessr_client_id';

/* ---------- STATE ---------- */
let schedule = [];             // all pre-sampled days
let csvRows = null;            // full database, loaded lazily for Free Play
let todayNumber = 1;
let session = { mode: 'daily', day: 1 };   // or { mode: 'free' }
let roundBirds = [];           // the 5 checklists being played
let currentRound = 1;
let totalScore = 0;
let roundScores = [];          // {distance, score}
let currentBird = null;
let map = null;
let playerMarker = null;
let actualMarker = null;
let resultLine = null;
let gameState = 'waiting';
let progress = {};             // { "<day>": {scores:[...], submitted:bool} }

/* ---------- DAY NUMBERS ---------- */
function getDayNumber() {
    const now = new Date();
    const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return Math.max(1, Math.floor((todayUTC - EPOCH_UTC) / 86400000) + 1);
}

function dayDate(day) {
    return new Date(EPOCH_UTC + (day - 1) * 86400000);
}

function fmtDate(day, opts) {
    return dayDate(day).toLocaleDateString('en-GB', { ...opts, timeZone: 'UTC' });
}

/* ---------- DATA LOADING ---------- */
async function loadSchedule() {
    try {
        const res = await fetch(SCHEDULE_FILE);
        if (!res.ok) throw new Error('Schedule file not found');
        return await res.json();
    } catch (error) {
        console.error('Error loading schedule:', error);
        return [];
    }
}

function birdsForDay(day) {
    const entry = schedule[(day - 1) % schedule.length];   // loops if schedule runs out
    return entry.map(r => ({ ...r, lat: parseFloat(r.lat), lng: parseFloat(r.long) }));
}

// Free Play uses the whole database; fetched only when first needed.
async function ensureCSV() {
    if (csvRows) return csvRows;
    const res = await fetch(CSV_FILE);
    if (!res.ok) throw new Error('CSV file not found');
    const parsed = Papa.parse(await res.text(), {
        header: true, dynamicTyping: true, skipEmptyLines: true
    });
    csvRows = parsed.data
        .map(r => ({ ...r, lat: parseFloat(r.lat), lng: parseFloat(r.long) }))
        .filter(r => r.species && isFinite(r.lat) && isFinite(r.lng));
    return csvRows;
}

function sampleRows(rows, n) {
    const idx = new Set();
    while (idx.size < Math.min(n, rows.length)) idx.add(Math.floor(Math.random() * rows.length));
    return [...idx].map(i => rows[i]);
}

/* ---------- PERSISTENCE ---------- */
function loadProgress() {
    try { progress = JSON.parse(localStorage.getItem(PROGRESS_KEY)) || {}; } catch (e) { progress = {}; }
    // migrate the single-day format of the first version
    try {
        const old = JSON.parse(localStorage.getItem(OLD_PROGRESS_KEY));
        if (old && old.day && !progress[old.day]) {
            progress[old.day] = { scores: old.scores || [], submitted: !!old.submitted };
        }
        localStorage.removeItem(OLD_PROGRESS_KEY);
    } catch (e) {}
    writeProgress();
}

function writeProgress() {
    try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress)); } catch (e) {}
}

function getDayProgress(day) {
    return progress[day] || { scores: [], submitted: false };
}

function persist() {
    if (session.mode !== 'daily') return;
    const p = getDayProgress(session.day);
    p.scores = roundScores;
    progress[session.day] = p;
    writeProgress();
}

function getClientId() {
    try {
        let id = localStorage.getItem(CLIENT_KEY);
        if (!id) {
            id = crypto.randomUUID();
            localStorage.setItem(CLIENT_KEY, id);
        }
        return id;
    } catch (e) {
        return crypto.randomUUID();
    }
}

/* ---------- SCORE DISTRIBUTION (Supabase) ---------- */
// Legacy anon keys are JWTs (start with "eyJ") and go in both headers; the newer
// "publishable" keys (sb_publishable_...) are not JWTs and go in `apikey` only.
const sbHeaders = () => {
    const h = { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' };
    if (SUPABASE_ANON_KEY.startsWith('eyJ')) h['Authorization'] = 'Bearer ' + SUPABASE_ANON_KEY;
    return h;
};

async function submitScore(day, score) {
    const p = getDayProgress(day);
    if (!SUPABASE_URL || p.submitted) return;
    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/${SCORES_TABLE}`, {
            method: 'POST',
            headers: { ...sbHeaders(), 'Prefer': 'return=minimal' },
            body: JSON.stringify({ day, client_id: getClientId(), score })
        });
        // 409 = this client already submitted this day's score; also fine
        if (res.ok || res.status === 409) {
            p.submitted = true;
            progress[day] = p;
            writeProgress();
        }
    } catch (e) {
        console.error('Score submit failed:', e);
    }
}

// Returns array of 10 counts (bins of 500 points), or null if unavailable.
async function fetchHistogram(day) {
    if (!SUPABASE_URL) return null;
    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/daily_histogram`, {
            method: 'POST',
            headers: sbHeaders(),
            body: JSON.stringify({ day_in: day })
        });
        if (!res.ok) return null;
        const rows = await res.json();
        const bins = new Array(10).fill(0);
        rows.forEach(r => { bins[r.bin] = Number(r.n); });
        return bins;
    } catch (e) {
        console.error('Histogram fetch failed:', e);
        return null;
    }
}

function renderHistogram(container, bins, myScore, day) {
    const total = bins.reduce((a, b) => a + b, 0);
    const myBin = Math.min(9, Math.floor(myScore / 500));
    const max = Math.max(...bins, 1);
    const below = bins.slice(0, myBin).reduce((a, b) => a + b, 0) + bins[myBin] / 2;
    const pct = total > 0 ? Math.round(100 * below / total) : 0;

    const bars = bins.map((n, i) => {
        const h = Math.round(100 * n / max);
        const mine = i === myBin;
        return `
        <div style="flex:1; display:flex; flex-direction:column; align-items:center; justify-content:flex-end; height:100%;">
            <span style="font-size:11px; color:var(--text-cream);">${n || ''}</span>
            <div style="width:80%; height:${Math.max(h, n ? 3 : 0)}%; background:${mine ? 'var(--accent-gold)' : 'var(--bg-light-green)'}; border:${mine ? '2px solid var(--accent-light-gold)' : '1px solid var(--accent-bronze)'}; border-radius:3px 3px 0 0;"></div>
        </div>`;
    }).join('');

    const labels = bins.map((_, i) =>
        `<div style="flex:1; text-align:center; font-size:10px; color:var(--text-cream);">${i * 500}</div>`
    ).join('');

    container.innerHTML = `
        <p class="text-lg mb-2" style="color: var(--accent-light-gold);">
            Day ${day} scores (${total} player${total === 1 ? '' : 's'})
        </p>
        <div style="display:flex; align-items:flex-end; height:140px; gap:3px;">${bars}</div>
        <div style="display:flex; gap:3px; margin-top:2px;">${labels}</div>
        <p class="text-sm mt-3" style="color: var(--text-cream);">
            ${total > 1 ? `You did better than about <b style="color:var(--accent-gold);">${pct}%</b> of players.` : 'You are the first player!'}
        </p>`;
}

/* ---------- ARCHIVE ---------- */
(function injectStyles() {
    const st = document.createElement('style');
    st.textContent = `
    .archive-item { display:flex; justify-content:space-between; align-items:center; width:100%;
        padding:.5rem .75rem; margin-bottom:.35rem; border:1px solid var(--accent-bronze);
        border-radius:.5rem; background:rgba(26,58,46,.6); color:var(--text-light-cream);
        text-align:left; transition:all .2s; }
    .archive-item:hover { border-color:var(--accent-gold); background:rgba(61,107,85,.8); }
    .archive-item small { display:block; color:var(--text-cream); opacity:.8; font-size:.75em; }
    .archive-status { color:var(--accent-gold); }`;
    document.head.appendChild(st);
})();

function buildArchive() {
    const box = document.getElementById('archiveList');
    if (!box) return;
    box.innerHTML = '';
    for (let d = todayNumber; d >= 1; d--) {
        const scores = getDayProgress(d).scores;
        const n = scores.length;
        const total = scores.reduce((a, r) => a + r.score, 0);
        const status = n >= ROUNDS_PER_SET ? `★ ${total}` : n > 0 ? `${n}/${ROUNDS_PER_SET}` : 'Play';
        const btn = document.createElement('button');
        btn.className = 'archive-item';
        btn.innerHTML = `
            <span>Day ${d}${d === todayNumber ? ' · Today' : ''}
                <small>${fmtDate(d, { day: '2-digit', month: 'short', year: 'numeric' })}</small></span>
            <span class="archive-status">${status}</span>`;
        btn.addEventListener('click', () => playDay(d));
        box.appendChild(btn);
    }
}

/* ---------- SESSIONS ---------- */
function launchSession(sess, birds) {
    session = sess;
    roundBirds = birds;
    roundScores = sess.mode === 'daily' ? getDayProgress(sess.day).scores.slice() : [];
    totalScore = roundScores.reduce((a, r) => a + r.score, 0);

    showPage('gamePage');
    initializeMap();
    const f = document.getElementById('finalScoreboard');
    if (f) f.remove();
    setModeLabel();

    if (roundScores.length >= ROUNDS_PER_SET) {
        document.getElementById('totalScore').textContent = totalScore;
        document.getElementById('roundNumber').textContent = ROUNDS_PER_SET;
        document.getElementById('totalRounds').textContent = ROUNDS_PER_SET;
        showFinalScoreboard();
    } else {
        currentRound = roundScores.length + 1;
        startNewRound();
    }
}

function playDay(day) {
    if (schedule.length === 0) { alert('Daily birds not loaded!'); return; }
    launchSession({ mode: 'daily', day }, birdsForDay(day));
}

async function playFree() {
    const btn = document.getElementById('freePlayBtn');
    const label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'LOADING...'; }
    try {
        const rows = await ensureCSV();
        launchSession({ mode: 'free' }, sampleRows(rows, ROUNDS_PER_SET));
    } catch (e) {
        console.error(e);
        alert('Could not load the bird database for Free Play.');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = label; }
    }
}

function setModeLabel() {
    let el = document.getElementById('modeLabel');
    if (!el) {
        el = document.createElement('p');
        el.id = 'modeLabel';
        el.className = 'text-lg';
        el.style.color = 'var(--accent-gold)';
        document.getElementById('gameInfo').prepend(el);
    }
    el.textContent = session.mode === 'free'
        ? 'Free Play'
        : session.day === todayNumber ? `Day ${session.day} · Today` : `Day ${session.day} · Archive`;
}

/* ---------- GAME ROUNDS ---------- */
const birdInfo = document.getElementById('birdInfo');
const birdsHeader = document.getElementById('birdsHeader');

birdInfo.addEventListener('scroll', () => {
    birdsHeader.classList.toggle('birdsHeader--scrolled', birdInfo.scrollTop > 0);
});

function parseSpecies(s) {
    if (!s) return [];
    return String(s).split(',').map(x => x.trim()).filter(x => x.length > 0);
}

function startNewRound() {
    currentBird = roundBirds[currentRound - 1];
    if (!currentBird) return;

    const species = parseSpecies(currentBird.species);
    birdInfo.scrollTo({ top: 0, behavior: 'smooth' });
    const birdListDiv = document.getElementById('birdList');
    birdListDiv.innerHTML = '';
    species.forEach((bird, index) => {
        const p = document.createElement('p');
        p.className = 'birdItem text-xl font-medium';
        p.style.color = 'var(--accent-gold)';
        const words = bird.trim().split(/\s+/);
        const lastWord = words.pop();
        const rest = words.join(' ');
        p.innerHTML = rest.length > 0
            ? `${rest} <span class="bird-lastword">${lastWord}</span>`
            : `<span class="bird-lastword">${lastWord}</span>`;
        p.style.animationDelay = `${index * 0.005}s`;
        birdListDiv.appendChild(p);
    });

    document.getElementById('birdDate').textContent = currentBird.date || 'Unknown';
    document.getElementById('roundNumber').textContent = currentRound;
    document.getElementById('totalRounds').textContent = ROUNDS_PER_SET;
    document.getElementById('totalScore').textContent = totalScore;

    gameState = 'waiting';

    [playerMarker, actualMarker, resultLine].forEach(l => { if (l) map.removeLayer(l); });
    playerMarker = actualMarker = resultLine = null;
    map.setView([20, 0], 2);

    hideOverlay();
}

function initializeMap() {
    if (map) map.remove();
    map = L.map('map', {
        worldCopyJump: true,
        maxBounds: [[-90, -180], [90, 180]],
        maxBoundsViscosity: 1.0,
        minZoom: 2,
    }).setView([20, 0], 2);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
        noWrap: true
    }).addTo(map);

    map.on('click', handleMapClick);
}

function calculateDistance(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function handleMapClick(e) {
    if (gameState !== 'waiting') return;
    const { lat, lng } = e.latlng;

    if (playerMarker) {
        playerMarker.setLatLng([lat, lng]);
    } else {
        playerMarker = L.marker([lat, lng], {
            icon: L.divIcon({
                className: 'custom-div-icon',
                html: '<div style="background-color: #d4af37; width: 20px; height: 20px; border-radius: 50%; border: 3px solid #f0d98c; box-shadow: 0 0 10px rgba(212, 175, 55, 0.6);"></div>',
                iconSize: [20, 20],
                iconAnchor: [10, 10]
            })
        }).addTo(map);
    }

    const confirmHandler = () => {
        const g = playerMarker.getLatLng();
        const distance = calculateDistance(g.lat, g.lng, currentBird.lat, currentBird.lng);

        actualMarker = L.marker([currentBird.lat, currentBird.lng], {
            icon: L.divIcon({
                className: 'custom-div-icon',
                html: '<div style="background-color: #3d6b55; width: 20px; height: 20px; border-radius: 50%; border: 3px solid #d4af37; box-shadow: 0 0 10px rgba(61, 107, 85, 0.8);"></div>',
                iconSize: [20, 20],
                iconAnchor: [10, 10]
            })
        }).addTo(map);

        resultLine = L.polyline([[g.lat, g.lng], [currentBird.lat, currentBird.lng]], {
            color: '#c9a961', weight: 3, dashArray: '5, 10'
        }).addTo(map);

        map.fitBounds(new L.featureGroup([playerMarker, actualMarker]).getBounds().pad(0.1));

        const roundScore = Math.max(0, MAX_ROUND_SCORE - Math.floor(distance / 10));
        totalScore += roundScore;
        roundScores.push({ distance, score: roundScore });
        persist();   // daily/archive progress survives a reload

        document.getElementById('roundDistance').textContent = Math.round(distance) + ' km';
        document.getElementById('roundScore').textContent = roundScore;
        document.getElementById('overlayTotalScore').textContent = totalScore;
        document.getElementById('nextRoundBtn').textContent =
            currentRound >= ROUNDS_PER_SET ? 'See Results' : 'Next Round';
        showOverlay();
        gameState = 'showing-result';
    };

    playerMarker.bindPopup(`
    <div style="text-align:center;">
        <button onclick="window.confirmGuess()" class="popup-confirm-btn">Confirm</button>
    </div>`).openPopup();

    window.confirmGuess = () => {
        playerMarker.closePopup();
        confirmHandler();
    };
}

/* ---------- OVERLAYS ---------- */
const overlay = document.getElementById('gameOverlay');
const roundInfo = document.getElementById('roundEndInfo');

function showOverlay() {
    overlay.classList.remove('hidden');
    requestAnimationFrame(() => roundInfo.classList.add('roundEndInfo--visible'));
}

function hideOverlay() {
    roundInfo.classList.remove('roundEndInfo--visible');
    setTimeout(() => overlay.classList.add('hidden'), 250);
}

function showFinalScoreboard() {
    hideOverlay();
    const existing = document.getElementById('finalScoreboard');
    if (existing) existing.remove();

    const isFree = session.mode === 'free';
    const day = session.day;

    let shareText = isFree
        ? `#BirdGuessr #FreePlay\n`
        : `#BirdGuessr #Day${day} (${fmtDate(day, { day: '2-digit', month: '2-digit', year: 'numeric' })})\n`;
    shareText += `I scored ${totalScore}/${ROUNDS_PER_SET * MAX_ROUND_SCORE} \n`;
    roundScores.forEach((r, i) => {
        const distKm = r.distance >= 1000
            ? `${(r.distance / 1000).toFixed(1)}K km`
            : `${Math.round(r.distance)} km`;
        shareText += `${i + 1}️⃣ 📍${distKm} - ⭐${r.score}/${MAX_ROUND_SCORE}\n`;
    });
    shareText += SITE_URL;

    const finalOverlay = document.createElement('div');
    finalOverlay.id = 'finalScoreboard';
    finalOverlay.className = 'absolute inset-0 bg-black bg-opacity-50 flex items-center justify-center';
    finalOverlay.style.zIndex = '2000';
    finalOverlay.innerHTML = `
        <div class="rounded-2xl p-8 w-2/3 max-w-2xl shadow-2xl text-center vintage-border"
             style="background: linear-gradient(135deg, var(--bg-medium-green) 0%, var(--bg-light-green) 100%); color: var(--text-light-cream); max-height: 92vh; overflow-y: auto;">
            <p class="text-xl mb-1" style="color: var(--text-cream);">BirdGuessr · ${isFree ? 'Free Play' : 'Day ' + day}</p>
            <p class="text-6xl font-bold mb-2 glow-text" style="color: var(--accent-light-gold);">${totalScore}</p>
            <p class="text-lg mb-4" style="color: var(--text-cream);">out of ${ROUNDS_PER_SET * MAX_ROUND_SCORE} points</p>

            <div class="rounded-lg p-4 mb-4 text-left" style="background: rgba(26, 58, 46, 0.6); border: 2px solid var(--accent-bronze);">
                <pre id="shareText" class="text-sm whitespace-pre-wrap font-mono" style="color: var(--text-cream);">${shareText}</pre>
            </div>

            ${isFree ? '' : `
            <div id="distribution" class="rounded-lg p-4 mb-4 text-left" style="background: rgba(26, 58, 46, 0.6); border: 2px solid var(--accent-bronze);">
                <p style="color: var(--text-cream);">Loading scores...</p>
            </div>`}

            <div class="flex gap-4 justify-center flex-wrap">
                <button onclick="copyScore()" class="vintage-button font-bold py-3 px-6 rounded-lg text-lg">📋 Copy Score</button>
                ${isFree ? `<button onclick="playFree()" class="vintage-button font-bold py-3 px-6 rounded-lg text-lg">🔄 Play Again</button>` : ''}
                <button onclick="closeFinal()" class="vintage-button font-bold py-3 px-6 rounded-lg text-lg">Home</button>
            </div>
            ${isFree ? '' : `<p class="text-sm mt-4" style="color: var(--text-cream);">A new set of birds arrives at 00:00 UTC.</p>`}
        </div>`;
    document.getElementById('gameContent').appendChild(finalOverlay);

    if (!isFree) loadDistribution(day, totalScore);
}

async function loadDistribution(day, score) {
    await submitScore(day, score);
    const bins = await fetchHistogram(day);
    const box = document.getElementById('distribution');
    if (!box) return;
    if (bins) {
        renderHistogram(box, bins, score, day);
    } else {
        box.innerHTML = `<p style="color: var(--text-cream);">Global score distribution isn't available right now.</p>`;
    }
}

function copyScore() {
    const text = document.getElementById('shareText').textContent;
    navigator.clipboard.writeText(text).then(() => {
        const btn = document.querySelector('button[onclick="copyScore()"]');
        const original = btn.innerHTML;
        btn.innerHTML = '✅ Copied!';
        setTimeout(() => { btn.innerHTML = original; }, 2000);
    }).catch(err => {
        console.error('Failed to copy:', err);
        alert('Failed to copy. Please select and copy manually.');
    });
}

/* ---------- NAVIGATION ---------- */
function showPage(pageId) {
    document.getElementById('homePage').classList.add('hidden');
    document.getElementById('gamePage').classList.add('hidden');
    document.getElementById(pageId).classList.remove('hidden');
}

function refreshStartButton() {
    const n = getDayProgress(todayNumber).scores.length;
    document.getElementById('startGameBtn').textContent =
        n >= ROUNDS_PER_SET ? 'VIEW TODAY\'S RESULTS'
        : n > 0 ? 'CONTINUE TODAY'
        : "PLAY TODAY'S GAME";
}

function goHome() {
    refreshStartButton();
    buildArchive();
    showPage('homePage');
}

function closeFinal() { goHome(); }

document.getElementById('startGameBtn').addEventListener('click', () => playDay(todayNumber));
document.getElementById('freePlayBtn').addEventListener('click', playFree);
document.getElementById('homeBtn').addEventListener('click', goHome);

document.getElementById('nextRoundBtn').addEventListener('click', () => {
    currentRound++;
    if (currentRound <= ROUNDS_PER_SET) {
        startNewRound();
    } else {
        showFinalScoreboard();
    }
});

/* ---------- INIT ---------- */
(async function init() {
    const startBtn = document.getElementById('startGameBtn');
    startBtn.disabled = true;
    startBtn.textContent = 'LOADING...';
    showPage('homePage');

    todayNumber = getDayNumber();
    loadProgress();
    schedule = await loadSchedule();
    if (schedule.length === 0) {
        startBtn.textContent = 'DATA NOT FOUND';
        return;
    }

    refreshStartButton();
    buildArchive();
    startBtn.disabled = false;
})();
