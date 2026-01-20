/**
 * Airline logos as inline SVGs
 *
 * Maps airline ICAO codes to their logo SVGs.
 * Logos are simplified/stylized versions for display purposes.
 */

const AIRLINE_LOGOS = {
    // American Airlines - Eagle/bird shape
    'AAL': `<svg viewBox="0 0 100 60" class="airline-logo">
        <polygon points="10,30 50,10 90,30 50,50" fill="#0078D2"/>
        <polygon points="40,25 50,15 60,25 50,35" fill="#E31837"/>
        <polygon points="45,27 50,20 55,27 50,33" fill="#FFFFFF"/>
    </svg>`,

    // Delta - Triangle
    'DAL': `<svg viewBox="0 0 100 60" class="airline-logo">
        <polygon points="50,5 95,55 5,55" fill="#003366"/>
        <polygon points="50,15 80,50 20,50" fill="#E31937"/>
    </svg>`,

    // United - Globe
    'UAL': `<svg viewBox="0 0 100 60" class="airline-logo">
        <circle cx="50" cy="30" r="25" fill="#002244"/>
        <ellipse cx="50" cy="30" rx="25" ry="10" fill="none" stroke="#4FA8E0" stroke-width="2"/>
        <line x1="50" y1="5" x2="50" y2="55" stroke="#4FA8E0" stroke-width="2"/>
        <ellipse cx="50" cy="30" rx="10" ry="25" fill="none" stroke="#4FA8E0" stroke-width="2"/>
    </svg>`,

    // Southwest - Heart
    'SWA': `<svg viewBox="0 0 100 60" class="airline-logo">
        <path d="M50,55 C20,30 20,10 35,10 C45,10 50,20 50,20 C50,20 55,10 65,10 C80,10 80,30 50,55" fill="#FFBF27"/>
        <path d="M50,50 C25,30 25,15 37,15 C45,15 50,22 50,22 C50,22 55,15 63,15 C75,15 75,30 50,50" fill="#304CB2"/>
        <path d="M50,45 C30,30 30,18 40,18 C46,18 50,24 50,24 C50,24 54,18 60,18 C70,18 70,30 50,45" fill="#E31937"/>
    </svg>`,

    // JetBlue - Stylized J
    'JBU': `<svg viewBox="0 0 100 60" class="airline-logo">
        <rect x="20" y="10" width="60" height="40" rx="5" fill="#003876"/>
        <text x="50" y="42" font-family="Arial Black" font-size="32" fill="#FFFFFF" text-anchor="middle">B6</text>
    </svg>`,

    // Alaska - Eskimo face
    'ASA': `<svg viewBox="0 0 100 60" class="airline-logo">
        <circle cx="50" cy="30" r="25" fill="#01426A"/>
        <circle cx="50" cy="28" r="15" fill="#FFFFFF"/>
        <circle cx="45" cy="25" r="3" fill="#01426A"/>
        <circle cx="55" cy="25" r="3" fill="#01426A"/>
        <path d="M42,33 Q50,40 58,33" fill="none" stroke="#01426A" stroke-width="2"/>
    </svg>`,

    // Frontier - Animals
    'FFT': `<svg viewBox="0 0 100 60" class="airline-logo">
        <rect x="15" y="10" width="70" height="40" rx="5" fill="#00A651"/>
        <text x="50" y="40" font-family="Arial" font-size="24" fill="#FFFFFF" text-anchor="middle">F9</text>
    </svg>`,

    // Spirit - Yellow
    'NKS': `<svg viewBox="0 0 100 60" class="airline-logo">
        <rect x="15" y="10" width="70" height="40" rx="5" fill="#FFDD00"/>
        <text x="50" y="40" font-family="Arial Black" font-size="22" fill="#000000" text-anchor="middle">NK</text>
    </svg>`,

    // Air Canada - Maple leaf
    'ACA': `<svg viewBox="0 0 100 60" class="airline-logo">
        <circle cx="50" cy="30" r="25" fill="#F01428"/>
        <path d="M50,10 L53,22 L65,22 L55,30 L60,42 L50,35 L40,42 L45,30 L35,22 L47,22 Z" fill="#FFFFFF"/>
    </svg>`,

    // Jazz Aviation (Air Canada Express)
    'JZA': `<svg viewBox="0 0 100 60" class="airline-logo">
        <rect x="10" y="15" width="80" height="30" rx="4" fill="#1a1a2e"/>
        <text x="50" y="38" font-family="Arial" font-size="18" fill="#F01428" text-anchor="middle" font-weight="bold">JAZZ</text>
    </svg>`,

    // Republic Airways
    'RPA': `<svg viewBox="0 0 100 60" class="airline-logo">
        <rect x="10" y="12" width="80" height="36" rx="4" fill="#003366"/>
        <text x="50" y="37" font-family="Arial" font-size="16" fill="#FFFFFF" text-anchor="middle" font-weight="bold">REPUBLIC</text>
    </svg>`,

    // Porter Airlines
    'POE': `<svg viewBox="0 0 100 60" class="airline-logo">
        <rect x="10" y="12" width="80" height="36" rx="4" fill="#1C3A5F"/>
        <text x="50" y="37" font-family="Georgia" font-size="18" fill="#FFFFFF" text-anchor="middle">Porter</text>
    </svg>`,

    // Flair Airlines
    'FLE': `<svg viewBox="0 0 100 60" class="airline-logo">
        <rect x="10" y="12" width="80" height="36" rx="4" fill="#7CB82F"/>
        <text x="50" y="37" font-family="Arial Black" font-size="18" fill="#FFFFFF" text-anchor="middle">flair</text>
    </svg>`,

    // Sunwing
    'SWG': `<svg viewBox="0 0 100 60" class="airline-logo">
        <rect x="10" y="12" width="80" height="36" rx="4" fill="#00AEEF"/>
        <circle cx="30" cy="30" r="12" fill="#FFD200"/>
        <text x="62" y="35" font-family="Arial" font-size="14" fill="#FFFFFF" text-anchor="middle">Sunwing</text>
    </svg>`,

    // British Airways - Ribbon
    'BAW': `<svg viewBox="0 0 100 60" class="airline-logo">
        <rect x="10" y="20" width="80" height="20" fill="#2E5C99"/>
        <rect x="10" y="20" width="26" height="20" fill="#EB2226"/>
        <rect x="36" y="20" width="14" height="20" fill="#FFFFFF"/>
    </svg>`,

    // Lufthansa - Crane
    'DLH': `<svg viewBox="0 0 100 60" class="airline-logo">
        <circle cx="50" cy="30" r="25" fill="#05164D"/>
        <circle cx="50" cy="30" r="22" fill="none" stroke="#F0C000" stroke-width="3"/>
        <path d="M35,35 L50,20 L65,35 L50,25 Z" fill="#F0C000"/>
    </svg>`,

    // Air France - Swirl
    'AFR': `<svg viewBox="0 0 100 60" class="airline-logo">
        <rect x="15" y="15" width="70" height="30" fill="#002157"/>
        <path d="M25,30 Q50,10 75,30 Q50,50 25,30" fill="#ED1C24"/>
    </svg>`,

    // KLM - Crown
    'KLM': `<svg viewBox="0 0 100 60" class="airline-logo">
        <rect x="20" y="15" width="60" height="35" fill="#00A1E4"/>
        <path d="M35,25 L50,10 L65,25" fill="none" stroke="#FFFFFF" stroke-width="3"/>
        <text x="50" y="43" font-family="Arial" font-size="18" fill="#FFFFFF" text-anchor="middle">KLM</text>
    </svg>`,

    // Emirates - Arabic text style
    'UAE': `<svg viewBox="0 0 100 60" class="airline-logo">
        <rect x="10" y="15" width="80" height="30" fill="#D71920"/>
        <text x="50" y="38" font-family="serif" font-size="20" fill="#FFFFFF" text-anchor="middle">Emirates</text>
    </svg>`,

    // FedEx - Arrow
    'FDX': `<svg viewBox="0 0 100 60" class="airline-logo">
        <text x="10" y="42" font-family="Arial Black" font-size="28" fill="#4D148C">Fed</text>
        <text x="55" y="42" font-family="Arial Black" font-size="28" fill="#FF6600">Ex</text>
    </svg>`,

    // UPS - Shield
    'UPS': `<svg viewBox="0 0 100 60" class="airline-logo">
        <path d="M50,5 L80,15 L80,40 Q80,55 50,55 Q20,55 20,40 L20,15 Z" fill="#351C15"/>
        <path d="M50,10 L75,18 L75,38 Q75,50 50,50 Q25,50 25,38 L25,18 Z" fill="#FFB500"/>
        <text x="50" y="40" font-family="Arial Black" font-size="18" fill="#351C15" text-anchor="middle">UPS</text>
    </svg>`,

    // SkyWest - Regional
    'SKW': `<svg viewBox="0 0 100 60" class="airline-logo">
        <rect x="15" y="15" width="70" height="30" rx="5" fill="#003087"/>
        <text x="50" y="38" font-family="Arial" font-size="16" fill="#FFFFFF" text-anchor="middle">SkyWest</text>
    </svg>`,

    // Default/Unknown
    'DEFAULT': `<svg viewBox="0 0 100 60" class="airline-logo">
        <rect x="20" y="15" width="60" height="30" rx="5" fill="#4A5568"/>
        <path d="M30,40 L50,20 L70,40 Z" fill="#A0AEC0"/>
    </svg>`,
};

/**
 * Get airline logo SVG by ICAO or IATA code
 */
function getAirlineLogo(code) {
    if (!code) return AIRLINE_LOGOS['DEFAULT'];

    const upperCode = code.toUpperCase();

    // Direct ICAO match
    if (AIRLINE_LOGOS[upperCode]) {
        return AIRLINE_LOGOS[upperCode];
    }

    // Try extracting from callsign (first 3 chars)
    if (upperCode.length >= 3) {
        const prefix = upperCode.substring(0, 3);
        if (AIRLINE_LOGOS[prefix]) {
            return AIRLINE_LOGOS[prefix];
        }
    }

    return AIRLINE_LOGOS['DEFAULT'];
}

/**
 * Get airline name from ICAO code
 */
function getAirlineName(code) {
    const AIRLINE_NAMES = {
        'AAL': 'American Airlines',
        'DAL': 'Delta Air Lines',
        'UAL': 'United Airlines',
        'SWA': 'Southwest Airlines',
        'JBU': 'JetBlue Airways',
        'ASA': 'Alaska Airlines',
        'FFT': 'Frontier Airlines',
        'NKS': 'Spirit Airlines',
        'ACA': 'Air Canada',
        'WJA': 'WestJet',
        'BAW': 'British Airways',
        'DLH': 'Lufthansa',
        'AFR': 'Air France',
        'KLM': 'KLM',
        'UAE': 'Emirates',
        'QFA': 'Qantas',
        'ANA': 'All Nippon Airways',
        'JAL': 'Japan Airlines',
        'CPA': 'Cathay Pacific',
        'SIA': 'Singapore Airlines',
        'SKW': 'SkyWest Airlines',
        'RPA': 'Republic Airways',
        'ENY': 'Envoy Air',
        'FDX': 'FedEx Express',
        'UPS': 'UPS Airlines',
    };

    if (!code) return 'Unknown';

    const upperCode = code.toUpperCase();

    if (AIRLINE_NAMES[upperCode]) {
        return AIRLINE_NAMES[upperCode];
    }

    // Try prefix
    if (upperCode.length >= 3) {
        const prefix = upperCode.substring(0, 3);
        if (AIRLINE_NAMES[prefix]) {
            return AIRLINE_NAMES[prefix];
        }
    }

    return null;
}
