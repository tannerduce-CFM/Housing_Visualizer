// ==================== CONFIGURATION ====================
// Paste your Mapbox Access Token between the quotes below (e.g. "pk.eyJ1Ijo...")
const MAPBOX_ACCESS_TOKEN = "pk.eyJ1IjoiY2ZtLW1hcCIsImEiOiJjbXZkMG04NWQwOTBzMndvcTQ0cjhiNjlvIn0.Z8A60hdQgmPgvdnP_Ry0fw";
// =======================================================

// Global Application State
let appData = {
    houses: null,
    boundaries: null,
    mapping: null
};

let localAddressCache = {};
let map = null;
let houseMarkersLayer = null;
let boundaryLayersGroup = null;
let houseLayerMap = {}; // Maps house id to Leaflet Marker
let boundaryLayerMap = {}; // Maps boundary name to Leaflet Polygon

// Detailed City/Zone Coordinates Fallback Map
const zoneCoordinates = {
    'f': [36.7468, -119.7726],        // Fresno Center
    'fe': [36.7550, -119.7000],       // Fresno East
    'fn': [36.8400, -119.7800],       // Fresno North
    'fw': [36.7600, -119.8300],       // Fresno West
    'm': [37.3022, -120.4830],        // Merced
    'ma': [36.9613, -120.0607],       // Madera
    'h': [36.3275, -119.6457],        // Hanford
    'r': [36.5963, -119.4504],        // Reedley
    'v': [36.3302, -119.2921],        // Visalia
    'p': [36.0652, -119.0168],        // Porterville
    'clovis': [36.8252, -119.7029],   // Clovis
    'chowchilla': [37.1230, -120.2602], // Chowchilla
    'sanger': [36.7080, -119.5560],   // Sanger
    'mariposa': [37.4850, -119.9660], // Mariposa
    'los banos': [37.0583, -120.8500],// Los Banos
    'corcoran': [36.0980, -119.5590], // Corcoran
    'selma': [36.5708, -119.6120],    // Selma
    'kerman': [36.7236, -120.0599],   // Kerman
    'lemoore': [36.3008, -119.7829]   // Lemoore
};

// On Page Load: Load local addresses_cache.json and default wards_base.geojson
window.addEventListener('DOMContentLoaded', async () => {
    try {
        const response = await fetch('addresses_cache.json');
        if (response.ok) {
            localAddressCache = await response.json();
            console.log(`Loaded ${Object.keys(localAddressCache).length} cached addresses locally.`);
        }
    } catch (err) {
        console.warn('addresses_cache.json not found or empty. Falling back to API geocoding.');
    }
    fetchBaseBoundaryFile('wards_base.geojson');
});

// Helper to extract bracketed unit numbers, e.g. "Echo (Spanish) (181528)" -> "181528"
function extractUnitNumber(str) {
    if (!str) return null;
    const match = String(str).match(/\((\d+)\)/);
    return match ? match[1] : null;
}

// Robust matching helper comparing unit numbers first, then fallback to substring
function isUnitMatch(unitA, unitB) {
    if (!unitA || !unitB) return false;

    const numA = extractUnitNumber(unitA);
    const numB = extractUnitNumber(unitB);

    if (numA && numB) {
        return numA === numB;
    }

    const aLower = String(unitA).toLowerCase();
    const bLower = String(unitB).toLowerCase();
    return aLower.includes(bLower) || bLower.includes(aLower);
}

// Clean street address strings for maximum geocoding match rate
function cleanStreetAddressForGeocoding(street, cityState) {
    let s = String(street || '').trim();
    let c = String(cityState || '').trim();

    s = s.replace(/#\s*\S+/gi, '')
         .replace(/\b(apt|apartment|suite|ste|unit)\b\s*\S+/gi, '')
         .replace(/\d+(st|nd|rd|th)?\s*floor.*/gi, '')
         .replace(/access from.*/gi, '')
         .replace(/\r?\n|\r/g, ' ')
         .trim();

    if (!c) c = 'California';

    return `${s}, ${c}`;
}

// Smart Geocoding with Local Cache First
async function geocodeHouseAddresses(houses) {
    let cachedHitCount = 0;
    const unmappedHouses = [];

    // 1. Check localAddressCache FIRST before making any network calls
    houses.forEach(house => {
        if (house.isGeocoded) return;

        const rawAddress = house.address ? house.address.trim() : '';
        const cleanQuery = house.streetQuery ? house.streetQuery.trim() : '';

        if (localAddressCache[rawAddress]) {
            house.lat = localAddressCache[rawAddress].lat;
            house.lng = localAddressCache[rawAddress].lng;
            house.isGeocoded = true;
            cachedHitCount++;
        } else if (localAddressCache[cleanQuery]) {
            house.lat = localAddressCache[cleanQuery].lat;
            house.lng = localAddressCache[cleanQuery].lng;
            house.isGeocoded = true;
            cachedHitCount++;
        } else {
            unmappedHouses.push(house);
        }
    });

    if (cachedHitCount > 0) {
        showToast(`Loaded ${cachedHitCount} house location(s) directly from addresses_cache.json!`, "success");
    }

    // If all houses were in local cache, update textarea and return with ZERO API requests!
    if (unmappedHouses.length === 0) {
        document.getElementById('house-json-input').value = JSON.stringify(houses, null, 2);
        return;
    }

    // 2. Fallback to API Geocoding for unmapped addresses
    if (MAPBOX_ACCESS_TOKEN && MAPBOX_ACCESS_TOKEN !== "PASTE_YOUR_MAPBOX_TOKEN_HERE") {
        await geocodeHouseAddressesMapbox(unmappedHouses, houses);
    } else {
        await geocodeHouseAddressesNominatim(unmappedHouses, houses);
    }
}

async function geocodeHouseAddressesMapbox(unmappedHouses, fullHouseList) {
    const progressContainer = document.getElementById('geocoding-progress-container');
    const progressText = document.getElementById('geocoding-progress-text');
    const progressBar = document.getElementById('geocoding-progress-bar');
    const progressLabel = document.getElementById('geocoding-progress-label');

    progressContainer.classList.remove('hidden');

    let completed = 0;
    let geocodedCount = 0;
    const total = unmappedHouses.length;
    const bbox = "-121.2,35.5,-118.5,37.8";
    const proximity = "-119.77,36.74";

    for (let house of unmappedHouses) {
        completed++;
        progressText.innerText = `${completed} / ${total}`;
        progressBar.style.width = `${Math.round((completed / total) * 100)}%`;
        progressLabel.innerText = `Mapbox Geocoding: ${house.name || 'House'}`;

        try {
            const query = encodeURIComponent(house.streetQuery);
            const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${query}.json?access_token=${MAPBOX_ACCESS_TOKEN}&country=US&bbox=${bbox}&proximity=${proximity}&limit=1`;
            
            const response = await fetch(url);
            const data = await response.json();

            if (data && data.features && data.features.length > 0) {
                const [lng, lat] = data.features[0].center;
                house.lat = lat;
                house.lng = lng;
                house.isGeocoded = true;
                geocodedCount++;

                localAddressCache[house.address] = { lat: house.lat, lng: house.lng };

                if (map && houseLayerMap[house.id]) {
                    houseLayerMap[house.id].setLatLng([lat, lng]);
                }
            }
        } catch (err) {
            console.warn(`Mapbox Geocoding failed for ${house.address}:`, err);
        }

        await new Promise(resolve => setTimeout(resolve, 100));
    }

    document.getElementById('house-json-input').value = JSON.stringify(fullHouseList, null, 2);

    setTimeout(() => {
        progressContainer.classList.add('hidden');
        showToast(`Finished Mapbox Geocoding! Resolved ${geocodedCount} house(s).`, "success");
    }, 500);
}

async function geocodeHouseAddressesNominatim(unmappedHouses, fullHouseList) {
    const progressContainer = document.getElementById('geocoding-progress-container');
    const progressText = document.getElementById('geocoding-progress-text');
    const progressBar = document.getElementById('geocoding-progress-bar');
    const progressLabel = document.getElementById('geocoding-progress-label');

    progressContainer.classList.remove('hidden');

    let completed = 0;
    let geocodedCount = 0;
    const total = unmappedHouses.length;
    const viewboxParam = '&countrycodes=us&viewbox=-121.2,37.8,-118.5,35.5&bounded=1';

    for (let house of unmappedHouses) {
        completed++;
        progressText.innerText = `${completed} / ${total}`;
        progressBar.style.width = `${Math.round((completed / total) * 100)}%`;
        progressLabel.innerText = `API Geocoding: ${house.name || 'House'}`;

        try {
            const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(house.streetQuery)}${viewboxParam}`;
            const response = await fetch(url);
            const results = await response.json();

            if (results && results.length > 0) {
                house.lat = parseFloat(results[0].lat);
                house.lng = parseFloat(results[0].lon);
                house.isGeocoded = true;
                geocodedCount++;

                localAddressCache[house.address] = { lat: house.lat, lng: house.lng };

                if (map && houseLayerMap[house.id]) {
                    houseLayerMap[house.id].setLatLng([house.lat, house.lng]);
                }
            }
        } catch (err) {
            console.warn(`Nominatim geocoding skipped for ${house.address}:`, err);
        }

        await new Promise(resolve => setTimeout(resolve, 1100));
    }

    document.getElementById('house-json-input').value = JSON.stringify(fullHouseList, null, 2);

    setTimeout(() => {
        progressContainer.classList.add('hidden');
        showToast(`Finished geocoding! Placed ${geocodedCount} house(s) in Central CA.`, "success");
    }, 800);
}

// Mock Data definitions
const mockHouses = [
    {
        id: "house-1",
        address: "742 E Olive Ave (Tower District), Fresno, CA",
        zone: "F",
        lat: 36.7410,
        lng: -119.8000,
        capacity: 4,
        companionships: ["Echo Ward 1.1"],
        cost: "$1,500.00",
        bedrooms: "2",
        bathrooms: "2"
    },
    {
        id: "house-2",
        address: "1250 E Shepherd Ave (Northern Clovis), Clovis, CA",
        zone: "FN",
        lat: 36.8535,
        lng: -119.7020,
        capacity: 4,
        companionships: ["Sierra Vista 1.1"],
        cost: "$1,500.00",
        bedrooms: "2",
        bathrooms: "2"
    }
];

const mockBoundaries = {
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "properties": {
                "name": "Echo Ward (181528)"
            },
            "geometry": {
                "type": "Polygon",
                "coordinates": [
                    [
                        [-119.8150, 36.7500],
                        [-119.7850, 36.7500],
                        [-119.7850, 36.7320],
                        [-119.8150, 36.7320],
                        [-119.8150, 36.7500]
                    ]
                ]
            }
        },
        {
            "type": "Feature",
            "properties": {
                "name": "Sierra Vista Ward (21504)"
            },
            "geometry": {
                "type": "Polygon",
                "coordinates": [
                    [
                        [-119.7300, 36.8700],
                        [-119.6700, 36.8700],
                        [-119.6700, 36.8350],
                        [-119.7300, 36.8350],
                        [-119.7300, 36.8700]
                    ]
                ]
            }
        }
    ]
};

const mockMapping = {
    "Echo Ward 1.1": ["Echo (Spanish) (181528)"],
    "Sierra Vista 1.1": ["Sierra Vista (21504)"]
};

function handleBaseBoundarySelect(val) {
    if (val === 'custom_upload') {
        document.getElementById('boundary-json-input').value = '';
        document.getElementById('boundary-status').innerText = "Status: Awaiting custom file upload";
        document.getElementById('boundary-icon-status').className = "fa-solid fa-circle-check text-slate-300";
    } else {
        fetchBaseBoundaryFile(val);
    }
}

async function fetchBaseBoundaryFile(filename) {
    try {
        const response = await fetch(filename);
        if (!response.ok) throw new Error(`HTTP error ${response.status}`);
        const data = await response.json();
        
        appData.boundaries = data;
        document.getElementById('boundary-json-input').value = JSON.stringify(data, null, 2);
        document.getElementById('boundary-status').innerText = `Status: Loaded (${filename})`;
        document.getElementById('boundary-icon-status').className = "fa-solid fa-circle-check text-emerald-500";
    } catch (err) {
        console.warn(`Could not auto-load ${filename}. Waiting for manual upload.`, err);
        document.getElementById('boundary-status').innerText = "Status: Upload boundary file or paste JSON";
        document.getElementById('boundary-icon-status').className = "fa-solid fa-circle-check text-slate-300";
    }
}

function loadMockData() {
    appData.houses = mockHouses;
    appData.boundaries = mockBoundaries;
    appData.mapping = mockMapping;

    document.getElementById('house-json-input').value = JSON.stringify(mockHouses, null, 2);
    document.getElementById('boundary-json-input').value = JSON.stringify(mockBoundaries, null, 2);
    document.getElementById('mapping-json-input').value = JSON.stringify(mockMapping, null, 2);

    updateStatusIndicators();
    showToast("Mock data successfully loaded!", "success");
}

function downloadMockFiles() {
    downloadJSON(mockHouses, "houses_template.json");
    setTimeout(() => downloadJSON(mockBoundaries, "boundaries_template.geojson"), 300);
    setTimeout(() => downloadJSON(mockMapping, "companionship_mapping_template.json"), 600);
    showToast("Downloaded sample configuration files!", "info");
}

function downloadJSON(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function handleFileUpload(event, type) {
    const file = event.target.files[0];
    if (!file) return;

    const filename = file.name.toLowerCase();
    const reader = new FileReader();

    if (filename.endsWith('.xlsx') || filename.endsWith('.xls')) {
        reader.onload = function(e) {
            try {
                const data = new Uint8Array(e.target.result);
                const workbook = XLSX.read(data, { type: 'array' });
                processExcelWorkbook(workbook, type, file.name);
            } catch (err) {
                showToast(`Error reading Excel file: ${err.message}`, "error");
                console.error(err);
            }
        };
        reader.readAsArrayBuffer(file);
    } else if (filename.endsWith('.csv')) {
        reader.onload = function(e) {
            try {
                const text = e.target.result;
                const workbook = XLSX.read(text, { type: 'string' });
                processExcelWorkbook(workbook, type, file.name);
            } catch (err) {
                showToast(`Error reading CSV file: ${err.message}`, "error");
                console.error(err);
            }
        };
        reader.readAsText(file);
    } else {
        reader.onload = function(e) {
            try {
                const content = e.target.result;
                if (type === 'houses') {
                    document.getElementById('house-json-input').value = content;
                } else if (type === 'boundaries') {
                    document.getElementById('boundary-json-input').value = content;
                    appData.boundaries = JSON.parse(content);
                    document.getElementById('base-boundary-select').value = 'custom_upload';
                } else if (type === 'mapping') {
                    document.getElementById('mapping-json-input').value = content;
                }
                updateStatusIndicators();
                showToast(`Loaded ${file.name}`, "success");
            } catch (err) {
                showToast(`Error parsing file: ${err.message}`, "error");
            }
        };
        reader.readAsText(file);
    }
}

function parseBedsBaths(rawStr) {
    if (!rawStr) return { bedrooms: "-", bathrooms: "-" };
    const text = String(rawStr).trim();

    const matchPlus = text.match(/(\d+(?:\.\d+)?)\s*\+\s*(\d+(?:\.\d+)?)/);
    if (matchPlus) {
        return { bedrooms: matchPlus[1], bathrooms: matchPlus[2] };
    }

    let beds = "-";
    const matchBed = text.match(/(\d+)\s*bed[s]?/i);
    if (matchBed) beds = matchBed[1];

    let baths = "-";
    if (/half\s*bath/i.test(text)) {
        baths = "1.5";
    } else {
        const matchBath = text.match(/(\d+(?:\.\d+)?)\s*bath/i);
        if (matchBath) baths = matchBath[1];
    }

    return { bedrooms: beds, bathrooms: baths };
}

function formatRent(rawRent) {
    if (!rawRent) return "N/A";
    const str = String(rawRent).trim();
    if (str.startsWith('$')) return str;
    const num = str.replace(/[^\d.]/g, '');
    return num ? `$${num}` : str;
}

function processExcelWorkbook(workbook, uploadType, filename) {
    try {
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const rawRows = XLSX.utils.sheet_to_json(worksheet, { defval: "" });

        if (!rawRows || rawRows.length === 0) {
            showToast(`The sheet "${sheetName}" contains no rows.`, "info");
            return;
        }

        const { houses, mappings, warnings } = parseRosterSpreadsheet(rawRows);

        if (houses.length > 0) {
            document.getElementById('house-json-input').value = JSON.stringify(houses, null, 2);
            appData.houses = houses;
            geocodeHouseAddresses(houses);
        }
        if (Object.keys(mappings).length > 0) {
            document.getElementById('mapping-json-input').value = JSON.stringify(mappings, null, 2);
            appData.mapping = mappings;
        }

        updateStatusIndicators();
        showToast(`Loaded "${filename}": ${houses.length} houses processed.`, "success");

    } catch (err) {
        console.error("Spreadsheet Parsing Error:", err);
        showToast(`Unable to parse Excel file: ${err.message}`, "error");
    }
}

function parseRosterSpreadsheet(rows) {
    const housesMap = {};
    const mappingsMap = {};
    const warnings = [];

    function getRowVal(row, candidates) {
        const rowKeys = Object.keys(row);
        for (let cand of candidates) {
            const matchKey = rowKeys.find(k => String(k).trim().toLowerCase().includes(cand.toLowerCase()));
            if (matchKey && row[matchKey] !== undefined && row[matchKey] !== null) {
                const val = String(row[matchKey]).trim();
                if (val !== "") return val;
            }
        }
        return "";
    }

    rows.forEach((row, idx) => {
        try {
            const houseName = getRowVal(row, ['house name', 'house', 'residence']);
            const status = getRowVal(row, ['status']);
            const streetAddress = getRowVal(row, ['street address', 'street', 'address']);
            const cityState = getRowVal(row, ['city, state', 'city', 'state']);
            const teachingAreas = getRowVal(row, ['teaching area', 'area', 'missionaries', 'companionship']);
            const maxCap = getRowVal(row, ['max capacity', 'capacity']);
            const rentVal = getRowVal(row, ['lease rent amount', 'rent', 'cost']);
            const bedsBathsVal = getRowVal(row, ['beds/baths', 'beds', 'baths']);
            const zoneVal = getRowVal(row, ['zone']);
            const districtVal = getRowVal(row, ['district']);
            const phoneVal = getRowVal(row, ['phone', 'contact']);
            const carVal = getRowVal(row, ['car']);
            const unitsVal = getRowVal(row, ['ecclesiastical unit', 'ecclesiastical', 'boundaries']);
            const latVal = parseFloat(getRowVal(row, ['lat', 'latitude']));
            const lngVal = parseFloat(getRowVal(row, ['lng', 'lon', 'longitude']));

            if (!teachingAreas && !houseName && !streetAddress) {
                warnings.push(`Row ${idx + 2}: Empty or unmapped row.`);
                return;
            }

            // Always use the real street address if present, otherwise fall back to house name
            const actualStreet = streetAddress || houseName;
            let fullAddress = actualStreet;
            if (streetAddress && cityState) {
                fullAddress = `${streetAddress.replace(/\r?\n|\r/g, ' ')}, ${cityState}`;
            } else if (streetAddress) {
                fullAddress = streetAddress.replace(/\r?\n|\r/g, ' ');
            }

            const { bedrooms, bathrooms } = parseBedsBaths(bedsBathsVal);

            let compList = [];
            if (teachingAreas) {
                compList = teachingAreas.split(',').map(a => a.trim()).filter(a => a.length > 0);
            }

            if (compList.length > 0 && unitsVal) {
                const unitList = unitsVal.split(',').map(u => u.trim()).filter(u => u.length > 0);
                compList.forEach(comp => {
                    if (!mappingsMap[comp]) mappingsMap[comp] = [];
                    unitList.forEach(u => {
                        if (!mappingsMap[comp].includes(u)) mappingsMap[comp].push(u);
                    });
                });
            }

            if (fullAddress) {
                const houseKey = houseName || fullAddress;
                if (!housesMap[houseKey]) {
                    let lat = !isNaN(latVal) ? latVal : null;
                    let lng = !isNaN(lngVal) ? lngVal : null;

                    if (lat === null || lng === null) {
                        const zoneKey = (zoneVal || '').toLowerCase().trim();
                        const cityKey = (cityState || '').toLowerCase().split(',')[0].trim();
                        const baseCoords = zoneCoordinates[cityKey] || zoneCoordinates[zoneKey] || [36.7800, -119.7500];
                        const offsetCount = Object.keys(housesMap).length;
                        lat = baseCoords[0] + ((offsetCount % 5) - 2) * 0.005;
                        lng = baseCoords[1] + (Math.floor(offsetCount / 5) % 5 - 2) * 0.005;
                    }

                    housesMap[houseKey] = {
                        id: `house-${Object.keys(housesMap).length + 1}`,
                        name: houseName || fullAddress,
                        address: fullAddress,
                        // Fix: Force geocoding to query streetAddress + cityState rather than "Mission Office"
                        streetQuery: cleanStreetAddressForGeocoding(streetAddress, cityState),
                        zone: zoneVal || 'Unassigned',
                        district: districtVal || '',
                        status: status || 'Open',
                        cost: formatRent(rentVal),
                        capacity: maxCap || 2,
                        bedrooms: bedrooms,
                        bathrooms: bathrooms,
                        lat: lat,
                        lng: lng,
                        companionships: [],
                        phones: [],
                        car: carVal,
                        isGeocoded: !isNaN(latVal) && !isNaN(lngVal)
                    };
                }

                compList.forEach(c => {
                    if (!housesMap[houseKey].companionships.includes(c)) {
                        housesMap[houseKey].companionships.push(c);
                    }
                });
            }

        } catch (rowErr) {
            warnings.push(`Row ${idx + 2}: ${rowErr.message}`);
        }
    });

    return {
        houses: Object.values(housesMap),
        mappings: mappingsMap,
        warnings: warnings
    };
}

function updateStatusIndicators() {
    const houseVal = document.getElementById('house-json-input').value.trim();
    if (houseVal) {
        document.getElementById('house-status').innerText = "Status: Loaded";
        document.getElementById('house-icon-status').className = "fa-solid fa-circle-check text-emerald-500";
    }
    const boundVal = document.getElementById('boundary-json-input').value.trim();
    if (boundVal) {
        document.getElementById('boundary-status').innerText = "Status: Loaded";
        document.getElementById('boundary-icon-status').className = "fa-solid fa-circle-check text-emerald-500";
    }
    const mapVal = document.getElementById('mapping-json-input').value.trim();
    if (mapVal) {
        document.getElementById('mapping-status').innerText = "Status: Loaded";
        document.getElementById('mapping-icon-status').className = "fa-solid fa-circle-check text-emerald-500";
    }
}

function showToast(message, type = "info") {
    const toast = document.getElementById('toast');
    const toastMsg = document.getElementById('toast-message');
    const toastIcon = document.getElementById('toast-icon');

    toastMsg.innerText = message;
    if (type === "success") {
        toastIcon.className = "fa-solid fa-circle-check text-emerald-400";
    } else if (type === "error") {
        toastIcon.className = "fa-solid fa-triangle-exclamation text-rose-400";
    } else {
        toastIcon.className = "fa-solid fa-circle-info text-sky-400";
    }

    toast.classList.remove('translate-y-[-200%]');
    setTimeout(() => {
        toast.classList.add('translate-y-[-200%]');
    }, 4000);
}

async function launchMap() {
    try {
        const houseText = document.getElementById('house-json-input').value.trim();
        const boundText = document.getElementById('boundary-json-input').value.trim();
        const mapText = document.getElementById('mapping-json-input').value.trim();

        if (!houseText && !boundText && !mapText) {
            loadMockData();
        } else {
            appData.houses = houseText ? JSON.parse(houseText) : [];
            appData.boundaries = boundText ? JSON.parse(boundText) : { type: "FeatureCollection", features: [] };
            appData.mapping = mapText ? JSON.parse(mapText) : {};
        }
    } catch (err) {
        showToast("Error parsing input data. Please verify file content.", "error");
        console.error(err);
        return;
    }

    document.getElementById('home-view').classList.add('hidden');
    document.getElementById('map-view').classList.remove('hidden');

    setTimeout(() => {
        initLeafletMap();
    }, 100);
}

function returnToHome() {
    document.getElementById('map-view').classList.add('hidden');
    document.getElementById('home-view').classList.remove('hidden');
}

function initLeafletMap() {
    try {
        if (!map) {
            map = L.map('leaflet-map').setView([36.7800, -119.7500], 10);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 19,
                attribution: '&copy; OpenStreetMap contributors'
            }).addTo(map);
        } else {
            map.invalidateSize();
        }

        renderMapLayers();
    } catch (err) {
        console.error("Map initialization error:", err);
    }
}

function getFeatureName(feature) {
    if (!feature || !feature.properties) return "Unnamed Area";
    const p = feature.properties;
    return p.name || p.Ward || p.ward || p.unit || p.Unit || p.EcclesiasticalUnit || p.TITLE || "Unnamed Area";
}

function renderMapLayers() {
    if (boundaryLayersGroup) map.removeLayer(boundaryLayersGroup);
    if (houseMarkersLayer) map.removeLayer(houseMarkersLayer);

    boundaryLayerMap = {};
    houseLayerMap = {};

    boundaryLayersGroup = L.layerGroup();
    houseMarkersLayer = L.layerGroup();

    if (appData.boundaries && Array.isArray(appData.boundaries.features)) {
        L.geoJSON(appData.boundaries, {
            style: function(feature) {
                return {
                    color: '#6366f1',
                    weight: 2,
                    fillColor: '#818cf8',
                    fillOpacity: 0.25
                };
            },
            onEachFeature: function(feature, layer) {
                const name = getFeatureName(feature);
                boundaryLayerMap[name] = layer;

                layer.on('click', function(e) {
                    L.DomEvent.stopPropagation(e);
                    highlightBoundary(name);
                });

                layer.bindTooltip(`<strong>${name}</strong><br><span class="text-xs">Click to inspect ward boundary</span>`, { sticky: true });
            }
        }).addTo(boundaryLayersGroup);

        try {
            const tempGeoLayer = L.geoJSON(appData.boundaries);
            map.fitBounds(tempGeoLayer.getBounds(), { padding: [30, 30] });
        } catch (e) {}
    }

    if (appData.houses && Array.isArray(appData.houses)) {
        appData.houses.forEach(house => {
            if (house && !isNaN(house.lat) && !isNaN(house.lng)) {
                const houseIcon = L.divIcon({
                    className: 'custom-house-marker',
                    html: `<div style="background: white; border: 2px solid #4f46e5; border-radius: 50%; width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); font-size: 18px; cursor: pointer;">🏠</div>`,
                    iconSize: [36, 36],
                    iconAnchor: [18, 18]
                });

                const marker = L.marker([house.lat, house.lng], { icon: houseIcon });
                houseLayerMap[house.id] = marker;

                marker.on('click', function(e) {
                    L.DomEvent.stopPropagation(e);
                    highlightHouse(house.id);
                });

                const houseTitle = house.name || house.address || 'House Location';
                marker.bindTooltip(`<strong>${houseTitle}</strong><br><span class="text-xs">Zone: ${house.zone || 'N/A'}</span>`);
                houseMarkersLayer.addLayer(marker);
            }
        });
    }

    boundaryLayersGroup.addTo(map);
    houseMarkersLayer.addTo(map);

    document.getElementById('stat-house-count').innerText = appData.houses ? appData.houses.length : 0;
    document.getElementById('stat-boundary-count').innerText = appData.boundaries && appData.boundaries.features ? appData.boundaries.features.length : 0;
    
    let comps = new Set();
    if (appData.mapping) Object.keys(appData.mapping).forEach(c => comps.add(c));
    if (appData.houses) appData.houses.forEach(h => { if (h.companionships) h.companionships.forEach(c => comps.add(c)); });
    document.getElementById('stat-comp-count').innerText = comps.size;
}

function highlightHouse(houseId) {
    const house = appData.houses.find(h => h.id === houseId);
    if (!house) return;

    resetMapHighlighting();

    const marker = houseLayerMap[houseId];
    if (marker && house.lat && house.lng) {
        map.setView([house.lat, house.lng], 14, { animate: true });
    }

    let coveredBoundaries = new Set();
    if (house.companionships && appData.mapping) {
        house.companionships.forEach(comp => {
            const assignedAreas = appData.mapping[comp] || [];
            assignedAreas.forEach(area => coveredBoundaries.add(area));
        });
    }

    Object.keys(boundaryLayerMap).forEach(bName => {
        const bLayer = boundaryLayerMap[bName];
        let isMatch = Array.from(coveredBoundaries).some(cBound => isUnitMatch(bName, cBound));
        if (isMatch && bLayer) {
            bLayer.setStyle({
                color: '#10b981',
                fillColor: '#34d399',
                fillOpacity: 0.5,
                weight: 3
            });
        }
    });

    const panelTitle = document.getElementById('panel-title');
    const panelSubtitle = document.getElementById('panel-subtitle');
    const panelIcon = document.getElementById('panel-icon');
    const panelBody = document.getElementById('panel-body');

    panelIcon.className = "w-8 h-8 rounded-lg bg-indigo-100 text-indigo-600 flex items-center justify-center text-base";
    panelIcon.innerHTML = `<i class="fa-solid fa-house"></i>`;
    panelTitle.innerText = house.name || house.address || 'House Details';
    panelSubtitle.innerText = house.zone ? `Zone: ${house.zone}` : "House Details";

    let compsHtml = house.companionships && house.companionships.length > 0 
        ? house.companionships.map(c => `<span class="bg-indigo-50 text-indigo-700 font-semibold px-2.5 py-1 rounded-lg text-xs mr-1 inline-block mb-1">${c}</span>`).join('')
        : '<span class="text-slate-400 italic">None assigned</span>';

    let boundsHtml = coveredBoundaries.size > 0
        ? Array.from(coveredBoundaries).map(b => `<span class="bg-emerald-50 text-emerald-700 font-medium px-2.5 py-1 rounded-lg text-xs mr-1 inline-block mb-1"><i class="fa-solid fa-draw-polygon mr-1"></i>${b}</span>`).join('')
        : '<span class="text-slate-400 italic">No assigned ward coverage</span>';

    panelBody.innerHTML = `
        <div class="space-y-4">
            <div class="bg-slate-50 p-4 rounded-2xl border border-slate-100 space-y-3">
                <div class="flex justify-between items-center text-xs text-slate-500 border-b border-slate-200/60 pb-2">
                    <span>Street Address</span>
                    <strong class="text-slate-900 text-xs text-right max-w-[180px]">${house.address || 'N/A'}</strong>
                </div>
                <div class="flex justify-between items-center text-xs text-slate-500 border-b border-slate-200/60 pb-2">
                    <span>Monthly Rent</span>
                    <strong class="text-slate-900 text-sm font-semibold">${house.cost || 'N/A'}</strong>
                </div>
                <div class="flex justify-between items-center text-xs text-slate-500 border-b border-slate-200/60 pb-2">
                    <span>Bedrooms / Bathrooms</span>
                    <strong class="text-slate-900 text-sm">${house.bedrooms || '-'} Beds / ${house.bathrooms || '-'} Baths</strong>
                </div>
                <div class="flex justify-between items-center text-xs text-slate-500">
                    <span>Max Capacity</span>
                    <strong class="text-slate-900 text-sm">${house.capacity || '-'}</strong>
                </div>
            </div>

            <div>
                <h4 class="text-xs font-bold uppercase text-slate-400 mb-2">Teaching Areas / Companionships</h4>
                <div>${compsHtml}</div>
            </div>

            <div>
                <h4 class="text-xs font-bold uppercase text-slate-400 mb-2">Covered Ward Units</h4>
                <div>${boundsHtml}</div>
            </div>
        </div>
    `;
}

function highlightBoundary(areaName) {
    resetMapHighlighting();

    const bLayer = boundaryLayerMap[areaName];
    if (bLayer) {
        bLayer.setStyle({
            color: '#f59e0b',
            fillColor: '#fbbf24',
            fillOpacity: 0.5,
            weight: 3
        });
        map.fitBounds(bLayer.getBounds(), { padding: [50, 50], animate: true });
    }

    let coveringComps = new Set();

    if (appData.mapping) {
        Object.keys(appData.mapping).forEach(comp => {
            const areas = appData.mapping[comp];
            if (areas && areas.some(a => isUnitMatch(areaName, a))) {
                coveringComps.add(comp);
            }
        });
    }

    let residentHouses = [];
    if (appData.houses) {
        appData.houses.forEach(house => {
            if (house.companionships) {
                const hasDirectArea = house.companionships.some(comp => {
                    const isMatch = isUnitMatch(areaName, comp) || Array.from(coveringComps).some(c => isUnitMatch(comp, c));
                    if (isMatch) coveringComps.add(comp);
                    return isMatch;
                });

                if (hasDirectArea) {
                    residentHouses.push(house);
                }
            }
        });
    }

    const compArray = Array.from(coveringComps);

    const panelTitle = document.getElementById('panel-title');
    const panelSubtitle = document.getElementById('panel-subtitle');
    const panelIcon = document.getElementById('panel-icon');
    const panelBody = document.getElementById('panel-body');

    panelIcon.className = "w-8 h-8 rounded-lg bg-amber-100 text-amber-600 flex items-center justify-center text-base";
    panelIcon.innerHTML = `<i class="fa-solid fa-draw-polygon"></i>`;
    panelTitle.innerText = areaName;
    panelSubtitle.innerText = "Ward Boundary & Assigned Companionships";

    let compsHtml = compArray.length > 0
        ? compArray.map(c => `<span class="bg-amber-50 text-amber-700 font-semibold px-2.5 py-1 rounded-lg text-xs mr-1 inline-block mb-1"><i class="fa-solid fa-users mr-1"></i>${c}</span>`).join('')
        : '<span class="text-slate-400 italic">No companionships assigned</span>';

    let housesHtml = residentHouses.length > 0
        ? residentHouses.map(h => `
            <div onclick="highlightHouse('${h.id}')" class="p-3 bg-slate-50 hover:bg-indigo-50/50 border border-slate-200 rounded-xl cursor-pointer transition mb-2">
                <div class="font-semibold text-slate-800 text-xs flex items-center">
                    <i class="fa-solid fa-house text-indigo-600 mr-2"></i> ${h.name || h.address}
                </div>
                <div class="text-xs text-slate-500 mt-1 flex justify-between">
                    <span>Areas: ${h.companionships ? h.companionships.join(', ') : 'N/A'}</span>
                    <span class="font-medium text-indigo-600">Inspect &rarr;</span>
                </div>
            </div>
        `).join('')
        : '<span class="text-slate-400 italic">No registered houses assigned to this unit</span>';

    panelBody.innerHTML = `
        <div class="space-y-4">
            <div>
                <h4 class="text-xs font-bold uppercase text-slate-400 mb-2">Companionships Covering This Unit</h4>
                <div>${compsHtml}</div>
            </div>

            <div>
                <h4 class="text-xs font-bold uppercase text-slate-400 mb-2">Resident Houses</h4>
                <div class="space-y-2">${housesHtml}</div>
            </div>
        </div>
    `;
}

function resetMapHighlighting() {
    if (appData.boundaries && boundaryLayersGroup) {
        boundaryLayersGroup.eachLayer(layer => {
            layer.setStyle({
                color: '#6366f1',
                weight: 2,
                fillColor: '#818cf8',
                fillOpacity: 0.25
            });
        });
    }
}

function closeInfoPanel() {}

function handleSearch(query) {
    const dropdown = document.getElementById('search-results-dropdown');
    if (!query.trim()) {
        dropdown.classList.add('hidden');
        dropdown.innerHTML = '';
        return;
    }

    const q = query.toLowerCase();
    let results = [];

    if (appData.houses) {
        appData.houses.forEach(h => {
            if (
                (h.name && h.name.toLowerCase().includes(q)) ||
                (h.address && h.address.toLowerCase().includes(q)) ||
                (h.zone && h.zone.toLowerCase().includes(q)) ||
                (h.companionships && h.companionships.some(c => c.toLowerCase().includes(q)))
            ) {
                results.push({
                    type: 'house',
                    title: h.name || h.address || 'House',
                    subtitle: `House • Zone: ${h.zone || 'N/A'} • Areas: ${h.companionships ? h.companionships.join(', ') : 'None'}`,
                    id: h.id
                });
            }
        });
    }

    if (appData.boundaries && appData.boundaries.features) {
        appData.boundaries.features.forEach(f => {
            const name = getFeatureName(f);
            if (name.toLowerCase().includes(q)) {
                results.push({ type: 'boundary', title: name, subtitle: 'Ward Boundary', id: name });
            }
        });
    }

    if (results.length === 0) {
        dropdown.innerHTML = `<div class="p-3 text-xs text-slate-400 text-center">No matching results found</div>`;
        dropdown.classList.remove('hidden');
        return;
    }

    dropdown.innerHTML = results.slice(0, 10).map(r => `
        <div onclick="selectSearchResult('${r.type}', '${r.id}')" class="p-3 hover:bg-slate-50 cursor-pointer border-b border-slate-100 last:border-none">
            <div class="text-xs font-semibold text-slate-800 flex items-center">
                <i class="fa-solid ${r.type === 'house' ? 'fa-house text-indigo-600' : 'fa-draw-polygon text-amber-600'} mr-2"></i>
                ${r.title}
            </div>
            <div class="text-[11px] text-slate-400 mt-0.5 ml-5">${r.subtitle}</div>
        </div>
    `).join('');

    dropdown.classList.remove('hidden');
}

function selectSearchResult(type, id) {
    document.getElementById('search-results-dropdown').classList.add('hidden');
    document.getElementById('search-input').value = '';

    if (type === 'house') {
        highlightHouse(id);
    } else if (type === 'boundary') {
        highlightBoundary(id);
    }
}