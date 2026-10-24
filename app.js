// ==================== CONFIGURATION ====================
// Paste your Mapbox Access Token between quotes (e.g. "pk.eyJ1Ijo...")
const MAPBOX_ACCESS_TOKEN = "pk.eyJ1IjoiY2ZtLW1hcCIsImEiOiJjbXZkMG04NWQwOTBzMndvcTQ0cjhiNjlvIn0.Z8A60hdQgmPgvdnP_Ry0fw";
// =======================================================

let appData = {
    houses: null,
    boundaries: null,
    mapping: null
};

let localAddressCache = {};
let map = null;

let houseMarkersLayer = null;
let wardBoundariesGroup = null;
let areaBoundariesGroup = null;

let houseLayerMap = {};
let wardLayerMap = {};
let areaLayerMap = {};

let activeHighlightedHouseId = null;
let hoveredBoundaryLayer = null;
let toastTimeout = null;

const zoneCoordinates = {
    'f': [36.7468, -119.7726], 'fe': [36.7550, -119.7000], 'fn': [36.8400, -119.7800],
    'fw': [36.7600, -119.8300], 'm': [37.3022, -120.4830], 'ma': [36.9613, -120.0607],
    'h': [36.3275, -119.6457], 'r': [36.5963, -119.4504], 'v': [36.3302, -119.2921],
    'p': [36.0652, -119.0168], 'clovis': [36.8252, -119.7029], 'chowchilla': [37.1230, -120.2602],
    'sanger': [36.7080, -119.5560], 'mariposa': [37.4850, -119.9660], 'los banos': [37.0583, -120.8500],
    'corcoran': [36.0980, -119.5590], 'selma': [36.5708, -119.6120], 'kerman': [36.7236, -120.0599],
    'lemoore': [36.3008, -119.7829]
};

// On Page Load: Load addresses_cache.json if present
window.addEventListener('DOMContentLoaded', async () => {
    try {
        const response = await fetch('addresses_cache.json');
        if (response.ok) {
            localAddressCache = await response.json();
            console.log(`Loaded ${Object.keys(localAddressCache).length} cached addresses.`);
        }
    } catch (err) {
        console.warn('addresses_cache.json not found or empty.');
    }
});

function setupHoverTracking(layer) {
    layer.on('mouseover', function(e) { hoveredBoundaryLayer = e.target; });
    layer.on('mouseout', function() { hoveredBoundaryLayer = null; });
}

window.addEventListener('keydown', (event) => {
    if (event.key.toLowerCase() === 'l' && !['input', 'textarea'].includes(document.activeElement.tagName.toLowerCase())) {
        if (hoveredBoundaryLayer && typeof hoveredBoundaryLayer.bringToBack === 'function') {
            hoveredBoundaryLayer.bringToBack();
            showToast("Sent overlapping boundary to back", "info");
        } else {
            showToast("Hover over an overlapping boundary area and press 'L'", "info");
        }
    }
});

function extractUnitNumber(str) {
    if (!str) return null;
    const strVal = String(str).trim();
    if (/^\d+$/.test(strVal)) return strVal;
    const match = strVal.match(/\((\d+)\)/);
    return match ? match[1] : null;
}

function getFeatureUnitId(feature) {
    if (!feature || !feature.properties) return null;
    const p = feature.properties;
    if (p.id !== undefined && p.id !== null) return String(p.id).trim();
    if (p.ID !== undefined && p.ID !== null) return String(p.ID).trim();
    return extractUnitNumber(p.name || p.Name || p.Ward || p.ward);
}

function isUnitMatch(unitA, unitB, featureA = null) {
    if (!unitA || !unitB) return false;
    const idA = featureA ? getFeatureUnitId(featureA) : extractUnitNumber(unitA);
    const idB = extractUnitNumber(unitB);
    if (idA && idB) return idA === idB;
    const aLower = String(unitA).toLowerCase();
    const bLower = String(unitB).toLowerCase();
    return aLower.includes(bLower) || bLower.includes(aLower);
}

function getFeatureDisplayName(feature) {
    if (!feature || !feature.properties) return "Unnamed Area";
    const p = feature.properties;
    const name = p.name || p.Name || p.Ward || p.ward || p.unit || "Unnamed Area";
    const unitId = getFeatureUnitId(feature);
    if (unitId && !name.includes(`(${unitId})`)) {
        return `${name} (#${unitId})`;
    }
    return name;
}

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

async function geocodeHouseAddresses(houses) {
    let cachedHitCount = 0;
    const unmappedHouses = [];

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
        showToast(`Loaded ${cachedHitCount} house(s) from addresses_cache.json`, "success");
    }

    if (unmappedHouses.length === 0) {
        document.getElementById('house-json-input').value = JSON.stringify(houses, null, 2);
        return;
    }

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
        showToast(`Geocoded ${geocodedCount} house(s).`, "success");
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
        showToast(`Geocoded ${geocodedCount} house(s) in Central CA.`, "success");
    }, 800);
}

function toggleBoundaryLayer(layerType, isChecked) {
    if (!map) return;
    if (layerType === 'ward') {
        if (isChecked && wardBoundariesGroup) map.addLayer(wardBoundariesGroup);
        else if (wardBoundariesGroup) map.removeLayer(wardBoundariesGroup);
    } else if (layerType === 'area') {
        if (isChecked && areaBoundariesGroup) map.addLayer(areaBoundariesGroup);
        else if (areaBoundariesGroup) map.removeLayer(areaBoundariesGroup);
    }
}

function handleFileUpload(event, type) {
    const file = event.target.files[0];
    if (!file) return;

    const filename = file.name.toLowerCase();
    const reader = new FileReader();

    if (filename.endsWith('.xlsx') || filename.endsWith('.xls') || filename.endsWith('.csv')) {
        reader.onload = function(e) {
            try {
                let workbook;
                if (filename.endsWith('.csv')) {
                    workbook = XLSX.read(e.target.result, { type: 'string' });
                } else {
                    const data = new Uint8Array(e.target.result);
                    workbook = XLSX.read(data, { type: 'array' });
                }

                const sheetName = workbook.SheetNames[0];
                const worksheet = workbook.Sheets[sheetName];
                const rawRows = XLSX.utils.sheet_to_json(worksheet, { defval: "" });

                if (!rawRows || rawRows.length === 0) {
                    showToast(`The sheet "${sheetName}" contains no rows.`, "info");
                    return;
                }

                const parsed = parseRosterSpreadsheet(rawRows);

                if (type === 'houses') {
                    appData.houses = parsed.houses;
                    document.getElementById('house-json-input').value = JSON.stringify(parsed.houses, null, 2);
                    geocodeHouseAddresses(parsed.houses);
                    showToast(`Loaded ${parsed.houses.length} houses from ${file.name}`, "success");
                } else if (type === 'mapping') {
                    appData.mapping = parsed.mappings;
                    document.getElementById('mapping-json-input').value = JSON.stringify(parsed.mappings, null, 2);
                    showToast(`Loaded mapping for ${Object.keys(parsed.mappings).length} companionships`, "success");
                }

                updateStatusIndicators();
            } catch (err) {
                showToast(`Error reading spreadsheet: ${err.message}`, "error");
            }
        };

        if (filename.endsWith('.csv')) reader.readAsText(file);
        else reader.readAsArrayBuffer(file);

    } else {
        reader.onload = function(e) {
            try {
                const content = e.target.result;
                const parsed = JSON.parse(content);

                if (type === 'houses') {
                    appData.houses = parsed;
                    document.getElementById('house-json-input').value = content;
                } else if (type === 'boundaries') {
                    appData.boundaries = parsed;
                    document.getElementById('boundary-json-input').value = content;
                } else if (type === 'mapping') {
                    appData.mapping = parsed;
                    document.getElementById('mapping-json-input').value = content;
                }

                updateStatusIndicators();
                showToast(`Loaded ${file.name}`, "success");
            } catch (err) {
                showToast(`Error parsing JSON: ${err.message}`, "error");
            }
        };
        reader.readAsText(file);
    }
}

function parseBedsBaths(rawStr) {
    if (!rawStr) return { bedrooms: "-", bathrooms: "-" };
    const text = String(rawStr).trim();
    const matchPlus = text.match(/(\d+(?:\.\d+)?)\s*\+\s*(\d+(?:\.\d+)?)/);
    if (matchPlus) return { bedrooms: matchPlus[1], bathrooms: matchPlus[2] };

    let beds = "-";
    const matchBed = text.match(/(\d+)\s*bed[s]?/i);
    if (matchBed) beds = matchBed[1];

    let baths = "-";
    if (/half\s*bath/i.test(text)) baths = "1.5";
    else {
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

function parseRosterSpreadsheet(rows) {
    const housesMap = {};
    const mappingsMap = {};

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

        const actualStreet = streetAddress || houseName;
        let fullAddress = actualStreet;
        if (streetAddress && cityState) fullAddress = `${streetAddress.replace(/\r?\n|\r/g, ' ')}, ${cityState}`;
        else if (streetAddress) fullAddress = streetAddress.replace(/\r?\n|\r/g, ' ');

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
                    streetQuery: cleanStreetAddressForGeocoding(streetAddress, cityState),
                    zone: zoneVal ? String(zoneVal).toUpperCase().trim() : 'UNASSIGNED',
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
    });

    return {
        houses: Object.values(housesMap),
        mappings: mappingsMap
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

    if (!toast || !toastMsg || !toastIcon) return;
    if (toastTimeout) clearTimeout(toastTimeout);

    toastMsg.innerText = message;
    if (type === "success") toastIcon.className = "fa-solid fa-circle-check text-emerald-400";
    else if (type === "error") toastIcon.className = "fa-solid fa-triangle-exclamation text-rose-400";
    else toastIcon.className = "fa-solid fa-circle-info text-sky-400";

    toast.classList.remove('translate-y-[-200%]');
    toastTimeout = setTimeout(() => { toast.classList.add('translate-y-[-200%]'); }, 2500);
}

async function launchMap() {
    try {
        const houseText = document.getElementById('house-json-input').value.trim();
        const boundText = document.getElementById('boundary-json-input').value.trim();
        const mapText = document.getElementById('mapping-json-input').value.trim();

        if (!houseText && !boundText && !mapText) {
            showToast("Please upload at least one file before launching the map.", "error");
            return;
        }

        appData.houses = houseText ? JSON.parse(houseText) : [];
        appData.boundaries = boundText ? JSON.parse(boundText) : { type: "FeatureCollection", features: [] };
        appData.mapping = mapText ? JSON.parse(mapText) : {};
    } catch (err) {
        showToast("Error parsing input data. Please verify file format.", "error");
        return;
    }

    document.getElementById('home-view').classList.add('hidden');
    document.getElementById('map-view').classList.remove('hidden');

    setTimeout(() => { initLeafletMap(); }, 100);
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

// Generate house marker HTML with dynamic highlighting
function buildHouseMarkerHtml(isSelected = false) {
    if (isSelected) {
        return `
            <div class="transition-transform duration-200 transform scale-125" style="background: #fef3c7; border: 3px solid #f59e0b; border-radius: 50%; width: 38px; height: 38px; display: flex; align-items: center; justify-content: center; box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.4), 0 10px 15px -3px rgba(0,0,0,0.3); font-size: 20px; cursor: pointer;">
                🏠
            </div>
        `;
    }
    return `
        <div class="transition-transform duration-150 hover:scale-110" style="background: white; border: 2px solid #4f46e5; border-radius: 50%; width: 34px; height: 34px; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.15); font-size: 17px; cursor: pointer;">
            🏠
        </div>
    `;
}

function renderMapLayers() {
    if (wardBoundariesGroup) map.removeLayer(wardBoundariesGroup);
    if (areaBoundariesGroup) map.removeLayer(areaBoundariesGroup);
    if (houseMarkersLayer) map.removeLayer(houseMarkersLayer);

    wardLayerMap = {};
    areaLayerMap = {};
    houseLayerMap = {};

    wardBoundariesGroup = L.layerGroup();
    areaBoundariesGroup = L.layerGroup();
    houseMarkersLayer = L.layerGroup();

    if (appData.boundaries && Array.isArray(appData.boundaries.features)) {
        appData.boundaries.features.forEach(feature => {
            const displayName = getFeatureDisplayName(feature);
            const pType = (feature.properties && (feature.properties.type || feature.properties.rawType) || '').toUpperCase();

            const isWard = pType !== 'AREA';
            
            // Standard baseline styles (soft opacity so roads show through clearly)
            const layerStyle = isWard ? {
                color: '#6366f1',
                weight: 1.75,
                fillColor: '#818cf8',
                fillOpacity: 0.12
            } : {
                color: '#059669',
                weight: 2,
                dashArray: '5, 5',
                fillColor: '#10b981',
                fillOpacity: 0.12
            };

            const layer = L.geoJSON(feature, {
                style: function() { return layerStyle; },
                onEachFeature: function(feat, lyr) {
                    setupHoverTracking(lyr);
                    lyr.on('click', function(e) {
                        L.DomEvent.stopPropagation(e);
                        highlightBoundary(displayName);
                    });
                    lyr.bindTooltip(`<strong>${displayName}</strong><br><span class="text-xs">${isWard ? 'Ward Boundary' : 'Teaching Area'}</span>`, { sticky: true });
                }
            });

            if (isWard) {
                wardLayerMap[displayName] = { layer: layer, feature: feature, type: 'WARD' };
                wardBoundariesGroup.addLayer(layer);
            } else {
                areaLayerMap[displayName] = { layer: layer, feature: feature, type: 'AREA' };
                areaBoundariesGroup.addLayer(layer);
            }
        });

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
                    html: buildHouseMarkerHtml(false),
                    iconSize: [34, 34],
                    iconAnchor: [17, 17]
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

    const wardCheckbox = document.getElementById('toggle-ward-layer');
    const areaCheckbox = document.getElementById('toggle-area-layer');

    if (!wardCheckbox || wardCheckbox.checked) wardBoundariesGroup.addTo(map);
    if (!areaCheckbox || areaCheckbox.checked) areaBoundariesGroup.addTo(map);
    houseMarkersLayer.addTo(map);

    document.getElementById('stat-house-count').innerText = appData.houses ? appData.houses.length : 0;
    document.getElementById('stat-boundary-count').innerText = appData.boundaries && appData.boundaries.features ? appData.boundaries.features.length : 0;
    
    let comps = new Set();
    if (appData.mapping) Object.keys(appData.mapping).forEach(c => comps.add(c));
    if (appData.houses) appData.houses.forEach(h => { if (h.companionships) h.companionships.forEach(c => comps.add(c)); });
    document.getElementById('stat-comp-count').innerText = comps.size;
}

// Highlight House + Both Ward Boundaries & Teaching Area Boundaries
function highlightHouse(houseId) {
    const house = appData.houses.find(h => h.id === houseId);
    if (!house) return;

    resetMapHighlighting();

    // 1. Highlight the Selected House Pin with animated glow ring
    activeHighlightedHouseId = houseId;
    const activeMarker = houseLayerMap[houseId];
    if (activeMarker && house.lat && house.lng) {
        activeMarker.setIcon(L.divIcon({
            className: 'custom-house-marker',
            html: buildHouseMarkerHtml(true),
            iconSize: [38, 38],
            iconAnchor: [19, 19]
        }));
        map.setView([house.lat, house.lng], 14, { animate: true });
    }

    // 2. Identify all covered areas and wards associated with house
    let assignedTeachingAreas = new Set();
    let coveredWardUnits = new Set();

    if (house.companionships) {
        house.companionships.forEach(comp => {
            assignedTeachingAreas.add(comp);
            if (appData.mapping && appData.mapping[comp]) {
                appData.mapping[comp].forEach(ward => coveredWardUnits.add(ward));
            }
        });
    }

    // 3. Highlight Matching Ward Boundaries (Soft Indigo)
    Object.keys(wardLayerMap).forEach(wName => {
        const wObj = wardLayerMap[wName];
        let isMatch = Array.from(coveredWardUnits).some(u => isUnitMatch(wName, u, wObj.feature)) ||
                      Array.from(assignedTeachingAreas).some(a => isUnitMatch(wName, a, wObj.feature));
        
        if (isMatch && wObj && wObj.layer) {
            wObj.layer.setStyle({
                color: '#6366f1',
                fillColor: '#a5b4fc',
                fillOpacity: 0.22,
                weight: 2.5
            });
            if (typeof wObj.layer.closeTooltip === 'function') wObj.layer.closeTooltip();
        }
    });

    // 4. Highlight Matching Teaching Areas in RED
    Object.keys(areaLayerMap).forEach(aName => {
        const aObj = areaLayerMap[aName];
        let isMatch = Array.from(assignedTeachingAreas).some(a => isUnitMatch(aName, a, aObj.feature)) ||
                      Array.from(coveredWardUnits).some(u => isUnitMatch(aName, u, aObj.feature));
        
        if (isMatch && aObj && aObj.layer) {
            aObj.layer.setStyle({
                color: '#e11d48',       // Distinct Rose-Red border
                fillColor: '#f43f5e',   // Soft Red fill
                fillOpacity: 0.20,      // Light, transparent shading so roads show through
                weight: 2.5,
                dashArray: '5, 5'
            });
            if (typeof aObj.layer.closeTooltip === 'function') aObj.layer.closeTooltip();
        }
    });

    // 5. Update Sidebar Panel with cleanly divided sections
    const panelTitle = document.getElementById('panel-title');
    const panelSubtitle = document.getElementById('panel-subtitle');
    const panelIcon = document.getElementById('panel-icon');
    const panelBody = document.getElementById('panel-body');

    panelIcon.className = "w-8 h-8 rounded-lg bg-indigo-100 text-indigo-600 flex items-center justify-center text-base";
    panelIcon.innerHTML = `<i class="fa-solid fa-house"></i>`;
    panelTitle.innerText = house.name || house.address || 'House Details';
    panelSubtitle.innerText = house.zone ? `Zone: ${house.zone}` : "House Details";

    let areasHtml = assignedTeachingAreas.size > 0 
        ? Array.from(assignedTeachingAreas).map(a => `<span class="bg-rose-50 text-rose-800 border border-rose-200 font-medium px-2.5 py-1 rounded-lg text-xs mr-1 inline-block mb-1.5"><i class="fa-solid fa-users text-rose-600 mr-1.5"></i>${a}</span>`).join('')
        : '<span class="text-slate-400 italic text-xs">No teaching areas assigned</span>';

    let wardsHtml = coveredWardUnits.size > 0
        ? Array.from(coveredWardUnits).map(w => `<span class="bg-indigo-50 text-indigo-800 border border-indigo-200 font-medium px-2.5 py-1 rounded-lg text-xs mr-1 inline-block mb-1.5"><i class="fa-solid fa-draw-polygon text-indigo-500 mr-1.5"></i>${w}</span>`).join('')
        : '<span class="text-slate-400 italic text-xs">No ward boundaries mapped</span>';

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

            <!-- Teaching Areas Section (Red Tag) -->
            <div>
                <div class="flex items-center space-x-1.5 mb-2">
                    <span class="w-2.5 h-2.5 rounded-full bg-rose-500"></span>
                    <h4 class="text-xs font-bold uppercase tracking-wide text-slate-600">Assigned Teaching Areas (AREA)</h4>
                </div>
                <div>${areasHtml}</div>
            </div>

            <!-- Ward Boundaries Section -->
            <div>
                <div class="flex items-center space-x-1.5 mb-2">
                    <span class="w-2.5 h-2.5 rounded-full bg-indigo-500"></span>
                    <h4 class="text-xs font-bold uppercase tracking-wide text-slate-600">Covered Ward Units (UNIT)</h4>
                </div>
                <div>${wardsHtml}</div>
            </div>
        </div>
    `;
}

// Highlight clicked boundary (Red for AREA, Amber for WARD)
function highlightBoundary(areaDisplayName) {
    resetMapHighlighting();

    const bObj = wardLayerMap[areaDisplayName] || areaLayerMap[areaDisplayName];
    if (bObj && bObj.layer) {
        const isArea = bObj.type === 'AREA';

        bObj.layer.setStyle({
            color: isArea ? '#e11d48' : '#d97706',
            fillColor: isArea ? '#f43f5e' : '#fde68a',
            fillOpacity: 0.25,
            weight: 3,
            dashArray: isArea ? '5, 5' : null
        });
        map.fitBounds(bObj.layer.getBounds(), { padding: [50, 50], animate: true });
    }

    let coveringComps = new Set();
    if (appData.mapping) {
        Object.keys(appData.mapping).forEach(comp => {
            const areas = appData.mapping[comp];
            if (areas && areas.some(a => isUnitMatch(areaDisplayName, a, bObj ? bObj.feature : null))) {
                coveringComps.add(comp);
            }
        });
    }

    let residentHouses = [];
    if (appData.houses) {
        appData.houses.forEach(house => {
            if (house.companionships) {
                const hasDirectArea = house.companionships.some(comp => {
                    const isMatch = isUnitMatch(areaDisplayName, comp, bObj ? bObj.feature : null) || Array.from(coveringComps).some(c => isUnitMatch(comp, c));
                    if (isMatch) coveringComps.add(comp);
                    return isMatch;
                });
                if (hasDirectArea) residentHouses.push(house);
            }
        });
    }

    const compArray = Array.from(coveringComps);

    const panelTitle = document.getElementById('panel-title');
    const panelSubtitle = document.getElementById('panel-subtitle');
    const panelIcon = document.getElementById('panel-icon');
    const panelBody = document.getElementById('panel-body');

    const isArea = bObj && bObj.type === 'AREA';
    panelIcon.className = `w-8 h-8 rounded-lg ${isArea ? 'bg-rose-100 text-rose-600' : 'bg-amber-100 text-amber-600'} flex items-center justify-center text-base`;
    panelIcon.innerHTML = `<i class="fa-solid fa-draw-polygon"></i>`;
    panelTitle.innerText = areaDisplayName;
    panelSubtitle.innerText = isArea ? "Teaching Area Boundary" : "Ward Unit Boundary";

    let compsHtml = compArray.length > 0
        ? compArray.map(c => `<span class="${isArea ? 'bg-rose-50 text-rose-800 border border-rose-200' : 'bg-amber-50 text-amber-700'} font-semibold px-2.5 py-1 rounded-lg text-xs mr-1 inline-block mb-1"><i class="fa-solid fa-users mr-1"></i>${c}</span>`).join('')
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
        : '<span class="text-slate-400 italic">No registered houses assigned to this area</span>';

    panelBody.innerHTML = `
        <div class="space-y-4">
            <div>
                <h4 class="text-xs font-bold uppercase text-slate-400 mb-2">Companionships Covering This Area</h4>
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
    // 1. Reset all house marker icons back to standard
    if (activeHighlightedHouseId && houseLayerMap[activeHighlightedHouseId]) {
        houseLayerMap[activeHighlightedHouseId].setIcon(L.divIcon({
            className: 'custom-house-marker',
            html: buildHouseMarkerHtml(false),
            iconSize: [34, 34],
            iconAnchor: [17, 17]
        }));
        activeHighlightedHouseId = null;
    }

    // 2. Reset Ward baseline styles
    Object.keys(wardLayerMap).forEach(name => {
        const bObj = wardLayerMap[name];
        if (bObj && bObj.layer) {
            bObj.layer.setStyle({
                color: '#6366f1',
                weight: 1.75,
                fillColor: '#818cf8',
                fillOpacity: 0.12
            });
            if (typeof bObj.layer.closeTooltip === 'function') bObj.layer.closeTooltip();
        }
    });

    // 3. Reset Area baseline styles
    Object.keys(areaLayerMap).forEach(name => {
        const bObj = areaLayerMap[name];
        if (bObj && bObj.layer) {
            bObj.layer.setStyle({
                color: '#059669',
                weight: 2,
                dashArray: '5, 5',
                fillColor: '#10b981',
                fillOpacity: 0.12
            });
            if (typeof bObj.layer.closeTooltip === 'function') bObj.layer.closeTooltip();
        }
    });
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
            const name = getFeatureDisplayName(f);
            if (name.toLowerCase().includes(q)) {
                const isWard = ((f.properties && f.properties.type) || '').toUpperCase() !== 'AREA';
                results.push({
                    type: 'boundary',
                    title: name,
                    subtitle: isWard ? 'Ward Unit Boundary' : 'Teaching Area Boundary',
                    id: name
                });
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

    if (type === 'house') highlightHouse(id);
    else if (type === 'boundary') highlightBoundary(id);
}