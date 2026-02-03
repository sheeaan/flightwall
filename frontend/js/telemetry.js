/**
 * FlightWall - Telemetry Dashboard JavaScript
 *
 * Full-screen flight telemetry deep-dive view.
 * Handles:
 * - Leaflet map with flight path polyline
 * - Canvas telemetry charts (altitude, speed, heading)
 * - Live polling for flight updates
 * - Scrolling ticker bar
 * - Status bar with clocks
 */

// ============================================
// Configuration
// ============================================
const CONFIG = {
    API_BASE: '/api',
    POLL_INTERVAL_MS: 5000,
    HISTORY_MINUTES: 60,
    DEFAULT_ZOOM: 6,
};

// ============================================
// State
// ============================================
let map = null;
let flightPathLine = null;
let originMarker = null;
let currentPosMarker = null;
let icao24 = null;
let flightData = null;
let historyData = [];
let pollTimer = null;
let clockTimer = null;

// ============================================
// Initialization
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    // Parse icao24 from URL
    const params = new URLSearchParams(window.location.search);
    icao24 = params.get('icao24');

    if (!icao24) {
        document.querySelector('.telem-info-panel .telem-airline-name').textContent = 'No flight selected';
        return;
    }

    document.getElementById('telemIcao24').textContent = icao24;

    // Init map
    initMap();

    // Start clocks
    startClocks();

    // Start ticker animation
    initTicker();

    // Fetch initial data
    fetchFlightData();
    fetchHistoryData();

    // Start polling
    pollTimer = setInterval(() => {
        fetchFlightData();
        fetchHistoryData();
    }, CONFIG.POLL_INTERVAL_MS);

    // Copy button
    document.getElementById('copyFlightInfo').addEventListener('click', copyFlightInfo);
});

// ============================================
// Map
// ============================================
function initMap() {
    map = L.map('telemMap', {
        center: [40, -95],
        zoom: CONFIG.DEFAULT_ZOOM,
        zoomControl: true,
    });

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 19,
    }).addTo(map);
}

function updateMapPath(positions) {
    if (!positions || positions.length === 0) return;

    // Remove old path and markers
    if (flightPathLine) map.removeLayer(flightPathLine);
    if (originMarker) map.removeLayer(originMarker);
    if (currentPosMarker) map.removeLayer(currentPosMarker);

    const latlngs = positions
        .filter(p => p.latitude && p.longitude)
        .map(p => [p.latitude, p.longitude]);

    if (latlngs.length === 0) return;

    // Draw gradient polyline using segments
    const segmentCount = latlngs.length - 1;
    for (let i = 0; i < segmentCount; i++) {
        const ratio = i / Math.max(segmentCount - 1, 1);
        const color = interpolateColor(ratio);
        L.polyline([latlngs[i], latlngs[i + 1]], {
            color: color,
            weight: 3,
            opacity: 0.8,
        }).addTo(map);
    }

    // Store reference for cleanup (we'll just clear all polylines on next update)
    flightPathLine = L.layerGroup().addTo(map);

    // Origin marker (blue circle)
    originMarker = L.circleMarker(latlngs[0], {
        radius: 6,
        fillColor: '#3b82f6',
        color: '#1e40af',
        weight: 2,
        fillOpacity: 1,
    }).addTo(map);
    originMarker.bindTooltip('Origin', { permanent: false });

    // Current position marker (yellow/gold)
    const lastPos = latlngs[latlngs.length - 1];
    const heading = flightData?.telemetry?.heading || 0;
    currentPosMarker = L.marker(lastPos, {
        icon: createPlaneIcon(heading),
    }).addTo(map);

    // Fit map to bounds
    const bounds = L.latLngBounds(latlngs);
    map.fitBounds(bounds, { padding: [40, 40] });
}

function createPlaneIcon(heading) {
    const svg = `
        <svg width="28" height="28" viewBox="0 0 24 24" style="transform: rotate(${heading}deg);">
            <path d="M12 2L8 10H4L6 14H8L10 22H14L16 14H18L20 10H16L12 2Z"
                  fill="#eab308" stroke="#92400e" stroke-width="0.5"/>
        </svg>
    `;
    return L.divIcon({
        className: 'aircraft-marker',
        html: svg,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
    });
}

function interpolateColor(ratio) {
    // Purple -> Blue -> Cyan gradient
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
        updateConnectionStatus('connected', 'Connected');
        updateFlightInfo(flightData);
        updateTicker(flightData);
        document.getElementById('telemLastUpdate').textContent = `Last update: ${new Date().toLocaleTimeString()}`;
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
    // Airline logo
    const callsign = flight.callsign || '';
    const airlineCode = callsign.substring(0, 3);
    const logoSvg = getAirlineLogo(airlineCode);
    document.getElementById('telemAirlineLogo').innerHTML = logoSvg;

    // Airline name
    const airlineName = getAirlineName(airlineCode) || callsign.substring(0, 2);
    document.getElementById('telemAirlineName').textContent = airlineName;

    // Route
    if (flight.route && flight.route.origin && flight.route.destination) {
        document.getElementById('telemOrigin').textContent = flight.route.origin;
        document.getElementById('telemDestination').textContent = flight.route.destination;
        document.getElementById('telemOriginName').textContent = flight.route.origin_name || 'Origin';
        document.getElementById('telemDestinationName').textContent = flight.route.destination_name || 'Destination';
    }

    // Flight meta
    document.getElementById('telemCallsign').textContent = callsign || '---';
    document.getElementById('telemAircraft').textContent = flight.aircraft_type_desc || flight.aircraft_type || 'Unknown';

    // Phase
    const phase = flight.status?.flight_phase || 'unknown';
    const phaseDisplay = {
        'climb': 'Climbing',
        'cruise': 'Cruise',
        'descent': 'Descending',
        'ground': 'On Ground',
        'unknown': 'In Flight',
    };
    const phaseEl = document.getElementById('telemPhase');
    phaseEl.textContent = phaseDisplay[phase] || phase;
    phaseEl.className = 'telem-meta-value status-badge ' + phase;

    // Telemetry values
    const telemetry = flight.telemetry || {};
    const position = flight.position || {};

    const altFt = telemetry.altitude_ft || 0;
    const speedKts = telemetry.speed_kts || 0;
    const heading = telemetry.heading || 0;
    const vRate = telemetry.vertical_rate_fpm || 0;
    const distKm = position.distance_km || flight.distance_km || 0;

    document.getElementById('telemAltValue').textContent = altFt ? altFt.toLocaleString() : '---';
    document.getElementById('telemSpeedValue').textContent = speedKts || '---';
    document.getElementById('telemHeadingValue').textContent = heading || '---';

    // Status row
    document.getElementById('telemCurrentStatus').textContent = phaseDisplay[phase] || 'In Flight';
    document.getElementById('telemVRate').textContent = `${vRate > 0 ? '+' : ''}${vRate} fpm`;
    document.getElementById('telemDistance').textContent = distKm ? `${distKm.toFixed(1)} km` : '---';

    const flightStatus = flight.route?.status || 'Active';
    const statusEl = document.getElementById('telemFlightStatus');
    statusEl.textContent = flightStatus.charAt(0).toUpperCase() + flightStatus.slice(1);
    statusEl.className = 'telem-status-value ' + (flightStatus === 'active' ? 'status-on-time' : '');

    // Update page title
    document.title = `FlightWall - ${callsign || icao24}`;
}

// ============================================
// Telemetry Charts
// ============================================
function updateCharts(positions) {
    if (!positions || positions.length < 2) return;

    const altitudes = positions.map(p => p.altitude_ft || p.baro_altitude * 3.28084 || 0);
    const speeds = positions.map(p => p.speed_kts || p.velocity * 1.94384 || 0);
    const headings = positions.map(p => p.heading || p.true_track || 0);

    drawAreaChart('telemAltChart', altitudes, '#06b6d4', 'rgba(6, 182, 212, 0.15)');
    drawAreaChart('telemSpeedChart', speeds, '#22c55e', 'rgba(34, 197, 94, 0.15)');
    drawAreaChart('telemHeadingChart', headings, '#8b5cf6', 'rgba(139, 92, 246, 0.15)');
}

function drawAreaChart(canvasId, data, lineColor, fillColor) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || data.length < 2) return;

    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * (window.devicePixelRatio || 1);
    canvas.height = rect.height * (window.devicePixelRatio || 1);
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';

    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const dpr = window.devicePixelRatio || 1;

    ctx.scale(dpr, dpr);
    const width = rect.width;
    const height = rect.height;

    // Clear
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#1a1a24';
    ctx.fillRect(0, 0, width, height);

    // Margins
    const ml = 40, mr = 10, mt = 5, mb = 20;
    const pw = width - ml - mr;
    const ph = height - mt - mb;

    // Data range
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;

    // Draw grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
        const y = mt + (ph * i / 4);
        ctx.beginPath();
        ctx.moveTo(ml, y);
        ctx.lineTo(ml + pw, y);
        ctx.stroke();
    }

    // Draw Y-axis labels
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = '10px Inter, sans-serif';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
        const val = max - (range * i / 4);
        const y = mt + (ph * i / 4) + 3;
        ctx.fillText(formatChartValue(val), ml - 4, y);
    }

    // Build path
    const points = data.map((val, i) => ({
        x: ml + (i / (data.length - 1)) * pw,
        y: mt + ph - ((val - min) / range) * ph,
    }));

    // Draw filled area
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.lineTo(points[points.length - 1].x, mt + ph);
    ctx.lineTo(points[0].x, mt + ph);
    ctx.closePath();
    ctx.fillStyle = fillColor;
    ctx.fill();

    // Draw line
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Draw dot at latest point
    const last = points[points.length - 1];
    ctx.beginPath();
    ctx.arc(last.x, last.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = lineColor;
    ctx.fill();
}

function formatChartValue(val) {
    if (Math.abs(val) >= 1000) {
        return (val / 1000).toFixed(1) + 'k';
    }
    return Math.round(val).toString();
}

// ============================================
// Clocks
// ============================================
function startClocks() {
    updateClocks();
    clockTimer = setInterval(updateClocks, 1000);
}

function updateClocks() {
    const now = new Date();
    document.getElementById('telemUtcTime').textContent =
        `UTC: ${now.toISOString().substring(11, 19)}`;
    document.getElementById('telemLocalTime').textContent =
        `Local: ${now.toLocaleTimeString()}`;
}

// ============================================
// Connection Status
// ============================================
function updateConnectionStatus(state, message) {
    const dot = document.getElementById('telemConnDot');
    const text = document.getElementById('telemConnStatus');
    dot.className = 'status-dot ' + state;
    text.textContent = message;
}

// ============================================
// Ticker Bar
// ============================================
function initTicker() {
    // CSS animation handles the scrolling
}

function updateTicker(flight) {
    const callsign = flight.callsign || '---';
    const route = (flight.route?.origin && flight.route?.destination)
        ? `${flight.route.origin} > ${flight.route.destination}` : '---';
    const aircraft = flight.aircraft_type_desc || flight.aircraft_type || '---';
    const alt = flight.telemetry?.altitude_ft
        ? `${flight.telemetry.altitude_ft.toLocaleString()}ft` : '---';

    const flightText = `Flight: ${callsign} | Alt: ${alt}`;
    const routeText = `Route: ${route}`;
    const aircraftText = `Aircraft: ${aircraft}`;

    // Update both copies for seamless scrolling
    document.getElementById('tickerFlight').textContent = flightText;
    document.getElementById('tickerFlight2').textContent = flightText;
    document.getElementById('tickerRoute').textContent = routeText;
    document.getElementById('tickerRoute2').textContent = routeText;
    document.getElementById('tickerAircraft').textContent = aircraftText;
    document.getElementById('tickerAircraft2').textContent = aircraftText;
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
        `Heading: ${flightData.telemetry?.heading || '---'}°`,
    ].join('\n');

    navigator.clipboard.writeText(info).then(() => {
        const btn = document.getElementById('copyFlightInfo');
        btn.style.color = 'var(--accent-green)';
        setTimeout(() => { btn.style.color = ''; }, 1500);
    });
}
