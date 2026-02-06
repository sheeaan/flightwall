/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║                      FLIGHTWALL MAP VIEW                                  ║
 * ║                                                                           ║
 * ║  The main attraction - a beautiful dark-themed map showing aircraft       ║
 * ║  movements in real-time. Like Google Maps, but for people who look up.    ║
 * ║                                                                           ║
 * ║  Author: Shawn (aviation enthusiast & late-night coder)                   ║
 * ║  Version: 2.0.0                                                           ║
 * ║  License: MIT                                                             ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Features:
 * - Leaflet-powered interactive map with dark theme
 * - Real-time aircraft markers with rotation based on heading
 * - Clickable flights with detailed info panel
 * - Flight list sidebar for quick navigation
 * - Range circle showing detection radius
 * - Mini telemetry graphs in the info panel
 *
 * The map uses CartoDB Dark Matter tiles because dark mode is the only mode.
 */

// =============================================================================
//  CONFIGURATION
//  (The control panel for our map behavior)
// =============================================================================

const CONFIG = {
    /** API base URL - where we get our flight data */
    API_BASE: '/api',

    /** Polling interval in milliseconds - 5 seconds is a good balance */
    POLL_INTERVAL_MS: 5000,

    /** Default zoom level - close enough to see aircraft, far enough to see context */
    DEFAULT_ZOOM: 8,

    /** Fallback center coordinates - NYC, because why not */
    DEFAULT_CENTER: [40.7128, -74.0060],

    /** LocalStorage key for range setting (synced with ticker view) */
    STORAGE_KEY: 'flightwall_range_km',

    /** Default detection range in kilometers */
    DEFAULT_RANGE_KM: 10,
};

// =============================================================================
//  APPLICATION STATE
//  (All the things we need to keep track of)
// =============================================================================

/** @type {L.Map|null} The Leaflet map instance */
let map = null;

/** @type {Map<string, L.Marker>} Aircraft markers indexed by icao24 */
let aircraftMarkers = new Map();

/** @type {string|null} Currently selected flight's icao24 */
let selectedFlight = null;

/** @type {Array<number>|null} Observer location [lat, lng] */
let observerLocation = null;

/** @type {number|null} Polling interval ID */
let pollInterval = null;

/** @type {L.Circle|null} Detection range circle */
let rangeCircle = null;

/** @type {number} Current range in kilometers */
let currentRangeKm = CONFIG.DEFAULT_RANGE_KM;

// =============================================================================
//  INITIALIZATION
//  (Getting everything set up and ready to go)
// =============================================================================

/**
 * Main initialization - runs when DOM is ready.
 * Sets up the map, determines location, and starts polling.
 */
document.addEventListener('DOMContentLoaded', async () => {
    // Load range setting from localStorage (shared with ticker view)
    loadRangeFromStorage();

    // Initialize the Leaflet map
    initMap();

    // Try to determine observer location (auto-detect or use saved)
    await initLocation();

    // Start the data polling loop
    startPolling();

    // Listen for range changes from other tabs (cross-tab sync!)
    window.addEventListener('storage', handleStorageChange);
});

/**
 * Initializes the Leaflet map with dark theme tiles.
 * CartoDB Dark Matter - the official tile set of night owls.
 */
function initMap() {
    map = L.map('map', {
        center: CONFIG.DEFAULT_CENTER,
        zoom: CONFIG.DEFAULT_ZOOM,
        zoomControl: true,
    });

    // Dark map tiles - because we're tracking flights at 2 AM
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 19,
    }).addTo(map);
}

/**
 * Initializes the observer location.
 * Tries to use saved location first, then falls back to auto-detection.
 */
async function initLocation() {
    try {
        // Check if we already have a location set
        const response = await fetch(`${CONFIG.API_BASE}/metrics/location`);
        const data = await response.json();

        if (data.location && data.location.latitude) {
            observerLocation = [data.location.latitude, data.location.longitude];
            map.setView(observerLocation, CONFIG.DEFAULT_ZOOM);
            addObserverMarker();
            updateStatus('connected', 'Connected');
            return;
        }

        // No saved location - try auto-detection via IP geolocation
        const autoResponse = await fetch(`${CONFIG.API_BASE}/metrics/location/auto`, {
            method: 'POST',
        });
        const autoData = await autoResponse.json();

        if (autoData.success) {
            observerLocation = [autoData.location.latitude, autoData.location.longitude];
            map.setView(observerLocation, CONFIG.DEFAULT_ZOOM);
            addObserverMarker();
            updateStatus('connected', `Connected - ${autoData.details.city || 'Unknown'}`);
        } else {
            updateStatus('disconnected', 'Location not set');
        }
    } catch (error) {
        console.error('Location init error:', error);
        updateStatus('disconnected', 'Connection error');
    }
}

/**
 * Adds the observer location marker to the map.
 * A glowing cyan dot marks where you're watching from.
 */
function addObserverMarker() {
    if (!observerLocation) return;

    // Create a glowing cyan dot icon
    const icon = L.divIcon({
        className: 'observer-marker',
        html: `<div style="
            width: 12px;
            height: 12px;
            background: var(--accent-cyan);
            border-radius: 50%;
            border: 2px solid white;
            box-shadow: 0 0 10px var(--accent-cyan);
        "></div>`,
        iconSize: [12, 12],
        iconAnchor: [6, 6],
    });

    L.marker(observerLocation, { icon }).addTo(map)
        .bindPopup('Your Location');

    // Add the range circle showing detection area
    updateRangeCircle();
}

// =============================================================================
//  DATA POLLING
//  (The heartbeat of our real-time tracking)
// =============================================================================

/**
 * Starts the polling loop for flight data.
 */
function startPolling() {
    // Fetch immediately on startup
    fetchFlights();

    // Then poll at regular intervals
    pollInterval = setInterval(fetchFlights, CONFIG.POLL_INTERVAL_MS);
}

/**
 * Fetches current flight data from the API.
 * Updates markers, flight list, and selected flight panel.
 */
async function fetchFlights() {
    try {
        const response = await fetch(`${CONFIG.API_BASE}/flights?airborne_only=true&limit=100`);
        const data = await response.json();

        // Update status bar with connection info
        updateStatus('connected', 'Connected');
        document.getElementById('lastUpdate').textContent = `Last update: ${new Date().toLocaleTimeString()}`;
        document.getElementById('queryTime').textContent = `Query: ${data.query_time_ms} ms`;

        // Update the map and UI with fresh data
        updateAircraftMarkers(data.flights);
        updateFlightList(data.flights);
        document.getElementById('flightCount').textContent = data.count;

        // If we have a flight selected, update its panel
        if (selectedFlight) {
            const updated = data.flights.find(f => f.icao24 === selectedFlight);
            if (updated) {
                updateFlightPanel(updated);
            }
        }
    } catch (error) {
        console.error('Fetch error:', error);
        updateStatus('disconnected', 'Connection error');
    }
}

// =============================================================================
//  AIRCRAFT MARKERS
//  (Little planes on a map - the whole point of this app)
// =============================================================================

/**
 * Updates aircraft markers on the map.
 * Adds new markers, updates existing ones, removes stale ones.
 *
 * @param {Array} flights - Array of flight objects from the API
 */
function updateAircraftMarkers(flights) {
    const currentIcaos = new Set(flights.map(f => f.icao24));

    // Remove markers for aircraft that are no longer in range
    for (const [icao24, marker] of aircraftMarkers) {
        if (!currentIcaos.has(icao24)) {
            map.removeLayer(marker);
            aircraftMarkers.delete(icao24);
        }
    }

    // Update or create markers for current flights
    for (const flight of flights) {
        // Skip flights without position data
        if (!flight.position.latitude || !flight.position.longitude) continue;

        const position = [flight.position.latitude, flight.position.longitude];
        const heading = flight.telemetry.heading || 0;

        if (aircraftMarkers.has(flight.icao24)) {
            // Update existing marker position and rotation
            const marker = aircraftMarkers.get(flight.icao24);
            marker.setLatLng(position);
            marker.setIcon(createAircraftIcon(heading, flight.icao24 === selectedFlight));
        } else {
            // Create a new marker for this aircraft
            const marker = L.marker(position, {
                icon: createAircraftIcon(heading, false),
                title: flight.callsign,
            });

            marker.on('click', () => selectFlight(flight.icao24));
            marker.addTo(map);
            aircraftMarkers.set(flight.icao24, marker);
        }
    }
}

/**
 * Creates an SVG aircraft icon.
 * The icon rotates based on heading and changes color when selected.
 *
 * @param {number} heading - Aircraft heading in degrees
 * @param {boolean} isSelected - Whether this aircraft is currently selected
 * @returns {L.DivIcon} A Leaflet DivIcon with the aircraft SVG
 */
function createAircraftIcon(heading, isSelected) {
    const color = isSelected ? '#3b82f6' : '#f0f0f5'; // Blue when selected, white otherwise
    const size = isSelected ? 24 : 20; // Bigger when selected

    // SVG aircraft silhouette - a simple but effective design
    const svg = `
        <svg width="${size}" height="${size}" viewBox="0 0 24 24" style="transform: rotate(${heading}deg);">
            <path d="M12 2L8 10H4L6 14H8L10 22H14L16 14H18L20 10H16L12 2Z"
                  fill="${color}" stroke="#000" stroke-width="0.5"/>
        </svg>
    `;

    return L.divIcon({
        className: 'aircraft-marker',
        html: svg,
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
    });
}

// =============================================================================
//  FLIGHT LIST SIDEBAR
//  (For when you want to click on a specific flight)
// =============================================================================

/** @type {Map<string, HTMLElement>} Flight list elements indexed by icao24 */
const flightListElements = new Map();

/**
 * Updates the flight list sidebar with current flights.
 *
 * @param {Array} flights - Array of flight objects
 */
function updateFlightList(flights) {
    const container = document.getElementById('flightListItems');
    const currentIcaos = new Set(flights.map(f => f.icao24));

    // Remove list items for flights no longer present
    for (const [icao24, element] of flightListElements) {
        if (!currentIcaos.has(icao24)) {
            element.remove();
            flightListElements.delete(icao24);
        }
    }

    // Update or create list items
    for (const flight of flights) {
        // Format altitude display (flight level or feet)
        const altDisplay = flight.telemetry.flight_level ||
            (flight.telemetry.altitude_ft ? `${Math.round(flight.telemetry.altitude_ft / 100) * 100}ft` : '---');
        const typeDisplay = flight.aircraft_type_desc || flight.aircraft_type || '';

        // Route display for sidebar (compact format)
        const routeDisplay = flight.route && flight.route.origin && flight.route.destination
            ? `${flight.route.origin}-${flight.route.destination}`
            : '';

        if (flightListElements.has(flight.icao24)) {
            // Update existing list item
            const item = flightListElements.get(flight.icao24);
            item.className = 'flight-list-item' + (flight.icao24 === selectedFlight ? ' selected' : '');
            item.querySelector('.flight-callsign').textContent = flight.callsign;
            item.querySelector('.flight-type').textContent = typeDisplay;
            item.querySelector('.flight-altitude').textContent = altDisplay;

            // Update or add route display
            let routeEl = item.querySelector('.flight-route');
            if (routeDisplay) {
                if (!routeEl) {
                    routeEl = document.createElement('span');
                    routeEl.className = 'flight-route';
                    item.insertBefore(routeEl, item.querySelector('.flight-altitude'));
                }
                routeEl.textContent = routeDisplay;
            } else if (routeEl) {
                routeEl.remove();
            }
        } else {
            // Create new list item
            const item = document.createElement('div');
            item.className = 'flight-list-item' + (flight.icao24 === selectedFlight ? ' selected' : '');
            item.onclick = () => selectFlight(flight.icao24);

            item.innerHTML = `
                <span class="flight-callsign">${flight.callsign}</span>
                <span class="flight-type">${typeDisplay}</span>
                ${routeDisplay ? `<span class="flight-route">${routeDisplay}</span>` : ''}
                <span class="flight-altitude">${altDisplay}</span>
            `;

            container.appendChild(item);
            flightListElements.set(flight.icao24, item);
        }
    }
}

// =============================================================================
//  FLIGHT DETAIL PANEL
//  (The deep dive into a single flight)
// =============================================================================

/**
 * Selects a flight and shows its detail panel.
 *
 * @param {string} icao24 - The ICAO 24-bit hex identifier of the flight
 */
function selectFlight(icao24) {
    selectedFlight = icao24;

    // Update marker styles (selected flight gets highlighted)
    for (const [id, marker] of aircraftMarkers) {
        marker.setIcon(createAircraftIcon(0, id === icao24));
    }

    // Show the detail panel
    document.getElementById('flightPanel').style.display = 'block';

    // Update the telemetry dashboard link
    document.getElementById('panelTelemLink').href = `/telemetry?icao24=${icao24}`;

    // Fetch detailed data for this flight
    fetchFlightDetails(icao24);

    // Update list selection styling
    for (const [id, element] of flightListElements) {
        element.className = 'flight-list-item' + (id === icao24 ? ' selected' : '');
    }
}

/**
 * Fetches detailed flight data including analytics.
 *
 * @param {string} icao24 - The flight's ICAO 24-bit identifier
 */
async function fetchFlightDetails(icao24) {
    try {
        const response = await fetch(`${CONFIG.API_BASE}/flights/${icao24}?include_analytics=true`);
        const data = await response.json();
        updateFlightPanel(data);
    } catch (error) {
        console.error('Flight details error:', error);
    }
}

// =============================================================================
//  TELEMETRY HISTORY
//  (Mini graphs in the flight panel - because data is beautiful)
// =============================================================================

/**
 * Telemetry history for the mini graphs in the flight panel.
 * We keep the last 30 data points for a nice historical view.
 */
const telemetryHistory = {
    altitude: [],
    speed: [],
    heading: [],
    maxPoints: 30,
};

/**
 * Updates the flight detail panel with current data.
 *
 * @param {Object} flight - Flight data object from the API
 */
function updateFlightPanel(flight) {
    // Airline logo - use airline_icao if available, otherwise extract from callsign
    const airlineCode = flight.airline_icao || flight.callsign?.substring(0, 3) || '';
    const logoEl = document.getElementById('panelAirlineLogo');
    if (typeof getAirlineLogo === 'function') {
        logoEl.innerHTML = getAirlineLogo(airlineCode);
        logoEl.style.background = 'var(--bg-tertiary)';
    }

    // Route display (origin → destination)
    if (flight.route && flight.route.origin && flight.route.destination) {
        document.getElementById('panelOrigin').textContent = flight.route.origin;
        document.getElementById('panelDestination').textContent = flight.route.destination;
        document.getElementById('panelOriginName').textContent = flight.route.origin_name || 'Origin';
        document.getElementById('panelDestinationName').textContent = flight.route.destination_name || 'Destination';
    } else {
        document.getElementById('panelOrigin').textContent = '---';
        document.getElementById('panelDestination').textContent = '---';
        document.getElementById('panelOriginName').textContent = 'Unknown';
        document.getElementById('panelDestinationName').textContent = 'Unknown';
    }

    // Flight meta info
    document.getElementById('panelCallsign').textContent = flight.callsign || '---';
    document.getElementById('panelAircraft').textContent = flight.aircraft_type_desc || flight.aircraft_type || 'Unknown';

    // Flight phase badge with color coding
    const phaseBadge = document.getElementById('panelPhase');
    const phase = flight.status?.flight_phase || 'unknown';
    const phaseDisplay = {
        'climb': 'Climbing',
        'cruise': 'Cruise (En route)',
        'descent': 'Descending',
        'ground': 'On Ground',
        'unknown': 'In Flight',
    };
    phaseBadge.textContent = phaseDisplay[phase] || phase;
    phaseBadge.className = 'meta-value status-badge ' + phase;

    // Alliance display (Star Alliance, oneworld, SkyTeam)
    const allianceRow = document.getElementById('panelAllianceRow');
    if (typeof getAirlineAllianceInfo === 'function') {
        const allianceInfo = getAirlineAllianceInfo(airlineCode);
        if (allianceInfo && allianceInfo.name) {
            document.getElementById('panelAllianceName').textContent = allianceInfo.name;
            if (allianceInfo.logo) {
                document.getElementById('panelAllianceLogo').innerHTML = allianceInfo.logo;
            }
            allianceRow.style.display = 'flex';
        } else {
            allianceRow.style.display = 'none';
        }
    }

    // Telemetry values
    const telemetry = flight.telemetry || {};
    const position = flight.position || {};

    const altFt = telemetry.altitude_ft || 0;
    const speedKts = telemetry.speed_kts || 0;
    const heading = telemetry.heading || 0;
    const vRate = telemetry.vertical_rate_fpm || 0;
    const distKm = position.distance_km || flight.distance_km || 0;

    // Update telemetry displays with formatted values
    document.getElementById('panelAltitude').textContent =
        altFt ? `${altFt.toLocaleString()}ft` : '---';

    document.getElementById('panelSpeed').textContent =
        speedKts ? `${speedKts}kts` : '---';

    document.getElementById('panelHeading').textContent =
        heading ? `${heading}°` : '---';

    document.getElementById('panelVRate').textContent =
        `${vRate > 0 ? '+' : ''}${vRate} fpm`;

    document.getElementById('panelDistance').textContent =
        distKm ? `${distKm.toFixed(1)} km` : '---';

    // Current status display
    document.getElementById('panelCurrentStatus').textContent = phaseDisplay[phase] || 'In Flight';

    // Flight status (active, on time, delayed, etc.)
    const flightStatus = flight.route?.status || 'Active';
    const statusEl = document.getElementById('panelFlightStatus');
    statusEl.textContent = flightStatus.charAt(0).toUpperCase() + flightStatus.slice(1);
    statusEl.className = 'status-value ' + (flightStatus === 'active' ? 'status-on-time' : '');

    // Anomaly banner - show if flight behavior is unusual
    const anomalyBanner = document.getElementById('panelAnomaly');
    anomalyBanner.style.display = flight.analytics?.is_anomaly ? 'block' : 'none';

    // Update telemetry history for graphs
    telemetryHistory.altitude.push(altFt);
    telemetryHistory.speed.push(speedKts);
    telemetryHistory.heading.push(heading);

    // Keep history limited to maxPoints
    if (telemetryHistory.altitude.length > telemetryHistory.maxPoints) {
        telemetryHistory.altitude.shift();
        telemetryHistory.speed.shift();
        telemetryHistory.heading.shift();
    }

    // Draw the mini telemetry graphs
    drawTelemetryGraph('altitudeGraph', telemetryHistory.altitude, '#06b6d4');
    drawTelemetryGraph('speedGraph', telemetryHistory.speed, '#06b6d4');
    drawTelemetryGraph('headingGraph', telemetryHistory.heading, '#06b6d4');
}

/**
 * Draws a mini telemetry graph on a canvas element.
 *
 * @param {string} canvasId - ID of the canvas element
 * @param {Array<number>} data - Array of data points to plot
 * @param {string} color - Line/fill color
 */
function drawTelemetryGraph(canvasId, data, color) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    // Clear with dark background
    ctx.fillStyle = '#1a1a24';
    ctx.fillRect(0, 0, width, height);

    if (data.length < 2) return;

    // Calculate scale from data range
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;

    // Draw the line
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();

    data.forEach((value, i) => {
        const x = (i / (data.length - 1)) * width;
        const y = height - ((value - min) / range) * (height - 10) - 5;

        if (i === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
    });

    ctx.stroke();

    // Draw semi-transparent fill under the line
    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    ctx.fillStyle = color + '20'; // 20 = 12.5% opacity in hex
    ctx.fill();
}

/**
 * Returns a CSS class for the given trend direction.
 * Used for styling trend indicators.
 *
 * @param {string} trend - 'increasing', 'decreasing', or 'stable'
 * @returns {string} CSS class name
 */
function getTrendClass(trend) {
    switch (trend) {
        case 'increasing': return 'climbing';
        case 'decreasing': return 'descending';
        case 'stable': return 'cruise';
        default: return '';
    }
}

/**
 * Closes the flight detail panel.
 * Resets telemetry history and marker styles.
 */
function closeFlightPanel() {
    selectedFlight = null;
    document.getElementById('flightPanel').style.display = 'none';

    // Clear telemetry history
    telemetryHistory.altitude = [];
    telemetryHistory.speed = [];
    telemetryHistory.heading = [];

    // Reset all marker styles
    for (const [id, marker] of aircraftMarkers) {
        marker.setIcon(createAircraftIcon(0, false));
    }
}

// =============================================================================
//  STATUS BAR UPDATES
//  (Keeping you informed about connection state)
// =============================================================================

/**
 * Updates the connection status display.
 *
 * @param {string} state - 'connected' or 'disconnected'
 * @param {string} message - Status message to display
 */
function updateStatus(state, message) {
    const dot = document.getElementById('connectionDot');
    const text = document.getElementById('connectionStatus');

    dot.className = 'status-dot ' + state;
    text.textContent = message;
}

// =============================================================================
//  RANGE CIRCLE
//  (Visual indicator of your detection range)
// =============================================================================

/**
 * Loads the detection range from localStorage.
 * Synced with ticker view for consistency.
 */
function loadRangeFromStorage() {
    const saved = localStorage.getItem(CONFIG.STORAGE_KEY);
    if (saved) {
        const range = parseInt(saved, 10);
        if (range >= 1 && range <= 50) {
            currentRangeKm = range;
        }
    }
}

/**
 * Handles cross-tab storage changes.
 * Updates range circle when ticker view changes the range.
 *
 * @param {StorageEvent} event - The storage change event
 */
function handleStorageChange(event) {
    if (event.key === CONFIG.STORAGE_KEY) {
        const newRange = parseInt(event.newValue, 10);
        if (newRange >= 1 && newRange <= 50) {
            currentRangeKm = newRange;
            updateRangeCircle();
        }
    }
}

/**
 * Updates or creates the range circle on the map.
 * Shows a dashed cyan circle indicating detection radius.
 */
function updateRangeCircle() {
    if (!observerLocation || !map) return;

    // Remove existing circle
    if (rangeCircle) {
        map.removeLayer(rangeCircle);
    }

    // Create new circle (radius is in meters, so multiply km by 1000)
    rangeCircle = L.circle(observerLocation, {
        radius: currentRangeKm * 1000,
        color: '#06b6d4',        // Cyan stroke
        fillColor: '#06b6d4',
        fillOpacity: 0.08,       // Very subtle fill
        weight: 2,
        dashArray: '8, 4',       // Dashed line for style
        interactive: false,      // Don't block clicks
    }).addTo(map);

    // Add tooltip showing the range
    rangeCircle.bindTooltip(`${currentRangeKm} km radius`, {
        permanent: false,
        direction: 'top',
        className: 'range-tooltip',
    });
}
