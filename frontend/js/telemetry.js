/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║                    FLIGHTWALL TELEMETRY DASHBOARD                         ║
 * ║                                                                           ║
 * ║  The cockpit view for aviation nerds. Real-time flight data visualization ║
 * ║  with fancy charts, gradient flight paths, and more numbers than a        ║
 * ║  Boeing 747 instrument panel.                                             ║
 * ║                                                                           ║
 * ║  Author: Shawn (the one watching planes instead of being productive)      ║
 * ║  Version: 2.0.0                                                           ║
 * ║  License: MIT                                                             ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Features:
 * - Leaflet map with gradient flight path polyline (purple → blue → cyan)
 * - Canvas-based telemetry charts for altitude, speed, and vertical rate
 * - Live polling for real-time flight updates
 * - Scrolling ticker bar (because every good dashboard needs one)
 * - Status bar with clocks, flight time, and ETA
 *
 * Fun fact: The gradient colors were chosen because they look like the sky
 * at different times of day. Or a synthwave album cover. Either works.
 */

// =============================================================================
//  CONFIGURATION
//  (The knobs and dials we can tweak without breaking everything)
// =============================================================================

const CONFIG = {
    /** Base URL for API calls - keeping it simple, keeping it local */
    API_BASE: '/api',

    /** How often to bug the server for updates (in milliseconds) */
    POLL_INTERVAL_MS: 5000,

    /** How much history to fetch - 60 minutes of flight shenanigans */
    HISTORY_MINUTES: 60,

    /** Default map zoom level - zoomed out enough to see the journey */
    DEFAULT_ZOOM: 5,
};

// =============================================================================
//  APPLICATION STATE
//  (All the variables that make this thing tick)
// =============================================================================

/** @type {L.Map|null} The Leaflet map instance - our window to the sky */
let map = null;

/** @type {L.LayerGroup|null} Contains all flight path segments */
let flightPathGroup = null;

/** @type {L.CircleMarker|null} Blue dot marking where this journey began */
let originMarker = null;

/** @type {L.Marker|null} Destination marker (when we know where they're going) */
let destMarker = null;

/** @type {L.Marker|null} Yellow star showing current aircraft position */
let currentPosMarker = null;

/** @type {string|null} The ICAO 24-bit hex address of our tracked aircraft */
let icao24 = null;

/** @type {Object|null} Current flight data from the API */
let flightData = null;

/** @type {Array} Historical position/telemetry data for charts and path */
let historyData = [];

/** @type {number|null} Timer ID for polling interval */
let pollTimer = null;

/** @type {number|null} Timer ID for clock updates */
let clockTimer = null;

/** @type {number|null} Timestamp of first successful data fetch */
let firstFetchTime = null;

// =============================================================================
//  INITIALIZATION
//  (The part where we wake everything up and get to work)
// =============================================================================

/**
 * Main initialization - runs when the DOM is ready.
 * Parses URL params, sets up the map, and starts the data party.
 */
document.addEventListener('DOMContentLoaded', () => {
    // Grab the icao24 from URL params - this is who we're stalking today
    const params = new URLSearchParams(window.location.search);
    icao24 = params.get('icao24');

    // No flight specified? Show a friendly message and bail
    if (!icao24) {
        document.querySelector('.telem-flight-meta').innerHTML =
            '<div class="telem-meta-line" style="color: var(--text-muted);">No flight selected. Use ?icao24=&lt;hex&gt;</div>';
        initMap();
        drawEmptyCharts();
        startClocks();
        updateConnectionStatus('disconnected', 'No flight');
        return;
    }

    // Initialize all the things!
    initMap();
    drawEmptyCharts();
    startClocks();

    // Fetch initial data
    fetchFlightData();
    fetchHistoryData();

    // Set up polling - because stale data is sad data
    pollTimer = setInterval(() => {
        fetchFlightData();
        fetchHistoryData();
    }, CONFIG.POLL_INTERVAL_MS);

    // Wire up the copy button for sharing flight info
    document.getElementById('copyFlightInfo').addEventListener('click', copyFlightInfo);
});

// =============================================================================
//  MAP INITIALIZATION & RENDERING
//  (Making the world look pretty, one tile at a time)
// =============================================================================

/**
 * Initializes the Leaflet map with dark theme tiles.
 * Because light mode is for people who don't track flights at 2 AM.
 */
function initMap() {
    map = L.map('telemMap', {
        center: [39, -98], // Center of the US - our default vantage point
        zoom: CONFIG.DEFAULT_ZOOM,
        zoomControl: true,
    });

    // CARTO dark tiles - sleek, mysterious, perfect for aviation
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OSM &copy; CARTO',
        subdomains: 'abcd',
        maxZoom: 19,
    }).addTo(map);

    // Give the map a moment to find itself, then resize
    setTimeout(() => map.invalidateSize(), 150);

    // Handle window resizes - responsive design is not optional
    window.addEventListener('resize', () => {
        map.invalidateSize();
        drawEmptyCharts();
    });
}

/**
 * Draws the flight path on the map with a gradient polyline.
 * Purple → Blue → Cyan, like a synthwave sunset.
 *
 * @param {Array} positions - Array of position objects with lat/lng
 */
function updateMapPath(positions) {
    if (!positions || positions.length === 0) return;

    // Out with the old, in with the new
    if (flightPathGroup) map.removeLayer(flightPathGroup);
    if (originMarker) map.removeLayer(originMarker);
    if (destMarker) map.removeLayer(destMarker);
    if (currentPosMarker) map.removeLayer(currentPosMarker);

    // Filter out positions with missing coordinates
    const latlngs = positions
        .filter(p => p.latitude && p.longitude)
        .map(p => [p.latitude, p.longitude]);

    if (latlngs.length === 0) return;

    flightPathGroup = L.layerGroup().addTo(map);

    // Draw gradient polyline segment by segment
    // Each segment gets a slightly different color = smooth gradient effect
    const segCount = latlngs.length - 1;
    for (let i = 0; i < segCount; i++) {
        const ratio = i / Math.max(segCount - 1, 1);
        L.polyline([latlngs[i], latlngs[i + 1]], {
            color: interpolateColor(ratio),
            weight: 3,
            opacity: 0.85,
        }).addTo(flightPathGroup);
    }

    // Origin marker: blue outlined circle - "You are here... well, you were"
    originMarker = L.circleMarker(latlngs[0], {
        radius: 7,
        fillColor: '#60a5fa',
        color: '#3b82f6',
        weight: 2,
        fillOpacity: 0.9,
    }).addTo(map);

    // Current position: yellow star icon - the main attraction
    const lastPos = latlngs[latlngs.length - 1];
    currentPosMarker = L.marker(lastPos, {
        icon: createStarIcon(),
    }).addTo(map);

    // Zoom to fit the entire flight path with some padding
    const bounds = L.latLngBounds(latlngs);
    map.fitBounds(bounds, { padding: [50, 50] });
}

/**
 * Creates a yellow 4-pointed star SVG icon for the current position marker.
 * Because a simple dot just doesn't capture the magic of flight.
 *
 * @returns {L.DivIcon} A Leaflet DivIcon with star SVG
 */
function createStarIcon() {
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

/**
 * Interpolates between purple, blue, and cyan based on ratio.
 * This is the secret sauce that makes our flight paths look so good.
 *
 * Color progression:
 *   0.0 → Purple (#9333ea) - "We just took off"
 *   0.5 → Blue (#3b82f6)   - "Cruising altitude achieved"
 *   1.0 → Cyan (#06b6d4)   - "Almost there!"
 *
 * @param {number} ratio - Value between 0 and 1
 * @returns {string} RGB color string
 */
function interpolateColor(ratio) {
    if (ratio < 0.5) {
        // Purple → Blue transition
        const t = ratio * 2;
        const r = Math.round(147 * (1 - t) + 59 * t);
        const g = Math.round(51 * (1 - t) + 130 * t);
        const b = Math.round(234 * (1 - t) + 246 * t);
        return `rgb(${r},${g},${b})`;
    } else {
        // Blue → Cyan transition
        const t = (ratio - 0.5) * 2;
        const r = Math.round(59 * (1 - t) + 6 * t);
        const g = Math.round(130 * (1 - t) + 182 * t);
        const b = Math.round(246 * (1 - t) + 212 * t);
        return `rgb(${r},${g},${b})`;
    }
}

// =============================================================================
//  DATA FETCHING
//  (The part where we talk to the backend and hope it talks back)
// =============================================================================

/**
 * Fetches current flight data from the API.
 * This is the heartbeat of our telemetry dashboard.
 */
async function fetchFlightData() {
    try {
        const response = await fetch(`${CONFIG.API_BASE}/flights/${icao24}?include_analytics=true`);

        if (!response.ok) {
            updateConnectionStatus('disconnected', 'Flight not found');
            return;
        }

        flightData = await response.json();

        // Record first fetch time for flight duration calculations
        if (!firstFetchTime) firstFetchTime = Date.now();

        // Update all the UI elements
        updateConnectionStatus('connected', 'Connected');
        updateFlightInfo(flightData);
        updateTicker(flightData);
        updateStatusBar(flightData);

    } catch (error) {
        console.error('Flight data fetch error:', error);
        updateConnectionStatus('disconnected', 'Connection error');
    }
}

/**
 * Fetches historical position/telemetry data for charts and flight path.
 * The API returns arrays that we transform into position objects.
 *
 * API Response Format:
 *   { history: { timestamps, altitudes, speeds, vertical_rates, positions } }
 *
 * We transform this into an array of position objects for easier consumption.
 */
async function fetchHistoryData() {
    try {
        const response = await fetch(`${CONFIG.API_BASE}/flights/history/${icao24}?minutes=${CONFIG.HISTORY_MINUTES}`);
        if (!response.ok) return;

        const data = await response.json();

        // Destructure the API response with sensible defaults
        const history = data.history || {};
        const timestamps = history.timestamps || [];
        const altitudes = history.altitudes || [];
        const speeds = history.speeds || [];
        const verticalRates = history.vertical_rates || [];
        const positions = history.positions || [];

        // Transform arrays into position objects
        // This makes the data much easier to work with downstream
        historyData = timestamps.map((ts, i) => ({
            timestamp: ts,
            altitude_ft: altitudes[i] ?? null,
            speed_kts: speeds[i] ?? null,
            vertical_rate_fpm: verticalRates[i] ?? null,
            latitude: positions[i] ? positions[i][0] : null,
            longitude: positions[i] ? positions[i][1] : null,
        })).filter(p =>
            // Keep records that have at least some valid telemetry data
            // No point in keeping completely empty records
            p.altitude_ft !== null || p.speed_kts !== null ||
            (p.latitude !== null && p.longitude !== null)
        );

        // Update the map and charts with fresh data
        updateMapPath(historyData);
        updateCharts(historyData);

    } catch (error) {
        console.error('History fetch error:', error);
    }
}

// =============================================================================
//  FLIGHT INFO PANEL
//  (The command center for flight information)
// =============================================================================

/**
 * Updates the flight info panel with current flight data.
 * This is where we display all the juicy details about our tracked aircraft.
 *
 * @param {Object} flight - Flight data object from the API
 */
function updateFlightInfo(flight) {
    const callsign = flight.callsign || '';

    // Get airline code for logo lookup - try route info first, then callsign prefix
    const airlineCode = flight.airline_icao || callsign.substring(0, 3);
    const logoSvg = getAirlineLogo(airlineCode);
    document.getElementById('telemAirlineLogo').innerHTML = logoSvg;

    // Route information - where we came from and where we're going
    const origin = flight.route?.origin || '---';
    const dest = flight.route?.destination || '---';
    document.getElementById('telemOrigin').textContent = origin;
    document.getElementById('telemDestination').textContent = dest;
    document.getElementById('telemOriginName').textContent = flight.route?.origin_name || 'Origin Airport';
    document.getElementById('telemDestinationName').textContent = flight.route?.destination_name || 'Destination Airport';

    // Flight meta information
    document.getElementById('telemCallsign').textContent = callsign || '---';
    document.getElementById('telemAircraft').textContent =
        flight.aircraft_type_desc || flight.aircraft_type || 'Unknown';

    // Flight phase with human-readable labels
    const phase = flight.status?.flight_phase || 'unknown';
    const phaseDisplay = {
        'climb': 'Climbing',      // Going up! 🚀
        'cruise': 'In Flight',    // Smooth sailing
        'descent': 'Descending',  // Coming down
        'ground': 'On Ground',    // Taxiing or parked
        'unknown': 'In Flight',   // When in doubt, they're flying
    };
    document.getElementById('telemPhase').textContent = phaseDisplay[phase] || 'In Flight';

    // Telemetry values for chart headers
    const telemetry = flight.telemetry || {};
    const altFt = telemetry.altitude_ft || 0;
    const speedKts = telemetry.speed_kts || 0;
    const verticalRate = telemetry.vertical_rate_fpm || 0;

    // Format values with units - looking fancy
    document.getElementById('telemAltValue').innerHTML = altFt
        ? `${altFt.toLocaleString()}<span class="telem-chart-unit">ft</span>` : '---';
    document.getElementById('telemSpeedValue').innerHTML = speedKts
        ? `${speedKts}<span class="telem-chart-unit">kts</span>` : '---';
    document.getElementById('telemHeadingValue').innerHTML = verticalRate
        ? `${verticalRate > 0 ? '+' : ''}${verticalRate.toLocaleString()}<span class="telem-chart-unit">fpm</span>` : '---';

    // Status row with verbose phase descriptions
    const phaseStatusDisplay = {
        'climb': 'Climbing',
        'cruise': 'Cruise (En route)',
        'descent': 'Descending',
        'ground': 'On Ground',
        'unknown': 'In Flight',
    };
    document.getElementById('telemCurrentStatus').textContent = phaseStatusDisplay[phase] || 'In Flight';

    // Display airline alliance if available (Star Alliance, oneworld, SkyTeam)
    const allianceInfo = getAirlineAllianceInfo(airlineCode);
    const allianceLine = document.getElementById('telemAllianceLine');
    if (allianceInfo && allianceInfo.name) {
        document.getElementById('telemAllianceName').textContent = allianceInfo.name;
        if (allianceInfo.logo) {
            document.getElementById('telemAllianceLogo').innerHTML = allianceInfo.logo;
        }
        allianceLine.style.display = 'flex';
    } else {
        allianceLine.style.display = 'none';
    }

    // Departure / Arrival labels with airport codes for context
    if (origin !== '---') {
        document.getElementById('telemDepLabel').textContent = `Departure Time (${origin}):`;
    }
    if (dest !== '---') {
        document.getElementById('telemArrLabel').textContent = `Estimated Arrival Time (${dest}):`;
    }

    // Departure time - use first_seen as fallback
    const depTime = flight.route?.departure_time || flight.first_seen;
    if (depTime) {
        const d = new Date(depTime * 1000 || depTime);
        document.getElementById('telemDepTime').textContent = isNaN(d.getTime()) ? '---'
            : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) + ' ' + getTimezoneAbbr();
    }

    // Arrival time / ETA
    const arrTime = flight.route?.arrival_time || flight.route?.eta;
    if (arrTime) {
        const d = new Date(arrTime * 1000 || arrTime);
        document.getElementById('telemArrTime').textContent = isNaN(d.getTime()) ? '---'
            : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) + ' ' + getTimezoneAbbr();
    }

    // Flight status badge - green for on-time, default otherwise
    const flightStatus = flight.route?.status || 'active';
    const statusEl = document.getElementById('telemFlightStatus');
    if (flightStatus === 'active' || flightStatus === 'on_time') {
        statusEl.textContent = 'On Time';
        statusEl.className = 'telem-status-value telem-status-big telem-status-green';
    } else {
        statusEl.textContent = flightStatus.charAt(0).toUpperCase() + flightStatus.slice(1);
        statusEl.className = 'telem-status-value telem-status-big';
    }

    // Update page title with flight info - for that browser tab flex
    const airlineName = getAirlineName(airlineCode) || '';
    const titleRoute = (origin !== '---' && dest !== '---') ? `${origin} to ${dest}` : callsign;
    document.title = airlineName
        ? `FlightWall - ${airlineName} ${titleRoute}`
        : `FlightWall - Telemetry – ${titleRoute}`;
}

/**
 * Gets the user's timezone abbreviation (e.g., "EST", "PST").
 * Because time zones are confusing and we want to be helpful.
 *
 * @returns {string} Timezone abbreviation
 */
function getTimezoneAbbr() {
    try {
        return new Date().toLocaleTimeString('en-US', { timeZoneName: 'short' }).split(' ').pop();
    } catch {
        return '';
    }
}

// =============================================================================
//  TELEMETRY CHARTS
//  (Where the magic happens - pixels become flight data)
// =============================================================================

/**
 * Updates all telemetry charts with historical data.
 * Handles null values gracefully and only draws when we have enough data.
 *
 * @param {Array} positions - Array of position objects with telemetry data
 */
function updateCharts(positions) {
    if (!positions || positions.length < 2) return;

    // Extract altitude data with unit conversion for metric values
    const altitudes = positions.map(p => {
        if (p.altitude_ft != null) return p.altitude_ft;
        if (p.baro_altitude != null) return p.baro_altitude * 3.28084; // meters to feet
        return null;
    }).filter(v => v !== null);

    // Extract speed data with unit conversion
    const speeds = positions.map(p => {
        if (p.speed_kts != null) return p.speed_kts;
        if (p.velocity != null) return p.velocity * 1.94384; // m/s to knots
        return null;
    }).filter(v => v !== null);

    // Extract vertical rate data
    const verticalRates = positions.map(p => p.vertical_rate_fpm ?? null)
        .filter(v => v !== null);

    // Only draw charts if we have enough valid data points
    // Two points minimum for a meaningful chart
    if (altitudes.length >= 2) {
        drawAreaChart('telemAltChart', altitudes, '#06b6d4', 'rgba(6, 182, 212, 0.25)', 'ft');
    }
    if (speeds.length >= 2) {
        drawAreaChart('telemSpeedChart', speeds, '#06b6d4', 'rgba(6, 182, 212, 0.25)', 'kts');
    }
    if (verticalRates.length >= 2) {
        drawAreaChart('telemHeadingChart', verticalRates, '#06b6d4', 'rgba(6, 182, 212, 0.25)', 'fpm');
    }
}

/**
 * Draws an area chart on a canvas element.
 * Features gradient fill, Y-axis labels, grid lines, and a current value dot.
 *
 * The chart is high-DPI aware and handles edge cases like NaN values gracefully.
 *
 * @param {string} canvasId - ID of the canvas element
 * @param {Array<number>} data - Array of numeric values to plot
 * @param {string} lineColor - CSS color for the line stroke
 * @param {string} fillColor - CSS color for the area fill (with alpha)
 * @param {string} unitSuffix - Unit suffix for Y-axis labels (ft, kts, fpm)
 */
function drawAreaChart(canvasId, data, lineColor, fillColor, unitSuffix) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || !data || data.length < 2) return;

    // Validate data - ensure no NaN or Infinity values sneak through
    // Math.min/max get angry with those
    const validData = data.filter(v => typeof v === 'number' && isFinite(v));
    if (validData.length < 2) return;
    data = validData;

    // Get dimensions from parent container
    const rect = canvas.parentElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    // Handle high-DPI displays (Retina, etc.)
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const width = rect.width;
    const height = rect.height;

    // Clear with dark background - our canvas, our rules
    ctx.fillStyle = '#111118';
    ctx.fillRect(0, 0, width, height);

    // Margins for Y-axis labels (left margin is larger to fit numbers)
    const ml = 55, mr = 8, mt = 8, mb = 8;
    const pw = width - ml - mr;  // Plot width
    const ph = height - mt - mb; // Plot height

    // Calculate data range with smart defaults
    let min = Math.min(...data);
    let max = Math.max(...data);

    // Use 0 as floor for altitude/speed (they don't go negative... usually)
    if (unitSuffix === 'ft' || unitSuffix === 'kts') min = 0;

    // For vertical rate, center around 0 (climbs positive, descents negative)
    if (unitSuffix === 'fpm') {
        const absMax = Math.max(Math.abs(min), Math.abs(max), 500);
        min = -absMax;
        max = absMax;
    }

    const range = max - min || 1; // Avoid division by zero

    // Generate nice tick values for Y-axis
    const tickCount = 4;
    const ticks = [];
    for (let i = 0; i <= tickCount; i++) {
        ticks.push(max - (range * i / tickCount));
    }

    // Draw horizontal grid lines and Y-axis labels
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';

    for (let i = 0; i <= tickCount; i++) {
        const y = mt + (ph * i / tickCount);

        // Grid line - subtle but helpful
        ctx.beginPath();
        ctx.moveTo(ml, y);
        ctx.lineTo(ml + pw, y);
        ctx.stroke();

        // Y-axis label with unit
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

    // Build path points from data
    const points = data.map((val, i) => ({
        x: ml + (i / (data.length - 1)) * pw,
        y: mt + ph - ((val - min) / range) * ph,
    }));

    // Draw filled area under the line
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

    // Draw the line on top of the fill
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Draw a dot at the latest value - the "you are here" of the chart
    const last = points[points.length - 1];
    ctx.beginPath();
    ctx.arc(last.x, last.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#60a5fa';
    ctx.fill();
}

/**
 * Draws empty placeholder charts with "Awaiting data..." message.
 * Called before we have any data to show.
 */
function drawEmptyCharts() {
    ['telemAltChart', 'telemSpeedChart', 'telemHeadingChart'].forEach(canvasId => {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;

        const rect = canvas.parentElement.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;

        // Handle high-DPI displays
        const dpr = window.devicePixelRatio || 1;
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        canvas.style.width = rect.width + 'px';
        canvas.style.height = rect.height + 'px';

        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);

        // Dark background
        ctx.fillStyle = '#111118';
        ctx.fillRect(0, 0, rect.width, rect.height);

        // Centered placeholder text
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.font = '11px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Awaiting data…', rect.width / 2, rect.height / 2 + 4);
    });
}

// =============================================================================
//  CLOCKS & STATUS BAR
//  (Time is an illusion, but we track it anyway)
// =============================================================================

/**
 * Starts the clock update interval.
 * Updates every second because time waits for no one.
 */
function startClocks() {
    updateClocks();
    clockTimer = setInterval(updateClocks, 1000);
}

/**
 * Updates the UTC and local time displays.
 * Also calculates flight time elapsed since first data fetch.
 */
function updateClocks() {
    const now = new Date();

    // UTC time in ISO format (without the 'T' because we're classy)
    const utcStr = now.toISOString().replace('T', ' ').substring(0, 19);
    document.getElementById('telemUtcTime').textContent = `UTC: ${utcStr}`;

    // Local time in 12-hour format
    document.getElementById('telemLocalTime').textContent =
        `Local: ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`;

    // Flight time (elapsed since we started tracking)
    if (firstFetchTime) {
        const elapsed = Math.floor((Date.now() - firstFetchTime) / 1000);
        const hrs = Math.floor(elapsed / 3600);
        const mins = Math.floor((elapsed % 3600) / 60);
        document.getElementById('telemFlightTime').textContent =
            `Flight Time: ${hrs}h ${mins.toString().padStart(2, '0')}m`;
    }
}

/**
 * Updates the status bar with current flight information.
 * Shows airline name, route, connection status, and ETA.
 *
 * @param {Object} flight - Flight data object
 */
function updateStatusBar(flight) {
    const callsign = flight.callsign || '';
    const airlineCode = flight.airline_icao || callsign.substring(0, 3);
    const airlineName = flight.airline_name || getAirlineName(airlineCode) || callsign;
    const origin = flight.route?.origin || '';
    const dest = flight.route?.destination || '';
    const routeStr = (origin && dest) ? `${origin} to ${dest}` : '';

    // Connection info area with satellite emoji because why not
    const connInfo = airlineName + (routeStr ? ` 📡 ${routeStr}` : '');
    document.getElementById('telemConnStatus').textContent = connInfo;

    // Right-side flight title
    const titleStr = airlineName + (routeStr ? ` Flight Telemetry — ${routeStr}` : ' Flight Telemetry');
    document.getElementById('telemBarTitle').textContent = titleStr;

    // ETA display
    const arrTime = flight.route?.arrival_time || flight.route?.eta;
    if (arrTime) {
        const d = new Date(arrTime * 1000 || arrTime);
        if (!isNaN(d.getTime())) {
            document.getElementById('telemEta').textContent =
                `EtA: ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: false })} ${getTimezoneAbbr()}`;
        }
    }
}

/**
 * Updates the connection status indicator.
 *
 * @param {string} state - Status class (connected, disconnected)
 * @param {string} message - Status message to display
 */
function updateConnectionStatus(state, message) {
    document.getElementById('telemConnDot').className = 'status-dot ' + state;
    if (!flightData) {
        document.getElementById('telemConnStatus').textContent = message;
    }
}

// =============================================================================
//  TICKER BAR
//  (The scrolling news feed of the aviation world)
// =============================================================================

/**
 * Updates the scrolling ticker bar with flight information.
 * Displays weather placeholders, system status, and current telemetry.
 *
 * @param {Object} flight - Flight data object
 */
function updateTicker(flight) {
    const callsign = flight.callsign || '---';
    const origin = flight.route?.origin || '---';
    const dest = flight.route?.destination || '---';
    const alt = flight.telemetry?.altitude_ft;
    const speed = flight.telemetry?.speed_kts;

    // Build ticker content - a mix of useful info and placeholders
    const parts = [
        `${origin}: Weather data loading`,
        `${dest}: Weather data loading`,
        `${callsign} EST Arr: ---`,
        'System Status: Normal',       // Always be optimistic
        'ADS-B Signal: Strong',         // Confidence is key
        alt ? `Altitude: ${alt.toLocaleString()}ft` : null,
        speed ? `Ground Speed: ${speed}kts` : null,
        'Weather Update: Checking...',
    ].filter(Boolean);

    const text = parts.join(' | ');

    // Update both ticker text elements (for seamless scrolling animation)
    document.getElementById('tickerText1').textContent = text;
    document.getElementById('tickerText2').textContent = text;
}

// =============================================================================
//  UTILITY FUNCTIONS
//  (The helpful bits that make everything else work)
// =============================================================================

/**
 * Copies current flight information to the clipboard.
 * Perfect for sharing with fellow aviation enthusiasts or just showing off.
 */
function copyFlightInfo() {
    if (!flightData) return;

    // Format vertical rate with +/- prefix
    const vr = flightData.telemetry?.vertical_rate_fpm;
    const vrStr = vr ? `${vr > 0 ? '+' : ''}${vr} fpm` : '---';

    // Build a nice formatted string
    const info = [
        `Flight: ${flightData.callsign || '---'}`,
        `ICAO24: ${icao24}`,
        `Aircraft: ${flightData.aircraft_type_desc || flightData.aircraft_type || 'Unknown'}`,
        `Route: ${flightData.route?.origin || '---'} -> ${flightData.route?.destination || '---'}`,
        `Altitude: ${flightData.telemetry?.altitude_ft?.toLocaleString() || '---'} ft`,
        `Speed: ${flightData.telemetry?.speed_kts || '---'} kts`,
        `Vertical Rate: ${vrStr}`,
    ].join('\n');

    // Copy to clipboard and show success feedback
    navigator.clipboard.writeText(info).then(() => {
        const btn = document.getElementById('copyFlightInfo');
        btn.style.color = 'var(--accent-green)';
        setTimeout(() => { btn.style.color = ''; }, 1500);
    });
}
