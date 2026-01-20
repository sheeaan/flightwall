/**
 * FlightWall - Map View JavaScript
 *
 * Handles:
 * - Leaflet map initialization
 * - Aircraft marker management
 * - Real-time data polling
 * - Flight panel interactions
 */

// ============================================
// Configuration
// ============================================
const CONFIG = {
    API_BASE: '/api',
    POLL_INTERVAL_MS: 5000,
    DEFAULT_ZOOM: 8,
    DEFAULT_CENTER: [40.7128, -74.0060], // NYC as fallback
    STORAGE_KEY: 'flightwall_range_km',
    DEFAULT_RANGE_KM: 10,
};

// ============================================
// State
// ============================================
let map = null;
let aircraftMarkers = new Map(); // icao24 -> marker
let selectedFlight = null;
let observerLocation = null;
let pollInterval = null;
let rangeCircle = null;
let currentRangeKm = CONFIG.DEFAULT_RANGE_KM;

// ============================================
// Initialization
// ============================================
document.addEventListener('DOMContentLoaded', async () => {
    // Load range from localStorage
    loadRangeFromStorage();

    // Initialize map
    initMap();

    // Try to get observer location
    await initLocation();

    // Start polling
    startPolling();

    // Listen for range changes from ticker view (cross-tab sync)
    window.addEventListener('storage', handleStorageChange);
});

function initMap() {
    // Create map with dark theme tiles
    map = L.map('map', {
        center: CONFIG.DEFAULT_CENTER,
        zoom: CONFIG.DEFAULT_ZOOM,
        zoomControl: true,
    });

    // Dark map tiles (CartoDB Dark Matter)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 19,
    }).addTo(map);
}

async function initLocation() {
    try {
        // First check if location is already set
        const response = await fetch(`${CONFIG.API_BASE}/metrics/location`);
        const data = await response.json();

        if (data.location && data.location.latitude) {
            observerLocation = [data.location.latitude, data.location.longitude];
            map.setView(observerLocation, CONFIG.DEFAULT_ZOOM);
            addObserverMarker();
            updateStatus('connected', 'Connected');
            return;
        }

        // Auto-detect location
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

function addObserverMarker() {
    if (!observerLocation) return;

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

    // Add range circle
    updateRangeCircle();
}

// ============================================
// Data Polling
// ============================================
function startPolling() {
    // Initial fetch
    fetchFlights();

    // Set up interval
    pollInterval = setInterval(fetchFlights, CONFIG.POLL_INTERVAL_MS);
}

async function fetchFlights() {
    try {
        const response = await fetch(`${CONFIG.API_BASE}/flights?airborne_only=true&limit=100`);
        const data = await response.json();

        // Update status
        updateStatus('connected', 'Connected');
        document.getElementById('lastUpdate').textContent = `Last update: ${new Date().toLocaleTimeString()}`;
        document.getElementById('queryTime').textContent = `Query: ${data.query_time_ms} ms`;

        // Update markers and list
        updateAircraftMarkers(data.flights);
        updateFlightList(data.flights);
        document.getElementById('flightCount').textContent = data.count;

        // Update selected flight panel if open
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

// ============================================
// Aircraft Markers
// ============================================
function updateAircraftMarkers(flights) {
    const currentIcaos = new Set(flights.map(f => f.icao24));

    // Remove markers for flights no longer tracked
    for (const [icao24, marker] of aircraftMarkers) {
        if (!currentIcaos.has(icao24)) {
            map.removeLayer(marker);
            aircraftMarkers.delete(icao24);
        }
    }

    // Update or create markers
    for (const flight of flights) {
        if (!flight.position.latitude || !flight.position.longitude) continue;

        const position = [flight.position.latitude, flight.position.longitude];
        const heading = flight.telemetry.heading || 0;

        if (aircraftMarkers.has(flight.icao24)) {
            // Update existing marker
            const marker = aircraftMarkers.get(flight.icao24);
            marker.setLatLng(position);
            marker.setIcon(createAircraftIcon(heading, flight.icao24 === selectedFlight));
        } else {
            // Create new marker
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

function createAircraftIcon(heading, isSelected) {
    const color = isSelected ? '#3b82f6' : '#f0f0f5';
    const size = isSelected ? 24 : 20;

    // SVG aircraft icon pointing up, rotated by heading
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

// ============================================
// Flight List
// ============================================
const flightListElements = new Map(); // icao24 -> DOM element

function updateFlightList(flights) {
    const container = document.getElementById('flightListItems');
    const currentIcaos = new Set(flights.map(f => f.icao24));

    // Remove elements for flights no longer present
    for (const [icao24, element] of flightListElements) {
        if (!currentIcaos.has(icao24)) {
            element.remove();
            flightListElements.delete(icao24);
        }
    }

    // Update or create elements
    for (const flight of flights) {
        const altDisplay = flight.telemetry.flight_level ||
            (flight.telemetry.altitude_ft ? `${Math.round(flight.telemetry.altitude_ft / 100) * 100}ft` : '---');
        const typeDisplay = flight.aircraft_type_desc || flight.aircraft_type || '';

        // Route display for sidebar (compact format)
        const routeDisplay = flight.route && flight.route.origin && flight.route.destination
            ? `${flight.route.origin}-${flight.route.destination}`
            : '';

        if (flightListElements.has(flight.icao24)) {
            // Update existing element
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
            // Create new element
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

// ============================================
// Flight Panel
// ============================================
function selectFlight(icao24) {
    selectedFlight = icao24;

    // Update marker styles
    for (const [id, marker] of aircraftMarkers) {
        marker.setIcon(createAircraftIcon(0, id === icao24));
    }

    // Show and update panel
    document.getElementById('flightPanel').style.display = 'block';

    // Fetch latest data for this flight
    fetchFlightDetails(icao24);

    // Update list selection styling
    for (const [id, element] of flightListElements) {
        element.className = 'flight-list-item' + (id === icao24 ? ' selected' : '');
    }
}

async function fetchFlightDetails(icao24) {
    try {
        const response = await fetch(`${CONFIG.API_BASE}/flights/${icao24}?include_analytics=true`);
        const data = await response.json();
        updateFlightPanel(data);
    } catch (error) {
        console.error('Flight details error:', error);
    }
}

// Telemetry history for graphs
const telemetryHistory = {
    altitude: [],
    speed: [],
    heading: [],
    maxPoints: 30
};

function updateFlightPanel(flight) {
    // Airline logo - extract code from callsign
    const airlineCode = flight.callsign?.substring(0, 2) || '--';
    document.getElementById('panelAirlineCode').textContent = airlineCode;

    // Set airline-specific logo colors
    const logoEl = document.getElementById('panelAirlineLogo');
    const airlineColors = {
        'AC': ['#dc2626', '#991b1b'], // Air Canada - Red
        'AA': ['#0078d2', '#005eb8'], // American - Blue
        'UA': ['#002244', '#001a33'], // United - Dark Blue
        'DL': ['#c8102e', '#9a0c23'], // Delta - Red
        'WN': ['#f9b612', '#d4990f'], // Southwest - Yellow/Orange
        'AS': ['#00274d', '#001a33'], // Alaska - Dark Blue
        'B6': ['#003876', '#002855'], // JetBlue - Blue
        'WS': ['#00a651', '#008c45'], // WestJet - Green
        'RP': ['#1e3a5f', '#152942'], // Republic - Navy
    };
    const colors = airlineColors[airlineCode] || ['#3b82f6', '#2563eb'];
    logoEl.style.background = `linear-gradient(135deg, ${colors[0]}, ${colors[1]})`;

    // Route display
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

    // Phase badge
    const phaseBadge = document.getElementById('panelPhase');
    const phase = flight.status?.flight_phase || 'unknown';
    const phaseDisplay = {
        'climb': 'Climbing',
        'cruise': 'Cruise (En route)',
        'descent': 'Descending',
        'ground': 'On Ground',
        'unknown': 'In Flight'
    };
    phaseBadge.textContent = phaseDisplay[phase] || phase;
    phaseBadge.className = 'meta-value status-badge ' + phase;

    // Telemetry values
    const telemetry = flight.telemetry || {};
    const position = flight.position || {};

    const altFt = telemetry.altitude_ft || 0;
    const speedKts = telemetry.speed_kts || 0;
    const heading = telemetry.heading || 0;
    const vRate = telemetry.vertical_rate_fpm || 0;
    const distKm = position.distance_km || flight.distance_km || 0;

    // Update telemetry displays
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

    // Flight status (active, on time, etc.)
    const flightStatus = flight.route?.status || 'Active';
    const statusEl = document.getElementById('panelFlightStatus');
    statusEl.textContent = flightStatus.charAt(0).toUpperCase() + flightStatus.slice(1);
    statusEl.className = 'status-value ' + (flightStatus === 'active' ? 'status-on-time' : '');

    // Anomaly banner
    const anomalyBanner = document.getElementById('panelAnomaly');
    anomalyBanner.style.display = flight.analytics?.is_anomaly ? 'block' : 'none';

    // Update telemetry history for graphs
    telemetryHistory.altitude.push(altFt);
    telemetryHistory.speed.push(speedKts);
    telemetryHistory.heading.push(heading);

    // Keep history limited
    if (telemetryHistory.altitude.length > telemetryHistory.maxPoints) {
        telemetryHistory.altitude.shift();
        telemetryHistory.speed.shift();
        telemetryHistory.heading.shift();
    }

    // Draw graphs
    drawTelemetryGraph('altitudeGraph', telemetryHistory.altitude, '#06b6d4');
    drawTelemetryGraph('speedGraph', telemetryHistory.speed, '#22c55e');
    drawTelemetryGraph('headingGraph', telemetryHistory.heading, '#8b5cf6');
}

function drawTelemetryGraph(canvasId, data, color) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    // Clear
    ctx.fillStyle = '#1a1a24';
    ctx.fillRect(0, 0, width, height);

    if (data.length < 2) return;

    // Find min/max for scaling
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;

    // Draw line
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

    // Draw fill
    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    ctx.fillStyle = color + '20';
    ctx.fill();
}

function getTrendClass(trend) {
    switch (trend) {
        case 'increasing': return 'climbing';
        case 'decreasing': return 'descending';
        case 'stable': return 'cruise';
        default: return '';
    }
}

function closeFlightPanel() {
    selectedFlight = null;
    document.getElementById('flightPanel').style.display = 'none';

    // Reset telemetry history
    telemetryHistory.altitude = [];
    telemetryHistory.speed = [];
    telemetryHistory.heading = [];

    // Reset marker styles
    for (const [id, marker] of aircraftMarkers) {
        marker.setIcon(createAircraftIcon(0, false));
    }
}

// ============================================
// Status Updates
// ============================================
function updateStatus(state, message) {
    const dot = document.getElementById('connectionDot');
    const text = document.getElementById('connectionStatus');

    dot.className = 'status-dot ' + state;
    text.textContent = message;
}

// ============================================
// Range Circle
// ============================================
function loadRangeFromStorage() {
    const saved = localStorage.getItem(CONFIG.STORAGE_KEY);
    if (saved) {
        const range = parseInt(saved, 10);
        if (range >= 1 && range <= 50) {
            currentRangeKm = range;
        }
    }
}

function handleStorageChange(event) {
    if (event.key === CONFIG.STORAGE_KEY) {
        const newRange = parseInt(event.newValue, 10);
        if (newRange >= 1 && newRange <= 50) {
            currentRangeKm = newRange;
            updateRangeCircle();
        }
    }
}

function updateRangeCircle() {
    if (!observerLocation || !map) return;

    // Remove existing circle
    if (rangeCircle) {
        map.removeLayer(rangeCircle);
    }

    // Create new circle (radius in meters)
    rangeCircle = L.circle(observerLocation, {
        radius: currentRangeKm * 1000,
        color: '#06b6d4',
        fillColor: '#06b6d4',
        fillOpacity: 0.08,
        weight: 2,
        dashArray: '8, 4',
        interactive: false,
    }).addTo(map);

    // Add tooltip showing range
    rangeCircle.bindTooltip(`${currentRangeKm} km radius`, {
        permanent: false,
        direction: 'top',
        className: 'range-tooltip',
    });
}
