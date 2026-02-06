/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║                    FLIGHTWALL TICKER VIEW                                 ║
 * ║                                                                           ║
 * ║  LED Matrix-style display for passive flight watching.                    ║
 * ║  Perfect for that second monitor, Raspberry Pi display, or any screen     ║
 * ║  you want to dedicate to the gentle art of plane spotting.                ║
 * ║                                                                           ║
 * ║  Author: Shawn (professional plane watcher)                               ║
 * ║  Version: 2.0.0                                                           ║
 * ║  License: MIT                                                             ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Features:
 * - One aircraft at a time, rotating display (like an airport departure board)
 * - Configurable detection range
 * - Unit toggles (ft/m, kts/kph) for international plane spotters
 * - Fullscreen mode (press 'F') for the ultimate zen experience
 * - Progress bar showing time until next aircraft
 *
 * Pro tip: This looks great on a vertical monitor. Just saying.
 */

// =============================================================================
//  CONFIGURATION
//  (Tweak these to your heart's content)
// =============================================================================

const CONFIG = {
    /** API base URL - where the magic data comes from */
    API_BASE: '/api',

    /** How often to poll for updates (2 seconds keeps it fresh) */
    POLL_INTERVAL_MS: 2000,

    /** How long to display each aircraft before rotating */
    ROTATION_INTERVAL_SECONDS: 8,

    /** Maximum detection radius in kilometers */
    MAX_DISTANCE_KM: 10,

    /** How long to wait before auto-closing settings (3 seconds of idle) */
    SETTINGS_IDLE_TIMEOUT_MS: 3000,

    /** LocalStorage keys - persisting your preferences across sessions */
    STORAGE_KEY: 'flightwall_range_km',
    STORAGE_KEY_ALT_UNIT: 'flightwall_alt_unit',
    STORAGE_KEY_SPD_UNIT: 'flightwall_spd_unit',
    STORAGE_KEY_AIRPORTS: 'flightwall_airport_display',
};

// =============================================================================
//  UNIT SETTINGS
//  (Because not everyone speaks freedom units)
// =============================================================================

/**
 * User's preferred measurement units.
 * Defaults to aviation standard (ft and kts), but we don't judge metric users.
 */
const UNITS = {
    altitude: 'ft',  // 'ft' for feet, 'm' for meters
    speed: 'kts',    // 'kts' for knots, 'kph' for kilometers per hour
};

/**
 * Display preferences for airport information.
 */
const DISPLAY = {
    airports: 'codes', // 'codes' (LAX-JFK) or 'names' (Los Angeles → New York)
};

// =============================================================================
//  APPLICATION STATE
//  (The memory of our little ticker brain)
// =============================================================================

/** @type {Object|null} Currently displayed flight data */
let currentFlight = null;

/** @type {number} Progress bar position (0-100) */
let rotationProgress = 0;

/** @type {number|null} Progress bar animation interval ID */
let progressInterval = null;

/** @type {number|null} Settings auto-close timeout ID */
let settingsIdleTimeout = null;

/** @type {boolean} Is the settings panel currently open? */
let isSettingsOpen = false;

// =============================================================================
//  INITIALIZATION
//  (Wake up, little ticker, it's time to watch some planes)
// =============================================================================

/**
 * Main initialization - fires when the DOM is ready.
 * Sets up all event listeners, loads saved settings, and starts the show.
 */
document.addEventListener('DOMContentLoaded', () => {
    // Load user preferences from localStorage (they saved these for a reason!)
    loadRangeFromStorage();
    loadUnitsFromStorage();
    loadDisplayFromStorage();

    // Initialize the settings panel and its various toggles
    initSettingsPanel();
    initUnitButtons();
    initAirportButtons();

    // Start the main data loop - time to fetch some aircraft!
    fetchTickerData();
    setInterval(fetchTickerData, CONFIG.POLL_INTERVAL_MS);

    // Start the hypnotic progress bar animation
    startProgressAnimation();

    // Keep the clock ticking (literally)
    updateClock();
    setInterval(updateClock, 1000);

    // Pause updates when tab is hidden (save those API calls!)
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Show settings button when mouse moves (hidden UI = clean UI)
    document.addEventListener('mousemove', handleMouseActivity);
    document.addEventListener('mousedown', handleMouseActivity);
});

// =============================================================================
//  DATA FETCHING
//  (The part where we actually get flight data)
// =============================================================================

/**
 * Fetches the current ticker flight from the API.
 * The backend handles rotation logic - we just display what we're told.
 */
async function fetchTickerData() {
    try {
        const response = await fetch(
            `${CONFIG.API_BASE}/flights/ticker?rotation_interval=${CONFIG.ROTATION_INTERVAL_SECONDS}&max_distance=${CONFIG.MAX_DISTANCE_KM}`
        );
        const data = await response.json();

        if (data.flight) {
            showFlight(data.flight);
            updateCounter(data.current_index + 1, data.total_count);

            // Reset progress bar when we switch to a new aircraft
            if (!currentFlight || currentFlight.icao24 !== data.flight.icao24) {
                resetProgress();
            }
            currentFlight = data.flight;
        } else {
            // No flights nearby - show the "waiting for aircraft" state
            showEmptyState();
            currentFlight = null;
        }
    } catch (error) {
        console.error('Ticker fetch error:', error);
        // Don't panic, just wait for the next poll
    }
}

// =============================================================================
//  DISPLAY UPDATES
//  (Making the data look pretty)
// =============================================================================

/**
 * Updates the display with flight information.
 * Handles unit conversions based on user preferences.
 *
 * @param {Object} flight - Flight data from the API
 */
function showFlight(flight) {
    // Show content, hide empty state
    document.getElementById('ledContent').style.display = 'flex';
    document.getElementById('ledEmpty').style.display = 'none';

    // Airline logo - the crown jewel of our display
    const logoContainer = document.getElementById('ledLogo');
    const airlineCode = flight.airline_icao || flight.operator || extractAirlineCode(flight.callsign);
    if (typeof getAirlineLogo === 'function') {
        logoContainer.innerHTML = getAirlineLogo(airlineCode);
    }

    // Airline name with alliance info (Star Alliance, oneworld, SkyTeam)
    const airlineName = flight.airline_name || getAirlineDisplayName(flight.callsign, flight.operator);
    const alliance = typeof getAirlineAlliance === 'function' ? getAirlineAlliance(airlineCode) : null;
    if (alliance) {
        document.getElementById('ledAirline').innerHTML =
            `${airlineName} <span style="font-size: 0.6em; color: var(--text-muted); font-weight: 400;">(${alliance})</span>`;
    } else {
        document.getElementById('ledAirline').textContent = airlineName;
    }

    // Route display - show origin-destination if available
    let routeDisplay = flight.callsign || '---';
    if (flight.route && flight.route.origin && flight.route.destination) {
        if (DISPLAY.airports === 'names' && flight.route.origin_name && flight.route.destination_name) {
            // Full airport names for the detail-oriented folks
            routeDisplay = `${flight.route.origin_name} → ${flight.route.destination_name}`;
        } else {
            // Classic airport codes (LAX-JFK style)
            routeDisplay = `${flight.route.origin}-${flight.route.destination}`;
        }
    }
    document.getElementById('ledRoute').textContent = routeDisplay;

    // Aircraft type - what beautiful machine is gracing our skies?
    document.getElementById('ledAircraft').textContent =
        flight.type || flight.type_description || '---';

    // Altitude - respecting user's unit preference
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

    // Speed - knots for pilots, kph for everyone else
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

    // Track/heading - where are they pointing?
    document.getElementById('ledTrk').textContent =
        flight.heading !== null ? `${flight.heading}deg` : '---';

    // Vertical rate - are they climbing or descending?
    const vrateEl = document.getElementById('ledVr');
    if (flight.vertical_rate_fpm !== null && flight.vertical_rate_fpm !== undefined) {
        let vrateDisplay;
        if (UNITS.speed === 'kph') {
            // Convert fpm to kph vertical for metric consistency
            const vrateKph = Math.round(flight.vertical_rate_fpm * 0.018288);
            const sign = vrateKph > 0 ? '+' : '';
            vrateDisplay = `${sign}${vrateKph}kph`;
        } else {
            // Standard feet per minute
            const sign = flight.vertical_rate_fpm > 0 ? '+' : '';
            vrateDisplay = `${sign}${flight.vertical_rate_fpm}fpm`;
        }
        vrateEl.textContent = vrateDisplay;
        // Color coding: green for climbing, red for descending
        vrateEl.className = 'ticker-telem-value ' +
            (flight.vertical_rate_fpm < 0 ? 'negative' : flight.vertical_rate_fpm > 0 ? 'positive' : '');
    } else {
        vrateEl.textContent = '---';
        vrateEl.className = 'ticker-telem-value';
    }
}

/**
 * Shows the empty state when no aircraft are detected.
 * Time to go outside and look up, maybe?
 */
function showEmptyState() {
    document.getElementById('ledContent').style.display = 'none';
    document.getElementById('ledEmpty').style.display = 'block';
    updateCounter(0, 0);
}

/**
 * Updates the aircraft counter display (e.g., "3/7").
 *
 * @param {number} current - Current aircraft index
 * @param {number} total - Total aircraft in range
 */
function updateCounter(current, total) {
    document.getElementById('tickerCount').textContent = `${current}/${total}`;
}

/**
 * Updates the clock display.
 * Because knowing the time while plane watching is important... somehow.
 */
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

// =============================================================================
//  PROGRESS BAR ANIMATION
//  (The satisfying fill that tells you when the next plane is coming)
// =============================================================================

/**
 * Starts the progress bar animation.
 * Fills up over the rotation interval, then resets.
 */
function startProgressAnimation() {
    const updateInterval = 100; // Update every 100ms for smooth animation
    const increment = (100 * updateInterval) / (CONFIG.ROTATION_INTERVAL_SECONDS * 1000);

    progressInterval = setInterval(() => {
        rotationProgress += increment;
        if (rotationProgress >= 100) {
            rotationProgress = 0;
        }
        document.getElementById('progressBar').style.width = `${rotationProgress}%`;
    }, updateInterval);
}

/**
 * Resets the progress bar to zero.
 * Called when switching to a new aircraft.
 */
function resetProgress() {
    rotationProgress = 0;
    document.getElementById('progressBar').style.width = '0%';
}

// =============================================================================
//  HELPER FUNCTIONS
//  (The unsung heroes of code organization)
// =============================================================================

/**
 * Extracts the airline code from a callsign.
 * Most callsigns start with a 3-letter airline code (e.g., "UAL123" → "UAL").
 *
 * @param {string} callsign - The flight callsign
 * @returns {string|null} The extracted airline code
 */
function extractAirlineCode(callsign) {
    if (!callsign || callsign.length < 3) return null;
    return callsign.substring(0, 3).toUpperCase();
}

/**
 * Gets a human-readable airline name from callsign or operator code.
 * Falls back to the raw code if we don't recognize it.
 *
 * @param {string} callsign - Flight callsign
 * @param {string} operator - Operator ICAO code
 * @returns {string} Display-friendly airline name
 */
function getAirlineDisplayName(callsign, operator) {
    // A curated list of airlines we might see
    // (This is basically a love letter to commercial aviation)
    const AIRLINES = {
        // The Big Three (US)
        'AAL': 'American',
        'DAL': 'Delta',
        'UAL': 'United',

        // US Low-Cost Carriers
        'SWA': 'Southwest',  // Bags fly free! 🧳
        'JBU': 'JetBlue',
        'ASA': 'Alaska',
        'FFT': 'Frontier',   // That deer tho
        'NKS': 'Spirit',     // You get what you pay for

        // Canadian Friends
        'ACA': 'Air Canada',
        'WJA': 'WestJet',
        'TSC': 'Air Transat',
        'WEN': 'Swoop',
        'POE': 'Porter',
        'JZA': 'Jazz',

        // European Heavy Hitters
        'BAW': 'British Airways',
        'DLH': 'Lufthansa',
        'AFR': 'Air France',
        'KLM': 'KLM',        // The Netherlands' pride

        // International Stars
        'UAE': 'Emirates',    // The A380 fan favorite
        'QFA': 'Qantas',
        'ANA': 'ANA',
        'JAL': 'JAL',
        'CPA': 'Cathay Pacific',
        'SIA': 'Singapore',   // Consistently ranked #1

        // US Regional Carriers (the unsung heroes)
        'SKW': 'SkyWest',
        'RPA': 'Republic',
        'ENY': 'Envoy',
        'EGF': 'American Eagle',
        'CPZ': 'Compass',
        'PDT': 'Piedmont',
        'JIA': 'PSA',

        // Cargo Kings
        'FDX': 'FedEx',      // When it absolutely, positively...
        'UPS': 'UPS',        // What can brown do for you?
    };

    // Try operator code first (more reliable)
    if (operator && AIRLINES[operator]) {
        return AIRLINES[operator];
    }

    // Fall back to callsign prefix
    if (callsign && callsign.length >= 3) {
        const prefix = callsign.substring(0, 3).toUpperCase();
        if (AIRLINES[prefix]) {
            return AIRLINES[prefix];
        }
    }

    // Last resort: show what we have
    return operator || (callsign ? callsign.substring(0, 3) : 'Unknown');
}

// =============================================================================
//  VISIBILITY HANDLING
//  (Being a good citizen and not wasting resources)
// =============================================================================

/**
 * Handles page visibility changes.
 * Pauses animation when tab is hidden to save CPU cycles.
 */
function handleVisibilityChange() {
    if (document.hidden) {
        // Tab is hidden - take a break
        if (progressInterval) {
            clearInterval(progressInterval);
            progressInterval = null;
        }
    } else {
        // We're back! Resume the animation
        if (!progressInterval) {
            startProgressAnimation();
        }
    }
}

// =============================================================================
//  SETTINGS PANEL
//  (Where the customization magic happens)
// =============================================================================

/**
 * Loads the detection range from localStorage.
 */
function loadRangeFromStorage() {
    const saved = localStorage.getItem(CONFIG.STORAGE_KEY);
    if (saved) {
        const range = parseInt(saved, 10);
        if (range >= 1 && range <= 50) {
            CONFIG.MAX_DISTANCE_KM = range;
        }
    }
}

/**
 * Saves the detection range to localStorage.
 * @param {number} range - Range in kilometers
 */
function saveRangeToStorage(range) {
    localStorage.setItem(CONFIG.STORAGE_KEY, range.toString());
}

/**
 * Loads unit preferences from localStorage.
 */
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

/**
 * Saves unit preferences to localStorage.
 */
function saveUnitsToStorage() {
    localStorage.setItem(CONFIG.STORAGE_KEY_ALT_UNIT, UNITS.altitude);
    localStorage.setItem(CONFIG.STORAGE_KEY_SPD_UNIT, UNITS.speed);
}

/**
 * Initializes the unit toggle buttons.
 * Wires up click handlers and sets initial states.
 */
function initUnitButtons() {
    // Altitude toggle buttons
    const altFtBtn = document.getElementById('altFt');
    const altMBtn = document.getElementById('altM');

    // Speed toggle buttons
    const spdKtsBtn = document.getElementById('spdKts');
    const spdKphBtn = document.getElementById('spdKph');

    // Set initial active states based on loaded preferences
    altFtBtn.classList.toggle('active', UNITS.altitude === 'ft');
    altMBtn.classList.toggle('active', UNITS.altitude === 'm');
    spdKtsBtn.classList.toggle('active', UNITS.speed === 'kts');
    spdKphBtn.classList.toggle('active', UNITS.speed === 'kph');

    // Altitude: feet
    altFtBtn.addEventListener('click', () => {
        UNITS.altitude = 'ft';
        altFtBtn.classList.add('active');
        altMBtn.classList.remove('active');
        saveUnitsToStorage();
        if (currentFlight) showFlight(currentFlight); // Refresh display
        resetSettingsIdleTimeout();
    });

    // Altitude: meters
    altMBtn.addEventListener('click', () => {
        UNITS.altitude = 'm';
        altMBtn.classList.add('active');
        altFtBtn.classList.remove('active');
        saveUnitsToStorage();
        if (currentFlight) showFlight(currentFlight);
        resetSettingsIdleTimeout();
    });

    // Speed: knots
    spdKtsBtn.addEventListener('click', () => {
        UNITS.speed = 'kts';
        spdKtsBtn.classList.add('active');
        spdKphBtn.classList.remove('active');
        saveUnitsToStorage();
        if (currentFlight) showFlight(currentFlight);
        resetSettingsIdleTimeout();
    });

    // Speed: kilometers per hour
    spdKphBtn.addEventListener('click', () => {
        UNITS.speed = 'kph';
        spdKphBtn.classList.add('active');
        spdKtsBtn.classList.remove('active');
        saveUnitsToStorage();
        if (currentFlight) showFlight(currentFlight);
        resetSettingsIdleTimeout();
    });
}

/**
 * Loads display preferences from localStorage.
 */
function loadDisplayFromStorage() {
    const airports = localStorage.getItem(CONFIG.STORAGE_KEY_AIRPORTS);

    if (airports === 'codes' || airports === 'names') {
        DISPLAY.airports = airports;
    }
}

/**
 * Saves display preferences to localStorage.
 */
function saveDisplayToStorage() {
    localStorage.setItem(CONFIG.STORAGE_KEY_AIRPORTS, DISPLAY.airports);
}

/**
 * Initializes the airport display toggle buttons.
 */
function initAirportButtons() {
    const airportCodesBtn = document.getElementById('airportCodes');
    const airportNamesBtn = document.getElementById('airportNames');

    // Set initial active states
    airportCodesBtn.classList.toggle('active', DISPLAY.airports === 'codes');
    airportNamesBtn.classList.toggle('active', DISPLAY.airports === 'names');

    // Airport codes (LAX-JFK)
    airportCodesBtn.addEventListener('click', () => {
        DISPLAY.airports = 'codes';
        airportCodesBtn.classList.add('active');
        airportNamesBtn.classList.remove('active');
        saveDisplayToStorage();
        if (currentFlight) showFlight(currentFlight);
        resetSettingsIdleTimeout();
    });

    // Full airport names
    airportNamesBtn.addEventListener('click', () => {
        DISPLAY.airports = 'names';
        airportNamesBtn.classList.add('active');
        airportCodesBtn.classList.remove('active');
        saveDisplayToStorage();
        if (currentFlight) showFlight(currentFlight);
        resetSettingsIdleTimeout();
    });
}

/**
 * Initializes the main settings panel.
 * Sets up the range slider, toggle button, and close behavior.
 */
function initSettingsPanel() {
    const slider = document.getElementById('rangeSlider');
    const valueDisplay = document.getElementById('rangeValue');
    const toggleBtn = document.getElementById('settingsToggle');
    const closeBtn = document.getElementById('settingsClose');
    const panel = document.getElementById('settingsPanel');

    // Set initial slider value from config
    slider.value = CONFIG.MAX_DISTANCE_KM;
    valueDisplay.textContent = CONFIG.MAX_DISTANCE_KM;

    // Range slider change handler
    slider.addEventListener('input', (e) => {
        const value = parseInt(e.target.value, 10);
        valueDisplay.textContent = value;
        CONFIG.MAX_DISTANCE_KM = value;
        saveRangeToStorage(value);
        resetSettingsIdleTimeout();
    });

    // Toggle button (the gear icon)
    toggleBtn.addEventListener('click', () => {
        toggleSettings();
    });

    // Close button (the X)
    closeBtn.addEventListener('click', () => {
        closeSettings();
    });

    // Click outside to close
    document.addEventListener('click', (e) => {
        if (isSettingsOpen &&
            !panel.contains(e.target) &&
            !toggleBtn.contains(e.target)) {
            closeSettings();
        }
    });

    // Keep panel open while mouse is inside
    panel.addEventListener('mouseenter', () => {
        clearTimeout(settingsIdleTimeout);
    });

    // Start idle timer when mouse leaves
    panel.addEventListener('mouseleave', () => {
        if (isSettingsOpen) {
            resetSettingsIdleTimeout();
        }
    });
}

/**
 * Toggles the settings panel open/closed.
 */
function toggleSettings() {
    if (isSettingsOpen) {
        closeSettings();
    } else {
        openSettings();
    }
}

/**
 * Opens the settings panel.
 */
function openSettings() {
    const panel = document.getElementById('settingsPanel');
    panel.classList.add('open');
    isSettingsOpen = true;
    resetSettingsIdleTimeout();
}

/**
 * Closes the settings panel.
 */
function closeSettings() {
    const panel = document.getElementById('settingsPanel');
    panel.classList.remove('open');
    isSettingsOpen = false;
    clearTimeout(settingsIdleTimeout);
}

/**
 * Resets the settings idle timeout.
 * Auto-closes settings after a period of inactivity.
 */
function resetSettingsIdleTimeout() {
    clearTimeout(settingsIdleTimeout);
    settingsIdleTimeout = setTimeout(() => {
        closeSettings();
    }, CONFIG.SETTINGS_IDLE_TIMEOUT_MS);
}

/**
 * Handles mouse activity to show/hide the settings button.
 * The button fades in when you move the mouse, fades out when idle.
 */
function handleMouseActivity() {
    const toggleBtn = document.getElementById('settingsToggle');
    toggleBtn.classList.add('visible');

    // Hide button after 2 seconds of no mouse activity
    clearTimeout(window.buttonIdleTimeout);
    window.buttonIdleTimeout = setTimeout(() => {
        if (!isSettingsOpen) {
            toggleBtn.classList.remove('visible');
        }
    }, 2000);
}

// =============================================================================
//  KEYBOARD SHORTCUTS
//  (For the power users who hate touching their mouse)
// =============================================================================

/**
 * Keyboard shortcut handler.
 *
 * Shortcuts:
 *   F - Toggle fullscreen (the ultimate immersion)
 *   S - Toggle settings panel
 *   M - Go to map view
 *   Escape - Close settings or exit fullscreen
 */
document.addEventListener('keydown', (event) => {
    switch (event.key) {
        case 'f':
        case 'F':
            // Toggle fullscreen - for maximum plane watching immersion
            if (!document.fullscreenElement) {
                document.documentElement.requestFullscreen();
            } else {
                document.exitFullscreen();
            }
            break;

        case 'Escape':
            // Escape key - the universal "get me out of here"
            if (isSettingsOpen) {
                closeSettings();
            } else if (document.fullscreenElement) {
                document.exitFullscreen();
            }
            break;

        case 's':
        case 'S':
            // Quick settings access
            toggleSettings();
            break;

        case 'm':
        case 'M':
            // Back to the map view
            window.location.href = '/';
            break;
    }
});
