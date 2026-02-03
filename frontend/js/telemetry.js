/**
 * FlightWall - Telemetry Dashboard JavaScript
 *
 * Full-screen flight telemetry deep-dive view matching the design mockup.
 * Handles:
 * - Leaflet map with gradient flight path polyline
 * - Canvas telemetry charts (altitude, speed, heading) with Y-axis labels
 * - Live polling for flight updates
 * - Scrolling ticker bar with weather/system info
 * - Status bar with clocks, flight time, ETA
 */

// ============================================
// Configuration
// ============================================
const CONFIG = {
    API_BASE: '/api',
    POLL_INTERVAL_MS: 5000,
    HISTORY_MINUTES: 60,
    DEFAULT_ZOOM: 5,
};

// ============================================
// State
// ============================================
let map = null;
let flightPathGroup = null;
let originMarker = null;
let destMarker = null;
let currentPosMarker = null;
let icao24 = null;
let flightData = null;
let historyData = [];
let pollTimer = null;
let clockTimer = null;
let firstFetchTime = null;

// ============================================
// Initialization
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    icao24 = params.get('icao24');

    if (!icao24) {
        document.querySelector('.telem-flight-meta').innerHTML =
            '<div class="telem-meta-line" style="color: var(--text-muted);">No flight selected. Use ?icao24=&lt;hex&gt;</div>';
        initMap();
        drawEmptyCharts();
        startClocks();
        updateConnectionStatus('disconnected', 'No flight');
        return;
    }

    initMap();
    drawEmptyCharts();
    startClocks();

    fetchFlightData();
    fetchHistoryData();

    pollTimer = setInterval(() => {
        fetchFlightData();
        fetchHistoryData();
    }, CONFIG.POLL_INTERVAL_MS);

    document.getElementById('copyFlightInfo').addEventListener('click', copyFlightInfo);
});

// ============================================
// Map
// ============================================
function initMap() {
    map = L.map('telemMap', {
        center: [39, -98],
        zoom: CONFIG.DEFAULT_ZOOM,
        zoomControl: true,
    });

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OSM &copy; CARTO',
        subdomains: 'abcd',
        maxZoom: 19,
    }).addTo(map);

    setTimeout(() => map.invalidateSize(), 150);
    window.addEventListener('resize', () => {
        map.invalidateSize();
        drawEmptyCharts();
    });
}

function updateMapPath(positions) {
    if (!positions || positions.length === 0) return;

    // Clear old layers
    if (flightPathGroup) map.removeLayer(flightPathGroup);
    if (originMarker) map.removeLayer(originMarker);
    if (destMarker) map.removeLayer(destMarker);
    if (currentPosMarker) map.removeLayer(currentPosMarker);

    const latlngs = positions
        .filter(p => p.latitude && p.longitude)
        .map(p => [p.latitude, p.longitude]);

    if (latlngs.length === 0) return;

    flightPathGroup = L.layerGroup().addTo(map);

    // Draw gradient polyline: purple -> blue -> cyan
    const segCount = latlngs.length - 1;
    for (let i = 0; i < segCount; i++) {
        const ratio = i / Math.max(segCount - 1, 1);
        L.polyline([latlngs[i], latlngs[i + 1]], {
            color: interpolateColor(ratio),
            weight: 3,
            opacity: 0.85,
        }).addTo(flightPathGroup);
    }

    // Origin marker: blue outlined circle
    originMarker = L.circleMarker(latlngs[0], {
        radius: 7,
        fillColor: '#60a5fa',
        color: '#3b82f6',
        weight: 2,
        fillOpacity: 0.9,
    }).addTo(map);

    // Current position: yellow star icon
    const lastPos = latlngs[latlngs.length - 1];
    const heading = flightData?.telemetry?.heading || 0;
    currentPosMarker = L.marker(lastPos, {
        icon: createStarIcon(),
    }).addTo(map);

    // Fit bounds
    const bounds = L.latLngBounds(latlngs);
    map.fitBounds(bounds, { padding: [50, 50] });
}

function createStarIcon() {
    // Yellow 4-pointed star matching the screenshot
    const svg = `<svg width="20" height="20" viewBox="0 0 20 20">
        <polygon points="10,0 12,8 20,10 12,12 10,20 8,12 0,10 8,8"
                 fill="#eab308" stroke="#a16207" stroke-width="0.5"/>
    </svg>`;
    return L.divIcon({
        className: '',
        html: svg,
        iconSize: [20, 20],
        iconAnchor: [10, 10],
    });
}

function interpolateColor(ratio) {
    // Purple (#9333ea) -> Blue (#3b82f6) -> Cyan (#06b6d4)
    if (ratio < 0.5) {
        const t = ratio * 2;
        const r = Math.round(147 * (1 - t) + 59 * t);
        const g = Math.round(51 * (1 - t) + 130 * t);
        const b = Math.round(234 * (1 - t) + 246 * t);
        return `rgb(${r},${g},${b})`;
    } else {
        const t = (ratio - 0.5) * 2;
        const r = Math.round(59 * (1 - t) + 6 * t);
        const g = Math.round(130 * (1 - t) + 182 * t);
        const b = Math.round(246 * (1 - t) + 212 * t);
        return `rgb(${r},${g},${b})`;
    }
}

// ============================================
// Data Fetching
// ============================================
async function fetchFlightData() {
    try {
        const response = await fetch(`${CONFIG.API_BASE}/flights/${icao24}?include_analytics=true`);
        if (!response.ok) {
            updateConnectionStatus('disconnected', 'Flight not found');
            return;
        }
        flightData = await response.json();
        if (!firstFetchTime) firstFetchTime = Date.now();
        updateConnectionStatus('connected', 'Connected');
        updateFlightInfo(flightData);
        updateTicker(flightData);
        updateStatusBar(flightData);
    } catch (error) {
        console.error('Flight data fetch error:', error);
        updateConnectionStatus('disconnected', 'Connection error');
    }
}

async function fetchHistoryData() {
    try {
        const response = await fetch(`${CONFIG.API_BASE}/flights/history/${icao24}?minutes=${CONFIG.HISTORY_MINUTES}`);
        if (!response.ok) return;
        const data = await response.json();
        historyData = data.positions || data.history || [];
        updateMapPath(historyData);
        updateCharts(historyData);
    } catch (error) {
        console.error('History fetch error:', error);
    }
}

// ============================================
// Flight Info Panel
// ============================================
function updateFlightInfo(flight) {
    const callsign = flight.callsign || '';
    const airlineCode = callsign.substring(0, 3);
    const logoSvg = getAirlineLogo(airlineCode);
    document.getElementById('telemAirlineLogo').innerHTML = logoSvg;

    // Route
    const origin = flight.route?.origin || '---';
    const dest = flight.route?.destination || '---';
    document.getElementById('telemOrigin').textContent = origin;
    document.getElementById('telemDestination').textContent = dest;
    document.getElementById('telemOriginName').textContent = flight.route?.origin_name || 'Origin Airport';
    document.getElementById('telemDestinationName').textContent = flight.route?.destination_name || 'Destination Airport';

    // Flight meta lines
    document.getElementById('telemCallsign').textContent = callsign || '---';
    document.getElementById('telemAircraft').textContent =
        flight.aircraft_type_desc || flight.aircraft_type || 'Unknown';

    const phase = flight.status?.flight_phase || 'unknown';
    const phaseDisplay = {
        'climb': 'Climbing', 'cruise': 'In Flight', 'descent': 'Descending',
        'ground': 'On Ground', 'unknown': 'In Flight',
    };
    document.getElementById('telemPhase').textContent = phaseDisplay[phase] || 'In Flight';

    // Chart header values (value + unit inline)
    const telemetry = flight.telemetry || {};
    const altFt = telemetry.altitude_ft || 0;
    const speedKts = telemetry.speed_kts || 0;
    const heading = telemetry.heading || 0;

    document.getElementById('telemAltValue').innerHTML = altFt
        ? `${altFt.toLocaleString()}<span class="telem-chart-unit">ft</span>` : '---';
    document.getElementById('telemSpeedValue').innerHTML = speedKts
        ? `${speedKts}<span class="telem-chart-unit">kts</span>` : '---';
    document.getElementById('telemHeadingValue').innerHTML = heading
        ? `${heading}<span class="telem-chart-unit">&deg;</span>` : '---';

    // Status row
    const phaseStatusDisplay = {
        'climb': 'Climbing', 'cruise': 'Cruise (En route)', 'descent': 'Descending',
        'ground': 'On Ground', 'unknown': 'In Flight',
    };
    document.getElementById('telemCurrentStatus').textContent = phaseStatusDisplay[phase] || 'In Flight';

    // Departure / Arrival labels with airport codes
    if (origin !== '---') {
        document.getElementById('telemDepLabel').textContent = `Departure Time (${origin}):`;
    }
    if (dest !== '---') {
        document.getElementById('telemArrLabel').textContent = `Estimated Arrival Time (${dest}):`;
    }

    // Times - use first_seen or reasonable estimate
    const depTime = flight.route?.departure_time || flight.first_seen;
    if (depTime) {
        const d = new Date(depTime * 1000 || depTime);
        document.getElementById('telemDepTime').textContent = isNaN(d.getTime()) ? '---'
            : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) + ' ' + getTimezoneAbbr();
    }
    const arrTime = flight.route?.arrival_time || flight.route?.eta;
    if (arrTime) {
        const d = new Date(arrTime * 1000 || arrTime);
        document.getElementById('telemArrTime').textContent = isNaN(d.getTime()) ? '---'
            : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) + ' ' + getTimezoneAbbr();
    }

    const flightStatus = flight.route?.status || 'active';
    const statusEl = document.getElementById('telemFlightStatus');
    if (flightStatus === 'active' || flightStatus === 'on_time') {
        statusEl.textContent = 'On Time';
        statusEl.className = 'telem-status-value telem-status-big telem-status-green';
    } else {
        statusEl.textContent = flightStatus.charAt(0).toUpperCase() + flightStatus.slice(1);
        statusEl.className = 'telem-status-value telem-status-big';
    }

    // Page title
    const airlineName = getAirlineName(airlineCode) || '';
    const titleRoute = (origin !== '---' && dest !== '---') ? `${origin} to ${dest}` : callsign;
    document.title = airlineName
        ? `${airlineName} Flight Telemetry \u2013 ${titleRoute}`
        : `Flight Telemetry \u2013 ${titleRoute}`;
}

function getTimezoneAbbr() {
    try {
        return new Date().toLocaleTimeString('en-US', { timeZoneName: 'short' }).split(' ').pop();
    } catch { return ''; }
}

// ============================================
// Telemetry Charts
// ============================================
function updateCharts(positions) {
    if (!positions || positions.length < 2) return;

    const altitudes = positions.map(p => p.altitude_ft || (p.baro_altitude ? p.baro_altitude * 3.28084 : 0));
    const speeds = positions.map(p => p.speed_kts || (p.velocity ? p.velocity * 1.94384 : 0));
    const headings = positions.map(p => p.heading || p.true_track || 0);

    drawAreaChart('telemAltChart', altitudes, '#06b6d4', 'rgba(6, 182, 212, 0.25)', 'ft');
    drawAreaChart('telemSpeedChart', speeds, '#06b6d4', 'rgba(6, 182, 212, 0.25)', 'kts');
    drawAreaChart('telemHeadingChart', headings, '#06b6d4', 'rgba(6, 182, 212, 0.25)', '\u00B0');
}

function drawAreaChart(canvasId, data, lineColor, fillColor, unitSuffix) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || data.length < 2) return;

    const rect = canvas.parentElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const width = rect.width;
    const height = rect.height;

    // Clear with dark bg
    ctx.fillStyle = '#111118';
    ctx.fillRect(0, 0, width, height);

    // Margins for Y-axis labels
    const ml = 55, mr = 8, mt = 8, mb = 8;
    const pw = width - ml - mr;
    const ph = height - mt - mb;

    // Data range - use 0 as floor for altitude/speed
    let min = Math.min(...data);
    let max = Math.max(...data);
    if (unitSuffix === 'ft' || unitSuffix === 'kts') min = 0;
    const range = max - min || 1;

    // Nice tick values
    const tickCount = 4;
    const ticks = [];
    for (let i = 0; i <= tickCount; i++) {
        ticks.push(max - (range * i / tickCount));
    }

    // Draw horizontal grid lines + Y-axis labels
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';

    for (let i = 0; i <= tickCount; i++) {
        const y = mt + (ph * i / tickCount);
        // Grid line
        ctx.beginPath();
        ctx.moveTo(ml, y);
        ctx.lineTo(ml + pw, y);
        ctx.stroke();
        // Label
        const val = ticks[i];
        let label;
        if (unitSuffix === 'ft') {
            label = val >= 1000 ? Math.round(val).toLocaleString() + 'ft' : Math.round(val) + 'ft';
        } else if (unitSuffix === 'kts') {
            label = Math.round(val) + 'kts';
        } else {
            label = Math.round(val) + unitSuffix;
        }
        ctx.fillText(label, ml - 5, y + 4);
    }

    // Build path points
    const points = data.map((val, i) => ({
        x: ml + (i / (data.length - 1)) * pw,
        y: mt + ph - ((val - min) / range) * ph,
    }));

    // Fill area
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.lineTo(points[points.length - 1].x, mt + ph);
    ctx.lineTo(points[0].x, mt + ph);
    ctx.closePath();
    ctx.fillStyle = fillColor;
    ctx.fill();

    // Stroke line
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Latest point dot
    const last = points[points.length - 1];
    ctx.beginPath();
    ctx.arc(last.x, last.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#60a5fa';
    ctx.fill();
}

function drawEmptyCharts() {
    ['telemAltChart', 'telemSpeedChart', 'telemHeadingChart'].forEach(canvasId => {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;
        const rect = canvas.parentElement.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        canvas.style.width = rect.width + 'px';
        canvas.style.height = rect.height + 'px';
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        ctx.fillStyle = '#111118';
        ctx.fillRect(0, 0, rect.width, rect.height);
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.font = '11px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Awaiting data\u2026', rect.width / 2, rect.height / 2 + 4);
    });
}

// ============================================
// Clocks & Status Bar
// ============================================
function startClocks() {
    updateClocks();
    clockTimer = setInterval(updateClocks, 1000);
}

function updateClocks() {
    const now = new Date();
    const utcStr = now.toISOString().replace('T', ' ').substring(0, 19);
    document.getElementById('telemUtcTime').textContent = `UTC: ${utcStr}`;
    document.getElementById('telemLocalTime').textContent =
        `Local: ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`;

    // Flight time (elapsed since first data fetch)
    if (firstFetchTime) {
        const elapsed = Math.floor((Date.now() - firstFetchTime) / 1000);
        const hrs = Math.floor(elapsed / 3600);
        const mins = Math.floor((elapsed % 3600) / 60);
        document.getElementById('telemFlightTime').textContent =
            `Flight Time: ${hrs}h ${mins.toString().padStart(2, '0')}m`;
    }
}

function updateStatusBar(flight) {
    const callsign = flight.callsign || '';
    const airlineCode = callsign.substring(0, 3);
    const airlineName = getAirlineName(airlineCode) || callsign;
    const origin = flight.route?.origin || '';
    const dest = flight.route?.destination || '';
    const routeStr = (origin && dest) ? `${origin} to ${dest}` : '';

    // Connection info area
    const connInfo = airlineName + (routeStr ? ` \uD83D\uDCE1 ${routeStr}` : '');
    document.getElementById('telemConnStatus').textContent = connInfo;

    // Right-side flight title
    const titleStr = airlineName + (routeStr ? ` Flight Telemetry \u2014 ${routeStr}` : ' Flight Telemetry');
    document.getElementById('telemBarTitle').textContent = titleStr;

    // ETA
    const arrTime = flight.route?.arrival_time || flight.route?.eta;
    if (arrTime) {
        const d = new Date(arrTime * 1000 || arrTime);
        if (!isNaN(d.getTime())) {
            document.getElementById('telemEta').textContent =
                `EtA: ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: false })} ${getTimezoneAbbr()}`;
        }
    }
}

function updateConnectionStatus(state, message) {
    document.getElementById('telemConnDot').className = 'status-dot ' + state;
    if (!flightData) {
        document.getElementById('telemConnStatus').textContent = message;
    }
}

// ============================================
// Ticker Bar
// ============================================
function updateTicker(flight) {
    const callsign = flight.callsign || '---';
    const origin = flight.route?.origin || '---';
    const dest = flight.route?.destination || '---';
    const alt = flight.telemetry?.altitude_ft;
    const speed = flight.telemetry?.speed_kts;

    const parts = [
        `${origin}: Weather data loading`,
        `${dest}: Weather data loading`,
        `${callsign} EST Arr: ---`,
        'System Status: Normal',
        'ADS-B Signal: Strong',
        alt ? `Altitude: ${alt.toLocaleString()}ft` : null,
        speed ? `Ground Speed: ${speed}kts` : null,
        'Weather Update: Checking...',
    ].filter(Boolean);

    const text = parts.join(' | ');
    document.getElementById('tickerText1').textContent = text;
    document.getElementById('tickerText2').textContent = text;
}

// ============================================
// Copy Flight Info
// ============================================
function copyFlightInfo() {
    if (!flightData) return;
    const info = [
        `Flight: ${flightData.callsign || '---'}`,
        `ICAO24: ${icao24}`,
        `Aircraft: ${flightData.aircraft_type_desc || flightData.aircraft_type || 'Unknown'}`,
        `Route: ${flightData.route?.origin || '---'} -> ${flightData.route?.destination || '---'}`,
        `Altitude: ${flightData.telemetry?.altitude_ft?.toLocaleString() || '---'} ft`,
        `Speed: ${flightData.telemetry?.speed_kts || '---'} kts`,
        `Heading: ${flightData.telemetry?.heading || '---'}\u00B0`,
    ].join('\n');

    navigator.clipboard.writeText(info).then(() => {
        const btn = document.getElementById('copyFlightInfo');
        btn.style.color = 'var(--accent-green)';
        setTimeout(() => { btn.style.color = ''; }, 1500);
    });
}
