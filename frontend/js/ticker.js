/**
 * FlightWall - Ticker View JavaScript (LED Matrix Style)
 *
 * Simple LED display mode showing one aircraft at a time.
 * Designed for always-on, passive viewing.
 */

// ============================================
// Configuration
// ============================================
const CONFIG = {
    API_BASE: '/api',
    POLL_INTERVAL_MS: 2000,
    ROTATION_INTERVAL_SECONDS: 8,
    MAX_DISTANCE_KM: 10,
    SETTINGS_IDLE_TIMEOUT_MS: 3000,
    STORAGE_KEY: 'flightwall_range_km',
    STORAGE_KEY_ALT_UNIT: 'flightwall_alt_unit',
    STORAGE_KEY_SPD_UNIT: 'flightwall_spd_unit',
    STORAGE_KEY_AIRPORTS: 'flightwall_airport_display',
};

// Unit settings (defaults: ft and kts)
const UNITS = {
    altitude: 'ft',  // 'ft' or 'm'
    speed: 'kts',    // 'kts' or 'kph'
};

// Display settings
const DISPLAY = {
    airports: 'codes', // 'codes' or 'names'
};

// ============================================
// State
// ============================================
let currentFlight = null;
let rotationProgress = 0;
let progressInterval = null;
let settingsIdleTimeout = null;
let isSettingsOpen = false;

// ============================================
// Initialization
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    // Load saved settings from localStorage
    loadRangeFromStorage();
    loadUnitsFromStorage();
    loadDisplayFromStorage();

    // Initialize settings panel
    initSettingsPanel();
    initUnitButtons();
    initAirportButtons();

    // Start polling
    fetchTickerData();
    setInterval(fetchTickerData, CONFIG.POLL_INTERVAL_MS);

    // Start progress bar animation
    startProgressAnimation();

    // Update clock
    updateClock();
    setInterval(updateClock, 1000);

    // Handle visibility change (pause when hidden)
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Show settings button on mouse movement
    document.addEventListener('mousemove', handleMouseActivity);
    document.addEventListener('mousedown', handleMouseActivity);
});

// ============================================
// Data Fetching
// ============================================
async function fetchTickerData() {
    try {
        const response = await fetch(
            `${CONFIG.API_BASE}/flights/ticker?rotation_interval=${CONFIG.ROTATION_INTERVAL_SECONDS}&max_distance=${CONFIG.MAX_DISTANCE_KM}`
        );
        const data = await response.json();

        if (data.flight) {
            showFlight(data.flight);
            updateCounter(data.current_index + 1, data.total_count);

            // Reset progress if flight changed
            if (!currentFlight || currentFlight.icao24 !== data.flight.icao24) {
                resetProgress();
            }
            currentFlight = data.flight;
        } else {
            showEmptyState();
            currentFlight = null;
        }
    } catch (error) {
        console.error('Ticker fetch error:', error);
    }
}

// ============================================
// Display Updates
// ============================================
function showFlight(flight) {
    document.getElementById('ledContent').style.display = 'flex';
    document.getElementById('ledEmpty').style.display = 'none';

    // Airline logo
    const logoContainer = document.getElementById('ledLogo');
    const airlineCode = flight.operator || extractAirlineCode(flight.callsign);
    if (typeof getAirlineLogo === 'function') {
        logoContainer.innerHTML = getAirlineLogo(airlineCode);
    }

    // Airline name
    const airlineName = getAirlineDisplayName(flight.callsign, flight.operator);
    document.getElementById('ledAirline').textContent = airlineName;

    // Route - show origin-destination if available, otherwise callsign
    let routeDisplay = flight.callsign || '---';
    if (flight.route && flight.route.origin && flight.route.destination) {
        if (DISPLAY.airports === 'names' && flight.route.origin_name && flight.route.destination_name) {
            // Show full airport names
            routeDisplay = `${flight.route.origin_name} → ${flight.route.destination_name}`;
        } else {
            // Show airport codes
            routeDisplay = `${flight.route.origin}-${flight.route.destination}`;
        }
    }
    document.getElementById('ledRoute').textContent = routeDisplay;

    // Aircraft type
    document.getElementById('ledAircraft').textContent =
        flight.type || flight.type_description || '---';

    // Telemetry - use selected units
    // Altitude
    if (flight.altitude_ft) {
        if (UNITS.altitude === 'm') {
            const altMeters = Math.round(flight.altitude_ft * 0.3048);
            document.getElementById('ledAlt').textContent = `${altMeters}m`;
        } else {
            document.getElementById('ledAlt').textContent = `${flight.altitude_ft}ft`;
        }
    } else {
        document.getElementById('ledAlt').textContent = '---';
    }

    // Speed
    if (flight.speed_kts) {
        if (UNITS.speed === 'kph') {
            const speedKph = Math.round(flight.speed_kts * 1.852);
            document.getElementById('ledSpd').textContent = `${speedKph}kph`;
        } else {
            document.getElementById('ledSpd').textContent = `${flight.speed_kts}kts`;
        }
    } else {
        document.getElementById('ledSpd').textContent = '---';
    }

    // Track/heading
    document.getElementById('ledTrk').textContent =
        flight.heading !== null ? `${flight.heading}deg` : '---';

    // Vertical rate - use same unit system as speed
    const vrateEl = document.getElementById('ledVr');
    if (flight.vertical_rate_fpm !== null && flight.vertical_rate_fpm !== undefined) {
        let vrateDisplay;
        if (UNITS.speed === 'kph') {
            // Convert fpm to kph vertical (fpm * 0.018288 = kph)
            const vrateKph = Math.round(flight.vertical_rate_fpm * 0.018288);
            const sign = vrateKph > 0 ? '+' : '';
            vrateDisplay = `${sign}${vrateKph}kph`;
        } else {
            // Show as fpm
            const sign = flight.vertical_rate_fpm > 0 ? '+' : '';
            vrateDisplay = `${sign}${flight.vertical_rate_fpm}fpm`;
        }
        vrateEl.textContent = vrateDisplay;
        vrateEl.className = 'ticker-telem-value ' + (flight.vertical_rate_fpm < 0 ? 'negative' : flight.vertical_rate_fpm > 0 ? 'positive' : '');
    } else {
        vrateEl.textContent = '---';
        vrateEl.className = 'ticker-telem-value';
    }
}

function showEmptyState() {
    document.getElementById('ledContent').style.display = 'none';
    document.getElementById('ledEmpty').style.display = 'block';
    updateCounter(0, 0);
}

function updateCounter(current, total) {
    document.getElementById('tickerCount').textContent = `${current}/${total}`;
}

function updateClock() {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
    document.getElementById('tickerTime').textContent = timeStr;
}

// ============================================
// Progress Animation
// ============================================
function startProgressAnimation() {
    const updateInterval = 100; // ms
    const increment = (100 * updateInterval) / (CONFIG.ROTATION_INTERVAL_SECONDS * 1000);

    progressInterval = setInterval(() => {
        rotationProgress += increment;
        if (rotationProgress >= 100) {
            rotationProgress = 0;
        }
        document.getElementById('progressBar').style.width = `${rotationProgress}%`;
    }, updateInterval);
}

function resetProgress() {
    rotationProgress = 0;
    document.getElementById('progressBar').style.width = '0%';
}

// ============================================
// Helper Functions
// ============================================
function extractAirlineCode(callsign) {
    if (!callsign || callsign.length < 3) return null;
    return callsign.substring(0, 3).toUpperCase();
}

function getAirlineDisplayName(callsign, operator) {
    const AIRLINES = {
        'AAL': 'American',
        'DAL': 'Delta',
        'UAL': 'United',
        'SWA': 'Southwest',
        'JBU': 'JetBlue',
        'ASA': 'Alaska',
        'FFT': 'Frontier',
        'NKS': 'Spirit',
        'ACA': 'Air Canada',
        'WJA': 'WestJet',
        'BAW': 'British Airways',
        'DLH': 'Lufthansa',
        'AFR': 'Air France',
        'KLM': 'KLM',
        'UAE': 'Emirates',
        'QFA': 'Qantas',
        'ANA': 'ANA',
        'JAL': 'JAL',
        'CPA': 'Cathay Pacific',
        'SIA': 'Singapore',
        'SKW': 'SkyWest',
        'RPA': 'Republic',
        'ENY': 'Envoy',
        'EGF': 'American Eagle',
        'CPZ': 'Compass',
        'PDT': 'Piedmont',
        'JIA': 'PSA',
        'FDX': 'FedEx',
        'UPS': 'UPS',
        'TSC': 'Air Transat',
        'WEN': 'Swoop',
        'POE': 'Porter',
        'JZA': 'Jazz',
    };

    // Try operator first
    if (operator && AIRLINES[operator]) {
        return AIRLINES[operator];
    }

    // Try callsign prefix
    if (callsign && callsign.length >= 3) {
        const prefix = callsign.substring(0, 3).toUpperCase();
        if (AIRLINES[prefix]) {
            return AIRLINES[prefix];
        }
    }

    // Return operator or first 3 chars of callsign
    return operator || (callsign ? callsign.substring(0, 3) : 'Unknown');
}

// ============================================
// Visibility Handling
// ============================================
function handleVisibilityChange() {
    if (document.hidden) {
        if (progressInterval) {
            clearInterval(progressInterval);
            progressInterval = null;
        }
    } else {
        if (!progressInterval) {
            startProgressAnimation();
        }
    }
}

// ============================================
// Settings Panel
// ============================================
function loadRangeFromStorage() {
    const saved = localStorage.getItem(CONFIG.STORAGE_KEY);
    if (saved) {
        const range = parseInt(saved, 10);
        if (range >= 1 && range <= 50) {
            CONFIG.MAX_DISTANCE_KM = range;
        }
    }
}

function saveRangeToStorage(range) {
    localStorage.setItem(CONFIG.STORAGE_KEY, range.toString());
}

function loadUnitsFromStorage() {
    const altUnit = localStorage.getItem(CONFIG.STORAGE_KEY_ALT_UNIT);
    const spdUnit = localStorage.getItem(CONFIG.STORAGE_KEY_SPD_UNIT);

    if (altUnit === 'ft' || altUnit === 'm') {
        UNITS.altitude = altUnit;
    }
    if (spdUnit === 'kts' || spdUnit === 'kph') {
        UNITS.speed = spdUnit;
    }
}

function saveUnitsToStorage() {
    localStorage.setItem(CONFIG.STORAGE_KEY_ALT_UNIT, UNITS.altitude);
    localStorage.setItem(CONFIG.STORAGE_KEY_SPD_UNIT, UNITS.speed);
}

function initUnitButtons() {
    // Altitude buttons
    const altFtBtn = document.getElementById('altFt');
    const altMBtn = document.getElementById('altM');

    // Speed buttons
    const spdKtsBtn = document.getElementById('spdKts');
    const spdKphBtn = document.getElementById('spdKph');

    // Set initial active states based on loaded settings
    altFtBtn.classList.toggle('active', UNITS.altitude === 'ft');
    altMBtn.classList.toggle('active', UNITS.altitude === 'm');
    spdKtsBtn.classList.toggle('active', UNITS.speed === 'kts');
    spdKphBtn.classList.toggle('active', UNITS.speed === 'kph');

    // Altitude toggle
    altFtBtn.addEventListener('click', () => {
        UNITS.altitude = 'ft';
        altFtBtn.classList.add('active');
        altMBtn.classList.remove('active');
        saveUnitsToStorage();
        if (currentFlight) showFlight(currentFlight);
        resetSettingsIdleTimeout();
    });

    altMBtn.addEventListener('click', () => {
        UNITS.altitude = 'm';
        altMBtn.classList.add('active');
        altFtBtn.classList.remove('active');
        saveUnitsToStorage();
        if (currentFlight) showFlight(currentFlight);
        resetSettingsIdleTimeout();
    });

    // Speed toggle
    spdKtsBtn.addEventListener('click', () => {
        UNITS.speed = 'kts';
        spdKtsBtn.classList.add('active');
        spdKphBtn.classList.remove('active');
        saveUnitsToStorage();
        if (currentFlight) showFlight(currentFlight);
        resetSettingsIdleTimeout();
    });

    spdKphBtn.addEventListener('click', () => {
        UNITS.speed = 'kph';
        spdKphBtn.classList.add('active');
        spdKtsBtn.classList.remove('active');
        saveUnitsToStorage();
        if (currentFlight) showFlight(currentFlight);
        resetSettingsIdleTimeout();
    });
}

function loadDisplayFromStorage() {
    const airports = localStorage.getItem(CONFIG.STORAGE_KEY_AIRPORTS);

    if (airports === 'codes' || airports === 'names') {
        DISPLAY.airports = airports;
    }
}

function saveDisplayToStorage() {
    localStorage.setItem(CONFIG.STORAGE_KEY_AIRPORTS, DISPLAY.airports);
}

function initAirportButtons() {
    const airportCodesBtn = document.getElementById('airportCodes');
    const airportNamesBtn = document.getElementById('airportNames');

    // Set initial active states
    airportCodesBtn.classList.toggle('active', DISPLAY.airports === 'codes');
    airportNamesBtn.classList.toggle('active', DISPLAY.airports === 'names');

    airportCodesBtn.addEventListener('click', () => {
        DISPLAY.airports = 'codes';
        airportCodesBtn.classList.add('active');
        airportNamesBtn.classList.remove('active');
        saveDisplayToStorage();
        if (currentFlight) showFlight(currentFlight);
        resetSettingsIdleTimeout();
    });

    airportNamesBtn.addEventListener('click', () => {
        DISPLAY.airports = 'names';
        airportNamesBtn.classList.add('active');
        airportCodesBtn.classList.remove('active');
        saveDisplayToStorage();
        if (currentFlight) showFlight(currentFlight);
        resetSettingsIdleTimeout();
    });
}

function initSettingsPanel() {
    const slider = document.getElementById('rangeSlider');
    const valueDisplay = document.getElementById('rangeValue');
    const toggleBtn = document.getElementById('settingsToggle');
    const closeBtn = document.getElementById('settingsClose');
    const panel = document.getElementById('settingsPanel');

    // Set initial slider value from config
    slider.value = CONFIG.MAX_DISTANCE_KM;
    valueDisplay.textContent = CONFIG.MAX_DISTANCE_KM;

    // Slider change handler
    slider.addEventListener('input', (e) => {
        const value = parseInt(e.target.value, 10);
        valueDisplay.textContent = value;
        CONFIG.MAX_DISTANCE_KM = value;
        saveRangeToStorage(value);

        // Reset idle timeout when interacting
        resetSettingsIdleTimeout();
    });

    // Toggle button
    toggleBtn.addEventListener('click', () => {
        toggleSettings();
    });

    // Close button
    closeBtn.addEventListener('click', () => {
        closeSettings();
    });

    // Close on click outside
    document.addEventListener('click', (e) => {
        if (isSettingsOpen &&
            !panel.contains(e.target) &&
            !toggleBtn.contains(e.target)) {
            closeSettings();
        }
    });

    // Prevent idle close when interacting with panel
    panel.addEventListener('mouseenter', () => {
        clearTimeout(settingsIdleTimeout);
    });

    panel.addEventListener('mouseleave', () => {
        if (isSettingsOpen) {
            resetSettingsIdleTimeout();
        }
    });
}

function toggleSettings() {
    if (isSettingsOpen) {
        closeSettings();
    } else {
        openSettings();
    }
}

function openSettings() {
    const panel = document.getElementById('settingsPanel');
    panel.classList.add('open');
    isSettingsOpen = true;
    resetSettingsIdleTimeout();
}

function closeSettings() {
    const panel = document.getElementById('settingsPanel');
    panel.classList.remove('open');
    isSettingsOpen = false;
    clearTimeout(settingsIdleTimeout);
}

function resetSettingsIdleTimeout() {
    clearTimeout(settingsIdleTimeout);
    settingsIdleTimeout = setTimeout(() => {
        closeSettings();
    }, CONFIG.SETTINGS_IDLE_TIMEOUT_MS);
}

function handleMouseActivity() {
    const toggleBtn = document.getElementById('settingsToggle');
    toggleBtn.classList.add('visible');

    // Hide after idle
    clearTimeout(window.buttonIdleTimeout);
    window.buttonIdleTimeout = setTimeout(() => {
        if (!isSettingsOpen) {
            toggleBtn.classList.remove('visible');
        }
    }, 2000);
}

// ============================================
// Keyboard Shortcuts
// ============================================
document.addEventListener('keydown', (event) => {
    switch (event.key) {
        case 'f':
        case 'F':
            if (!document.fullscreenElement) {
                document.documentElement.requestFullscreen();
            } else {
                document.exitFullscreen();
            }
            break;

        case 'Escape':
            if (isSettingsOpen) {
                closeSettings();
            } else if (document.fullscreenElement) {
                document.exitFullscreen();
            }
            break;

        case 's':
        case 'S':
            toggleSettings();
            break;

        case 'm':
        case 'M':
            window.location.href = '/';
            break;
    }
});
