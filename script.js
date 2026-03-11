const weatherForm = document.getElementById('weather-form');
const btnLocate = document.getElementById('btn-locate');
const fileImport = document.getElementById('file-import');
const dashboard = document.getElementById('dashboard');
const loading = document.getElementById('loading');
const errorMessage = document.getElementById('error-message');
const locationNameEl = document.getElementById('location-name');

// Map Setup
let map;
let marker;
let polygonLayer; // To display imported areas
let stationsLayer; // Layer group for weather stations
let isPickerActive = false;

// Global Chart Instances to destroy before re-rendering
let mainChartInst = null;
let precipMonthlyChartInst = null;
let tempMonthlyChartInst = null;
let currentChartData = null; 
let allSourcesData = { 'open-meteo': null, 'dwd': null };
let fixedScales = null; // Store chart scales based on Open-Meteo
let lastBaseLocationName = ""; 

// Initialization: Set default dates (last 30 days)
document.addEventListener('DOMContentLoaded', () => {
    // Register Service Worker for PWA
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('./service-worker.js')
                .then(registration => console.log('ServiceWorker registered with scope:', registration.scope))
                .catch(error => console.log('ServiceWorker registration failed:', error));
        });
    }

    const today = new Date();
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(today.getDate() - 30);

    document.getElementById('end-date').value = today.toISOString().split('T')[0];
    document.getElementById('start-date').value = thirtyDaysAgo.toISOString().split('T')[0];

    // Setup Season Buttons
    const currentYear = today.getFullYear();
    const prevYear = currentYear - 1;
    
    const btnSeasonPrev = document.getElementById('btn-season-prev');
    const btnSeasonCurr = document.getElementById('btn-season-curr');
    
    btnSeasonPrev.innerText = `Saison ${prevYear}`;
    btnSeasonCurr.innerText = `Saison ${currentYear}`;
    
    btnSeasonPrev.addEventListener('click', () => {
        document.getElementById('start-date').value = `${prevYear}-01-01`;
        document.getElementById('end-date').value = `${prevYear}-12-31`;
    });
    
    btnSeasonCurr.addEventListener('click', () => {
        const today = new Date();
        const twoDaysAgo = new Date();
        twoDaysAgo.setDate(today.getDate() - 2); // Open-Meteo Archive has ~2 days delay
        
        document.getElementById('start-date').value = `${currentYear}-01-01`;
        document.getElementById('end-date').value = twoDaysAgo.toISOString().split('T')[0];
    });

    // Initialize map
    initMap();
    
    // Bind checkbox events for chart
    const checkboxes = document.querySelectorAll('.checkbox-group input[type="checkbox"]');
    checkboxes.forEach(cb => {
        cb.addEventListener('change', updateChartVisibility);
    });

    // Bind file import event
    fileImport.addEventListener('change', handleFileImport);

    // Bind station toggle
    document.getElementById('toggle-stations').addEventListener('change', toggleWeatherStations);

    // Bind Zoom Sliders
    document.getElementById('zoom-slider-start').addEventListener('input', updateChartZoom);
    document.getElementById('zoom-slider-end').addEventListener('input', updateChartZoom);
    document.getElementById('btn-reset-zoom').addEventListener('click', resetChartZoom);
    document.getElementById('btn-export-csv').addEventListener('click', exportToCSV);

    // Bind Source Switcher (Live Update)
    const sourceRadios = document.querySelectorAll('input[name="weather-source"]');
    sourceRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            if (allSourcesData[e.target.value]) {
                renderDashboard(allSourcesData[e.target.value]);
                updateStationInHeader(e.target.value);
            }
        });
    });
});

function initMap() {
    // Default center (e.g., Berlin)
    map = L.map('map').setView([52.52, 13.40], 5);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    // Add Scale
    L.control.scale({ imperial: false, metric: true }).addTo(map);

    // Add Measurement Tool
    const measureControl = new L.Control.Measure({
        primaryLengthUnit: 'meters',
        secondaryLengthUnit: 'kilometers',
        primaryAreaUnit: 'sqmeters',
        secondaryAreaUnit: 'hectares',
        activeColor: '#2c7a7b',
        completedColor: '#319795',
        localization: 'de',
        popupOptions: {
            autoPan: false,
            closeButton: false
        }
    });
    measureControl.addTo(map);

    stationsLayer = L.layerGroup().addTo(map);

    // Add Custom Location Picker Button
    const PickerControl = L.Control.extend({
        options: { position: 'topleft' },
        onAdd: function() {
            const btn = L.DomUtil.create('a', 'location-picker-btn leaflet-bar');
            btn.innerHTML = '📍';
            btn.href = '#';
            btn.title = 'Standort für Wetterdaten festlegen';
            
            L.DomEvent.on(btn, 'click', function(e) {
                L.DomEvent.stopPropagation(e);
                L.DomEvent.preventDefault(e);
                togglePickerMode(btn);
            });
            return btn;
        }
    });
    map.addControl(new PickerControl());

    map.on('click', function(e) {
        if (isPickerActive) {
            const lat = e.latlng.lat.toFixed(6);
            const lon = e.latlng.lng.toFixed(6);
            clearPolygon();
            setCoordinates(lat, lon);
            togglePickerMode(document.querySelector('.location-picker-btn'));
        }
    });
}

function togglePickerMode(btn) {
    isPickerActive = !isPickerActive;
    if (isPickerActive) {
        btn.classList.add('active');
        map.getContainer().style.cursor = 'crosshair';
    } else {
        btn.classList.remove('active');
        map.getContainer().style.cursor = '';
    }
}

function clearPolygon() {
    if (polygonLayer) {
        map.removeLayer(polygonLayer);
        polygonLayer = null;
    }
}

function setCoordinates(lat, lon) {
    document.getElementById('coordinates').value = `${lat}, ${lon}`;
    
    if (marker) {
        marker.setLatLng([lat, lon]);
    } else {
        marker = L.marker([lat, lon]).addTo(map);
    }
    map.setView([lat, lon], 13);

    // Auto-update weather stations if enabled
    if (document.getElementById('toggle-stations').checked) {
        toggleWeatherStations({ target: { checked: true } });
    }
}

// File Import Logic
async function toggleWeatherStations(e) {
    if (e.target.checked) {
        showLoading();
        try {
            await fetchWeatherStations();
        } catch (err) {
            showError("Wetterstationen konnten nicht geladen werden: " + err.message);
            e.target.checked = false;
        } finally {
            hideLoading();
        }
    } else {
        stationsLayer.clearLayers();
    }
}

// --- Helper: Haversine Distance ---
function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

async function fetchWeatherStations() {
    // Clear existing stations first
    stationsLayer.clearLayers();

    const coordsStr = document.getElementById('coordinates').value;
    if (!coordsStr) {
        throw new Error("Bitte zuerst einen Standort auf der Karte wählen.");
    }
    const [targetLat, targetLon] = coordsStr.split(',').map(s => parseFloat(s.trim()));

    // Official DWD CDC Station List
    const dwdUrl = 'https://opendata.dwd.de/climate_environment/CDC/help/KL_Tageswerte_Beschreibung_Stationen.txt';
    
    // Try multiple proxies to ensure reliability
    const proxies = [
        `https://corsproxy.io/?${encodeURIComponent(dwdUrl)}`,
        `https://api.allorigins.win/raw?url=${encodeURIComponent(dwdUrl)}`,
        `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(dwdUrl)}`
    ];

    let text = "";
    
    for (const proxyUrl of proxies) {
        try {
            const response = await fetch(proxyUrl);
            if (response.ok) {
                // DWD files are typically ISO-8859-1 (Latin-1)
                const buffer = await response.arrayBuffer();
                const decoder = new TextDecoder('windows-1252'); // Handle German Umlaute
                text = decoder.decode(buffer);
                if (text && text.length > 500) break; // Success
            }
        } catch (e) {
            console.warn(`Proxy ${proxyUrl} failed:`, e);
            continue;
        }
    }

    if (!text) {
        throw new Error("DWD Stationsliste konnte nicht geladen werden.");
    }
    
    const lines = text.split('\n');
    
    // The file has a header (2 lines)
    // Format: Stations_id von_datum bis_datum Stationshoehe geoBreite geoLaenge Stationsname Bundesland
    const stations = [];
    const activeCutoff = 20250101;

    for (let i = 2; i < lines.length; i++) {
        const line = lines[i];
        if (line.length < 100) continue;

        const id = line.substring(0, 5).trim();
        const untilDate = line.substring(15, 23).trim();
        
        if (untilDate && parseInt(untilDate) < activeCutoff) continue;

        const lat = parseFloat(line.substring(39, 50).trim());
        const lon = parseFloat(line.substring(51, 60).trim());
        const elev = parseInt(line.substring(24, 38).trim());
        
        // Clean name and state (handle 'Frei' and Umlaute)
        let name = line.substring(61, 101).trim();
        let state = line.substring(102).trim().replace(/\s+Frei$/i, "");

        const dist = haversineDistance(targetLat, targetLon, lat, lon);

        if (dist <= 25) {
            stations.push({
                type: "Feature",
                properties: { id, name, elev, state, dist: dist.toFixed(2) },
                geometry: { type: "Point", coordinates: [lon, lat] }
            });
        }
    }

    if (stations.length === 0) {
        return; 
    }

    const data = { type: "FeatureCollection", features: stations };
    
    L.geoJSON(data, {
        pointToLayer: (feature, latlng) => {
            return L.circleMarker(latlng, {
                radius: 7,
                fillColor: "#e53e3e", 
                color: "#fff",
                weight: 2,
                opacity: 1,
                fillOpacity: 0.9
            });
        },
        onEachFeature: (feature, layer) => {
            const props = feature.properties;
            layer.bindPopup(`
                <div style="min-width: 200px">
                    <strong style="font-size: 1.1em">${props.name}</strong><br>
                    <span style="color: #666">Station ID: ${props.id}</span><br>
                    <hr style="margin: 5px 0; border: 0; border-top: 1px solid #eee">
                    <b>📍 Entfernung:</b> ${props.dist} km<br>
                    <b>⛰️ Höhe:</b> ${props.elev}m<br>
                    <b>🗺️ Bundesland:</b> ${props.state}<br>
                    <hr style="margin: 5px 0; border: 0; border-top: 1px solid #eee">
                    <small><b>Sensoren (Standard DWD CDC):</b><br>
                    Temp (2m), Feuchte, Niederschlag, Wind, Luftdruck, Globalstrahlung</small>
                </div>
            `);
        }
    }).addTo(stationsLayer);
}

async function handleFileImport(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
        const content = e.target.result;
        let points = [];

        try {
            if (file.name.endsWith('.kml')) {
                points = parseKML(content);
            } else if (file.name.endsWith('.plan')) {
                points = parsePlan(content);
            }

            if (points.length > 0) {
                displayPolygon(points);
                const centroid = calculateCentroid(points);
                setCoordinates(centroid.lat.toFixed(6), centroid.lon.toFixed(6));
                hideError();
            } else {
                showError("Keine gültigen Polygone in der Datei gefunden.");
            }
        } catch (err) {
            showError("Fehler beim Verarbeiten der Datei: " + err.message);
        }
    };
    reader.readAsText(file);
}

function parseKML(text) {
    const parser = new DOMParser();
    const kml = parser.parseFromString(text, "text/xml");
    const coordStrings = kml.getElementsByTagName("coordinates");
    let points = [];

    for (let coordStr of coordStrings) {
        const coords = coordStr.textContent.trim().split(/\s+/);
        for (let c of coords) {
            const parts = c.split(",");
            if (parts.length >= 2) {
                // KML is Lon, Lat, Alt
                points.push([parseFloat(parts[1]), parseFloat(parts[0])]);
            }
        }
    }
    return points;
}

function parsePlan(text) {
    const data = JSON.parse(text);
    let points = [];

    // Check geoFence polygons
    if (data.geoFence && data.geoFence.polygons) {
        for (let polyObj of data.geoFence.polygons) {
            if (polyObj.polygon) {
                // .plan polygons are [lat, lon]
                points = polyObj.polygon.map(p => [p[0], p[1]]);
                break; // Just take the first polygon for simplicity
            }
        }
    }
    
    // Fallback to mission items if no geoFence
    if (points.length === 0 && data.mission && data.mission.items) {
        points = data.mission.items
            .filter(item => item.params && item.params[4] !== undefined && item.params[5] !== undefined)
            .map(item => [item.params[4], item.params[5]]);
    }

    return points;
}

function displayPolygon(points) {
    clearPolygon();
    polygonLayer = L.polygon(points, { color: 'var(--primary-color)', fillOpacity: 0.3 }).addTo(map);
    map.fitBounds(polygonLayer.getBounds());
}

function calculateCentroid(points) {
    let lat = 0, lon = 0;
    points.forEach(p => {
        lat += p[0];
        lon += p[1];
    });
    return {
        lat: lat / points.length,
        lon: lon / points.length
    };
}

async function fetchLocationName(lat, lon) {
    try {
        const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=10&addressdetails=1`;
        const response = await fetch(url);
        if (response.ok) {
            const data = await response.json();
            if (data && data.address) {
                const city = data.address.city || data.address.town || data.address.village || data.address.county || "Unbekannter Ort";
                lastBaseLocationName = city;
                updateStationInHeader(document.querySelector('input[name="weather-source"]:checked').value);
                return;
            }
        }
        lastBaseLocationName = `${lat}, ${lon}`;
        updateStationInHeader(document.querySelector('input[name="weather-source"]:checked').value);
    } catch (error) {
        console.error("Geocoding error:", error);
        lastBaseLocationName = `${lat}, ${lon}`;
        updateStationInHeader(document.querySelector('input[name="weather-source"]:checked').value);
    }
}

function updateStationInHeader(source) {
    const dwdLabel = document.getElementById('label-dwd');
    
    if (allSourcesData.dwd && allSourcesData.dwd.station_name) {
        dwdLabel.innerText = `DWD: ${allSourcesData.dwd.station_name}`;
        if (source === 'dwd') {
            locationNameEl.innerText = `Auswertung für: ${lastBaseLocationName} (DWD Station: ${allSourcesData.dwd.station_name})`;
        } else {
            locationNameEl.innerText = `Auswertung für: ${lastBaseLocationName}`;
        }
    } else {
        dwdLabel.innerText = "DWD / Station (Messung)";
        locationNameEl.innerText = `Auswertung für: ${lastBaseLocationName}`;
    }
}

// Geolocation Handling
btnLocate.addEventListener('click', () => {
    if (!navigator.geolocation) {
        showError("Geolocation wird von deinem Browser nicht unterstützt.");
        return;
    }

    navigator.geolocation.getCurrentPosition(
        (position) => {
            const latStr = position.coords.latitude.toFixed(4);
            const lonStr = position.coords.longitude.toFixed(4);
            setCoordinates(latStr, lonStr);
            hideError();
        },
        (error) => {
            showError("Fehler beim Abrufen des Standorts: " + error.message);
        }
    );
});

// Form Submission
weatherForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const coordStr = document.getElementById('coordinates').value.trim();
    const startDate = document.getElementById('start-date').value;
    const endDate = document.getElementById('end-date').value;

    if (!coordStr || !startDate || !endDate) {
        showError("Bitte alle Felder ausfüllen.");
        return;
    }

    // Parse coordinates (expects "lat, lon" or "lat lon")
    const coordParts = coordStr.split(/[\s,]+/);
    if (coordParts.length < 2) {
        showError("Ungültiges Format für Koordinaten. Bitte im Format 'Lat, Lon' eingeben (z.B. 52.0728, 12.5552).");
        return;
    }

    const lat = parseFloat(coordParts[0]);
    const lon = parseFloat(coordParts[1]);

    if (isNaN(lat) || isNaN(lon)) {
        showError("Ungültige Koordinatenwerte. Bitte Zahlen eingeben.");
        return;
    }

    if (new Date(startDate) > new Date(endDate)) {
        showError("Das Startdatum darf nicht nach dem Enddatum liegen.");
        return;
    }

    setCoordinates(lat, lon); // Update marker on map if manually entered
    fetchLocationName(lat, lon); // Fetch and display city name

    hideError();
    showLoading();
    dashboard.classList.add('hidden');

    try {
        // Fetch both sources in parallel
        const [omRaw, dwdRaw] = await Promise.allSettled([
            fetchWeatherData(lat, lon, startDate, endDate, 'open-meteo'),
            fetchWeatherData(lat, lon, startDate, endDate, 'dwd')
        ]);

        // Process and store both
        allSourcesData['open-meteo'] = omRaw.status === 'fulfilled' ? prepareChartData(omRaw.value) : null;
        allSourcesData['dwd'] = dwdRaw.status === 'fulfilled' ? prepareChartData(dwdRaw.value) : null;

        // Calculate global fixed scales based on the maxima of BOTH sources
        fixedScales = calculateGlobalScales();

        const currentSource = document.querySelector('input[name="weather-source"]:checked').value;
        const dataToRender = allSourcesData[currentSource];

        if (!dataToRender) {
            if (currentSource === 'dwd' && dwdRaw.reason) throw dwdRaw.reason;
            if (currentSource === 'open-meteo' && omRaw.reason) throw omRaw.reason;
            throw new Error("Keine Daten für die gewählte Quelle verfügbar.");
        }

        renderDashboard(dataToRender);
        updateStationInHeader(currentSource);
        dashboard.classList.remove('hidden');
    } catch (error) {
        showError("Fehler beim Abrufen der Wetterdaten: " + error.message);
    } finally {
        hideLoading();
    }
});

async function fetchWeatherData(lat, lon, startDate, endDate, source) {
    if (source === 'dwd') {
        return fetchBrightSkyData(lat, lon, startDate, endDate);
    }

    // Open-Meteo Historical API Endpoint
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${startDate}&end_date=${endDate}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto`;
    
    const response = await fetch(url);
    if (!response.ok) {
        if (response.status === 400) {
            throw new Error("API Fehler: Wahrscheinlich liegt das Enddatum zu nah an der Gegenwart. Die Historien-API hat ca. 2 Tage Verzögerung.");
        }
        throw new Error(`API Fehler (${response.status})`);
    }
    
    return await response.json();
}

async function fetchBrightSkyData(lat, lon, startDate, endDate) {
    // Bright Sky uses ISO 8601 strings. 
    // We fetch hourly and aggregate to daily to match Open-Meteo format.
    const url = `https://api.brightsky.dev/weather?lat=${lat}&lon=${lon}&date=${startDate}&last_date=${endDate}`;
    
    const response = await fetch(url);
    if (!response.ok) throw new Error("Fehler beim Abrufen der Bright Sky Daten (DWD Station).");
    
    const raw = await response.json();
    if (!raw.weather || raw.weather.length === 0) throw new Error("Keine DWD Messdaten für diesen Zeitraum gefunden.");

    let stationName = "Unbekannt";
    if (raw.sources && raw.sources.length > 0) {
        stationName = raw.sources[0].station_name || raw.sources[0].dwd_station_id;
    }

    // Aggregate hourly data to daily
    const dailyData = {
        station_name: stationName,
        daily: {
            time: [],
            temperature_2m_max: [],
            temperature_2m_min: [],
            precipitation_sum: []
        }
    };

    const days = {};
    raw.weather.forEach(h => {
        const day = h.timestamp.split('T')[0];
        if (!days[day]) {
            days[day] = { temps: [], precip: 0 };
        }
        if (h.temperature !== null) days[day].temps.push(h.temperature);
        if (h.precipitation !== null) days[day].precip += h.precipitation;
    });

    Object.keys(days).sort().forEach(day => {
        const d = days[day];
        dailyData.daily.time.push(day);
        dailyData.daily.temperature_2m_max.push(d.temps.length ? Math.max(...d.temps) : null);
        dailyData.daily.temperature_2m_min.push(d.temps.length ? Math.min(...d.temps) : null);
        dailyData.daily.precipitation_sum.push(parseFloat(d.precip.toFixed(1)));
    });

    return dailyData;
}

function prepareChartData(data) {
    if (!data.daily || !data.daily.time || data.daily.time.length === 0) {
        return null;
    }

    const daily = data.daily;
    const times = daily.time;
    const tempMax = daily.temperature_2m_max;
    const tempMin = daily.temperature_2m_min;
    const precipSum = daily.precipitation_sum;

    // --- Calculate KPIs ---
    const validTempMax = tempMax.filter(v => v !== null);
    const validTempMin = tempMin.filter(v => v !== null);
    const absMaxTemp = validTempMax.length ? Math.max(...validTempMax) : 0;
    const absMinTemp = validTempMin.length ? Math.min(...validTempMin) : 0;
    const totalPrecip = precipSum.reduce((acc, val) => acc + (val || 0), 0);
    const validPrecip = precipSum.filter(v => v !== null);
    const maxPrecipDay = validPrecip.length ? Math.max(...validPrecip) : 0;
    const frostDaysCount = tempMin.filter(t => t !== null && t < 0).length;

    let totalGDD = 0;
    const gddData = [];
    const cumulativePrecipData = [];
    let currentCumulativePrecip = 0;

    for (let i = 0; i < times.length; i++) {
        const tMax = tempMax[i] !== null ? tempMax[i] : 0;
        const tMin = tempMin[i] !== null ? tempMin[i] : 0;
        const avgTemp = (tMax + tMin) / 2;
        let dailyGDD = avgTemp - 10;
        if (dailyGDD < 0) dailyGDD = 0;
        totalGDD += dailyGDD;
        gddData.push(parseFloat(totalGDD.toFixed(1)));

        const precip = precipSum[i] !== null ? precipSum[i] : 0;
        currentCumulativePrecip += precip;
        cumulativePrecipData.push(parseFloat(currentCumulativePrecip.toFixed(1)));
    }

    // --- Monthly Aggregation ---
    const monthlyPrecipMap = {};
    const monthlyTempSumMap = {};
    times.forEach((dateStr, index) => {
        const precipVal = precipSum[index] || 0;
        const tMax = tempMax[index] !== null ? tempMax[index] : 0;
        const tMin = tempMin[index] !== null ? tempMin[index] : 0;
        const avgTemp = (tMax + tMin) / 2;
        const tempSumVal = avgTemp > 0 ? avgTemp : 0;
        const monthStr = dateStr.substring(0, 7);
        if (!monthlyPrecipMap[monthStr]) {
            monthlyPrecipMap[monthStr] = 0;
            monthlyTempSumMap[monthStr] = 0;
        }
        monthlyPrecipMap[monthStr] += precipVal;
        monthlyTempSumMap[monthStr] += tempSumVal;
    });

    return {
        station_name: data.station_name || null,
        times, tempMax, tempMin, precipSum, cumulativePrecipData, gddData,
        monthlyLabels: Object.keys(monthlyPrecipMap),
        monthlyPrecipData: Object.values(monthlyPrecipMap).map(v => parseFloat(v.toFixed(1))),
        monthlyTempSumData: Object.values(monthlyTempSumMap).map(v => parseFloat(v.toFixed(1))),
        kpis: {
            absMaxTemp, absMinTemp, totalPrecip, maxPrecipDay, frostDaysCount, totalGDD
        }
    };
}

function calculateGlobalScales() {
    let maxT = -99, minT = 99, maxPD = 0, maxPC = 0, maxG = 0, maxMP = 10, maxMTS = 10;
    let found = false;

    Object.values(allSourcesData).forEach(data => {
        if (!data) return;
        found = true;
        maxT = Math.max(maxT, data.kpis.absMaxTemp);
        minT = Math.min(minT, data.kpis.absMinTemp);
        maxPD = Math.max(maxPD, data.kpis.maxPrecipDay);
        maxPC = Math.max(maxPC, data.kpis.totalPrecip);
        maxG = Math.max(maxG, data.kpis.totalGDD);
        maxMP = Math.max(maxMP, ...data.monthlyPrecipData);
        maxMTS = Math.max(maxMTS, ...data.monthlyTempSumData);
    });

    if (!found) return null;

    const pad = (val, factor = 1.1) => val > 0 ? val * factor : val * 0.9;
    const padMin = (val) => val < 0 ? val * 1.1 : val * 0.9;

    return {
        yTemp: { min: Math.floor(padMin(minT)), max: Math.ceil(pad(maxT)) },
        yPrecipDaily: { min: 0, max: Math.ceil(pad(maxPD)) },
        yPrecipCum: { min: 0, max: Math.ceil(pad(maxPC)) },
        yGdd: { min: 0, max: Math.ceil(pad(maxG)) },
        yMonthlyPrecip: { min: 0, max: Math.ceil(pad(maxMP)) },
        yMonthlyTempSum: { min: 0, max: Math.ceil(pad(maxMTS)) }
    };
}

function renderDashboard(data) {
    currentChartData = data;

    // Update UI KPIs
    document.getElementById('kpi-temp-max').innerText = `${data.kpis.absMaxTemp.toFixed(1)} °C`;
    document.getElementById('kpi-temp-min').innerText = `${data.kpis.absMinTemp.toFixed(1)} °C`;
    document.getElementById('kpi-precip-sum').innerText = `${data.kpis.totalPrecip.toFixed(1)} mm`;
    document.getElementById('kpi-gdd').innerText = `${data.kpis.totalGDD.toFixed(1)}`;
    document.getElementById('kpi-precip-max').innerText = `${data.kpis.maxPrecipDay.toFixed(1)} mm`;
    document.getElementById('kpi-frost-days').innerText = data.kpis.frostDaysCount;

    // Render Charts
    renderUnifiedChartReal(); // Initialize Chart instance
    renderUnifiedChart();     // Setup sliders and apply zoom
    renderMonthlyPrecipChart();
    renderMonthlyTempSumChart();
}

function processDataAndRender(data) {
    // Legacy function - now handled by prepareChartData + renderDashboard
    const prepared = prepareChartData(data);
    if (prepared) renderDashboard(prepared);
}

function updateChartVisibility() {
    if (!mainChartInst) return;
    
    mainChartInst.data.datasets.forEach(dataset => {
        const id = dataset.customId;
        const isChecked = document.getElementById(id).checked;
        dataset.hidden = !isChecked;
    });
    
    mainChartInst.update();
}

function renderUnifiedChart() {
    if (!currentChartData) return;
    
    // Set slider range based on data points
    const startSlider = document.getElementById('zoom-slider-start');
    const endSlider = document.getElementById('zoom-slider-end');
    const maxIdx = currentChartData.times.length - 1;
    
    startSlider.max = maxIdx;
    endSlider.max = maxIdx;
    
    // Default to full range if not already adjusted or if new data loaded
    if (startSlider.value === "0" && endSlider.value === "100") { // Initial defaults
        startSlider.value = 0;
        endSlider.value = maxIdx;
    }

    applyChartZoom();
}

function updateChartZoom(e) {
    const startSlider = document.getElementById('zoom-slider-start');
    const endSlider = document.getElementById('zoom-slider-end');
    let startVal = parseInt(startSlider.value);
    let endVal = parseInt(endSlider.value);

    // Prevent sliders from crossing each other
    if (e.target.id === 'zoom-slider-start') {
        if (startVal >= endVal) {
            startSlider.value = endVal - 1;
            if (startSlider.value < 0) startSlider.value = 0;
        }
    } else {
        if (endVal <= startVal) {
            endSlider.value = startVal + 1;
            if (endSlider.value > parseInt(endSlider.max)) endSlider.value = endSlider.max;
        }
    }

    applyChartZoom();
}

function resetChartZoom() {
    const startSlider = document.getElementById('zoom-slider-start');
    const endSlider = document.getElementById('zoom-slider-end');
    startSlider.value = 0;
    endSlider.value = currentChartData ? currentChartData.times.length - 1 : 100;
    applyChartZoom();
}

function applyChartZoom() {
    if (!currentChartData || !mainChartInst) return;

    const startIdx = parseInt(document.getElementById('zoom-slider-start').value);
    const endIdx = parseInt(document.getElementById('zoom-slider-end').value);
    
    // We already enforced start < end in updateChartZoom, so we can use them directly
    const labels = currentChartData.times.slice(startIdx, endIdx + 1);
    const displayRange = `${labels[0]} bis ${labels[labels.length-1]}`;
    document.getElementById('zoom-period-display').innerText = displayRange;

    // Update Chart Data
    mainChartInst.data.labels = labels;
    
    // Map datasets (Temperature, Precip, GDD)
    const datasets = [
        currentChartData.tempMax,
        currentChartData.tempMin,
        currentChartData.precipSum,
        currentChartData.cumulativePrecipData,
        currentChartData.gddData
    ];

    mainChartInst.data.datasets.forEach((ds, idx) => {
        if (datasets[idx]) {
            ds.data = datasets[idx].slice(startIdx, endIdx + 1);
        }
    });

    mainChartInst.update('none'); // Update without animation for performance
}

function renderUnifiedChartReal() {
    const ctx = document.getElementById('mainChart').getContext('2d');
    if (mainChartInst) mainChartInst.destroy();

    const data = currentChartData;
    
    // Determine current zoom indices
    const startIdx = parseInt(document.getElementById('zoom-slider-start').value) || 0;
    const endIdx = parseInt(document.getElementById('zoom-slider-end').value) || (data.times.length - 1);

    // Initial labels and data should respect the current zoom sliders
    const labels = data.times.slice(startIdx, endIdx + 1);

    mainChartInst = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Max Temperatur (°C)',
                    data: data.tempMax.slice(startIdx, endIdx + 1),
                    borderColor: '#e53e3e',
                    backgroundColor: 'rgba(229, 62, 62, 0.1)',
                    borderWidth: 2,
                    fill: false,
                    tension: 0.3,
                    yAxisID: 'yTemp',
                    customId: 'toggle-temp-max',
                    hidden: !document.getElementById('toggle-temp-max').checked
                },
                {
                    label: 'Min Temperatur (°C)',
                    data: data.tempMin.slice(startIdx, endIdx + 1),
                    borderColor: '#3182ce',
                    backgroundColor: 'rgba(49, 130, 206, 0.1)',
                    borderWidth: 2,
                    fill: false,
                    tension: 0.3,
                    yAxisID: 'yTemp',
                    customId: 'toggle-temp-min',
                    hidden: !document.getElementById('toggle-temp-min').checked
                },
                {
                    type: 'bar',
                    label: 'Niederschlag (mm/Tag)',
                    data: data.precipSum.slice(startIdx, endIdx + 1),
                    backgroundColor: 'rgba(44, 122, 123, 0.6)',
                    borderColor: '#2c7a7b',
                    borderWidth: 1,
                    yAxisID: 'yPrecipDaily',
                    customId: 'toggle-precip-daily',
                    hidden: !document.getElementById('toggle-precip-daily').checked
                },
                {
                    label: 'Summe Niederschlag (mm)',
                    data: data.cumulativePrecipData.slice(startIdx, endIdx + 1),
                    borderColor: '#319795',
                    backgroundColor: 'rgba(49, 151, 149, 0.1)',
                    borderWidth: 2,
                    borderDash: [5, 5],
                    fill: true,
                    tension: 0.3,
                    yAxisID: 'yPrecipCum',
                    customId: 'toggle-precip-sum',
                    hidden: !document.getElementById('toggle-precip-sum').checked
                },
                {
                    label: 'GDD (kumuliert)',
                    data: data.gddData.slice(startIdx, endIdx + 1),
                    borderColor: '#dd6b20', // Orange
                    backgroundColor: 'rgba(221, 107, 32, 0.1)',
                    borderWidth: 2,
                    fill: true,
                    tension: 0.3,
                    yAxisID: 'yGdd',
                    customId: 'toggle-gdd',
                    hidden: !document.getElementById('toggle-gdd').checked
                }
            ]
        },
        options: {
            animation: false,
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false,
            },
            plugins: {
                tooltip: {
                    mode: 'index',
                    intersect: false
                },
                legend: {
                    display: false // We use our own custom checkboxes
                }
            },
            scales: {
                x: {
                    title: { display: true, text: 'Datum' }
                },
                yTemp: {
                    type: 'linear',
                    display: true,
                    position: 'left',
                    title: { display: true, text: 'Temperatur (°C)' },
                    min: fixedScales?.yTemp?.min,
                    max: fixedScales?.yTemp?.max
                },
                yPrecipDaily: {
                    type: 'linear',
                    display: true,
                    position: 'right',
                    title: { display: true, text: 'Niederschlag / Tag (mm)' },
                    grid: { drawOnChartArea: false },
                    min: fixedScales?.yPrecipDaily?.min,
                    max: fixedScales?.yPrecipDaily?.max
                },
                yPrecipCum: {
                    type: 'linear',
                    display: true,
                    position: 'right',
                    title: { display: true, text: 'Summe Niederschlag (mm)' },
                    grid: { drawOnChartArea: false },
                    min: fixedScales?.yPrecipCum?.min,
                    max: fixedScales?.yPrecipCum?.max
                },
                yGdd: {
                    type: 'linear',
                    display: true,
                    position: 'right',
                    title: { display: true, text: 'GDD' },
                    grid: { drawOnChartArea: false },
                    min: fixedScales?.yGdd?.min,
                    max: fixedScales?.yGdd?.max
                }
            }
        }
    });
}

function exportToCSV() {
    if (!currentChartData || !mainChartInst) {
        showError("Keine Daten zum Exportieren vorhanden.");
        return;
    }

    const labels = mainChartInst.data.labels;
    const source = document.querySelector('input[name="weather-source"]:checked').value;
    const sourceLabel = source === 'dwd' ? `DWD_Station_${currentChartData.station_name || 'unknown'}` : 'OpenMeteo';
    
    // CSV Header
    let csvContent = "Datum;Max_Temperatur_C;Min_Temperatur_C;Niederschlag_mm;Summe_Niederschlag_mm;GDD_kumuliert\n";

    // Data rows (using the currently zoomed/visible range from mainChartInst)
    for (let i = 0; i < labels.length; i++) {
        const row = [
            labels[i],
            mainChartInst.data.datasets[0].data[i] ?? "",
            mainChartInst.data.datasets[1].data[i] ?? "",
            mainChartInst.data.datasets[2].data[i] ?? "",
            mainChartInst.data.datasets[3].data[i] ?? "",
            mainChartInst.data.datasets[4].data[i] ?? ""
        ];
        csvContent += row.join(";") + "\n";
    }

    // Create download link
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const timestamp = new Date().toISOString().slice(0, 10);
    
    link.setAttribute("href", url);
    link.setAttribute("download", `Wetterdaten_${sourceLabel}_${timestamp}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// Utility Functions
function showError(msg) {
    errorMessage.innerText = msg;
    errorMessage.classList.remove('hidden');
}

function hideError() {
    errorMessage.classList.add('hidden');
    errorMessage.innerText = '';
}

function showLoading() {
    loading.classList.remove('hidden');
}

function hideLoading() {
    loading.classList.add('hidden');
}

function renderMonthlyPrecipChart() {
    if (!currentChartData) return;
    
    const ctx = document.getElementById('precipMonthlyChart').getContext('2d');
    if (precipMonthlyChartInst) precipMonthlyChartInst.destroy();

    const data = currentChartData;

    precipMonthlyChartInst = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: data.monthlyLabels,
            datasets: [{
                label: 'Niederschlag (mm)',
                data: data.monthlyPrecipData,
                backgroundColor: '#319795', // Teal
                borderRadius: 4
            }]
        },
        options: {
            animation: false,
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    title: { display: true, text: 'Monat' }
                },
                y: {
                    min: fixedScales?.yMonthlyPrecip?.min,
                    max: fixedScales?.yMonthlyPrecip?.max,
                    title: { display: true, text: 'Niederschlag (mm)' }
                }
            }
        }
    });
}

function renderMonthlyTempSumChart() {
    if (!currentChartData) return;
    
    const ctx = document.getElementById('tempMonthlyChart').getContext('2d');
    if (tempMonthlyChartInst) tempMonthlyChartInst.destroy();

    const data = currentChartData;

    tempMonthlyChartInst = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: data.monthlyLabels,
            datasets: [{
                label: 'Temperatursumme (°C > 0)',
                data: data.monthlyTempSumData,
                backgroundColor: '#dd6b20', // Orange
                borderRadius: 4
            }]
        },
        options: {
            animation: false,
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    title: { display: true, text: 'Monat' }
                },
                y: {
                    min: fixedScales?.yMonthlyTempSum?.min,
                    max: fixedScales?.yMonthlyTempSum?.max,
                    title: { display: true, text: 'Summe °C' }
                }
            }
        }
    });
}
