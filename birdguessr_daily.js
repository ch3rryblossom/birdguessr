/* =====================================================================
   BirdGuessr - DAILY MODE
   Replaces the last inline <script> block of the page.
   ===================================================================== */

/* ---------- CONFIG ---------- */
const SCHEDULE_FILE = 'daily_schedule.json';   // made offline by make_daily_schedule.R
const ROUNDS_PER_DAY = 5;
const MAX_ROUND_SCORE = 1000;
const EPOCH_UTC = Date.UTC(2026, 9, 24);   // Day 1 = 24 Oct 2026 (month is 0-based)

// Shared score storage (Supabase REST). Leave empty to run without global stats.
const SUPABASE_URL = 'https://auvorzvqpgvngrennedh.supabase.co';        // e.g. 'https://xxxx.supabase.co'
const SUPABASE_ANON_KEY = 'sb_publishable_IFX5i-Qvph9QMZ-TeBJ75A_0wmHd7n6';
const SCORES_TABLE = 'daily_scores';
const SITE_URL = 'https://ch3rryblossom.github.io/birdguessr'; 

const STORAGE_KEY = 'birdguessr_daily_v1';
const CLIENT_KEY = 'birdguessr_client_id';

/* ---------- STATE ---------- */
let dailyBirds = [];
let dayNumber = 1;
let currentRound = 1;
let totalScore = 0;
let roundScores = [];          // {distance, score}
let currentBird = null;
let map = null;
let playerMarker = null;
let actualMarker = null;
let resultLine = null;
let gameState = 'waiting';
let saved = null;              // persisted progress for today

/* ---------- DAY NUMBER ---------- */
function getDayNumber() {
    const now = new Date();
    const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return Math.max(1, Math.floor((todayUTC - EPOCH_UTC) / 86400000) + 1);
}

function dayDate(day) {
    return new Date(EPOCH_UTC + (day - 1) * 86400000);
}

/* ---------- DATA LOADING ---------- */
// The 5 checklists per day are pre-sampled offline, so only a tiny JSON is fetched
// (no multi-MB CSV download or parsing).
async function loadTodaysBirds(day) {
    try {
        const res = await fetch(SCHEDULE_FILE);
        if (!res.ok) throw new Error('Schedule file not found');
        const schedule = await res.json();
        // if the schedule runs out, loop back to its start
        const entry = schedule[(day - 1) % schedule.length];
        return entry.map(r => ({ ...r, lat: parseFloat(r.lat), lng: parseFloat(r.long) }));
    } catch (error) {
        console.error('Error loading schedule:', error);
        return [];
    }
}

/* ---------- PERSISTENCE ---------- */
function loadSaved() {
    try {
        const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
        if (s && s.day === dayNumber) return s;
    } catch (e) {}
    return { day: dayNumber, scores: [], submitted: false };
}

function persist() {
    saved.scores = roundScores;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(saved)); } catch (e) {}
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
    if (!SUPABASE_URL || saved.submitted) return;
    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/${SCORES_TABLE}`, {
            method: 'POST',
            headers: { ...sbHeaders(), 'Prefer': 'return=minimal' },
            body: JSON.stringify({ day, client_id: getClientId(), score })
        });
        // 409 = this client already submitted today's score; also fine
        if (res.ok || res.status === 409) {
            saved.submitted = true;
            persist();
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

function renderHistogram(container, bins, myScore) {
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
            Today's scores (${total} player${total === 1 ? '' : 's'})
        </p>
        <div style="display:flex; align-items:flex-end; height:140px; gap:3px;">${bars}</div>
        <div style="display:flex; gap:3px; margin-top:2px;">${labels}</div>
        <p class="text-sm mt-3" style="color: var(--text-cream);">
            ${total > 1 ? `You did better than about <b style="color:var(--accent-gold);">${pct}%</b> of today's players.` : 'You are the first player today!'}
        </p>`;
}

/* ---------- GAME ROUNDS ---------- */
const birdInfo = document.getElementById('birdInfo');
const birdsHeader = document.getElementById('birdsHeader');

birdInfo.addEventListener('scroll', () => {
    birdsHeader.classList.toggle('birdsHeader--scrolled', birdInfo.scrollTop > 0);
});

function parseSpecies(s) {
    if (!s) return [];
    return s.split(',').map(x => x.trim()).filter(x => x.length > 0);
}

function startNewRound() {
    currentBird = dailyBirds[currentRound - 1];
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
    document.getElementById('totalRounds').textContent = ROUNDS_PER_DAY;
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
        persist();   // progress survives a reload

        document.getElementById('roundDistance').textContent = Math.round(distance) + ' km';
        document.getElementById('roundScore').textContent = roundScore;
        document.getElementById('overlayTotalScore').textContent = totalScore;
        document.getElementById('nextRoundBtn').textContent =
            currentRound >= ROUNDS_PER_DAY ? 'See Results' : 'Next Round';
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

    const dateStr = dayDate(dayNumber).toLocaleDateString('en-GB',
        { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });

    let shareText = `#BirdGuessr #Day${dayNumber} (${dateStr})\n`;
    shareText += `I scored ${totalScore}/${ROUNDS_PER_DAY * MAX_ROUND_SCORE} \n`;
    roundScores.forEach((r, i) => {
        const distKm = r.distance >= 1000
            ? `${(r.distance / 1000).toFixed(1)}K km`
            : `${Math.round(r.distance)} km`;
        shareText += `${i + 1}️⃣ 📍${distKm} - ⭐${r.score}/${MAX_ROUND_SCORE}\n`;
    });
    shareText += SITE_URL;     // <-- new

    const finalOverlay = document.createElement('div');
    finalOverlay.id = 'finalScoreboard';
    finalOverlay.className = 'absolute inset-0 bg-black bg-opacity-50 flex items-center justify-center';
    finalOverlay.style.zIndex = '2000';
    finalOverlay.innerHTML = `
        <div class="rounded-2xl p-8 w-2/3 max-w-2xl shadow-2xl text-center vintage-border"
             style="background: linear-gradient(135deg, var(--bg-medium-green) 0%, var(--bg-light-green) 100%); color: var(--text-light-cream); max-height: 92vh; overflow-y: auto;">
            <p class="text-xl mb-1" style="color: var(--text-cream);">BirdGuessr · Day ${dayNumber}</p>
            <p class="text-6xl font-bold mb-2 glow-text" style="color: var(--accent-light-gold);">${totalScore}</p>
            <p class="text-lg mb-4" style="color: var(--text-cream);">out of ${ROUNDS_PER_DAY * MAX_ROUND_SCORE} points</p>

            <div class="rounded-lg p-4 mb-4 text-left" style="background: rgba(26, 58, 46, 0.6); border: 2px solid var(--accent-bronze);">
                <pre id="shareText" class="text-sm whitespace-pre-wrap font-mono" style="color: var(--text-cream);">${shareText}</pre>
            </div>

            <div id="distribution" class="rounded-lg p-4 mb-4 text-left" style="background: rgba(26, 58, 46, 0.6); border: 2px solid var(--accent-bronze);">
                <p style="color: var(--text-cream);">Loading today's scores...</p>
            </div>

            <div class="flex gap-4 justify-center">
                <button onclick="copyScore()" class="vintage-button font-bold py-3 px-6 rounded-lg text-lg">📋 Copy Score</button>
                <button onclick="closeFinal()" class="vintage-button font-bold py-3 px-6 rounded-lg text-lg">Home</button>
            </div>
            <p class="text-sm mt-4" style="color: var(--text-cream);">A new set of birds arrives at 00:00 UTC.</p>
        </div>`;
    document.getElementById('gameContent').appendChild(finalOverlay);

    loadDistribution();
}

async function loadDistribution() {
    const box = document.getElementById('distribution');
    await submitScore(dayNumber, totalScore);
    const bins = await fetchHistogram(dayNumber);
    if (!box) return;
    if (bins) {
        renderHistogram(box, bins, totalScore);
    } else {
        box.innerHTML = `<p style="color: var(--text-cream);">Global score distribution isn't available right now.</p>`;
    }
}

function closeFinal() {
    refreshStartButton();
    showPage('homePage');
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

function isComplete() {
    return roundScores.length >= ROUNDS_PER_DAY;
}

function refreshStartButton() {
    const btn = document.getElementById('startGameBtn');
    btn.textContent = isComplete() ? 'VIEW RESULTS'
        : roundScores.length > 0 ? 'CONTINUE TODAY'
        : "PLAY TODAY'S GAME";
}

document.getElementById('startGameBtn').addEventListener('click', () => {
    if (dailyBirds.length === 0) {
        alert('Daily birds not loaded!');
        return;
    }
    showPage('gamePage');
    initializeMap();

    totalScore = roundScores.reduce((a, r) => a + r.score, 0);
    if (isComplete()) {
        document.getElementById('totalScore').textContent = totalScore;
        document.getElementById('roundNumber').textContent = ROUNDS_PER_DAY;
        document.getElementById('totalRounds').textContent = ROUNDS_PER_DAY;
        showFinalScoreboard();
    } else {
        const f = document.getElementById('finalScoreboard');
        if (f) f.remove();
        currentRound = roundScores.length + 1;
        startNewRound();
    }
});

document.getElementById('homeBtn').addEventListener('click', () => {
    refreshStartButton();
    showPage('homePage');
});

document.getElementById('nextRoundBtn').addEventListener('click', () => {
    currentRound++;
    if (currentRound <= ROUNDS_PER_DAY) {
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

    dayNumber = getDayNumber();
    dailyBirds = await loadTodaysBirds(dayNumber);
    if (dailyBirds.length === 0) {
        startBtn.textContent = 'DATA NOT FOUND';
        return;
    }

    saved = loadSaved();
    roundScores = saved.scores || [];
    totalScore = roundScores.reduce((a, r) => a + r.score, 0);

    refreshStartButton();
    startBtn.disabled = false;
})();
